import { vi } from 'vitest';

/**
 * Test fixture: a fake GPU device whose queue really moves bytes, shared by the
 * tests of the GPU profiler (gpu-profiler.test.ts drives the profiler by hand,
 * gpu-profiler-graph.test.ts drives it through RenderGraph.render()).
 */

/** WebGPU's usage and map-mode constants, which node does not define. Call from a `beforeAll`. */
export function installGpuGlobals(): void {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    (globalThis as any).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
      INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
    };
  }
  if (typeof globalThis.GPUMapMode === 'undefined') {
    (globalThis as any).GPUMapMode = { READ: 0x0001, WRITE: 0x0002 };
  }
}

export interface FakeBuffer {
  label?: string;
  size: number;
  usage: number;
  bytes: Uint8Array;
  destroyed: boolean;
  mapped: boolean;
  failMap: boolean;
  failRange: boolean;
  /** Runs inside mapAsync, once the buffer is marked mapped and before the promise resolves. */
  onMap: (() => void) | null;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

/** What `encoder.finish()` hands back: the commands that touch a buffer (resolve, copy), in order. */
export interface FakeCommandBuffer {
  ops: Array<() => void>;
}

/**
 * A fake device whose queue really moves bytes: queue.writeBuffer lands at
 * once, a submitted command buffer first "runs its passes" (the stamps the
 * test says they write land in the query set), then its resolve and copies in
 * order; a rejected one runs nothing, which is the case the seal is for.
 *
 * Two ways to submit. `submit(enc, { stamps, reject })` is the test's own: it
 * finishes the encoder and runs it. `device.queue.submit` is the real entry
 * point, which `RenderGraph.render()` calls itself: it runs the command
 * buffers with the stamps queued by `stampsForNextSubmit` (consumed by that
 * one submit; none queued means the passes write nothing).
 *
 * The encoder's begin*Pass methods live on its prototype, like the real
 * GPUCommandEncoder's, so a test can tell an own-property override (the
 * profiler's interception) from an untouched encoder.
 *
 * It is as strict as WebGPU about a mapped buffer: mapAsync marks `mapped` at
 * call time, so `mapped` also means "a map is pending", and writeBuffer, the
 * resolve and the copy throw when their DESTINATION is in that state. The real
 * code never does that to a readback, and a regression that recycled one
 * without unmapping it now shows here instead of as a silently lost frame.
 * Reading the mapped range of a destroyed buffer throws too.
 */
export function makeGpu() {
  const buffers: FakeBuffer[] = [];
  let values = new BigUint64Array(0);
  let nextStamps: bigint[] | undefined;
  const assertUnmapped = (buffer: FakeBuffer, op: string) => {
    if (buffer.mapped) throw new Error(`ValidationError: ${op} into '${buffer.label}', which is mapped or has a map pending`);
  };
  const runCommandBuffers = (commandBuffers: Iterable<FakeCommandBuffer>, stamps?: bigint[]) => {
    if (stamps) values.set(stamps);
    for (const commandBuffer of commandBuffers) for (const op of commandBuffer.ops) op();
  };

  const pass = () => ({
    draw() {}, drawIndexed() {}, drawIndirect() {}, drawIndexedIndirect() {}, executeBundles() {},
    dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {}, end() {},
  });

  class FakeEncoder {
    private readonly ops: Array<() => void> = [];

    beginComputePass(_desc?: GPUComputePassDescriptor) {
      return pass();
    }

    beginRenderPass(_desc: GPURenderPassDescriptor) {
      return pass();
    }

    resolveQuerySet(_qs: unknown, first: number, count: number, dst: FakeBuffer, offset: number) {
      this.ops.push(() => {
        assertUnmapped(dst, 'resolveQuerySet');
        dst.bytes.set(new Uint8Array(values.buffer, first * 8, count * 8), offset);
      });
    }

    copyBufferToBuffer(src: FakeBuffer, srcOffset: number, dst: FakeBuffer, dstOffset: number, size: number) {
      this.ops.push(() => {
        assertUnmapped(dst, 'copyBufferToBuffer');
        dst.bytes.set(src.bytes.slice(srcOffset, srcOffset + size), dstOffset);
      });
    }

    finish(): FakeCommandBuffer {
      return { ops: this.ops };
    }
  }

  const encoder = () => new FakeEncoder() as unknown as GPUCommandEncoder;

  const device = {
    createQuerySet: vi.fn(({ count }: GPUQuerySetDescriptor) => {
      values = new BigUint64Array(count);
      return { count, destroy: vi.fn() };
    }),
    createBuffer: vi.fn(({ size, usage, label }: GPUBufferDescriptor) => {
      const b: FakeBuffer = {
        label, size, usage, bytes: new Uint8Array(size), destroyed: false, mapped: false,
        failMap: false, failRange: false, onMap: null,
        async mapAsync() {
          if (b.failMap) throw new Error('OperationError: device lost');
          if (b.mapped) throw new Error('OperationError: buffer already mapped');
          b.mapped = true;
          b.onMap?.();
        },
        getMappedRange: (offset = 0, size2?: number) => {
          if (b.destroyed) throw new Error('OperationError: buffer is destroyed');
          if (b.failRange) throw new Error('OperationError: mapped range unavailable');
          return b.bytes.slice(offset, size2 === undefined ? undefined : offset + size2).buffer;
        },
        unmap() { b.mapped = false; },
        destroy() { b.destroyed = true; },
      };
      buffers.push(b);
      return b;
    }),
    createCommandEncoder: () => encoder(),
    queue: {
      writeBuffer: vi.fn((buffer: FakeBuffer, offset: number, data: ArrayBufferView) => {
        assertUnmapped(buffer, 'writeBuffer');
        buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
      }),
      submit: vi.fn((commandBuffers: Iterable<FakeCommandBuffer>) => {
        const stamps = nextStamps;
        nextStamps = undefined;
        runCommandBuffers(commandBuffers, stamps);
      }),
    },
  };

  /** Submit: the passes write `stamps` into the query set, then the frame's resolve and copies run. */
  function submit(enc: GPUCommandEncoder, opts: { stamps?: bigint[]; reject?: boolean } = {}) {
    const commandBuffer = enc.finish() as unknown as FakeCommandBuffer;
    if (opts.reject) return;
    runCommandBuffers([commandBuffer], opts.stamps);
  }

  /** The stamps the passes write when the next `device.queue.submit` runs (once: it consumes them). */
  function stampsForNextSubmit(stamps: bigint[]) {
    nextStamps = stamps;
  }

  return {
    device: device as unknown as GPUDevice, buffers, encoder, submit, stampsForNextSubmit,
    createQuerySet: device.createQuerySet, createBuffer: device.createBuffer,
    writeBuffer: device.queue.writeBuffer, queueSubmit: device.queue.submit,
  };
}

export type Gpu = ReturnType<typeof makeGpu>;

/** Stamps for passes of `durationsMs`, one after the other, in frame `frame` (distinct frames never repeat a stamp). */
export function stampsOf(frame: number, ...durationsMs: number[]): bigint[] {
  let t = 1_000_000_000n * BigInt(frame + 1);
  const out: bigint[] = [];
  for (const d of durationsMs) {
    out.push(t, t + BigInt(Math.round(d * 1e6)));
    t += 10_000_000n;
  }
  return out;
}

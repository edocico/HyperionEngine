import { describe, it, expect } from 'vitest';
import { DebugLinePass, LineBatchPass } from './debug-line-pass';
import type { FrameState } from '../render-pass';

/** Test subclass exposing the protected staging buffers. */
class InspectablePass extends DebugLinePass {
  get positions(): Float32Array {
    return this.vertStaging;
  }
  get colors(): Float32Array {
    return this.colorStaging;
  }
}

function makeFrame(lines?: Float32Array): FrameState {
  return {
    entityCount: 0,
    transforms: new Float32Array(0),
    bounds: new Float32Array(0),
    renderMeta: new Uint32Array(0),
    texIndices: new Uint32Array(0),
    primParams: new Float32Array(0),
    cameraViewProjection: new Float32Array(16),
    canvasWidth: 800,
    canvasHeight: 600,
    deltaTime: 1 / 60,
    physicsDebugLines: lines,
    transparentCount: 0,
    frameStamp: 1,
  };
}

describe('DebugLinePass', () => {
  it('has correct render-graph metadata', () => {
    const pass = new DebugLinePass();
    expect(pass.name).toBe('physics-debug');
    expect(pass.optional).toBe(true);
    // Read-modify-write of the swapchain — see graph-assembly.test.ts for the
    // ordering this buys (the overlay runs after the final composite).
    expect(pass.reads).toContain('swapchain');
    expect(pass.writes).toContain('swapchain');
  });

  it('setLines expands 8-f32 records into two vertices with shared color', () => {
    const pass = new InspectablePass();
    // One line from (1,2) to (3,4), red.
    pass.setLines(new Float32Array([1, 2, 3, 4, 1, 0, 0, 1]));

    expect(pass.stagedVertexCount).toBe(2);
    // Vertex A
    expect(pass.positions[0]).toBe(1);
    expect(pass.positions[1]).toBe(2);
    expect(pass.positions[2]).toBe(0); // z = 0
    // Vertex B
    expect(pass.positions[3]).toBe(3);
    expect(pass.positions[4]).toBe(4);
    // Both endpoints share the line color
    expect(Array.from(pass.colors.slice(0, 4))).toEqual([1, 0, 0, 1]);
    expect(Array.from(pass.colors.slice(4, 8))).toEqual([1, 0, 0, 1]);
  });

  it('setLines with null/empty input stages zero vertices', () => {
    const pass = new DebugLinePass();
    pass.setLines(new Float32Array([1, 2, 3, 4, 1, 0, 0, 1]));
    expect(pass.stagedVertexCount).toBe(2);

    pass.setLines(null);
    expect(pass.stagedVertexCount).toBe(0);

    pass.setLines(new Float32Array(0));
    expect(pass.stagedVertexCount).toBe(0);
  });

  it('setLines truncates at maxLines capacity', () => {
    const pass = new DebugLinePass(2); // capacity: 2 lines = 4 vertices
    const records = new Float32Array(5 * 8); // 5 lines
    pass.setLines(records);
    expect(pass.stagedVertexCount).toBe(4);
  });

  it('prepare auto-feeds from FrameState.physicsDebugLines', () => {
    const pass = new DebugLinePass();
    // No GPU device needed: with no buffers created, prepare only stages.
    pass.prepare(
      { queue: { writeBuffer: () => {} } } as unknown as GPUDevice,
      makeFrame(new Float32Array([0, 0, 5, 5, 0, 1, 0, 1])),
    );
    expect(pass.stagedVertexCount).toBe(2);

    // Frame without lines clears the batch.
    pass.prepare(
      { queue: { writeBuffer: () => {} } } as unknown as GPUDevice,
      makeFrame(undefined),
    );
    expect(pass.stagedVertexCount).toBe(0);
  });

  it('setEnabled(false) clears staged vertices and blocks feeding', () => {
    const pass = new DebugLinePass();
    pass.setLines(new Float32Array([1, 2, 3, 4, 1, 0, 0, 1]));
    expect(pass.stagedVertexCount).toBe(2);

    pass.setEnabled(false);
    expect(pass.stagedVertexCount).toBe(0);
    expect(pass.isEnabled).toBe(false);

    pass.prepare(
      { queue: { writeBuffer: () => {} } } as unknown as GPUDevice,
      makeFrame(new Float32Array([0, 0, 5, 5, 0, 1, 0, 1])),
    );
    expect(pass.stagedVertexCount).toBe(0);
  });

  it('setup throws without SHADER_SOURCE', () => {
    const saved = LineBatchPass.SHADER_SOURCE;
    LineBatchPass.SHADER_SOURCE = '';
    try {
      const pass = new DebugLinePass();
      expect(() =>
        pass.setup({} as GPUDevice, { getTextureView: () => undefined } as never),
      ).toThrow(/SHADER_SOURCE/);
    } finally {
      LineBatchPass.SHADER_SOURCE = saved;
    }
  });

  it('execute is a no-op with zero vertices (no pipeline access)', () => {
    const pass = new DebugLinePass();
    // Must not throw even with a null encoder: it returns before using it.
    expect(() =>
      pass.execute(
        null as unknown as GPUCommandEncoder,
        makeFrame(),
        { getTextureView: () => undefined } as never,
      ),
    ).not.toThrow();
  });
});

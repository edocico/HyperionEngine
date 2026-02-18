const HEADER_SIZE = 32;
const WRITE_HEAD_OFFSET = 0; // byte offset in i32 units = 0
const READ_HEAD_OFFSET = 1;  // byte offset 4 in i32 units = 1

/** True on little-endian platforms (~99.97% of devices). Enables TypedArray fast path. */
export const IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Header field offsets (i32 indices) for Worker Supervisor (Phase 4.5). */
export const HEARTBEAT_W1_OFFSET = 4;   // i32 index: byte 16 / 4 = 4
export const HEARTBEAT_W2_OFFSET = 5;   // i32 index: byte 20 / 4 = 5
export const SUPERVISOR_FLAGS_OFFSET = 6; // i32 index: byte 24 / 4 = 6
export const OVERFLOW_COUNTER_OFFSET = 7; // i32 index: byte 28 / 4 = 7

export const enum CommandType {
  Noop = 0,
  SpawnEntity = 1,
  DespawnEntity = 2,
  SetPosition = 3,
  SetRotation = 4,
  SetScale = 5,
  SetVelocity = 6,
  SetTextureLayer = 7,
  SetMeshHandle = 8,
  SetRenderPrimitive = 9,
  SetParent = 10,
}

/** Payload sizes in bytes for each command type (excluding type + entity_id). */
const PAYLOAD_SIZES: Record<CommandType, number> = {
  [CommandType.Noop]: 0,
  [CommandType.SpawnEntity]: 0,
  [CommandType.DespawnEntity]: 0,
  [CommandType.SetPosition]: 12,
  [CommandType.SetRotation]: 16,
  [CommandType.SetScale]: 12,
  [CommandType.SetVelocity]: 12,
  [CommandType.SetTextureLayer]: 4,
  [CommandType.SetMeshHandle]: 4,
  [CommandType.SetRenderPrimitive]: 4,
  [CommandType.SetParent]: 4,
};

export class RingBufferProducer {
  private readonly header: Int32Array;
  private readonly data: DataView;
  private readonly capacity: number;
  // Fast path views (same underlying buffer, offset by header)
  private readonly u8View: Uint8Array;
  private readonly u32View: Uint32Array;
  private readonly f32View: Float32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, 8);
    this.capacity = buffer.byteLength - HEADER_SIZE;
    this.data = new DataView(buffer, HEADER_SIZE, this.capacity);
    this.u8View = new Uint8Array(buffer, HEADER_SIZE, this.capacity);
    this.u32View = new Uint32Array(buffer, HEADER_SIZE, Math.floor(this.capacity / 4));
    this.f32View = new Float32Array(buffer, HEADER_SIZE, Math.floor(this.capacity / 4));
  }

  private get writeHead(): number {
    return Atomics.load(this.header, WRITE_HEAD_OFFSET);
  }

  private set writeHead(val: number) {
    Atomics.store(this.header, WRITE_HEAD_OFFSET, val);
  }

  private get readHead(): number {
    return Atomics.load(this.header, READ_HEAD_OFFSET);
  }

  get freeSpace(): number {
    const w = this.writeHead;
    const r = this.readHead;
    if (w >= r) {
      return this.capacity - w + r - 1;
    }
    return r - w - 1;
  }

  writeCommand(cmd: CommandType, entityId: number, payload?: Float32Array): boolean {
    const payloadSize = PAYLOAD_SIZES[cmd];
    const msgSize = 1 + 4 + payloadSize;

    if (this.freeSpace < msgSize) {
      console.warn("Ring buffer full, dropping command", cmd);
      return false;
    }

    let pos = this.writeHead;

    // Write command type (1 byte)
    this.u8View[pos % this.capacity] = cmd;
    pos++;

    // Write entity ID (4 bytes, little-endian)
    const idPos = pos % this.capacity;
    if (IS_LITTLE_ENDIAN && (idPos & 3) === 0) {
      this.u32View[idPos >> 2] = entityId;
    } else {
      this.data.setUint32(idPos, entityId, true);
    }
    pos += 4;

    // Write payload (f32 values, little-endian)
    if (payload && payloadSize > 0) {
      if (IS_LITTLE_ENDIAN) {
        for (let i = 0; i < payload.length; i++) {
          const p = (pos + i * 4) % this.capacity;
          if ((p & 3) === 0) {
            this.f32View[p >> 2] = payload[i];
          } else {
            this.data.setFloat32(p, payload[i], true);
          }
        }
      } else {
        for (let i = 0; i < payload.length; i++) {
          this.data.setFloat32((pos + i * 4) % this.capacity, payload[i], true);
        }
      }
      pos += payloadSize;
    }

    // Commit write head
    this.writeHead = pos % this.capacity;
    return true;
  }

  setPosition(entityId: number, x: number, y: number, z: number): boolean {
    const payload = new Float32Array([x, y, z]);
    return this.writeCommand(CommandType.SetPosition, entityId, payload);
  }

  spawnEntity(entityId: number): boolean {
    return this.writeCommand(CommandType.SpawnEntity, entityId);
  }

  despawnEntity(entityId: number): boolean {
    return this.writeCommand(CommandType.DespawnEntity, entityId);
  }

  setTextureLayer(entityId: number, packedIndex: number): boolean {
    const payload = new Float32Array(1);
    // Write the u32 as raw bytes into a Float32Array (reinterpret, not convert)
    new Uint32Array(payload.buffer)[0] = packedIndex;
    return this.writeCommand(CommandType.SetTextureLayer, entityId, payload);
  }

  setMeshHandle(entityId: number, handle: number): boolean {
    const payload = new Float32Array(1);
    new Uint32Array(payload.buffer)[0] = handle;
    return this.writeCommand(CommandType.SetMeshHandle, entityId, payload);
  }

  setRenderPrimitive(entityId: number, primitive: number): boolean {
    const payload = new Float32Array(1);
    new Uint32Array(payload.buffer)[0] = primitive;
    return this.writeCommand(CommandType.SetRenderPrimitive, entityId, payload);
  }
}

export function createRingBuffer(capacity: number): SharedArrayBuffer | ArrayBuffer {
  const totalSize = HEADER_SIZE + capacity;
  if (typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated) {
    return new SharedArrayBuffer(totalSize);
  }
  return new ArrayBuffer(totalSize);
}

/**
 * Extract unread bytes from a ring buffer SharedArrayBuffer.
 *
 * Returns a contiguous Uint8Array of command bytes (handling wrap-around)
 * and advances the read head to the current write head.
 *
 * Used by the Worker to bridge SAB → engine_push_commands().
 */
export function extractUnread(sab: SharedArrayBuffer): {
  bytes: Uint8Array;
  capacity: number;
} {
  const header = new Int32Array(sab, 0, 8);
  const capacity = sab.byteLength - HEADER_SIZE;
  const writeHead = Atomics.load(header, WRITE_HEAD_OFFSET);
  const readHead = Atomics.load(header, READ_HEAD_OFFSET);

  if (writeHead === readHead) {
    return { bytes: new Uint8Array(0), capacity };
  }

  const data = new Uint8Array(sab, HEADER_SIZE, capacity);
  let bytes: Uint8Array;

  if (writeHead > readHead) {
    bytes = data.slice(readHead, writeHead);
  } else {
    // Wrap-around: readHead..end + 0..writeHead
    const part1 = data.slice(readHead);
    const part2 = data.slice(0, writeHead);
    bytes = new Uint8Array(part1.length + part2.length);
    bytes.set(part1);
    bytes.set(part2, part1.length);
  }

  // Advance read head
  Atomics.store(header, READ_HEAD_OFFSET, writeHead);

  return { bytes, capacity };
}

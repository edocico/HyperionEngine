/**
 * TLV (Type-Length-Value) parser for ECS inspector debug data.
 * Decodes the binary format produced by engine.debug_get_components().
 *
 * Wire format per entry: [type: u8][length: u16 LE][data: length bytes]
 */

export const COMPONENT_NAMES: Record<number, string> = {
  1: 'Position',
  2: 'Velocity',
  3: 'Rotation',
  4: 'Scale',
  5: 'ModelMatrix',
  6: 'BoundingRadius',
  7: 'TextureLayerIndex',
  8: 'MeshHandle',
  9: 'RenderPrimitive',
  10: 'Parent',
  11: 'Active',
  12: 'ExternalId',
  13: 'PrimitiveParams',
  14: 'LocalMatrix',
  15: 'Children',
};

export interface ParsedComponent {
  readonly type: number;
  readonly name: string;
  readonly values: Record<string, unknown>;
}

function readVec3(dv: DataView, offset: number): { x: number; y: number; z: number } {
  return {
    x: dv.getFloat32(offset, true),
    y: dv.getFloat32(offset + 4, true),
    z: dv.getFloat32(offset + 8, true),
  };
}

function readQuat(dv: DataView, offset: number): { x: number; y: number; z: number; w: number } {
  return {
    x: dv.getFloat32(offset, true),
    y: dv.getFloat32(offset + 4, true),
    z: dv.getFloat32(offset + 8, true),
    w: dv.getFloat32(offset + 12, true),
  };
}

function decodeValues(type: number, data: DataView, offset: number, len: number): Record<string, unknown> {
  switch (type) {
    case 1: // Position (Vec3)
    case 2: // Velocity (Vec3)
    case 4: // Scale (Vec3)
      return readVec3(data, offset);
    case 3: // Rotation (Quat)
      return readQuat(data, offset);
    case 5: // ModelMatrix (16 f32)
    case 14: { // LocalMatrix (16 f32)
      const m: number[] = [];
      for (let i = 0; i < 16; i++) m.push(data.getFloat32(offset + i * 4, true));
      return { matrix: m };
    }
    case 6: // BoundingRadius (f32)
      return { radius: data.getFloat32(offset, true) };
    case 7: // TextureLayerIndex (u32)
      return { value: data.getUint32(offset, true) };
    case 8: // MeshHandle (u32)
      return { value: data.getUint32(offset, true) };
    case 9: // RenderPrimitive (u8)
      return { value: data.getUint8(offset) };
    case 10: // Parent (u32)
      return { parentId: data.getUint32(offset, true) };
    case 11: // Active (marker, 0 bytes)
      return {};
    case 12: // ExternalId (u32)
      return { id: data.getUint32(offset, true) };
    case 13: { // PrimitiveParams (8 f32)
      const params: number[] = [];
      for (let i = 0; i < 8; i++) params.push(data.getFloat32(offset + i * 4, true));
      return { params };
    }
    case 15: { // Children: [count: u8][ids: count × u32 LE]
      if (len === 0) return { count: 0, childIds: [] };
      const count = data.getUint8(offset);
      const childIds: number[] = [];
      for (let i = 0; i < count; i++) {
        childIds.push(data.getUint32(offset + 1 + i * 4, true));
      }
      return { count, childIds };
    }
    default:
      return { raw: len };
  }
}

export function parseTLV(data: Uint8Array): ParsedComponent[] {
  const components: ParsedComponent[] = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = 0;

  while (cursor + 3 <= data.length) {
    const type = data[cursor];
    const len = dv.getUint16(cursor + 1, true);
    const dataOffset = cursor + 3;

    if (dataOffset + len > data.length) break;

    components.push({
      type,
      name: COMPONENT_NAMES[type] ?? `Unknown(${type})`,
      values: decodeValues(type, dv, dataOffset, len),
    });

    cursor = dataOffset + len;
  }

  return components;
}

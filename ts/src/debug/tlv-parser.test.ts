import { describe, it, expect } from 'vitest';
import { parseTLV, COMPONENT_NAMES } from './tlv-parser';

describe('TLV Parser', () => {
  it('parses a single Position component', () => {
    const buf = new Uint8Array(15);
    buf[0] = 1; // Position
    buf[1] = 12; buf[2] = 0; // len=12 LE
    const dv = new DataView(buf.buffer);
    dv.setFloat32(3, 5.0, true);
    dv.setFloat32(7, 10.0, true);
    dv.setFloat32(11, 15.0, true);
    const components = parseTLV(buf);
    expect(components).toHaveLength(1);
    expect(components[0].type).toBe(1);
    expect(components[0].name).toBe('Position');
    expect(components[0].values).toEqual({ x: 5, y: 10, z: 15 });
  });

  it('parses Active marker (zero-length data)', () => {
    const buf = new Uint8Array(3);
    buf[0] = 11; buf[1] = 0; buf[2] = 0;
    const components = parseTLV(buf);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Active');
  });

  it('parses multiple components sequentially', () => {
    const buf = new Uint8Array(18);
    buf[0] = 1; buf[1] = 12; buf[2] = 0;
    const dv = new DataView(buf.buffer);
    dv.setFloat32(3, 1.0, true);
    dv.setFloat32(7, 2.0, true);
    dv.setFloat32(11, 3.0, true);
    buf[15] = 11; buf[16] = 0; buf[17] = 0;
    const components = parseTLV(buf);
    expect(components).toHaveLength(2);
  });

  it('COMPONENT_NAMES covers all types 1-15', () => {
    for (let i = 1; i <= 15; i++) {
      expect(COMPONENT_NAMES[i]).toBeDefined();
    }
  });
});

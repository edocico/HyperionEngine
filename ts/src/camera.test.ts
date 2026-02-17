import { describe, it, expect } from "vitest";
import { orthographic, Camera } from "./camera";

// Helper: multiply a 4x4 column-major matrix by a point (x, y, z, 1)
function transformPoint(
  m: Float32Array | number[],
  x: number,
  y: number,
  z: number
): [number, number, number] {
  const w = 1;
  const ox = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  const oy = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  const oz = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  const ow = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return [ox / ow, oy / ow, oz / ow];
}

describe("orthographic", () => {
  it("maps center to origin in NDC", () => {
    const m = orthographic(-10, 10, -10, 10, 0, 100);
    const [x, y, z] = transformPoint(m, 0, 0, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it("maps corners correctly", () => {
    const m = orthographic(-10, 10, -10, 10, 0, 100);
    const [rx] = transformPoint(m, 10, 0, 0);
    expect(rx).toBeCloseTo(1);
    const [, ty] = transformPoint(m, 0, 10, 0);
    expect(ty).toBeCloseTo(1);
  });

  it("maps depth to 0..1 range (WebGPU convention)", () => {
    const m = orthographic(-10, 10, -10, 10, 0, 100);
    const [, , zNear] = transformPoint(m, 0, 0, 0);
    expect(zNear).toBeCloseTo(0);
    // Far plane (z=-100) → NDC z = 1 (looking down -Z)
    const [, , zFar] = transformPoint(m, 0, 0, -100);
    expect(zFar).toBeCloseTo(1);
  });
});

describe("Camera", () => {
  it("creates a view-projection matrix", () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 1000);
    const vp = cam.viewProjection;
    expect(vp.length).toBe(16);
    expect(vp.some((v) => v !== 0)).toBe(true);
  });

  it("position offsets the view", () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 1000);
    cam.setPosition(5, 0, 0);
    const vp = cam.viewProjection;
    // A point at world (5, 0, 0) should map to screen center
    const [x] = transformPoint(vp, 5, 0, 0);
    expect(x).toBeCloseTo(0);
  });
});

import { describe, it, expect } from "vitest";
import { orthographic, Camera, extractFrustumPlanes, isPointInFrustum, isSphereInFrustum } from "./camera";

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

describe("extractFrustumPlanes", () => {
  it("extracts 6 planes from an orthographic VP matrix", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const vp = camera.viewProjection;
    const planes = extractFrustumPlanes(vp);
    expect(planes.length).toBe(24);
  });

  it("classifies a point inside the frustum as visible", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);
    const visible = isPointInFrustum(planes, 0, 0, -50);
    expect(visible).toBe(true);
  });

  it("classifies a point outside the frustum as not visible", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);
    const visible = isPointInFrustum(planes, 100, 0, -50);
    expect(visible).toBe(false);
  });

  it("classifies a sphere partially inside as visible", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);
    // Sphere at x=10.3, radius=0.5 — center is just outside right plane (10.0),
    // but sphere overlaps. Should be visible.
    const visible = isSphereInFrustum(planes, 10.3, 0, -50, 0.5);
    expect(visible).toBe(true);
  });

  it("classifies a sphere fully outside as not visible", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);
    // Sphere at x=20, radius=0.5 — fully outside right plane (10.0)
    const visible = isSphereInFrustum(planes, 20, 0, -50, 0.5);
    expect(visible).toBe(false);
  });
});

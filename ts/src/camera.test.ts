import { describe, it, expect } from "vitest";
import { orthographic, Camera, extractFrustumPlanes, isPointInFrustum, isSphereInFrustum, mat4Inverse, mat4Multiply } from "./camera";

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

describe('mat4Inverse', () => {
  it('inverse of identity is identity', () => {
    const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const inv = mat4Inverse(I);
    expect(inv).not.toBeNull();
    for (let i = 0; i < 16; i++) {
      expect(inv![i]).toBeCloseTo(I[i], 5);
    }
  });

  it('inverse of VP times VP ≈ identity', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(3, 7, 0);
    const vp = cam.viewProjection;
    const inv = mat4Inverse(vp)!;
    const result = mat4Multiply(inv, vp);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        const expected = col === row ? 1 : 0;
        expect(result[col * 4 + row]).toBeCloseTo(expected, 4);
      }
    }
  });

  it('returns null for singular matrix', () => {
    // All-zeros matrix is singular
    const singular = new Float32Array(16);
    expect(mat4Inverse(singular)).toBeNull();
  });

  it('inverse of translation matrix restores original point', () => {
    // Translation matrix: translate by (5, 3, -2)
    const T = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 5,3,-2,1]);
    const inv = mat4Inverse(T)!;
    expect(inv).not.toBeNull();
    // inv should be translation by (-5, -3, 2)
    expect(inv[12]).toBeCloseTo(-5, 5);
    expect(inv[13]).toBeCloseTo(-3, 5);
    expect(inv[14]).toBeCloseTo(2, 5);
  });
});

describe('screenToRay', () => {
  it('center pixel produces ray at world origin for centered camera', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);
    const ray = cam.screenToRay(400, 300, 800, 600);
    expect(ray.origin[0]).toBeCloseTo(0, 2);
    expect(ray.origin[1]).toBeCloseTo(0, 2);
    expect(ray.direction[0]).toBeCloseTo(0, 2);
    expect(ray.direction[1]).toBeCloseTo(0, 2);
    expect(ray.direction[2]).toBeCloseTo(-1, 2);
  });

  it('top-left pixel produces ray at negative world coords', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);
    const ray = cam.screenToRay(0, 0, 800, 600);
    expect(ray.origin[0]).toBeCloseTo(-10, 1);
    expect(ray.origin[1]).toBeCloseTo(10, 1);
  });

  it('accounts for camera position offset', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(5, 3, 0);
    const ray = cam.screenToRay(400, 300, 800, 600);
    expect(ray.origin[0]).toBeCloseTo(5, 2);
    expect(ray.origin[1]).toBeCloseTo(3, 2);
  });

  it('bottom-right pixel produces ray at positive world coords', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);
    const ray = cam.screenToRay(800, 600, 800, 600);
    expect(ray.origin[0]).toBeCloseTo(10, 1);
    expect(ray.origin[1]).toBeCloseTo(-10, 1);
  });

  it('ray direction is always -Z for orthographic camera', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);
    // Test multiple pixel positions — all should produce -Z direction
    for (const [px, py] of [[0, 0], [400, 300], [800, 600], [200, 100]]) {
      const ray = cam.screenToRay(px, py, 800, 600);
      expect(ray.direction[0]).toBeCloseTo(0, 2);
      expect(ray.direction[1]).toBeCloseTo(0, 2);
      expect(ray.direction[2]).toBeCloseTo(-1, 2);
    }
  });
});

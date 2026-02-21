import { describe, it, expect } from 'vitest';
import { hitTestRay } from './hit-tester';
import { Camera } from './camera';

describe('input → picking integration', () => {
  it('click at entity position returns correct entityId', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);

    // Entity at world (3, 4, 0) with radius 1
    const bounds = new Float32Array([3, 4, 0, 1]);
    const entityIds = new Uint32Array([99]);

    // Pixel that maps to world (3, 4):
    // NDC x = 3/10 = 0.3  → px = (0.3+1)/2 * 800 = 520
    // NDC y = 4/10 = 0.4  → py = (1-0.4)/2 * 600 = 180
    const ray = cam.screenToRay(520, 180, 800, 600);
    const result = hitTestRay(ray, bounds, entityIds);
    expect(result).toBe(99);
  });

  it('click at empty area returns null', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);

    const bounds = new Float32Array([3, 4, 0, 1]);
    const entityIds = new Uint32Array([99]);

    // Click far from entity (top-left corner → world -10, 10)
    const ray = cam.screenToRay(0, 0, 800, 600);
    const result = hitTestRay(ray, bounds, entityIds);
    expect(result).toBeNull();
  });

  it('2.5D: picks frontmost entity when multiple overlap on screen', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);

    // Two entities at same XY but different Z depths.
    // Camera looks down -Z, so closer = less negative Z.
    const bounds = new Float32Array([
      0, 0, -10, 2, // entity A: further from camera (z=-10)
      0, 0, -2, 2,  // entity B: closer to camera (z=-2)
    ]);
    const entityIds = new Uint32Array([10, 20]);

    const ray = cam.screenToRay(400, 300, 800, 600); // center
    const result = hitTestRay(ray, bounds, entityIds);
    // B is closer (ray from near plane hits z=-2 before z=-10)
    expect(result).toBe(20);
  });
});

import { describe, it, expect } from 'vitest';
import { CameraAPI } from './camera-api';
import { Camera } from './camera';

describe('CameraAPI', () => {
  it('wraps Camera.setPosition', () => {
    const cam = new Camera();
    const api = new CameraAPI(cam);
    api.position(10, 20);
    const vp = cam.viewProjection;
    expect(vp).toBeTruthy();
  });

  it('zoom adjusts orthographic width/height', () => {
    const cam = new Camera();
    const api = new CameraAPI(cam);
    api.setOrthographic(800, 600);
    api.zoom(2.0);
    expect(api.zoomLevel).toBe(2.0);
  });

  it('zoom clamps to positive values', () => {
    const cam = new Camera();
    const api = new CameraAPI(cam);
    api.setOrthographic(800, 600);
    api.zoom(0);
    expect(api.zoomLevel).toBe(0.01);
    api.zoom(-5);
    expect(api.zoomLevel).toBe(0.01);
  });
});

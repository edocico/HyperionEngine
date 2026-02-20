import { Camera } from './camera';

export class CameraAPI {
  private readonly cam: Camera;
  private _zoom = 1.0;
  private _width = 0;
  private _height = 0;

  constructor(cam: Camera) {
    this.cam = cam;
  }

  get zoomLevel(): number {
    return this._zoom;
  }

  position(x: number, y: number, z = 0): void {
    this.cam.setPosition(x, y, z);
  }

  setOrthographic(width: number, height: number, near = 0.1, far = 1000): void {
    this._width = width;
    this._height = height;
    this.applyProjection(near, far);
  }

  zoom(level: number): void {
    this._zoom = Math.max(0.01, level);
    this.applyProjection();
  }

  get viewProjection(): Float32Array {
    return this.cam.viewProjection;
  }

  private applyProjection(near = 0.1, far = 1000): void {
    if (this._width === 0 || this._height === 0) return;
    const w = this._width / this._zoom;
    const h = this._height / this._zoom;
    this.cam.setOrthographic(w, h, near, far);
  }
}

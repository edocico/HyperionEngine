/**
 * Orthographic projection matrix (column-major, WebGPU depth 0..1).
 *
 * Maps world coordinates to clip space:
 * - X: left..right → -1..1
 * - Y: bottom..top → -1..1
 * - Z: -near..-far → 0..1  (looking down -Z)
 */
export function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number
): Float32Array {
  const lr = 1 / (right - left);
  const bt = 1 / (top - bottom);
  const nf = 1 / (far - near);

  // Column-major 4x4
  return new Float32Array([
    2 * lr,       0,            0,            0, // col 0
    0,            2 * bt,       0,            0, // col 1
    0,            0,            -nf,          0, // col 2
    -(right + left) * lr,
    -(top + bottom) * bt,
    -near * nf,
    1,                                           // col 3
  ]);
}

/** Multiply two 4x4 column-major matrices: result = a * b. */
function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** Simple orthographic camera. */
export class Camera {
  private projection: Float32Array = new Float32Array(16);
  private view: Float32Array = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  private _viewProjection: Float32Array = new Float32Array(16);
  private dirty = true;

  /** Set orthographic projection. width and height are world units visible. */
  setOrthographic(
    width: number,
    height: number,
    near: number,
    far: number
  ): void {
    const hw = width / 2;
    const hh = height / 2;
    this.projection = orthographic(-hw, hw, -hh, hh, near, far);
    this.dirty = true;
  }

  /** Set camera world position (view translates inversely). */
  setPosition(x: number, y: number, z: number): void {
    this.view = new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1,
    ]);
    this.dirty = true;
  }

  /** Get the combined view-projection matrix (column-major Float32Array). */
  get viewProjection(): Float32Array {
    if (this.dirty) {
      this._viewProjection = mat4Multiply(this.projection, this.view);
      this.dirty = false;
    }
    return this._viewProjection;
  }
}

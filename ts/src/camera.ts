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

/**
 * Extract 6 frustum planes from a column-major view-projection matrix.
 * Returns a Float32Array of 24 floats (6 planes x vec4).
 * Each plane: (a, b, c, d) where ax + by + cz + d >= 0 is inside.
 * Planes are normalized (|abc| = 1) for correct distance calculations.
 *
 * Plane order: Left, Right, Bottom, Top, Near, Far.
 *
 * Uses the Gribb & Hartmann (2001) extraction method for column-major matrices.
 * Near plane uses WebGPU depth [0,1] convention (row2 only, not row3+row2).
 */
export function extractFrustumPlanes(vp: Float32Array): Float32Array {
  const planes = new Float32Array(24);
  const m = vp;

  // Left: row3 + row0
  planes[0]  = m[3]  + m[0];  planes[1]  = m[7]  + m[4];
  planes[2]  = m[11] + m[8];  planes[3]  = m[15] + m[12];

  // Right: row3 - row0
  planes[4]  = m[3]  - m[0];  planes[5]  = m[7]  - m[4];
  planes[6]  = m[11] - m[8];  planes[7]  = m[15] - m[12];

  // Bottom: row3 + row1
  planes[8]  = m[3]  + m[1];  planes[9]  = m[7]  + m[5];
  planes[10] = m[11] + m[9];  planes[11] = m[15] + m[13];

  // Top: row3 - row1
  planes[12] = m[3]  - m[1];  planes[13] = m[7]  - m[5];
  planes[14] = m[11] - m[9];  planes[15] = m[15] - m[13];

  // Near: row2 (WebGPU depth [0,1])
  planes[16] = m[2];   planes[17] = m[6];
  planes[18] = m[10];  planes[19] = m[14];

  // Far: row3 - row2
  planes[20] = m[3]  - m[2];  planes[21] = m[7]  - m[6];
  planes[22] = m[11] - m[10]; planes[23] = m[15] - m[14];

  // Normalize each plane so |abc| = 1
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const len = Math.sqrt(
      planes[offset] * planes[offset] +
      planes[offset + 1] * planes[offset + 1] +
      planes[offset + 2] * planes[offset + 2]
    );
    if (len > 0) {
      planes[offset]     /= len;
      planes[offset + 1] /= len;
      planes[offset + 2] /= len;
      planes[offset + 3] /= len;
    }
  }

  return planes;
}

/**
 * Test if a point is inside all 6 frustum planes.
 * @param planes 24-float array from extractFrustumPlanes
 */
export function isPointInFrustum(
  planes: Float32Array, x: number, y: number, z: number
): boolean {
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const dist = planes[offset] * x + planes[offset + 1] * y +
                 planes[offset + 2] * z + planes[offset + 3];
    if (dist < 0) return false;
  }
  return true;
}

/**
 * Test if a bounding sphere intersects the frustum.
 * Returns true if any part of the sphere is inside.
 * @param planes 24-float array from extractFrustumPlanes
 */
export function isSphereInFrustum(
  planes: Float32Array, cx: number, cy: number, cz: number, radius: number
): boolean {
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const dist = planes[offset] * cx + planes[offset + 1] * cy +
                 planes[offset + 2] * cz + planes[offset + 3];
    if (dist < -radius) return false;
  }
  return true;
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

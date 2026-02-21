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
export function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
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
 * Compute the inverse of a 4x4 column-major matrix using cofactor expansion.
 * Returns a new Float32Array, or null if the matrix is singular.
 *
 * This is a general-purpose inverse (NOT an orthographic shortcut) — forward-
 * compatible with perspective cameras for future 3D support.
 */
export function mat4Inverse(m: Float32Array): Float32Array | null {
  const m00 = m[0],  m01 = m[1],  m02 = m[2],  m03 = m[3];
  const m10 = m[4],  m11 = m[5],  m12 = m[6],  m13 = m[7];
  const m20 = m[8],  m21 = m[9],  m22 = m[10], m23 = m[11];
  const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

  // 2x2 sub-determinants (reused across cofactors)
  const s0 = m00 * m11 - m10 * m01;
  const s1 = m00 * m12 - m10 * m02;
  const s2 = m00 * m13 - m10 * m03;
  const s3 = m01 * m12 - m11 * m02;
  const s4 = m01 * m13 - m11 * m03;
  const s5 = m02 * m13 - m12 * m03;

  const c5 = m22 * m33 - m32 * m23;
  const c4 = m21 * m33 - m31 * m23;
  const c3 = m21 * m32 - m31 * m22;
  const c2 = m20 * m33 - m30 * m23;
  const c1 = m20 * m32 - m30 * m22;
  const c0 = m20 * m31 - m30 * m21;

  const det = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;

  if (Math.abs(det) < 1e-10) {
    return null;
  }

  const invDet = 1.0 / det;

  return new Float32Array([
    ( m11 * c5 - m12 * c4 + m13 * c3) * invDet,  // [0]
    (-m01 * c5 + m02 * c4 - m03 * c3) * invDet,  // [1]
    ( m31 * s5 - m32 * s4 + m33 * s3) * invDet,  // [2]
    (-m21 * s5 + m22 * s4 - m23 * s3) * invDet,  // [3]

    (-m10 * c5 + m12 * c2 - m13 * c1) * invDet,  // [4]
    ( m00 * c5 - m02 * c2 + m03 * c1) * invDet,  // [5]
    (-m30 * s5 + m32 * s2 - m33 * s1) * invDet,  // [6]
    ( m20 * s5 - m22 * s2 + m23 * s1) * invDet,  // [7]

    ( m10 * c4 - m11 * c2 + m13 * c0) * invDet,  // [8]
    (-m00 * c4 + m01 * c2 - m03 * c0) * invDet,  // [9]
    ( m30 * s4 - m31 * s2 + m33 * s0) * invDet,  // [10]
    (-m20 * s4 + m21 * s2 - m23 * s0) * invDet,  // [11]

    (-m10 * c3 + m11 * c1 - m12 * c0) * invDet,  // [12]
    ( m00 * c3 - m01 * c1 + m02 * c0) * invDet,  // [13]
    (-m30 * s3 + m31 * s1 - m32 * s0) * invDet,  // [14]
    ( m20 * s3 - m21 * s1 + m22 * s0) * invDet,  // [15]
  ]);
}

/** A ray in 3D world space. */
export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number];
}

/**
 * Transform a point (x, y, z, 1) by a 4x4 column-major matrix,
 * performing the perspective divide by w.
 */
function transformPoint(
  m: Float32Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8]  * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9]  * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
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

  /**
   * Unproject a screen pixel into a world-space ray.
   *
   * Converts pixel coords to NDC, computes the inverse VP matrix, and
   * unprojects two NDC points (near z=0, far z=1) to produce a ray.
   *
   * Works with both orthographic (parallel rays) and perspective cameras
   * (diverging rays from eye point).
   *
   * @param pixelX   Horizontal pixel coordinate (0 = left edge)
   * @param pixelY   Vertical pixel coordinate (0 = top edge)
   * @param canvasWidth  Canvas width in pixels
   * @param canvasHeight Canvas height in pixels
   * @returns A Ray with origin on the near plane and normalized direction
   */
  screenToRay(
    pixelX: number,
    pixelY: number,
    canvasWidth: number,
    canvasHeight: number,
  ): Ray {
    // Pixel coords → NDC.  Y is flipped (screen Y-down, NDC Y-up).
    const ndcX =  (pixelX / canvasWidth)  * 2 - 1;
    const ndcY = -((pixelY / canvasHeight) * 2 - 1);

    // Inverse view-projection
    const invVP = mat4Inverse(this.viewProjection);
    if (invVP === null) {
      // Degenerate camera — return a default forward ray
      return { origin: [0, 0, 0], direction: [0, 0, -1] };
    }

    // Unproject near (z=0) and far (z=1) NDC points — WebGPU depth range [0,1]
    const near = transformPoint(invVP, ndcX, ndcY, 0);
    const far  = transformPoint(invVP, ndcX, ndcY, 1);

    // Direction = normalized(far - near)
    const dx = far[0] - near[0];
    const dy = far[1] - near[1];
    const dz = far[2] - near[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const invLen = len > 0 ? 1 / len : 0;

    return {
      origin: near,
      direction: [dx * invLen, dy * invLen, dz * invLen],
    };
  }
}

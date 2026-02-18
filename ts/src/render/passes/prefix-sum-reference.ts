/** Exclusive prefix sum (Blelloch scan, CPU reference implementation).
 *  Handles arbitrary input sizes by padding to the next power of 2. */
export function exclusiveScanCPU(input: number[]): number[] {
  const n = input.length;
  if (n === 0) return [];

  // Pad to next power of 2 for correct Blelloch operation
  let padded = n;
  if ((padded & (padded - 1)) !== 0) {
    padded = 1;
    while (padded < n) padded <<= 1;
  }

  const buf = new Array(padded).fill(0);
  for (let i = 0; i < n; i++) buf[i] = input[i];

  // Up-sweep (reduce)
  for (let d = 1; d < padded; d *= 2) {
    for (let i = padded - 1; i >= d; i -= d * 2) {
      buf[i] += buf[i - d];
    }
  }

  // Set last to 0 (exclusive scan)
  buf[padded - 1] = 0;

  // Down-sweep
  for (let d = padded >> 1; d >= 1; d >>= 1) {
    for (let i = padded - 1; i >= d; i -= d * 2) {
      const t = buf[i - d];
      buf[i - d] = buf[i];
      buf[i] += t;
    }
  }

  return buf.slice(0, n);
}

/** Exclusive prefix sum (Blelloch scan, CPU reference implementation) */
export function exclusiveScanCPU(input: number[]): number[] {
  const n = input.length;
  const output = new Array(n).fill(0);
  if (n === 0) return output;

  // Copy input
  for (let i = 0; i < n; i++) output[i] = input[i];

  // Up-sweep (reduce)
  for (let d = 1; d < n; d *= 2) {
    for (let i = n - 1; i >= d; i -= d * 2) {
      output[i] += output[i - d];
    }
  }

  // Set last to 0 (exclusive scan)
  output[n - 1] = 0;

  // Down-sweep
  for (let d = Math.floor(n / 2); d >= 1; d = Math.floor(d / 2)) {
    for (let i = n - 1; i >= d; i -= d * 2) {
      const t = output[i - d];
      output[i - d] = output[i];
      output[i] += t;
    }
  }

  return output;
}

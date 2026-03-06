import { describe, it, expect } from 'vitest';
import { exclusiveScanCPU, exclusiveScanSubgroupSimCPU } from './prefix-sum-reference';

describe('Prefix sum reference implementation', () => {
  it('should compute exclusive scan for simple input', () => {
    const visibility = [0, 1, 1, 0, 1, 0, 1, 1];
    const result = exclusiveScanCPU(visibility);
    expect(result).toEqual([0, 0, 1, 2, 2, 3, 3, 4]);
  });

  it('should handle all-visible', () => {
    const visibility = [1, 1, 1, 1];
    const result = exclusiveScanCPU(visibility);
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('should handle all-invisible', () => {
    const visibility = [0, 0, 0, 0];
    const result = exclusiveScanCPU(visibility);
    expect(result).toEqual([0, 0, 0, 0]);
  });

  it('should handle single element', () => {
    expect(exclusiveScanCPU([1])).toEqual([0]);
    expect(exclusiveScanCPU([0])).toEqual([0]);
  });

  it('should handle non-power-of-2 sizes', () => {
    expect(exclusiveScanCPU([1, 1, 1])).toEqual([0, 1, 2]);
    expect(exclusiveScanCPU([1, 0, 1, 0, 1])).toEqual([0, 1, 1, 2, 2]);
    expect(exclusiveScanCPU([0, 1, 1, 0, 1, 0, 1])).toEqual([0, 0, 1, 2, 2, 3, 3]);
  });

  it('should produce correct compacted indices', () => {
    const visibility = [0, 1, 1, 0, 1, 0, 1, 1];
    const scan = exclusiveScanCPU(visibility);
    const compacted: number[] = [];
    for (let i = 0; i < visibility.length; i++) {
      if (visibility[i] === 1) {
        compacted[scan[i]] = i;
      }
    }
    expect(compacted).toEqual([1, 2, 4, 6, 7]);
  });
});

describe('Subgroup-simulated prefix sum', () => {
  it('produces same result as Blelloch for simple input (sgSize=4)', () => {
    const input = [0, 1, 1, 0, 1, 0, 1, 1];
    const blelloch = exclusiveScanCPU(input);
    const subgroup = exclusiveScanSubgroupSimCPU(input, 4);
    expect(subgroup).toEqual(blelloch);
  });

  it('produces same result for all-visible (sgSize=32)', () => {
    const input = new Array(64).fill(1);
    expect(exclusiveScanSubgroupSimCPU(input, 32)).toEqual(exclusiveScanCPU(input));
  });

  it('produces same result for sparse visibility (sgSize=32)', () => {
    const input = new Array(256).fill(0);
    for (let i = 0; i < 256; i += 7) input[i] = 1;
    expect(exclusiveScanSubgroupSimCPU(input, 32)).toEqual(exclusiveScanCPU(input));
  });

  it('produces correct compacted indices (sgSize=8)', () => {
    const visibility = [0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0];
    const scan = exclusiveScanSubgroupSimCPU(visibility, 8);
    const compacted: number[] = [];
    for (let i = 0; i < visibility.length; i++) {
      if (visibility[i] === 1) compacted[scan[i]] = i;
    }
    expect(compacted).toEqual([1, 2, 4, 6, 7, 10]);
  });
});

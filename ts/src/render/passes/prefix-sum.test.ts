import { describe, it, expect } from 'vitest';
import { exclusiveScanCPU } from './prefix-sum-reference';

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

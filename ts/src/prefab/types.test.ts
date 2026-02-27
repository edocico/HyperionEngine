import { describe, it, expect } from 'vitest';
import { validateTemplate } from './types';
import type { PrefabTemplate } from './types';

describe('validateTemplate', () => {
  it('accepts minimal template with root only', () => {
    const t: PrefabTemplate = { root: {} };
    expect(() => validateTemplate(t)).not.toThrow();
  });

  it('accepts template with children', () => {
    const t: PrefabTemplate = {
      root: { position: [0, 0, 0] },
      children: {
        turret: { position: [1, 2, 3], scale: 0.5 },
        shield: { rotation: Math.PI / 4 },
      },
    };
    expect(() => validateTemplate(t)).not.toThrow();
  });

  it('rejects template without root', () => {
    expect(() => validateTemplate({} as PrefabTemplate)).toThrow('must have a root node');
    expect(() => validateTemplate(null as any)).toThrow('must have a root node');
  });

  it('rejects scale array with wrong length', () => {
    const t: PrefabTemplate = { root: { scale: [1, 2] as any } };
    expect(() => validateTemplate(t)).toThrow('root.scale must be a number or [sx, sy, sz]');
  });

  it('accepts numeric scale (uniform)', () => {
    const t: PrefabTemplate = { root: { scale: 2.5 } };
    expect(() => validateTemplate(t)).not.toThrow();
  });

  it('accepts 3-element scale array', () => {
    const t: PrefabTemplate = { root: { scale: [1, 2, 3] } };
    expect(() => validateTemplate(t)).not.toThrow();
  });
});

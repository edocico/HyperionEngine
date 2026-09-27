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
    const t: PrefabTemplate = { root: { scale: [1, 2, 3, 4] as any } };
    expect(() => validateTemplate(t)).toThrow('root.scale must be a number, [sx, sy] or [sx, sy, sz]');
  });

  it('z is optional: 2-element position, velocity and scale are accepted', () => {
    const t: PrefabTemplate = { root: { position: [1, 2], velocity: [3, 4], scale: [2, 2] } };
    expect(() => validateTemplate(t)).not.toThrow();
    expect(() => validateTemplate({ root: { position: [1] as any } })).toThrow('root.position must be [x, y] or [x, y, z]');
  });

  it('accepts mode 2d and 3d, rejects anything else', () => {
    expect(() => validateTemplate({ mode: '2d', root: {} })).not.toThrow();
    expect(() => validateTemplate({ mode: '3d', root: {} })).not.toThrow();
    expect(() => validateTemplate({ mode: '4d' as never, root: {} })).toThrow(/mode/);
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

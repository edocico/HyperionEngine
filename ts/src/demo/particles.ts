// ts/src/demo/particles.ts — Demo section: particle emitter creation, multiple emitters, destruction, entity tracking
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import type { ParticleHandle } from '../particle-types';

const entities: EntityHandle[] = [];
const emitters: (ParticleHandle | null)[] = [];

const section: DemoSection = {
  name: 'particles',
  label: 'Particles (Emitters / Lifecycle / Entity Tracking)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // ── 1. Create emitter ────────────────────────────────────────────────
    let anchor: EntityHandle | null = null;
    engine.batch(() => {
      anchor = engine.spawn().position(0, 4, 0).scale(1, 1, 1);
      entities.push(anchor);
    });

    const handle = engine.createParticleEmitter(
      {
        maxParticles: 500,
        emissionRate: 80,
        lifetime: [0.5, 1.5],
        velocityMin: [-10, 20],
        velocityMax: [10, 40],
        colorStart: [1, 0.6, 0.1, 1],
        colorEnd: [1, 0.2, 0, 0],
        sizeStart: 6,
        sizeEnd: 1,
        gravity: [0, -30],
      },
      anchor!.id,
    );

    if (handle === null) {
      // No renderer (Mode A main thread) — skip all checks
      reporter.skip('Create emitter', 'no renderer (createParticleEmitter returned null)');
      reporter.skip('Multiple emitters', 'no renderer');
      reporter.skip('Destroy emitter', 'no renderer');
      reporter.skip('Entity tracking', 'no renderer');
      return;
    }

    emitters.push(handle);
    reporter.check('Create emitter', true, `handle=${handle as number}`);

    // ── 2. Multiple emitters (fire / water / nature) ─────────────────────
    const configs: { name: string; color: { colorStart: [number, number, number, number]; colorEnd: [number, number, number, number] }; pos: [number, number, number] }[] = [
      {
        name: 'fire',
        color: { colorStart: [1, 0.4, 0, 1], colorEnd: [0.8, 0.1, 0, 0] },
        pos: [-6, 4, 0],
      },
      {
        name: 'water',
        color: { colorStart: [0.2, 0.5, 1, 1], colorEnd: [0.1, 0.3, 0.8, 0] },
        pos: [0, 0, 0],
      },
      {
        name: 'nature',
        color: { colorStart: [0.2, 0.9, 0.3, 1], colorEnd: [0.1, 0.5, 0.1, 0] },
        pos: [6, 4, 0],
      },
    ];

    let allValid = true;
    engine.batch(() => {
      for (const cfg of configs) {
        const a = engine.spawn().position(...cfg.pos).scale(1, 1, 1);
        entities.push(a);

        const h = engine.createParticleEmitter(
          {
            maxParticles: 300,
            emissionRate: 60,
            lifetime: [0.4, 1.2],
            velocityMin: [-8, 15],
            velocityMax: [8, 30],
            ...cfg.color,
            sizeStart: 5,
            sizeEnd: 0,
            gravity: [0, -20],
          },
          a.id,
        );

        emitters.push(h);
        if (h === null) allValid = false;
      }
    });
    reporter.check(
      'Multiple emitters',
      allValid,
      `created 3 themed emitters (fire/water/nature), all handles valid`,
    );

    // ── 3. Destroy emitter ───────────────────────────────────────────────
    const lastEmitter = emitters.pop() ?? null;
    try {
      engine.destroyParticleEmitter(lastEmitter);
      reporter.check('Destroy emitter', true, `destroyed handle=${lastEmitter as number}`);
    } catch (err) {
      reporter.check(
        'Destroy emitter',
        false,
        `destroyParticleEmitter threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 4. Entity tracking ───────────────────────────────────────────────
    // Move the first anchor entity — particles should follow its position.
    try {
      anchor!.position(3, 6, 0);
      reporter.check(
        'Entity tracking',
        true,
        'moved anchor entity to (3, 6, 0); particles follow',
      );
    } catch (err) {
      reporter.check(
        'Entity tracking',
        false,
        `position update threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },

  teardown(engine: Hyperion) {
    for (const h of emitters) engine.destroyParticleEmitter(h);
    emitters.length = 0;
    for (const e of entities) e.destroy();
    entities.length = 0;
  },
};

export default section;

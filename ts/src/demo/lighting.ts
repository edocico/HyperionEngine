// ts/src/demo/lighting.ts — Demo section: 2D lighting (Phase 17, backend 'lit')
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import type { HookFn } from '../game-loop';

const entities: EntityHandle[] = [];
const hooks: HookFn[] = [];
let panel: HTMLElement | null = null;

/** Resolves after `frames` animation frames: long enough for a command to reach WASM and come back. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}

/**
 * A small DOM panel over the canvas: shadow strength of the moving lights,
 * and lighting on/off for an A/B comparison. Removed in teardown.
 */
function buildPanel(onShadow: (v: number) => void, onLit: (on: boolean) => void): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:16px;bottom:40px;z-index:10;padding:8px 12px;'
    + 'background:rgba(0,0,0,0.7);color:#ddd;font:12px monospace;border-radius:4px;display:grid;gap:6px';
  const shadowLabel = document.createElement('label');
  shadowLabel.textContent = 'shadow intensity ';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.05';
  slider.value = '1';
  slider.addEventListener('input', () => onShadow(Number(slider.value)));
  shadowLabel.appendChild(slider);
  const litLabel = document.createElement('label');
  const lit = document.createElement('input');
  lit.type = 'checkbox';
  lit.checked = true;
  lit.addEventListener('change', () => onLit(lit.checked));
  litLabel.append(lit, ' lighting (backend lit)');
  el.append(shadowLabel, litLabel);
  document.body.appendChild(el);
  return el;
}

const section: DemoSection = {
  name: 'lighting',
  label: 'Lighting (point / spot / global, shadows, lit vs unlit)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    const lighting = engine.lighting;

    // ── Scene ──────────────────────────────────────────────────────────
    // A white floor that receives light shows the light buffer itself: the
    // ambient where no light reaches, each light's falloff, the shadows.
    let point!: EntityHandle;
    let spot!: EntityHandle;
    let global!: EntityHandle;
    engine.batch(() => {
      entities.push(engine.spawn().position(0, 0, -0.5).scale(40, 18, 1).receivesLight(true));

      // Occluders: two walls and a pillar. Unlit, so they read as solid shapes.
      // The pillar shadows layer 0 only, so layer 1 gets an SDF set of its own
      // (the "Light layers" check). No layer-1 light has it in the way of the
      // layer-1 sprite: the per-layer shadow itself is not on screen here.
      entities.push(engine.spawn().position(-3, 2.5, 0).scale(0.8, 5, 1).castsShadow(true));
      entities.push(engine.spawn().position(4, -3, 0).scale(6, 0.8, 1).castsShadow(true));
      entities.push(engine.spawn().position(9, 3, 0).scale(1.5, 1.5, 1).castsShadow(true).lightLayers(0b01));

      // Light layers: a sprite on layer 1, and a blue light for layer 1 only.
      // The blue light leaves the floor (layer 0) untouched.
      entities.push(engine.spawn().position(16, 4, 0).scale(3, 3, 1)
        .gradient(1, 0, [0, 0.9, 0.9, 0.9, 1, 0.5]).receivesLight(true).lightLayers(0b10));
      entities.push(engine.spawn().position(12, 5, 0)
        .light({ type: 'point', color: '#5577ff', energy: 2, range: 9, shadowIntensity: 1, layers: 0b10 }));

      // Lit vs unlit: the same gradient twice, inside the same light.
      entities.push(engine.spawn().position(-12, 3, 0).scale(4, 2.5, 1)
        .gradient(0, 0, [0, 1, 0.3, 0.1, 1, 0.2]).receivesLight(true));
      entities.push(engine.spawn().position(-12, -3, 0).scale(4, 2.5, 1)
        .gradient(0, 0, [0, 1, 0.3, 0.1, 1, 0.2]));

      point = engine.spawn().position(-7, 0, 0)
        .light({ type: 'point', color: '#ffcc88', energy: 1.4, range: 12, falloff: 1.2, shadowIntensity: 1 });
      spot = engine.spawn().position(12, -6, 0).rotation(2.3)
        .light({ type: 'spot', color: '#88bbff', energy: 1.6, range: 18, innerAngle: 18, outerAngle: 30, shadowIntensity: 1 });
      // A weak global light, placed off-screen on purpose: it must never be culled.
      global = engine.spawn().position(500, 500, 0)
        .light({ type: 'global', color: [0.25, 0.2, 0.35], energy: 0.5 });
      entities.push(point, spot, global);
    });
    reporter.check('Scene', true, '1 lit floor, 3 shadow casters, lit + unlit gradient, point/spot/global light, a layer-1 sprite and light');

    // ── 1. Backend 'lit', read back from WASM ─────────────────────────
    lighting.setAmbient([0.06, 0.07, 0.12], 1);
    lighting.setBackend('lit');
    reporter.pending('Backend lit');
    await frames(3);
    reporter.check('Backend lit', lighting.backend === 'lit', `engine reports '${lighting.backend}'`);

    // ── 2. Ambient round-trip ──────────────────────────────────────────
    const [ar, ag, ab, ai] = lighting.ambient;
    const ambientOk = Math.abs(ar - 0.06) < 1e-6 && Math.abs(ag - 0.07) < 1e-6 && Math.abs(ab - 0.12) < 1e-6 && ai === 1;
    reporter.check('Ambient', ambientOk, `[${[ar, ag, ab, ai].map((v) => v.toFixed(3)).join(', ')}]`);

    // ── 3. Quality ─────────────────────────────────────────────────────
    try {
      lighting.setQuality({ shadowSteps: 48 });
      reporter.check('Quality', true, 'shadowSteps 48 handed to the renderer on the next frame');
    } catch (err) {
      reporter.check('Quality', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── 4. Light layers ────────────────────────────────────────────────
    // Layer 0 (floor, gradients) and layer 1 (the sprite) differ in their
    // lights (the blue one) and their casters (the pillar): two light groups,
    // two SDF sets.
    const groups = lighting.groups;
    reporter.check(
      'Light layers',
      groups !== null && groups.groups.length === 2 && groups.sdfSets.length === 2,
      groups ? `${groups.groups.length} groups, ${groups.sdfSets.length} SDF sets` : 'no frame yet',
    );

    // ── Motion: the point light circles, the spot sweeps ──────────────
    let t = 0;
    const animate: HookFn = (dt) => {
      t += dt;
      point.position(-7 + Math.cos(t * 0.6) * 4, Math.sin(t * 0.6) * 4, 0);
      spot.rotation(2.3 + Math.sin(t * 0.4) * 0.5);
    };
    engine.addHook('preTick', animate);
    hooks.push(animate);

    panel = buildPanel(
      (v) => { point.shadows(v); spot.shadows(v); },
      (on) => lighting.setBackend(on ? 'lit' : 'off'),
    );
  },

  teardown(engine: Hyperion) {
    for (const fn of hooks) engine.removeHook('preTick', fn);
    hooks.length = 0;
    panel?.remove();
    panel = null;
    engine.lighting.setBackend('off');
    for (const e of entities) e.destroy();
    entities.length = 0;
  },
};

export default section;

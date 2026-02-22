import { Hyperion } from './hyperion';
import type { SoundHandle } from './audio-types';
import type { EntityHandle } from './entity-handle';
import type { ParticleHandle } from './particle-types';

async function main() {
  const overlay = document.getElementById('overlay')!;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  overlay.textContent = 'Hyperion Engine — initializing...';

  const engine = await Hyperion.create({ canvas });

  // Resize handler
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * dpr);
    const height = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      engine.resize(width, height);
    }
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // --- Bloom demo ---
  engine.enableBloom({ threshold: 0.6, intensity: 1.2 });

  // Spawn test entities: 50 inside frustum, 50 outside
  engine.batch(() => {
    for (let i = 0; i < 100; i++) {
      const e = engine.spawn();
      if (i < 50) {
        const col = i % 10;
        const row = Math.floor(i / 10);
        e.position((col - 4.5) * 2, (row - 2.5) * 2, 0);
      } else {
        const offset = i - 50;
        const x = offset < 25 ? -20 - offset : 20 + (offset - 25);
        e.position(x, 0, 0);
      }
    }
  });

  // Test lines
  for (let i = 0; i < 10; i++) {
    engine.spawn()
      .position(0, 0, 0)
      .scale(1, 1, 1)
      .line(-200 + i * 40, -100, -200 + i * 40, 100, 2);
  }

  // --- Bezier curve demo ---
  engine.spawn()
    .position(0, -6, 0)
    .scale(4, 2, 1)
    .bezier(0.0, 0.5, 0.5, 0.0, 1.0, 0.5, 0.03);

  engine.spawn()
    .position(5, -6, 0)
    .scale(3, 2, 1)
    .bezier(0.0, 0.0, 0.5, 1.0, 1.0, 0.0, 0.02);

  // --- Audio: load a click sound (file is optional; demo works silently if absent) ---
  let sfxHandle: SoundHandle | null = null;
  engine.audio.load('sfx/click.ogg').then(h => { sfxHandle = h; }).catch(() => {});

  // --- Particle state ---
  let particleHandle: ParticleHandle | null = null;
  let sparkleEntity: EntityHandle | null = null;

  // --- Input: click to select/deselect entities + play spatial sound + spawn particles ---
  engine.input.onClick((button, x, y) => {
    if (button !== 0) return;
    const entityId = engine.picking.hitTest(x, y);
    if (entityId !== null) {
      engine.selection?.toggle(entityId);
      if (sfxHandle !== null) {
        const worldX = (x / canvas.width - 0.5) * 20;
        const id = engine.audio.play(sfxHandle, { volume: 0.8 });
        if (id !== null) {
          engine.audio.setSoundPosition(id, worldX, 0);
        }
      }
    }

    // Spawn sparkle particles at click position (destroy previous first)
    if (particleHandle !== null) {
      engine.destroyParticleEmitter(particleHandle);
    }
    sparkleEntity?.destroy();
    sparkleEntity = engine.spawn().position(
      (x / canvas.width - 0.5) * 20 * (canvas.width / canvas.height),
      (0.5 - y / canvas.height) * 20,
      0
    );
    particleHandle = engine.createParticleEmitter({
      maxParticles: 200,
      emissionRate: 80,
      lifetime: [0.3, 1.0],
      velocityMin: [-3, -5],
      velocityMax: [3, -0.5],
      colorStart: [1, 0.8, 0.2, 1],
      colorEnd: [1, 0.2, 0, 0],
      sizeStart: 0.15,
      sizeEnd: 0,
      gravity: [0, 5],
    }, sparkleEntity.id);
  });

  // --- Input: WASD camera movement ---
  let camX = 0, camY = 0;
  engine.addHook('preTick', (dt) => {
    const speed = 15;
    let dx = 0, dy = 0;
    if (engine.input.isKeyDown('KeyW') || engine.input.isKeyDown('ArrowUp'))    dy += speed * dt;
    if (engine.input.isKeyDown('KeyS') || engine.input.isKeyDown('ArrowDown'))  dy -= speed * dt;
    if (engine.input.isKeyDown('KeyA') || engine.input.isKeyDown('ArrowLeft'))  dx -= speed * dt;
    if (engine.input.isKeyDown('KeyD') || engine.input.isKeyDown('ArrowRight')) dx += speed * dt;
    if (dx !== 0 || dy !== 0) {
      camX += dx;
      camY += dy;
      engine.cam.position(camX, camY, 0);
    }
  });

  // --- Input: scroll to zoom ---
  engine.input.onScroll((_dx, dy) => {
    const zoom = engine.cam.zoomLevel;
    engine.cam.zoom(zoom * (1 - dy * 0.001));
  });

  // Update overlay each frame
  engine.addHook('frameEnd', () => {
    const s = engine.stats;
    overlay.textContent =
      `Hyperion Engine — Phase 9\nMode: ${s.mode}\nFPS: ${s.fps}\nEntities: ${s.entityCount}\nWASD/Arrows: move | Scroll: zoom | Click: select+sound+particles\nFeatures: Bezier curves, Dual Kawase Bloom, GPU particles`;
  });

  engine.start();
}

main();

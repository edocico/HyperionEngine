import { Hyperion } from './hyperion';

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

  // --- Input: click to select/deselect entities ---
  engine.input.onClick((button, x, y) => {
    if (button !== 0) return;
    const entityId = engine.picking.hitTest(x, y);
    if (entityId !== null) {
      engine.selection?.toggle(entityId);
    }
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
      `Hyperion Engine\nMode: ${s.mode}\nFPS: ${s.fps}\nEntities: ${s.entityCount}\nWASD/Arrows: move | Scroll: zoom | Click: select`;
  });

  engine.start();
}

main();

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

  // Update overlay each frame
  engine.addHook('frameEnd', () => {
    const s = engine.stats;
    overlay.textContent =
      `Hyperion Engine\nMode: ${s.mode}\nFPS: ${s.fps}\nEntities: ${s.entityCount}`;
  });

  engine.start();
}

main();

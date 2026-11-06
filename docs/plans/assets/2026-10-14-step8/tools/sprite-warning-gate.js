async () => {
  // Round step 8, Task 9 Step 4b (leg 9e), the plan's step (3) verbatim: the
  // warning's pause while a texture load is in flight. Every fetch waits 2.5 s,
  // so the sprite light stays untextured (and listed) for more than a second of
  // lit frames while TextureManager.pendingLoads > 0: no warning may come.
  const engine = window.__hyperion;
  const fetch0 = window.fetch;
  window.fetch = async (...args) => { await new Promise((r) => setTimeout(r, 2500)); return fetch0(...args); };
  const png = new OffscreenCanvas(8, 8);
  const ctx = png.getContext('2d');
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, 8, 8);
  const url = URL.createObjectURL(await png.convertToBlob({ type: 'image/png' }));
  const hs = [];
  let light;
  engine.batch(() => {
    hs.push(engine.spawn().position(0, 0, -0.5).scale(40, 24, 1).receivesLight(true));
    light = engine.spawn({ mode: '2d' }).light({ type: 'sprite', range: 5 });
    hs.push(light);
  });
  engine.lighting.setBackend('lit');
  const t0 = performance.now();
  let frames = 0;
  let counting = true;
  const tick = () => { if (counting) { frames++; requestAnimationFrame(tick); } };
  requestAnimationFrame(tick);
  light.texture(await engine.loadTexture(url));
  const untexturedMs = performance.now() - t0;
  counting = false;
  window.fetch = fetch0;
  await new Promise((r) => setTimeout(r, 1500));
  const flagAtEnd = engine.lighting.groups?.untexturedSpriteLight ?? null;
  for (const h of hs) h.destroy();
  engine.lighting.setBackend('off');
  URL.revokeObjectURL(url);
  return { untexturedMs, frames, flagAtEnd };
}

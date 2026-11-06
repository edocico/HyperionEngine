async () => {
  // Round step 8, Task 9 Step 4b (leg 9e), the plan's step (1) verbatim: a lit
  // floor and one sprite light with no texture; the script times the
  // untextured-sprite warnings itself (Mode B), in ms since setBackend.
  const engine = window.__hyperion;
  const hs = [];
  engine.batch(() => {
    hs.push(engine.spawn().position(0, 0, -0.5).scale(40, 24, 1).receivesLight(true));
    hs.push(engine.spawn({ mode: '2d' }).light({ type: 'sprite', range: 5 }));
  });
  engine.lighting.setBackend('lit');
  // Mode B: the renderer warns on this thread, and seconds pass between a
  // step's return and list_console_messages (which gives no message time):
  // the script times the warnings itself, in ms since setBackend. Mode A's
  // render worker warns on its own console: these numbers say nothing there.
  const t0 = performance.now();
  const times = [];
  const warn0 = console.warn;
  console.warn = (...a) => {
    if (/^\[Hyperion\] (?:Sprite lights? |A sprite light )/.test(String(a[0]))) times.push(Math.round(performance.now() - t0));
    return warn0.apply(console, a);
  };
  window.__spriteWarnTimes = times;
  await new Promise((r) => setTimeout(r, 600));
  window.__spriteWarnHandles = hs;
  return { id: hs[1].id, untexturedSpriteLight: engine.lighting.groups?.untexturedSpriteLight ?? null, warnsBy600: times.length };
}

() => {
  // gpu-check: the map.json of scripts/pixels.py for the page as it is now
  // (SKILL.md §6, §7). Pass this file's whole text as the `function` of
  // chrome-devtools' evaluate_script, with filePath <out>/map.json (absolute).
  // Returns { rect, vp, dpr, mode, vpSource, vpMainThread, vpRenderWorker }:
  // rect, the canvas getBoundingClientRect() as [left, top, width, height] in
  // CSS px; dpr, devicePixelRatio, read now; vp, the view-projection the image
  // was drawn with: in Mode A the render worker's (its own Camera, which
  // neither engine.cam nor fitView reach: orthographic 20·a × 20, near -1,
  // far 1000, view identity, a = floor(clientWidth·dpr) / floor(clientHeight·dpr)),
  // in B and C window.__hyperion.cam.viewProjection. vpSource says which.
  // vpMainThread and vpRenderWorker are both kept for an A-versus-B
  // comparison: at camera (0, 0), zoom 1 the two are the same view.
  // From the round-step-6/7 map-modeA.js (SKILL.md §7, verbatim) and
  // map-modeB.js, joined.
  const engine = window.__hyperion;
  if (!engine) throw new Error('window.__hyperion is missing: open the dev harness (a dev build)');
  const c = document.getElementById('canvas');
  const dpr = window.devicePixelRatio;
  const a = Math.floor(c.clientWidth * dpr) / Math.floor(c.clientHeight * dpr);
  const r = c.getBoundingClientRect();
  const vpRenderWorker = [1 / (10 * a), 0, 0, 0, 0, 0.1, 0, 0, 0, 0, -1 / 1001, 0, 0, 0, 1 / 1001, 1];
  const vpMainThread = Array.from(engine.cam.viewProjection);
  const modeA = engine.mode === 'A';
  return {
    rect: [r.left, r.top, r.width, r.height],
    vp: modeA ? vpRenderWorker : vpMainThread,
    dpr,
    mode: engine.mode,
    vpSource: modeA ? 'render worker (Mode A, SKILL.md §7)' : 'window.__hyperion.cam.viewProjection',
    vpMainThread,
    vpRenderWorker,
  };
}

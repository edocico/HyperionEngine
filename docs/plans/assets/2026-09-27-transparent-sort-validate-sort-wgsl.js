async () => {
  // Phase 5b, spec §8 row 3 — Chrome half of the WGSL gate for the two sort
  // kernels. Paste this whole file as the `function` of chrome-devtools
  // evaluate_script, on the harness page served by `npm run dev` (Mode B: the
  // renderer, which sets TransparentSortPass.GATHER_SOURCE / SORT_SOURCE,
  // lives on the main thread; the dynamic import resolves to the module
  // instance the app uses, since Vite serves the same URL).
  //
  // It compiles both kernels (getCompilationInfo) and runs a throwaway
  // TransparentSortPass.setup() on a pool of its own inside error scopes,
  // which builds the four compute pipelines (gather, upsweep, scan, scatter)
  // on the pass's explicit layouts.
  //
  // A FRESH adapter and device, never window.__hyperion.renderer.device: the
  // live renderer's frames and graph requests must not interleave with these
  // error scopes (an adapter is consumed by requestDevice, so one
  // requestAdapter per device).
  const { TransparentSortPass } = await import('/src/render/passes/transparent-sort-pass.ts');
  const { ResourcePool } = await import('/src/render/resource-pool.ts');
  const { CAP, HEADER_BYTES } = await import('/src/render/passes/transparent-sort-constants.ts');

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  const device = await adapter.requestDevice();
  const out = { sources: {}, compilation: {}, setupErrors: [] };
  for (const [name, code] of [
    ['transparent-gather', TransparentSortPass.GATHER_SOURCE],
    ['transparent-sort', TransparentSortPass.SORT_SOURCE],
  ]) {
    out.sources[name] = code ? code.length : 0;
    if (!code) continue;
    const info = await device.createShaderModule({ code, label: `check-${name}` }).getCompilationInfo();
    out.compilation[name] = info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
  }
  const U = GPUBufferUsage;
  const pool = new ResourcePool();
  const made = [];
  const add = (name, size, usage) => {
    const b = device.createBuffer({ size, usage, label: `check-${name}` });
    made.push(b);
    pool.setBuffer(name, b);
  };
  add('indirect-args', 28 * 5 * 4, U.STORAGE | U.INDIRECT | U.COPY_DST);
  add('visible-indices', 28 * CAP * 4, U.STORAGE);
  add('entity-bounds', CAP * 16, U.STORAGE | U.COPY_DST);
  add('entity-ids', CAP * 4, U.STORAGE | U.COPY_DST);
  add('transparent-order', CAP * 4, U.STORAGE | U.COPY_SRC);
  add('transparent-args', HEADER_BYTES, U.STORAGE | U.INDIRECT | U.COPY_DST | U.COPY_SRC);
  const pass = new TransparentSortPass();
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  let thrown = null;
  try { pass.setup(device, pool); } catch (err) { thrown = String(err); }
  const oom = await device.popErrorScope();
  const validation = await device.popErrorScope();
  pass.destroy();
  for (const b of made) b.destroy();
  if (thrown) out.setupErrors.push(`threw: ${thrown}`);
  if (oom) out.setupErrors.push(`out-of-memory: ${oom.message}`);
  if (validation) out.setupErrors.push(`validation: ${validation.message}`);
  const { vendor, architecture, description } = adapter.info;
  device.destroy();
  const ok = Object.values(out.sources).every((length) => length > 0)
    && Object.values(out.compilation).every((messages) => !messages.some((m) => m.startsWith('error')))
    && out.setupErrors.length === 0;
  return { ok, adapter: { vendor, architecture, description }, ...out };
}

async () => {
  // M12 part c.2: probe 5 (m7-probe5-derive-proxy-gpu.json) repeated in Safari.
  // One fresh device with timestamp-query. Per derivation set: one query set (2 stamps per
  // case), one command encoder; each case opens ONE pass through the derived descriptor,
  // draws a full-screen triangle (render) or dispatches 64 workgroups (compute); then the
  // set is resolved and read back. A validation + internal error scope wraps the encoding
  // and the submit of each set.
  const { FrameRecorder } = await import('/src/render/timestamp-intercept.ts');
  const adapter = await navigator.gpu.requestAdapter();
  const hasTs = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: hasTs ? ['timestamp-query'] : [] });
  const renderModule = device.createShaderModule({ code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.2, 0.4, 0.6, 1.0); }` });
  const computeModule = device.createShaderModule({ code: `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  var x = f32(g.x);
  for (var i = 0u; i < 256u; i++) { x = x * 1.0001 + 0.5; }
  data[g.x] = x;
}` });
  const renderPipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: renderModule, entryPoint: 'vs' }, fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  const computePipeline = device.createComputePipeline({ layout: 'auto', compute: { module: computeModule, entryPoint: 'main' } });
  const storage = device.createBuffer({ size: 64 * 64 * 4, usage: GPUBufferUsage.STORAGE });
  const computeBindGroup = device.createBindGroup({ layout: computePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
  const target = device.createTexture({ size: [512, 512], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const view = target.createView();
  const attachments = () => [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }];
  class RenderDesc {
    #view;
    constructor(v) { this.#view = v; }
    get colorAttachments() { return [{ view: this.#view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }]; }
    get label() { return 'class-desc'; }
  }
  const cases = [
    { name: '0 render class #private', kind: 'render', make: () => new RenderDesc(view) },
    { name: '1 frozen literal, explicit undefined timestampWrites', kind: 'render', make: () => Object.freeze({ colorAttachments: Object.freeze(attachments()), timestampWrites: undefined }) },
    { name: '2 literal with a this-getter', kind: 'render', make: () => ({ _ca: attachments(), get colorAttachments() { return this._ca; } }) },
    { name: '3 compute undefined', kind: 'compute', make: () => undefined },
    { name: '4 compute null', kind: 'compute', make: () => null },
    { name: '5 compute label literal', kind: 'compute', make: () => ({ label: 'probe-compute' }) },
  ];
  const sets = {
    run2: {
      derivation: "const source = desc ?? {}; new Proxy({}, { get: (_target, key) => (key === 'timestampWrites' ? tw : Reflect.get(source, key, source)) }) — verbatim from m7-probe5-derive-proxy-gpu.json run2",
      derive: (desc, tw) => { const source = desc ?? {}; return new Proxy({}, { get: (_target, key) => (key === 'timestampWrites' ? tw : Reflect.get(source, key, source)) }); },
    },
    engineDerive: {
      derivation: 'FrameRecorder.derive() of ts/src/render/timestamp-intercept.ts (the code the profiler runs), imported from the dev server',
      recorder: true,
    },
    objectCreateControl: {
      derivation: "Object.create(desc ?? {}, { timestampWrites: { value: tw, enumerable: true } }) — run1 viaCreate, the control",
      derive: (desc, tw) => Object.create(desc ?? {}, { timestampWrites: { value: tw, enumerable: true } }),
    },
  };

  const ITER = 6;
  const seen = new Map(); // stamp value -> "iter/mode/set/pair" where it was first read
  const tally = {};
  const staleLog = [];
  const setNames = Object.keys(sets);
  for (let iter = 0; iter < ITER; iter++) {
    for (const mode of ['same-cb', 'after-done']) {
      const order = setNames.map((_, i) => setNames[(i + iter) % setNames.length]);
      for (const setName of order) {
        const set = sets[setName];
        const n = cases.length;
        const querySet = device.createQuerySet({ type: 'timestamp', count: 2 * n });
        const resolve = device.createBuffer({ size: 2 * n * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
        const readback = device.createBuffer({ size: 2 * n * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const recorder = set.recorder ? new FrameRecorder(querySet, n) : null;
        if (recorder) recorder.enterNode('probe5', true);
        device.pushErrorScope('validation');
        let encoder = device.createCommandEncoder();
        const threw = [];
        for (let k = 0; k < n; k++) {
          const c = cases[k];
          const original = c.make();
          const tw = { querySet, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 };
          try {
            const derived = recorder ? recorder.derive(original).desc : set.derive(original, tw);
            if (c.kind === 'render') { const p = encoder.beginRenderPass(derived); p.setPipeline(renderPipeline); p.draw(3); p.end(); }
            else { const p = encoder.beginComputePass(derived); p.setPipeline(computePipeline); p.setBindGroup(0, computeBindGroup); p.dispatchWorkgroups(64); p.end(); }
          } catch (err) { threw.push(k); }
        }
        if (mode === 'after-done') {
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
          encoder = device.createCommandEncoder();
        }
        encoder.resolveQuerySet(querySet, 0, 2 * n, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, readback, 0, 2 * n * 8);
        device.queue.submit([encoder.finish()]);
        const validation = await device.popErrorScope();
        await readback.mapAsync(GPUMapMode.READ);
        const stamps = new BigUint64Array(readback.getMappedRange().slice(0));
        readback.unmap();
        const key = `${mode}/${setName}`;
        tally[key] ??= { passesOpened: 0, fresh: 0, stale: 0, zero: 0, reversed: 0, threwPairsStale: 0, threwPairsZero: 0, validationErrors: 0 };
        const t = tally[key];
        if (validation) t.validationErrors++;
        for (let k = 0; k < n; k++) {
          const b = stamps[2 * k], e = stamps[2 * k + 1];
          const where = `${iter}/${mode}/${setName}/${k}`;
          const staleB = seen.has(b), staleE = seen.has(e);
          if (threw.includes(k)) {
            if (b === 0n && e === 0n) t.threwPairsZero++; else if (staleB || staleE) t.threwPairsStale++;
          } else {
            t.passesOpened++;
            if (b === 0n || e === 0n) t.zero++;
            else if (staleB || staleE) { t.stale++; staleLog.push({ where, kind: cases[k].kind, begin: String(b), end: String(e), staleBegin: staleB ? seen.get(b) : null, staleEnd: staleE ? seen.get(e) : null }); }
            else if (e < b) t.reversed++;
            else t.fresh++;
          }
          if (b !== 0n && !seen.has(b)) seen.set(b, where);
          if (e !== 0n && !seen.has(e)) seen.set(e, where);
        }
        querySet.destroy(); resolve.destroy(); readback.destroy();
      }
    }
  }
  device.destroy();
  return { iterations: ITER, cases: cases.map((c) => c.name), tally, staleLog };
}

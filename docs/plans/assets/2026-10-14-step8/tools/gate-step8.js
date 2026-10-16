async () => {
  // Round step 8, Task 3 GPU gate, on a device of its own: the step-8 shader
  // compiles, and so do the seven composed primitive modules, each with the
  // image flip of sampleTierOrWhite (sub-decision 2); the two-group pipeline
  // passes createGpuValidation; a frame drawing a sprite light through the
  // overflow tier submits with 0 errors after the tier GROWS, while a pool
  // left on the old view (the negative control) does not; then five texels
  // of the target (sub-decision 4 (d)): a loaded cookie lights, and index 0,
  // primary tier 1 layer 0, overflow tier 0 layer 0 and a layer past a
  // 1-layer array light nothing. Returns the evidence object (pass it a
  // filePath).
  const { LightAccumStage } = await import('/src/render/passes/light-accum-stage.ts');
  const { ForwardPass } = await import('/src/render/passes/forward-pass.ts');
  const { ResourcePool } = await import('/src/render/resource-pool.ts');
  const { createGpuValidation } = await import('/src/render/graph-host.ts');
  const { TextureManager, packTextureIndex } = await import('/src/texture-manager.ts');
  const source = LightAccumStage.SHADER_SOURCE;
  if (!source) {
    throw new Error('LightAccumStage.SHADER_SOURCE is empty: this import is a second module instance (restart the dev server and navigate again)');
  }
  // The six per-type modules and the uber, as the live renderer composed them.
  const primitiveSources = [...Object.values(ForwardPass.SHADER_SOURCES), ForwardPass.UBER_SOURCE];
  if (primitiveSources.length !== 7 || primitiveSources.some((s) => !s)) {
    throw new Error('ForwardPass.SHADER_SOURCES or UBER_SOURCE is empty: this import is a second module instance (restart the dev server and navigate again)');
  }
  const meta = window.__harnessMeta ?? {};
  let chrome = null;
  try {
    chrome = (await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']))?.fullVersionList ?? null;
  } catch {
    chrome = null;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('navigator.gpu.requestAdapter() returned null');
  const info = adapter.info ?? {};
  const device = await adapter.requestDevice();
  try {
    const compilation = await device.createShaderModule({ code: source }).getCompilationInfo();
    const messages = compilation.messages.map((m) => ({ type: m.type, line: m.lineNum, column: m.linePos, message: m.message }));
    const primitiveMessages = [];
    for (const [module, code] of primitiveSources.entries()) {
      for (const m of (await device.createShaderModule({ code }).getCompilationInfo()).messages) {
        primitiveMessages.push({ module, type: m.type, line: m.lineNum, column: m.linePos, message: m.message });
      }
    }
    const flip = /var image = in;\s*image\.uv = vec2f\(in\.uv\.x, 1\.0 - in\.uv\.y\);\s*return sampleTier\(image\);/;
    const imageFlipInEveryModule = primitiveSources.every((code) => flip.test(code.replace(/\/\/[^\n]*/g, '')));
    const validation = createGpuValidation(device);
    // One sprite light in slot 0: identity transform (centre 0, 0), white,
    // range 0.5, type 4, every layer; its cookie at overflow tier 0, layer 1.
    const storage = (label, data) => {
      const b = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: `gate-${label}` });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const cookie = packTextureIndex(0, 1, true) >>> 0;
    const textures = new TextureManager(device);
    const pools = { live: new ResourcePool(), stale: new ResourcePool() };
    for (const pool of Object.values(pools)) {
      pool.setBuffer('entity-transforms', storage('transforms', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])));
      pool.setBuffer('prim-params', storage('prim-params', new Float32Array([1, 1, 1, 0.5, -1, -1, 1, 0])));
      pool.setBuffer('render-meta', storage('render-meta', new Uint32Array([0, (6 | (4 << 11) | (0xffff << 16)) >>> 0])));
      pool.setBuffer('tex-indices', storage('tex-indices', new Uint32Array([cookie])));
    }
    // What renderer.ts registerTextureViews does, on the live pool only.
    const register = (pool) => {
      for (let t = 0; t < 4; t++) {
        pool.setTextureView(`tier${t}`, textures.getTierView(t));
        pool.setTextureView(`ovf${t}`, textures.getOverflowTierView(t));
      }
      pool.setSampler('texSampler', textures.getSampler());
    };
    register(pools.live);
    register(pools.stale);
    textures.onViewsChanged = () => register(pools.live);
    textures.ensureOverflowCapacity(0, 2);  // the first allocation: 16 layers, layer 1 the cookie's
    register(pools.stale);
    const stages = { live: new LightAccumStage(), stale: new LightAccumStage() };
    const setupErrors = {};
    for (const [name, stage] of Object.entries(stages)) setupErrors[name] = await validation.run(() => stage.setup(device, pools[name]));
    const targetTexture = device.createTexture({ size: { width: 64, height: 64 }, format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, label: 'gate-target' });
    const target = targetTexture.createView();
    const sdf = device.createTexture({ size: { width: 1, height: 1 }, format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'gate-sdf' }).createView();
    const frame = { canvasWidth: 128, canvasHeight: 128, cameraViewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), ambient: [0, 0, 0, 1], shadowSteps: 48 };
    const draw = (name) => validation.run(() => {
      const stage = stages[name];
      stage.prepare(device, frame, [{ layers: 1, sdfSet: -1 }], new Uint32Array([0]));
      const encoder = device.createCommandEncoder();
      stage.encode(encoder, 0, target, sdf, frame, pools[name]);
      device.queue.submit([encoder.finish()]);
    });
    const before = { live: await draw('live'), stale: await draw('stale') };
    textures.ensureOverflowCapacity(0, 17);  // 16 -> 32: the copy, then the old texture destroyed
    const after = { live: await draw('live'), stale: await draw('stale') };
    // Sub-decision 4 (d): five texels of the target, each after a frame drawn
    // with one index in slot 0. This TextureManager has no compressed format,
    // so every layer 0 is white and an unallocated tier is a 1-layer WHITE
    // placeholder: without the layer-0 drop of vs_main the target lights at
    // index 0, primary tier 1 layer 0 and overflow tier 0 layer 0, and
    // without the cookieLayers bound of fs_main overflow tier 3's layer 1 is
    // clamped to that placeholder's white layer 0. The cookie, a 4 x 4
    // rgb(255, 128, 0) PNG (primary tier 0, layer 1), is the positive control.
    const png = new OffscreenCanvas(4, 4);
    const ctx = png.getContext('2d');
    ctx.fillStyle = 'rgb(255, 128, 0)';
    ctx.fillRect(0, 0, 4, 4);
    const url = URL.createObjectURL(await png.convertToBlob({ type: 'image/png' }));
    const cookieIndex = await textures.loadTexture(url);
    URL.revokeObjectURL(url);
    const half = (h) => {
      const sign = h & 0x8000 ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const m = h & 0x3ff;
      if (e === 0) return sign * m * 2 ** -24;
      if (e === 31) return m ? NaN : sign * Infinity;
      return sign * (1 + m / 1024) * 2 ** (e - 15);
    };
    // Texel (32, 32), inside the light's square (pixels 16-48 of the target).
    const readTexel = async () => {
      const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'gate-readback' });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: targetTexture, origin: { x: 32, y: 32 } }, { buffer, bytesPerRow: 256 }, { width: 1, height: 1 });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const h = new Uint16Array(buffer.getMappedRange(0, 8).slice(0));
      buffer.unmap();
      buffer.destroy();
      return [half(h[0]), half(h[1]), half(h[2])];
    };
    const cases = {
      cookie: cookieIndex,
      index0: 0,
      tier1Layer0: packTextureIndex(1, 0),
      overflowLayer0: packTextureIndex(0, 0, true),
      pastTheEnd: packTextureIndex(3, 1, true),
    };
    const witness = {};
    for (const [name, index] of Object.entries(cases)) {
      device.queue.writeBuffer(pools.live.getBuffer('tex-indices'), 0, new Uint32Array([index >>> 0]));
      const errors = await draw('live');
      witness[name] = { index: index >>> 0, errors, rgb: await readTexel() };
    }
    for (const stage of Object.values(stages)) stage.destroy();
    const code = source.replace(/\/\/[^\n]*/g, '');
    return {
      gate: 'step8-task3',
      head: meta.head ?? null,
      adapterLine: meta.adapterLine ?? null,
      date: new Date().toISOString(),
      mode: window.__hyperion?.mode ?? null,
      search: location.search,
      adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', description: info.description ?? '' },
      chrome,
      userAgent: navigator.userAgent,
      shaderBytes: source.length,
      stepEightShader: /@group\(1\)\s*@binding\(5\)\s*var ovf0Tex/.test(code) && /\bspriteAxes\b/.test(code) && /\bcookieLayers\b/.test(code) && !/kind == SPRITE\) \{\s*discard/.test(code),
      messages,
      primitiveMessages,
      imageFlipInEveryModule,
      setupErrors,
      overflowAllocated: textures.getOverflowAllocatedLayers(0),
      drawErrors: { before, after },
      cookieIndex,
      witness,
    };
  } finally {
    device.destroy();
  }
}

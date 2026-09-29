async () => {
  // Phase 5b, spec §7.3.2 — Chrome half of the WGSL gate. Paste this whole
  // file as the `function` of chrome-devtools evaluate_script, on the harness
  // page served by `npm run dev` (Mode B: its renderer, and so the
  // ForwardPass statics compared below, live on the main thread).
  //
  // It composes the seven primitive modules from the pieces on disk, compiles
  // each one (getCompilationInfo) and builds every pipeline the engine builds
  // from it inside error scopes: per type the opaque and transparent forward
  // pipelines (three groups) and the occluder pipeline (two groups,
  // OCCLUDER_PASS = 1, fs_occluder); for the uber the transparent one. It
  // also checks the text against the modules the renderer published.
  //
  // A FRESH adapter and device: the harness device is left alone (an adapter
  // is consumed by requestDevice, so one requestAdapter per device).
  const { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule } = await import('/src/render/primitive-shaders.ts');
  const { primitiveGroup0LayoutEntries, textureTierLayoutEntries } = await import('/src/render/primitive-bindings.ts');
  const { SCENE_HDR_FORMAT, JFA_FORMAT } = await import('/src/render/formats.ts');
  const { ForwardPass } = await import('/src/render/passes/forward-pass.ts');
  const raw = async (name) => (await import(`/src/shaders/primitives/${name}.wgsl?raw`)).default;

  const pieces = { prelude: await raw('prelude'), libraries: {} };
  for (const lib of PRIMITIVE_LIBRARIES) pieces.libraries[lib.type] = await raw(lib.name);
  const typeModules = composeTypeModules(pieces);
  const uberModule = composeUberModule(pieces);

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  const device = await adapter.requestDevice();
  const g0 = device.createBindGroupLayout({ entries: primitiveGroup0LayoutEntries() });
  const g1 = device.createBindGroupLayout({ entries: textureTierLayoutEntries() });
  // Group 2 as ForwardPass declares it: the light buffer (2d-array), its sampler, LightingUniform.
  const g2 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const forwardLayout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1, g2] });
  const occluderLayout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1] });
  const vertex = (module, constants) => ({
    module, entryPoint: 'vs_main', constants,
    buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
  });
  const primitive = { topology: 'triangle-list', cullMode: 'back' };
  const blend = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const descriptors = {
    opaque: (module) => ({
      layout: forwardLayout, vertex: vertex(module), primitive,
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: SCENE_HDR_FORMAT }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    }),
    transparent: (module) => ({
      layout: forwardLayout, vertex: vertex(module), primitive,
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: SCENE_HDR_FORMAT, blend }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    }),
    occluder: (module) => ({
      layout: occluderLayout, vertex: vertex(module, { OCCLUDER_PASS: 1 }), primitive,
      fragment: { module, entryPoint: 'fs_occluder', targets: [{ format: JFA_FORMAT }] },
    }),
  };
  /** Run fn inside validation + internal error scopes; the messages, empty when clean. */
  const scoped = async (fn) => {
    device.pushErrorScope('internal');
    device.pushErrorScope('validation');
    let thrown = null;
    try { fn(); } catch (err) { thrown = err; }
    const validation = await device.popErrorScope();
    const internal = await device.popErrorScope();
    return [thrown && String(thrown), validation?.message, internal?.message].filter(Boolean);
  };
  const check = async (name, code, kinds, published) => {
    let module = null;
    const moduleErrors = await scoped(() => { module = device.createShaderModule({ code }); });
    const info = await module.getCompilationInfo();
    const pipelines = {};
    for (const kind of kinds) pipelines[kind] = await scoped(() => device.createRenderPipeline(descriptors[kind](module)));
    return {
      name,
      compileErrors: info.messages.filter((m) => m.type === 'error').length + moduleErrors.length,
      messages: [
        ...info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`),
        ...moduleErrors,
      ],
      pipelines,
      matchesPublished: published === code,
    };
  };

  const results = [];
  for (const lib of PRIMITIVE_LIBRARIES) {
    results.push(await check(`type-${lib.type}-${lib.name}`, typeModules[lib.type],
      ['opaque', 'transparent', 'occluder'], ForwardPass.SHADER_SOURCES[lib.type]));
  }
  results.push(await check('uber', uberModule, ['transparent'], ForwardPass.UBER_SOURCE));
  const { vendor, architecture, description } = adapter.info;
  device.destroy();
  const ok = results.every((r) => r.compileErrors === 0
    && Object.values(r.pipelines).every((errors) => errors.length === 0)
    && r.matchesPublished);
  return { ok, adapter: { vendor, architecture, description }, results };
}

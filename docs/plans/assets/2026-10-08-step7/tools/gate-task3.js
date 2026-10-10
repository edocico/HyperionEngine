async () => {
  // Round step 7, Task 3 Step 5.1: does the step-7 light-accum.wgsl compile on
  // this device, and does LightAccumStage's pipeline (LIGHT_BLEND, the binding-2
  // light list) pass the engine's own validation (graph-host.ts
  // createGpuValidation: the internal, out-of-memory and validation scopes,
  // all popped even when setup throws)? On a device of its own, destroyed at
  // the end; nothing of the live engine is touched.
  const { LightAccumStage } = await import('/src/render/passes/light-accum-stage.ts');
  const { ResourcePool } = await import('/src/render/resource-pool.ts');
  const { createGpuValidation } = await import('/src/render/graph-host.ts');
  const source = LightAccumStage.SHADER_SOURCE;
  if (!source) {
    throw new Error('LightAccumStage.SHADER_SOURCE is empty: this import is a second module instance (restart the dev server and navigate again)');
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
    const pool = new ResourcePool();
    for (const name of ['entity-transforms', 'prim-params', 'render-meta']) {
      pool.setBuffer(name, device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE, label: `gate-${name}` }));
    }
    const stage = new LightAccumStage();
    let pipelineErrors;
    let setupThrew = null;
    try {
      pipelineErrors = await createGpuValidation(device).run(() => stage.setup(device, pool));
    } catch (err) {
      setupThrew = String(err instanceof Error ? err.message : err);
      pipelineErrors = null;
    } finally {
      stage.destroy();
    }
    const code = source.replace(/\/\/[^\n]*/g, '');
    return {
      gate: 'step7-task3',
      head: meta.head ?? null,
      adapterLine: meta.adapterLine ?? null,
      date: new Date().toISOString(),
      mode: window.__hyperion?.mode ?? null,
      search: location.search,
      adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', description: info.description ?? '' },
      chrome,
      userAgent: navigator.userAgent,
      shaderBytes: source.length,
      stepSevenShader: /\blightOrder\b/.test(code) && !/\bvisibleIndices\b/.test(code),
      messages,
      pipelineErrors,
      setupThrew,
    };
  } finally {
    device.destroy();
  }
}

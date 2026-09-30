// m7-probe6: Chrome's timestamp-query quantization under different launch flags (2026-09-30).
// Written by the verifier of adversarial-review finding C1 (wf_c06a8209-415) and re-run by the
// controller on the Apple M2 Pro, Chrome 154, headless; results in m7-probe6-quantization-flags.json.
// Usage: node m7-probe6-quantization-flags.mjs <label> <port> [chrome flags...]
// (writes a throwaway Chrome profile and blank.html next to this script, and removes the profile).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [label, portStr, ...flags] = process.argv.slice(2);
const port = Number(portStr);
const scratch = new URL('.', import.meta.url).pathname;
const profile = join(scratch, `chrome-profile-${label}`);
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const page = join(scratch, 'blank.html');
writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>probe</title>');

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, ...flags, `file://${page}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('no page target');
}

const probe = `(async () => {
  const out = { secure: self.isSecureContext, hasGpu: !!navigator.gpu, ua: navigator.userAgent };
  if (!navigator.gpu) return out;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { out.adapter = null; return out; }
  out.info = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
               description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter };
  out.hasTimestampQuery = adapter.features.has('timestamp-query');
  if (!out.hasTimestampQuery) return out;
  const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  const N = 16;
  const qs = device.createQuerySet({ type: 'timestamp', count: N });
  const resolve = device.createBuffer({ size: N * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: N * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const module = device.createShaderModule({ code: \`
    @group(0) @binding(0) var<storage, read_write> buf: array<u32>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
      var x = id.x;
      for (var i = 0u; i < 2000u; i++) { x = x * 1664525u + 1013904223u; }
      buf[id.x] = x;
    }\` });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const storage = device.createBuffer({ size: 4 * 64 * 4096, usage: GPUBufferUsage.STORAGE });
  const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
  const results = [];
  for (let s = 0; s < 5; s++) {
    const enc = device.createCommandEncoder();
    for (let p = 0; p < N / 2; p++) {
      const pass = enc.beginComputePass({ timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 2 * p, endOfPassWriteIndex: 2 * p + 1 } });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(1 + p * 512);
      pass.end();
    }
    enc.resolveQuerySet(qs, 0, N, resolve, 0);
    enc.copyBufferToBuffer(resolve, 0, read, 0, N * 8);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const v = new BigUint64Array(read.getMappedRange().slice(0));
    read.unmap();
    results.push([...v]);
  }
  const all = results.flat();
  out.total = all.length;
  out.nonzero = all.filter((x) => x !== 0n).length;
  out.multiplesOf65536 = all.filter((x) => x % 65536n === 0n).length;
  out.durationsNs = results.map((r) => { const d = []; for (let p = 0; p < N / 2; p++) d.push(Number(r[2 * p + 1] - r[2 * p])); return d; });
  out.sampleRawLow16 = results[0].slice(0, 6).map((x) => Number(x % 65536n));
  device.destroy();
  return out;
})()`;

try {
  const ws = new WebSocket(await target());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const reply = await new Promise((res) => {
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id === 1) res(msg); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: probe, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  console.log(JSON.stringify({ label, flags, result: reply.result?.result?.value ?? reply.result ?? reply.error }, null, 1));
} catch (e) {
  console.log(JSON.stringify({ label, flags, error: String(e), stderr: stderr.slice(0, 2000) }));
} finally {
  chrome.kill('SIGTERM');
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}

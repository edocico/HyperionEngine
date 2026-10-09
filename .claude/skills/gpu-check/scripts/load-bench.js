async () => {
  // gpu-check: loads a committed bench from the asset server into the page
  // (SKILL.md, "Bench session"). Pass this file's whole text as the `function`
  // of chrome-devtools' evaluate_script, once per page load, after an earlier
  // evaluate_script has set
  //   window.__benchSpec = {
  //     bench: '/2026-10-08-step7-light-order-bench.js',      // URL path on the asset server
  //     globals: { __step7OldLightAccum: '/old-light-accum.wgsl' }, // optional: what the bench header reads
  //     origin: 'http://127.0.0.1:8765',                       // optional, this default
  //   };
  // The bench (a function expression, the body of one evaluate_script) is
  // evaluated with (0, eval)('(' + src + ')') into window.__benchFn; then each
  // bench task is `async () => await window.__benchFn()`. Each global is
  // fetched into window[NAME] as text, or undefined when the response is not
  // ok. Every fetch is cache: 'no-store'. A bench that does not load throws,
  // and leaves window.__benchFn undefined, never a previous bench.
  // Returns { origin, bench, benchStatus, benchBytes, benchSha256, benchType,
  // globals: { NAME: { status, bytes, sha256 } } }: the size and SHA-256 of
  // the bytes served, to compare with `shasum -a 256 FILE` (macOS; on Linux
  // `sha256sum FILE`) or `git show REV:PATH | shasum -a 256` (`| sha256sum`).
  // The harness page, http://localhost, IS a secure context, so sha256 is a
  // hex string there; it is null only on a page that is not one (no
  // crypto.subtle). A global whose status is not 200 is undefined in the
  // page. benchType must be 'function'.
  const spec = window.__benchSpec;
  if (!spec || typeof spec.bench !== 'string' || !spec.bench) {
    throw new Error("set window.__benchSpec = { bench: '/<bench>.js', globals: { NAME: '/<path>' }, origin: 'http://127.0.0.1:8765' } first, in an earlier evaluate_script");
  }
  const origin = spec.origin ?? 'http://127.0.0.1:8765';
  const hex = async (bytes) => (crypto.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('') : null);
  const get = async (path) => {
    const url = new URL(path, origin).href;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { url, status: res.status, bytes: 0, sha256: null, text: undefined };
    const buf = await res.arrayBuffer();
    return { url, status: res.status, bytes: buf.byteLength, sha256: await hex(buf), text: new TextDecoder().decode(buf) };
  };
  window.__benchFn = undefined;
  const bench = await get(spec.bench);
  if (bench.text === undefined) {
    throw new Error(`${bench.url}: HTTP ${bench.status} (is the asset server up and serving it? gpu-infra.sh status)`);
  }
  window.__benchFn = (0, eval)('(' + bench.text + ')');
  const globals = {};
  for (const [name, path] of Object.entries(spec.globals ?? {})) {
    window[name] = undefined;
    const g = await get(path);
    window[name] = g.text;
    globals[name] = { status: g.status, bytes: g.bytes, sha256: g.sha256 };
  }
  return { origin, bench: bench.url, benchStatus: bench.status, benchBytes: bench.bytes, benchSha256: bench.sha256, benchType: typeof window.__benchFn, globals };
}

async () => {
  // gpu-check: runs the harness tabs, each until the END of its section setup
  // (60 s cap), then 600 ms. Pass this file's whole text as the `function` of
  // chrome-devtools' evaluate_script.
  // Every tab by default. Only some: set their labels first, in an earlier
  // evaluate_script, `() => { window.__tabsOnly = ['Scene Graph']; }`;
  // `delete window.__tabsOnly` (or a new navigation) runs them all again.
  // Best on a ?bench page: no section is open at load, so each setup runs
  // from its click and setupMs is that setup. Without ?bench the first click
  // waits for the Primitives setup the page opened.
  // Returns, and keeps in window.__tabsOut, { [label]: { summary, failed,
  // pending, setupMs, timedOut } }: summary is the tab's 'N/M passed' line,
  // failed and pending its ✕ and ⏳ checks (SKILL.md §4). timedOut true
  // (setupMs ~60 000) says only that the wrapper did not see the setup end
  // within 60 s. Either the setup really ran that long, and its checks may
  // not be finished when they are read (rerun that tab alone), or this
  // import('/src/demo/…') got a second instance of the section module,
  // edited since the dev server started, whose setup never runs: the app ran
  // its own, so the checks read right, but restart the dev server
  // (gpu-infra.sh up) and navigate again. A tab missing from KEYS (main.ts
  // TABS) throws.
  // The SKILL.md §4 runner with the setup wait in place of a fixed 3.5 s
  // (round step 6, ruling R27), plus window.__tabsOnly.
  const KEYS = { 'Primitives': 'primitives', 'Scene Graph': 'scene-graph', 'Input': 'input', 'Audio': 'audio', 'Particles': 'particles', 'Rendering FX': 'rendering-fx', 'Lighting': 'lighting', 'Debug Tools': 'debug-tools', 'Lifecycle': 'lifecycle', '2D Twins': 'twin-2d' };
  const ONLY = [].concat(window.__tabsOnly ?? []);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabs = [...document.querySelectorAll('.tab')];
  const labels = tabs.map((t) => t.textContent.trim());
  const unknown = ONLY.filter((l) => !labels.includes(l));
  if (unknown.length) throw new Error(`window.__tabsOnly names no tab: ${unknown.join(', ')} (the tabs: ${labels.join(', ')})`);
  const out = {};
  for (const tab of tabs) {
    const name = tab.textContent.trim();
    if (ONLY.length && !ONLY.includes(name)) continue;
    const key = KEYS[name];
    if (!key) throw new Error(`unknown tab '${name}'`);
    const section = (await import(`/src/demo/${key}.ts`)).default;
    const setup = section.setup;
    let done;
    const finished = new Promise((r) => { done = r; });
    section.setup = async function (...a) { try { return await setup.apply(this, a); } finally { section.setup = setup; done(); } };
    const t0 = performance.now();
    tab.click();
    const timedOut = await Promise.race([finished.then(() => false), wait(60000).then(() => true)]);
    await wait(600);
    const leaves = [...document.querySelectorAll('*')].filter((n) => n.children.length === 0);
    out[name] = {
      summary: leaves.map((n) => n.textContent.trim()).filter((t) => /\d+\/\d+ passed/.test(t)).at(-1) ?? null,
      failed: leaves.filter((n) => /^✕/.test(n.textContent.trim())).map((n) => n.parentElement.textContent.trim().slice(0, 100)),
      pending: leaves.filter((n) => /^⏳/.test(n.textContent.trim())).map((n) => n.parentElement.textContent.trim().slice(0, 60)),
      setupMs: Math.round(performance.now() - t0),
      timedOut,
    };
  }
  window.__tabsOut = out;
  return out;
}

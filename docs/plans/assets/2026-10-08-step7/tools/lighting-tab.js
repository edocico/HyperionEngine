async () => {
  // The plan's Task 10 Step 3 per-tab script, verbatim, plus one property: tabs.
  const KEY = 'lighting', LABEL = 'Lighting';
  const section = (await import(`/src/demo/${KEY}.ts`)).default;
  const setup = section.setup;
  let done;
  const finished = new Promise((r) => { done = r; });
  section.setup = async function (...a) { try { return await setup.apply(this, a); } finally { section.setup = setup; done(); } };
  [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(LABEL)).click();
  await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))]);
  await new Promise((r) => setTimeout(r, 600));
  const checks = [...document.querySelectorAll('.check-item')].map((item) => ({
    name: item.querySelector('.check-name')?.textContent,
    status: [...item.querySelector('.check-icon').classList].find((c) => c !== 'check-icon'),
    detail: item.nextElementSibling?.classList.contains('check-detail') ? item.nextElementSibling.textContent : '',
  }));
  // The evidence's metadata, read like the bench's.
  const meta = window.__harnessMeta ?? {};
  let adapter = null;
  try {
    const a = await navigator.gpu?.requestAdapter();
    adapter = a ? { vendor: a.info?.vendor ?? '', architecture: a.info?.architecture ?? '', description: a.info?.description ?? '' } : null;
  } catch { adapter = null; }
  const chrome = (await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']))?.fullVersionList ?? null;
  const canvas = document.getElementById('canvas');
  return {
    format: 'hyperion-step7-harness/1', head: meta.head ?? null, adapterLine: meta.adapterLine ?? null,
    date: new Date().toISOString(), mode: window.__hyperion.mode, search: location.search, adapter, chrome,
    canvas: [canvas.width, canvas.height], css: [canvas.clientWidth, canvas.clientHeight], dpr: window.devicePixelRatio,
    lighting: checks,
    // Added (controller, Task 10): the all-tabs runner's output of this page load.
    tabs: window.__tabsOut ?? null,
  };
}

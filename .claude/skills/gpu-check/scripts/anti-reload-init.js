(() => {
  // gpu-check: the anti-reload initScript. Pass this file's whole text as the
  // `initScript` of chrome-devtools' navigate_page; it applies to that ONE
  // navigation (a plain reload drops it: navigate again with it).
  // navigate_page takes ONE initScript. On the Fedora box (Linux) the page
  // also needs the low-power adapter line of SKILL.md §3 (Fedora): pass ONE
  // string holding this file's whole text first, then a newline, a semicolon
  // and a newline, then that line. Never one of the two alone there: without
  // the low-power line Chrome hands out the NVIDIA adapter, which loses the
  // device at its first large allocation; without this file a long run dies
  // at the next close of the HMR socket.
  // Why (SKILL.md §3): in the Vite 6.4 client ANY close of the HMR WebSocket
  // ends in location.reload(), which kills a long evaluate_script with
  // "Execution context was destroyed". This wraps WebSocket for the
  // 'vite-hmr' protocol only: each close is pushed to window.__viteWsCloses,
  // logged as a '[mac-m2 test] vite-hmr websocket closed, reload suppressed'
  // warning, and its reload stopped. The adapter and the engine are untouched;
  // after a suppressed close the page gets no HMR update until it is navigated
  // again.
  // Returns nothing. At the end of a run window.__viteWsCloses is [] when the
  // socket never closed.
  // From docs/plans/2026-09-29-gpu-profiler-timestamp-writes-plan.md (Task 8),
  // one statement per line, otherwise unchanged.
  const Native = window.WebSocket;
  window.__viteWsCloses = [];
  function Patched(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const proto = Array.isArray(protocols) ? protocols.join(',') : String(protocols ?? '');
    if (proto.includes('vite-hmr')) {
      ws.addEventListener('close', (e) => {
        const rec = { t: new Date().toISOString(), perf: Math.round(performance.now()), code: e.code, reason: e.reason, wasClean: e.wasClean };
        window.__viteWsCloses.push(rec);
        console.warn('[mac-m2 test] vite-hmr websocket closed, reload suppressed: ' + JSON.stringify(rec));
        e.stopImmediatePropagation();
      });
    }
    return ws;
  }
  Patched.prototype = Native.prototype;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;
})()

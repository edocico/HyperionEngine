---
name: gpu-check
description: Verify rendering on real WebGPU in the verification harness — rebuild ts/wasm if stale, load the harness on a hardware adapter (AMD iGPU on Fedora, Apple GPU on the Mac), run every tab (or the ones named), report N/M passed, pending checks and console errors, and optionally sample screenshot pixels at world coordinates. Use after any change to rendering, shaders, the render graph, the command queue or the Rust engine, before calling it done.
---

Headless tests cannot see WebGPU errors; this is the check that can. Arguments (optional): the
tab labels to run, e.g. `/gpu-check Lighting` — default is every tab.

## 1. The WASM must be the current engine

The harness imports `ts/wasm/hyperion_core.js` (`build:wasm`: default features, **no physics-2d**).

```bash
[ -f ts/wasm/hyperion_core_bg.wasm ] || echo MISSING
find crates/hyperion-core/src crates/hyperion-core/Cargo.toml -newer ts/wasm/hyperion_core_bg.wasm \( -name '*.rs' -o -name Cargo.toml \) | head -3
```

`MISSING` or any listed file → `npm --prefix ts run build:wasm` first. The first line is not
decoration: `ts/wasm` is generated and gitignored, so a fresh clone or worktree has none, and
`find -newer` against a file that does not exist prints nothing on stdout (its error goes to
stderr), which reads exactly like "fresh". Physics behaviour is not in this build at all: verify it
with `cargo test -p hyperion-core --features physics-2d --test verify_physics`.

## 2. Dev server

After a `git checkout` / merge / rebase that touched a shader, RESTART it (stop the background task,
start it again): Vite can keep serving a stale transform of `?import&raw` with a 304, and the check
then runs the old shader (2026-09-27: pixel-width lines drew in world units).

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/
```

Not `200` → start it in the background (Bash `run_in_background`):
`npm --prefix ts run dev -- --strictPort --port 5173`.

## 3. Load the harness on a hardware adapter

Which machine: `uname -s` says `Darwin` on the Mac and `Linux` on the Fedora box. On both, read the
adapter line before trusting anything (`list_console_messages`, types `log`/`info`/`warn`):
`[Hyperion] WebGPU adapter: <vendor> / <architecture> / <device>, subgroups <min>-<max>` must name
the hardware GPU and must not carry `SOFTWARE FALLBACK`.

### Mac (Apple M2, macOS, Chrome stable)

One GPU, Metal, hardware WebGPU with no flag: no adapter initScript (the low-power one below is
Fedora-only), and Mode A can be checked. Two Chrome servers, two roles: **chrome-devtools-gpu**
(launched with `--enable-webgpu-developer-features`, persistent profile) for GPU timings, because
the flag lifts Chrome's 65 536 ns timestamp quantization, and **chrome-devtools** (no flags, what a
user's Chrome does) for stock behaviour. Either one gives the pass/fail verdicts.

`navigate_page` with `type: "url"`, `url: "http://localhost:5173/?mode=B"` and `ignoreCache: true`,
WITHOUT an `initScript`. Quote the URL in any shell command (zsh: `?` is a glob). The adapter line
must say Apple and not a fallback: `apple / metal-3 / 0x0000, subgroups 32-32` on the gpu server
(the stock Chrome leaves the device out: `apple / metal-3, subgroups 32-32`). A reload after a TS
edit is harmless: with one GPU and no initScript to reapply nothing is lost, so run the tabs again.
Then run `?mode=C` and `?mode=A` too, each loaded the same way and with its own adapter line (in
Mode A the render worker prints it, and `list_console_messages` shows worker messages: no DevTools
context switch is needed).

Long `evaluate_script` runs (the all-tabs runner: 35 s with its 3.5 s waits per tab, more with the
7 s the slow tabs want) start from a navigation that carries the anti-reload initScript. In the
Vite 6.4 client ANY close of the HMR WebSocket, even a clean one, ends in `location.reload()`
(`vite:ws:disconnect`, then `waitForSuccessfulPing`), and the run dies with
`Execution context was destroyed`: it happened twice on 2026-09-29, with the same server process
and nothing in its log. The script wraps `WebSocket` for the `vite-hmr` protocol only, records each
close in `window.__viteWsCloses` and in the console (a `[mac-m2 test] vite-hmr websocket closed`
warning), and stops the reload; it touches neither the adapter nor the engine. Verbatim, from
`docs/plans/2026-09-29-gpu-profiler-timestamp-writes-plan.md` (Task 8), as the `initScript` of
`navigate_page`:

```js
(() => { const Native = window.WebSocket; window.__viteWsCloses = []; function Patched(url, protocols) { const ws = protocols === undefined ? new Native(url) : new Native(url, protocols); const proto = Array.isArray(protocols) ? protocols.join(',') : String(protocols ?? ''); if (proto.includes('vite-hmr')) { ws.addEventListener('close', (e) => { const rec = { t: new Date().toISOString(), perf: Math.round(performance.now()), code: e.code, reason: e.reason, wasClean: e.wasClean }; window.__viteWsCloses.push(rec); console.warn('[mac-m2 test] vite-hmr websocket closed, reload suppressed: ' + JSON.stringify(rec)); e.stopImmediatePropagation(); }); } return ws; } Patched.prototype = Native.prototype; Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); window.WebSocket = Patched; })()
```

Like any initScript it applies to ONE navigation (a plain `reload` drops it: pass it again), and
after a suppressed close the page gets no more HMR updates until the next navigation. An empty
`window.__viteWsCloses` at the end of a run means the socket never dropped.

### Fedora (AMD iGPU + NVIDIA, Chrome with the Vulkan flags)

Use the **chrome-devtools-gpu** server (the one launched with the Vulkan flags). On the Fedora box the
NVIDIA adapter cannot present to a canvas, so force the low-power one — `navigate_page` with
`type: "url"`, `url: "http://localhost:5173/?mode=B"`, `ignoreCache: true` and this `initScript`:

```js
GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
```

Then read the adapter line (`list_console_messages`, types `log`/`info`/`warn`): it must say AMD,
not nvidia and not a software fallback (SwiftShader). Mode A cannot be checked on the Fedora box: the
initScript does not reach workers, which then pick NVIDIA and lose the device.

The initScript applies to ONE navigation. An edit Vite cannot hot-swap — any TS module, a demo
section included — reloads the page without it: the reload gets NVIDIA and loses the device at its
first large allocation (`VK_ERROR_OUT_OF_DEVICE_MEMORY`, every check "Device is lost"). That is not
a leak: `navigate_page` again with the initScript and re-read the adapter line. The tell is a new
`[vite] connecting...` and a second adapter line in the console. An edit to one of the 20
hot-reloadable WGSL files (`import.meta.hot.accept` in `renderer.ts`; the 7 primitive pieces are
grouped by a 50 ms debounce) is swapped in place and the page stays: keep it when the shader
hot-reload is what you are checking. A WGSL file WITHOUT its own accept reloads the whole page.

## 4. Run the tabs

`evaluate_script` (replace `ONLY` with `[]` for every tab, or with the labels asked for):

```js
async () => {
  const ONLY = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  for (const tab of [...document.querySelectorAll('.tab')]) {
    const name = tab.textContent.trim();
    if (ONLY.length && !ONLY.includes(name)) continue;
    tab.click();
    await wait(3500);
    const leaves = [...document.querySelectorAll('*')].filter((n) => n.children.length === 0);
    out[name] = {
      summary: leaves.map((n) => n.textContent.trim()).filter((t) => /\d+\/\d+ passed/.test(t)).at(-1) ?? null,
      failed: leaves.filter((n) => /^✕/.test(n.textContent.trim())).map((n) => n.parentElement.textContent.trim().slice(0, 100)),
      pending: leaves.filter((n) => /^⏳/.test(n.textContent.trim())).map((n) => n.parentElement.textContent.trim().slice(0, 60)),
    };
  }
  return out;
}
```

The harness draws ✓ pass, ✕ fail, ⊘ skip and ⏳ pending (`STATUS_ICON` in `main.ts`): the runner
reads those glyphs, and `summary` also says `N failed`.

Expected today (2026-09-27, the checks read pixels through the probe): every tab green except
**Input at 2/6** — its 4 checks wait for real keyboard/click/pointer/scroll input (⏳), which is
not a regression. Primitives (MSDF), Rendering FX (Tonemap stub) and Debug Tools each skip one
check. In Mode A most checks skip: §7 has the list. Lighting, Rendering FX and
Lifecycle take a few seconds: wait ~7 s on them. **2D Twins** (6 checks) holds the one check of
scatter format 0 and the transparent-sort checks: run it with `?mode=C` too, where its row check
must report scatter frames (Mode B uploads every row, so there it reports 0) and 'Transparent sort
under churn' runs (in Mode B it skips: 5/6 passed · 1 skipped). Its setup takes several seconds
(texture load, 10-frame reads): wait for it. `window.__hyperion` is the live facade for anything
the tabs do not check.

## 5. Console

`list_console_messages` with types `error` and `warn`. A `404` is only acceptable for
`favicon.ico` — confirm with `list_network_requests`. A LeakDetector warning is a real leak since
2026-09-27 (a handle collected without `destroy()`), and `[Hyperion] <phase> hook … threw` is a
failing hook: report both. Anything mentioning WebGPU, validation, a pipeline or a device is a
failure.

## 6. Pixels (when the question is "does it LOOK right")

**Prefer the in-engine probe** (dev builds, Mode B/C): it reads the next rendered frame with no
DOM overlay in the way. From `evaluate_script`:
`await window.__hyperion.debug.probe({ target: 'scene-hdr' | 'swapchain' | 'light-buffer', world: [[x, y], ...], layer })`
→ `{ values: [[r,g,b,a], ...], uv, targetSize, canvasSize }`.
- `scene-hdr` and `light-buffer` are LINEAR HDR. `swapchain` is what is displayed: tonemapped,
  0-1, 8-bit (1/255 steps). The first swapchain probe reconfigures the canvas with
  `TEXTURE_BINDING` for the rest of the session: take GPU timings BEFORE probing the swapchain.
- `light-buffer` only while the lit graph is live; `layer` is a light group of that frame
  (`window.__hyperion.lighting.groups`), anything else rejects.
- It rejects while the engine is paused, and waits while the world is empty (nothing renders).
- Known values: the `scene-hdr` clear is 0.067, an untextured quad 1.0.

`await window.__hyperion.debug.readEntityTransforms()` compares the GPU transform rows with the
CPU ones (`usedScatter` true only in `?mode=C`). The screenshot path below is for what the probe
cannot see: DOM overlays, and anything in Mode A (§7: there `vp` is the render worker's).

1. `evaluate_script` with `filePath: <out>/map.json`, returning
   `{ rect: [left, top, width, height] of the canvas getBoundingClientRect(), vp: Array.from(window.__hyperion.cam.viewProjection), dpr: window.devicePixelRatio }`
   — the file is plain JSON. In Mode A `vp` is NOT `cam.viewProjection`: see §7.
2. `take_screenshot` with `filePath: <out>/shot.png`.
3. `python3 .claude/skills/gpu-check/scripts/pixels.py <out>/shot.png <out>/map.json 15.6,4 15.6,2.8`
   or `--line x0,y0:x1,y1:N` for a profile. Coordinates are WORLD units.

`<out>` is a directory inside the repo: the MCP servers write only within their workspace roots,
and on the Mac the session scratchpad (`/private/tmp/...`) was refused with
`Access denied: ... is not within any of the configured workspace roots`. Use the gitignored
`target/gpu-check`; the tools create it.

With animated lights, compare points inside ONE screenshot (e.g. points symmetric about a light),
never across two. To test another canvas aspect, `resize_page`, then re-enter the tab (its setup
reads the size), and restore the size afterwards.

## 7. Mode A (`?mode=A`, the Mac only)

Main thread + engine worker + render worker. Chrome on macOS picks it with `?mode=auto` (checked
on both servers), but the harness forces B by default (`demo/preferred-mode.ts`), so ask for it.
`window.__hyperion.mode` must answer `'A'`: a `'B'` with a white canvas is the fallback failing
silently (look for `[Hyperion] Mode A failed, trying next fallback` or `Render Worker error` in the
console). The canvas belongs to the render worker, so the main thread has no renderer: the adapter
line and every GPU error come from the worker (`list_console_messages` shows them), and there is
no probe, no bloom, no outlines, no particles and no texture loading on the main thread. Load it
like §3, with the anti-reload initScript for a tab run.

**Expected: no `fail` from Mode A itself.** A check that passes in B passes or skips in A. Measured
on 2026-09-30 (M2 Pro, Chrome 154, `13d8c10`, the §4 runner, 35 s): Primitives 0/9 · 9 skipped,
Scene Graph 1/5 · 4 skipped, Input 1/6 · 1 skipped (+ the 4 ⏳), Audio 4/4, Particles 0/4 · 4
skipped, Rendering FX 0/4 · 3 skipped · 1 failed, Lighting 4/6 · 2 skipped, Debug Tools 6/7 · 1
skipped, Lifecycle 1/6 · 5 skipped, 2D Twins 0/6 · 6 skipped. The skips fall in a few classes:
"pixel probe unavailable" (every check that reads pixels: the probe needs a main-thread renderer),
"no renderer" (selection, particles, outlines), "no main-thread renderer" (test textures), the
ones B has too (MSDF atlas, Tonemap stub, determinism hash) and 'Transparent sort under churn'
(Mode C only).

The one fail is a harness bug, not Mode A: 'Bloom' reports
`probe error: Cannot enable bloom: no renderer available`. Since `cd8e398` the check calls
`engine.enableBloom()` before its first probe call, inside `pixelCheck`, which reports every throw
but a probe-unavailable one as a fail; before, the probe threw first and the check skipped (the
run of 2026-09-29: 0/4 · 4 skipped). It should skip in A: until it does, that one fail is expected
there and any other is real.

**Pixels: screenshots only.** No probe, so §6's screenshot path, with `vp` from the render
worker's camera and not from `cam.viewProjection`: the worker has its own `Camera`
(`render-worker.ts`), orthographic 20·aspect × 20, near -1, far 1000, view identity (it never
calls `setPosition`), and neither `engine.cam` nor the tabs' `fitView` reach it. Its aspect is the
one of the last `engine.resize(w, h)`, that is `floor(clientWidth·dpr) / floor(clientHeight·dpr)`,
not `rect.width / rect.height` (the CSS height is fractional: 0.08 % apart on the M2, under a
pixel there). `evaluate_script` with `filePath: <out>/map.json`:

```js
() => {
  const c = document.getElementById('canvas');
  const dpr = window.devicePixelRatio;
  const a = Math.floor(c.clientWidth * dpr) / Math.floor(c.clientHeight * dpr);
  const r = c.getBoundingClientRect();
  return {
    rect: [r.left, r.top, r.width, r.height],
    vp: [1 / (10 * a), 0, 0, 0, 0, 0.1, 0, 0, 0, 0, -1 / 1001, 0, 0, 0, 1 / 1001, 1],
    dpr,
  };
}
```

Checked on the M2 (2026-09-30, `?mode=A&bench`, camera at the origin, zoom 1): three 2D quads at
x = -4, 0, 4 (scale 2: white, a uniform-red gradient, a white `.transparent()`; the scene of M6b in
`docs/handoff/2026-09-29-mac-m2-handoff.md`) sample white 255, (255, 0, 0), white 255, and the
clear 17 at (-4, 1.2), the same as in B. After `engine.cam.position(3, 0, 0)` and `zoom(2)` the
worker's image had not moved: this `vp` still hit all three quads, `cam.viewProjection` missed them.

**An empty world keeps the last image.** The bridge drops render states with no entity
(`worker-bridge.ts`) and the render worker skips a frame at 0 entities (`render-worker.ts`), so
after everything is destroyed the screenshot still shows the last frame, and
`window.__hyperion.bridge.latestRenderState.entityCount` keeps its last non-zero value: the three
quads above still sampled white, red, white 1.2 s after `destroy()`, where B went back to the clear
(17). It is step 10 of the open-items round (`docs/plans/2026-09-27-open-items-round-plan.md`), a
known gap and not a regression: a "gone after destroy" pixel check proves nothing in A, run it in B
or C.

**State that travels by message.** The lighting quality and the sort's inputs (`transparentCount`,
`entityIdsGeneration`) reach the render worker too, and only a screenshot shows it. The Lighting
tab moves its lights every tick, so two of its screenshots never match: build a static scene in
`?mode=A&bench`. The sort, checked on the M2: three overlapping `.transparent()` 2D gradients at
`.depth()` 0.2, 0.5 and 0.8 (red uniform, green to black, blue to black) sample red in front at
(-0.6, 0), (0, 0) and (0.6, 0); after `depth(0.8)` on the red and `depth(0.2)` on the blue, blue is
in front: 202, 126, 51 along its gradient. The quality (README M6c in
`docs/plans/assets/2026-09-29-mac-m2/`, not re-run): `shadowSteps` 4 against 48 on a static lit
scene changes 6.35 % of the canvas.

## Report

One line per tab (`N/M passed`, pending, failed), the adapter, console errors, and any pixel
measurements with the points used. Say explicitly what this did NOT cover: physics, and on the
Fedora box Mode A ("did NOT cover Mode A"). On the Mac Mode A is covered, by screenshots only (§7):
write "Mode A: solo screenshot" instead.

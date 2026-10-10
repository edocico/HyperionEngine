---
name: gpu-check
description: Verify rendering on real WebGPU in the verification harness — rebuild ts/wasm if stale, load the harness on a hardware adapter (AMD iGPU on Fedora, Apple GPU on the Mac), run every tab (or the ones named), report N/M passed, pending checks and console errors, and optionally sample screenshot pixels at world coordinates; also runs a GPU bench session (fresh dev server, asset server, a committed bench). Use after any change to rendering, shaders, the render graph, the command queue or the Rust engine, before calling it done, and for any committed GPU bench or measurement.
---

Headless tests cannot see WebGPU errors; this is the check that can. Arguments (optional): the
tab labels to run, e.g. `/gpu-check Lighting` — default is every tab.

The scripts are in `.claude/skills/gpu-check/scripts/`; each file's header says how to pass it and
what it returns. A committed bench, or any GPU leg whose scripts import app modules, runs as a
**Bench session** (the last section).

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

Run those two lines from the root of the checkout the dev server SERVES, which is the code under
test: in a Bench session that is `gpu-infra.sh`'s root, not necessarily the shell's cwd (`up`
checks that root's `ts/wasm` the same way and prints a `note:` when it is missing or older).

## 2. Dev server

After a `git checkout` / merge / rebase that touched a shader, RESTART it (stop the background task,
start it again): Vite can keep serving a stale transform of `?import&raw` with a 304, and the check
then runs the old shader (2026-09-27: pixel-width lines drew in world units).

```bash
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/
```

Not `200` → start it in the background (Bash `run_in_background`):
`npm --prefix ts run dev -- --strictPort --port 5173`. `scripts/gpu-infra.sh up` restarts it
detached and checks COOP/COEP, with the asset server and caffeinate (Bench session).

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
WITHOUT the low-power adapter initScript (Fedora-only); for the §4 runner pass the anti-reload
initScript (`scripts/anti-reload-init.js`, below). Quote the URL in any shell command (zsh: `?` is
a glob). The adapter line must say Apple and not a fallback:
`apple / metal-3 / 0x0000, subgroups 32-32` on the gpu server (the stock Chrome leaves the device
out: `apple / metal-3, subgroups 32-32`). A reload after a TS edit keeps the adapter (one GPU,
nothing to force) but drops the anti-reload initScript: navigate again with it before a long run.
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
warning), and stops the reload; it touches neither the adapter nor the engine. It is
`scripts/anti-reload-init.js` (from `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-plan.md`,
Task 8): pass the file's whole text as the `initScript` of `navigate_page`.

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

A long run (a §4 runner, a Bench session) needs the anti-reload initScript too (§3 Mac explains
why), and `navigate_page` takes ONE `initScript`: pass one string holding the whole text of
`scripts/anti-reload-init.js` first, then a newline, a semicolon and a newline, then the line
above. Never one of the two alone on this box: without the line the page gets NVIDIA and loses the
device, without the anti-reload script a long run dies at the next close of the HMR socket.

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

`scripts/tab-runner.js` is this runner waiting for the END of each tab's setup (60 s cap, then
600 ms) instead of a fixed time, with `setupMs` and `timedOut` in its answer; the labels to run go
in `window.__tabsOnly`, set by an earlier `evaluate_script` (none: every tab). It imports
`/src/demo/<tab>.ts` to see the setup end, so it wants a dev server started after the last edit
(`gpu-infra.sh up`), best with a `?bench` page, where every setup starts from its click: a section
edited since the server started waits the full 60 s and says `timedOut: true` (its checks still
read right). A setup that really runs past 60 s says `timedOut: true` too, and its checks may not
be finished when they are read: rerun that tab alone.

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

1. `evaluate_script` with the text of `scripts/map-json.js` and `filePath: <out>/map.json`: plain
   JSON with `rect` (the canvas `getBoundingClientRect()` as `[left, top, width, height]`), `vp` and
   `dpr`. `vp` is `cam.viewProjection` in B and C and the render worker's in Mode A (§7); `vpSource`
   says which. It reads `dpr` live: never reuse a number, 2 on the Retina Mac, 1.25 or 1.667 on the
   Fedora box, and screenshot px = CSS px × dpr (a 1200×689 CSS window at dpr 2 gives a 2400×1378
   screenshot).
2. `take_screenshot` with `filePath: <out>/shot.png`.
3. `python3 .claude/skills/gpu-check/scripts/pixels.py <out>/shot.png <out>/map.json 15.6,4 15.6,2.8`
   or `--line x0,y0:x1,y1:N` for a profile. Coordinates are WORLD units. It needs Pillow, so
   `python3` must be a python that has it (`python3 -c "import PIL"` says): on the Mac it is
   Homebrew's (3.14, Pillow 12.3 from `brew install pillow`, no venv), while Apple's
   `/usr/bin/python3` has none and dies with `ModuleNotFoundError: No module named 'PIL'`, which is
   what a shell with a bare PATH gets. If Pillow lives in a venv, call `<venv>/bin/python` instead.

`<out>` is ONE absolute path, the same string for the MCP tools (paste it expanded into `filePath`:
they do not expand `$OUT`) and for `pixels.py`:
`OUT="$(git rev-parse --show-toplevel)/target/gpu-check"`, gitignored, created by the tools. Never a
relative one: chrome-devtools-mcp resolves it against ITS cwd, the main checkout (`lsof -a -p <pid>
-d cwd`), and `pixels.py` against the shell's, so from a worktree `take_screenshot` writes into the
main checkout and `pixels.py` then finds nothing in the worktree. The servers write only within
their workspace roots (the directory the session was opened on, worktrees under `.claude/worktrees/`
included) and `os.tmpdir()` (`$TMPDIR`, `/var/folders/…/T` on the Mac), so `$TMPDIR/gpu-check` works
too; the session scratchpad (`/private/tmp/...`) is outside both and was refused with
`Access denied: ... is not within any of the configured workspace roots`.

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

**Expected: no `fail` from Mode A itself.** A check that passes in B passes or skips in A, and a
`fail` there is real. Measured on 2026-10-10 (M2 Pro, Chrome 155, `83a9b9d`, `?mode=A&bench`, the
§4 runner waiting for the end of each tab's setup instead of 3.5 s): Primitives 0/9 · 9 skipped,
Scene Graph 1/5 · 4 skipped, Input 1/6 · 1 skipped (+ the 4 ⏳), Audio 4/4, Particles 0/4 · 4
skipped, Rendering FX 0/4 · 4 skipped, Lighting 4/12 · 8 skipped, Debug Tools 6/7 · 1 skipped,
Lifecycle 1/6 · 5 skipped, 2D Twins 0/6 · 6 skipped: 17 pass, 42 skips and 4 pending over the 63
checks, no `fail`. The skips fall in a few classes: "pixel probe unavailable" (every check that
reads pixels: the probe needs a main-thread renderer), "no renderer" (selection, particles, bloom,
outlines), "no main-thread renderer" (test textures), the ones B has too (MSDF atlas, Tonemap stub,
determinism hash) and 'Transparent sort under churn' (Mode C only).

'Bloom' skips with `no renderer: Cannot enable bloom: no renderer available`: it turns the bloom
graph on before its first probe, and `pixelCheck` (`demo/probe-checks.ts`) reports that throw as a
skip. A check that calls a renderer-only API outside `pixelCheck` has to skip on "no renderer"
itself, as the Outline check does. From `cd8e398`, which moved `enableBloom` ahead of the first
probe, until `08e2a5d` 'Bloom' was a `fail` in A: on a build in that range that one is known.

**Pixels: screenshots only.** No probe, so §6's screenshot path, with `vp` from the render
worker's camera and not from `cam.viewProjection`: the worker has its own `Camera`
(`render-worker.ts`), orthographic 20·aspect × 20, near -1, far 1000, view identity (it never
calls `setPosition`), and neither `engine.cam` nor the tabs' `fitView` reach it. Its aspect is the
one of the last `engine.resize(w, h)`, that is `floor(clientWidth·dpr) / floor(clientHeight·dpr)`,
not `rect.width / rect.height` (the CSS height is fractional: 0.08 % apart on the M2, under a
pixel there). `scripts/map-json.js` (§6) builds that `vp` whenever `window.__hyperion.mode` is
`'A'`, and keeps `cam.viewProjection` beside it as `vpMainThread`.

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
or C. The same gap leaves the canvas ELEMENT at the HTML default 300 × 150 on a fresh
`?mode=A&bench` page until the render worker presents its first frame (the canvas is transferred to
it): in Mode A read the canvas size after a frame was drawn, never right after a resize (round step
7, 2026-10-10: the same page read 1960 × 1248 once its tabs had drawn; the leg's verdict is
`docs/plans/assets/2026-10-08-step7/legs/task-9c-result.json`).

**State that travels by message.** The lighting quality and the sort's inputs (`transparentCount`,
`entityIdsGeneration`) reach the render worker too, and only a screenshot shows it. The Lighting
tab moves its lights every tick, so two of its screenshots never match: build a static scene in
`?mode=A&bench`. The sort, checked on the M2: three overlapping `.transparent()` 2D gradients at
`.depth()` 0.2, 0.5 and 0.8 (red uniform, green to black, blue to black) sample red in front at
(-0.6, 0), (0, 0) and (0.6, 0); after `depth(0.8)` on the red and `depth(0.2)` on the blue, blue is
in front: 202, 126, 51 along its gradient. The light list's id tie-break (round step 7) needs
`entityIds` in the render worker too: checked by the step-7 bench's `scene` phase 3 in
`?mode=A&bench` (2026-10-10, `83a9b9d`: at equal depths Q, the higher id, is in front of P, with
its slot below P's; A, B and the expected colours equal at 18 of 18 points over the three phases,
`docs/plans/assets/2026-10-08-step7/modeA-vs-B/pixels.json`). The quality (README M6c in
`docs/plans/assets/2026-09-29-mac-m2/`, not re-run): `shadowSteps` 4 against 48 on a static lit
scene changes 6.35 % of the canvas.

## Report

One line per tab (`N/M passed`, pending, failed), the adapter, console errors, and any pixel
measurements with the points used. Say explicitly what this did NOT cover: physics, and on the
Fedora box Mode A ("did NOT cover Mode A"). On the Mac Mode A is covered, by screenshots only (§7):
write "Mode A: solo screenshot" instead.

## Bench session

**When:** a committed bench (`docs/plans/assets/*-bench.js`), or any GPU leg whose scripts
`import('/src/…')` app modules. Such an import gets the app's own module instance only from a dev
server started after the last edit to an app module (CLAUDE.md, the dev-server gotcha), and a bench
runs for minutes with the display awake. From step 1 to step 8, edit no app file: Vite would reload
the page or re-instance the modules under the bench.

**The checkout `gpu-infra.sh` serves is the code under test:** `$HYPERION_ROOT`, else
`$CLAUDE_PROJECT_DIR` (when set, the checkout the session was opened on), else the checkout the
script is in. The page runs THAT checkout's `ts/src` and `ts/wasm`, and the asset server's default
root is its `docs/plans/assets` (a bench committed only in another checkout is a 404 there). To
check a worktree's change, serve the worktree itself: a fresh worktree has neither
`ts/node_modules` nor `ts/wasm`, so run `npm --prefix ts ci` and `npm --prefix ts run build:wasm`
in it first, and §1 there. `HYPERION_ROOT=<another checkout>` runs THAT checkout's code: right only
when the app code does not matter (a check of these scripts), never for a GPU check or a bench of
a change, where the other checkout's branch can report green for code it does not hold. `up`
prints the root, and a `note:` when it is not the script's own checkout or its `ts/wasm` is
missing or older than the Rust sources.

1. **Infrastructure:** `sh .claude/skills/gpu-check/scripts/gpu-infra.sh up [asset-server args]`,
   e.g. `… up --git /old-light-accum.wgsl=1d19575:ts/src/shaders/light-accum.wgsl` to serve a file as
   it is at a revision, with no copy to keep. Give the Bash call `timeout: 300000`: in the worst case
   `up` takes about 3 minutes (each stop waits up to 13 s, Vite up to 60 s, the asset server 30 s),
   past the tool's default 120 s. It starts `caffeinate -dimsu` on the Mac (8 h), restarts that
   checkout's Vite on :5173 and checks COOP/COEP (anything else on :5173 or :8765: it refuses, exit
   1, and changes nothing), then starts `asset-server.py` on 127.0.0.1:8765, serving
   `docs/plans/assets` live (`--map URLPATH=FILE` for another file, `--root DIR`; `asset-server.py
   --help`). Done when it prints `gpu-infra up: ready` and exits 0; `gpu-infra.sh status` checks it
   later. Its state is in `${TMPDIR:-/tmp}/hyperion-gpu-infra-<uid>`, so `status` and `down` find it
   only with the `TMPDIR` of `up`: the last line `up` prints is the `down` command with it.
2. **Page:** `navigate_page` with `type: "url"`, the page the bench header names (usually
   `"http://localhost:5173/?mode=B&bench"`), `ignoreCache: true`, and as `initScript` the whole text
   of `scripts/anti-reload-init.js`. On the Fedora box (`uname -s` says `Linux`) `navigate_page`
   still takes ONE `initScript`: that text first, then a newline, a semicolon and a newline, then
   §3's low-power adapter line (without it the page gets NVIDIA and loses the device). Then
   `resize_page` if the plan or the bench names a window.
3. **Adapter line** (§3), before anything else.
4. **Bench spec:** `evaluate_script` with
   `() => { window.__benchSpec = { bench: '/<bench file>', globals: { <NAME>: '/<path>' } }; return window.__benchSpec; }`
   naming the globals the bench header reads; round step 7's is
   `{ bench: '/2026-10-08-step7-light-order-bench.js', globals: { __step7OldLightAccum: '/old-light-accum.wgsl' } }`.
5. **Load:** `evaluate_script` with the text of `scripts/load-bench.js`, once per page load. Done
   when `benchType` is `'function'` and every global has `status` 200 and the `sha256` of its source
   (`shasum -a 256 <file>`, or `git show <rev>:<path> | shasum -a 256`; on Linux `sha256sum`, from
   coreutils: `shasum` is a Perl script that a Fedora install may lack).
6. **Run** each task as the bench header says, usually `window.__benchOpts = { task, label, … }`
   then `async () => await window.__benchFn()` with an absolute `filePath` inside the repo. A tab
   run in the same session uses `scripts/tab-runner.js` (§4).
7. **Each page ends** with `window.__viteWsCloses` at `[]` and a console (§5) holding only the
   `favicon.ico` 404.
8. **Down:** `sh .claude/skills/gpu-check/scripts/gpu-infra.sh down`, with the `TMPDIR` of `up`
   (the command `up` printed last), stops exactly what `up` started, each pid re-checked against its
   command and start time, and nothing else. With another `TMPDIR` it finds no state and stops
   nothing.

Report the `up` summary, and per page its adapter line, `load-bench.js`'s answer, the evidence
files, `window.__viteWsCloses` and the console.

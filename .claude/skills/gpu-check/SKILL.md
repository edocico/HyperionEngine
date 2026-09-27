---
name: gpu-check
description: Verify rendering on real WebGPU in the verification harness — rebuild ts/wasm if stale, load the harness on the AMD adapter, run every tab (or the ones named), report N/M passed, pending checks and console errors, and optionally sample screenshot pixels at world coordinates. Use after any change to rendering, shaders, the render graph, the command queue or the Rust engine, before calling it done.
---

Headless tests cannot see WebGPU errors; this is the check that can. Arguments (optional): the
tab labels to run, e.g. `/gpu-check Lighting` — default is every tab.

## 1. The WASM must be the current engine

The harness imports `ts/wasm/hyperion_core.js` (`build:wasm`: default features, **no physics-2d**).

```bash
find crates/hyperion-core/src crates/hyperion-core/Cargo.toml -newer ts/wasm/hyperion_core_bg.wasm \( -name '*.rs' -o -name Cargo.toml \) | head -3
```

Any output → `npm --prefix ts run build:wasm` first. Physics behaviour is not in this build at all:
verify it with `cargo test -p hyperion-core --features physics-2d --test verify_physics`.

## 2. Dev server

After a `git checkout` / merge / rebase that touched a shader, RESTART it (stop the background task,
start it again): Vite can keep serving a stale transform of `?import&raw` with a 304, and the check
then runs the old shader (2026-09-27: pixel-width lines drew in world units).

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/
```

Not `200` → start it in the background (Bash `run_in_background`):
`npm --prefix ts run dev -- --strictPort --port 5173`.

## 3. Load the harness on the AMD adapter

Use the **chrome-devtools-gpu** server (the one launched with the Vulkan flags). On this machine the
NVIDIA adapter cannot present to a canvas, so force the low-power one — `navigate_page` with
`type: "url"`, `url: "http://localhost:5173/?mode=B"`, `ignoreCache: true` and this `initScript`:

```js
GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
```

Then read the adapter line (`list_console_messages`, types `log`/`info`/`warn`): it must say AMD,
not nvidia and not a software fallback (SwiftShader). Mode A cannot be checked here: the initScript
does not reach workers, which then pick NVIDIA and lose the device.

The initScript applies to ONE navigation. An edit Vite cannot hot-swap — any TS module, a demo
section included — reloads the page without it: the reload gets NVIDIA and loses the device at its
first large allocation (`VK_ERROR_OUT_OF_DEVICE_MEMORY`, every check "Device is lost"). That is not
a leak: `navigate_page` again with the initScript and re-read the adapter line. The tell is a new
`[vite] connecting...` and a second adapter line in the console. An edit to one of the 18
hot-reloadable WGSL files (`import.meta.hot.accept` in `renderer.ts`) is swapped in place and the
page stays: keep it when the shader hot-reload is what you are checking.

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
      failed: leaves.filter((n) => /^[✗×]/.test(n.textContent.trim())).map((n) => n.parentElement.textContent.trim().slice(0, 100)),
      pending: leaves.filter((n) => /^⏳/.test(n.textContent.trim())).map((n) => n.parentElement.textContent.trim().slice(0, 60)),
    };
  }
  return out;
}
```

Expected today (2026-09-27, the checks read pixels through the probe): every tab green except
**Input at 2/6** — its 4 checks wait for real keyboard/click/pointer/scroll input (⏳), which is
not a regression. Primitives (MSDF), Rendering FX (Tonemap stub) and Debug Tools each skip one
check. In Mode A the pixel checks skip ("pixel probe unavailable"). Lighting, Rendering FX and
Lifecycle take a few seconds: wait ~7 s on them. **2D Twins** (3/3) is the one check of scatter
format 0: run it once with `?mode=C`, where its row check must report scatter frames (Mode B
uploads every row, so there it reports 0). `window.__hyperion` is the live facade for anything the
tabs do not check.

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
cannot see: DOM overlays, and anything in Mode A.


1. `evaluate_script` with `filePath: <scratchpad>/map.json`, returning
   `{ rect: [left, top, width, height] of the canvas getBoundingClientRect(), vp: Array.from(window.__hyperion.cam.viewProjection), dpr: window.devicePixelRatio }`
   — the file is plain JSON.
2. `take_screenshot` with `filePath: <scratchpad>/shot.png`.
3. `python3 .claude/skills/gpu-check/scripts/pixels.py shot.png map.json 15.6,4 15.6,2.8`
   or `--line x0,y0:x1,y1:N` for a profile. Coordinates are WORLD units.

With animated lights, compare points inside ONE screenshot (e.g. points symmetric about a light),
never across two. To test another canvas aspect, `resize_page`, then re-enter the tab (its setup
reads the size), and restore the size afterwards.

## Report

One line per tab (`N/M passed`, pending, failed), the adapter, console errors, and any pixel
measurements with the points used. Say explicitly what this did NOT cover: Mode A, and physics.

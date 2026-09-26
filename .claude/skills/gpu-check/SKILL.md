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

Expected today: every tab green except **Input at 2/6** — its 4 checks wait for real
keyboard/click/pointer/scroll input (⏳), which is not a regression. Primitives and Debug Tools
each skip one check. `window.__hyperion` is the live facade for anything the tabs do not check.

## 5. Console

`list_console_messages` with types `error` and `warn`. A `404` is only acceptable for
`favicon.ico` — confirm with `list_network_requests`. LeakDetector warnings about undisposed
EntityHandles after a tab switch are a known, pre-existing demo issue. Anything mentioning
WebGPU, validation, a pipeline or a device is a failure.

## 6. Pixels (when the question is "does it LOOK right")

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

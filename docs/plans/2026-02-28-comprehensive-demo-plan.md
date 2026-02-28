# Comprehensive Feature Demo — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `ts/src/main.ts` with a tab-based, multi-file verification harness that covers 100% of Hyperion's features with ~40 auto-checks and a downloadable JSON report.

**Architecture:** Single Hyperion instance, 10 files under `ts/src/demo/` (types, report, 8 sections). Each section implements `DemoSection` interface with `setup()`/`teardown()`. `main.ts` manages tab bar DOM, section switching, and check panel. Dynamic imports for lazy loading.

**Tech Stack:** TypeScript (Vite), pure DOM (no UI framework), existing Hyperion APIs.

**Design doc:** `docs/plans/2026-02-28-comprehensive-demo-design.md`

---

## Task 1: Demo Types

**Files:**
- Create: `ts/src/demo/types.ts`
- Test: `ts/src/demo/types.test.ts`

**Step 1: Write the test**

```ts
// ts/src/demo/types.test.ts
import { describe, it, expect } from 'vitest';
import type { DemoSection, TestResult, SectionReport } from './types';
import { createTestReporter } from './types';

describe('DemoSection types', () => {
  it('createTestReporter records pass/fail/skip', () => {
    const reporter = createTestReporter();
    reporter.check('quad grid', true, '25 entities');
    reporter.check('lines', false, 'missing');
    reporter.skip('msdf text', 'no atlas');
    const results = reporter.results();
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ name: 'quad grid', status: 'pass', detail: '25 entities' });
    expect(results[1]).toEqual({ name: 'lines', status: 'fail', detail: 'missing' });
    expect(results[2]).toEqual({ name: 'msdf text', status: 'skip', detail: 'no atlas' });
  });

  it('pending transitions to pass/fail', () => {
    const reporter = createTestReporter();
    reporter.pending('bloom');
    expect(reporter.results()[0].status).toBe('pending');
    reporter.check('bloom', true);
    expect(reporter.results()[0].status).toBe('pass');
  });

  it('sectionStatus computes overall status', () => {
    const reporter = createTestReporter();
    reporter.check('a', true);
    reporter.check('b', true);
    expect(reporter.sectionStatus()).toBe('pass');
    reporter.check('c', false);
    expect(reporter.sectionStatus()).toBe('fail');
  });

  it('sectionStatus is partial when mix of pass and skip', () => {
    const reporter = createTestReporter();
    reporter.check('a', true);
    reporter.skip('b', 'n/a');
    expect(reporter.sectionStatus()).toBe('partial');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/demo/types.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// ts/src/demo/types.ts
import type { Hyperion } from '../hyperion';

export interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'pending';
  detail?: string;
}

export type SectionStatus = 'not-run' | 'pass' | 'fail' | 'partial';

export interface SectionReport {
  status: SectionStatus;
  checks: TestResult[];
}

export interface TestReporter {
  check(name: string, passed: boolean, detail?: string): void;
  skip(name: string, reason: string): void;
  pending(name: string): void;
  results(): TestResult[];
  sectionStatus(): SectionStatus;
}

export interface DemoSection {
  readonly name: string;
  readonly label: string;
  setup(engine: Hyperion, reporter: TestReporter): Promise<void>;
  teardown(engine: Hyperion): void;
}

export function createTestReporter(): TestReporter {
  const results: TestResult[] = [];

  return {
    check(name: string, passed: boolean, detail?: string) {
      const existing = results.find(r => r.name === name);
      const entry: TestResult = { name, status: passed ? 'pass' : 'fail', detail };
      if (existing) {
        Object.assign(existing, entry);
      } else {
        results.push(entry);
      }
    },
    skip(name: string, reason: string) {
      results.push({ name, status: 'skip', detail: reason });
    },
    pending(name: string) {
      results.push({ name, status: 'pending' });
    },
    results() {
      return results;
    },
    sectionStatus(): SectionStatus {
      if (results.length === 0) return 'not-run';
      const hasAnyFail = results.some(r => r.status === 'fail');
      if (hasAnyFail) return 'fail';
      const hasSkipOrPending = results.some(r => r.status === 'skip' || r.status === 'pending');
      const hasPass = results.some(r => r.status === 'pass');
      if (hasPass && hasSkipOrPending) return 'partial';
      if (hasPass) return 'pass';
      return 'partial';
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/demo/types.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add ts/src/demo/types.ts ts/src/demo/types.test.ts
git commit -m "feat(demo): add DemoSection types and TestReporter"
```

---

## Task 2: Report System

**Files:**
- Create: `ts/src/demo/report.ts`
- Test: `ts/src/demo/report.test.ts`

**Step 1: Write the test**

```ts
// ts/src/demo/report.test.ts
import { describe, it, expect } from 'vitest';
import { ReportBuilder } from './report';

describe('ReportBuilder', () => {
  it('builds report JSON', () => {
    const builder = new ReportBuilder('B', 'test-agent');
    builder.addSection('primitives', {
      status: 'pass',
      checks: [
        { name: 'Quad grid', status: 'pass', detail: '25 entities' },
        { name: 'MSDF text', status: 'skip', detail: 'no atlas' },
      ],
    });
    builder.addSection('audio', {
      status: 'fail',
      checks: [
        { name: 'Load sound', status: 'fail', detail: 'fetch error' },
      ],
    });
    const report = builder.build();
    expect(report.engine).toBe('hyperion');
    expect(report.mode).toBe('B');
    expect(report.summary.total).toBe(3);
    expect(report.summary.pass).toBe(1);
    expect(report.summary.fail).toBe(1);
    expect(report.summary.skip).toBe(1);
  });

  it('toJSON returns valid JSON string', () => {
    const builder = new ReportBuilder('C', 'agent');
    const json = builder.toJSON();
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/demo/report.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// ts/src/demo/report.ts
import type { SectionReport, TestResult } from './types';

export interface DemoReport {
  engine: 'hyperion';
  timestamp: string;
  mode: string;
  userAgent: string;
  sections: Record<string, SectionReport>;
  summary: { total: number; pass: number; fail: number; skip: number };
}

export class ReportBuilder {
  private readonly sections = new Map<string, SectionReport>();

  constructor(
    private readonly mode: string,
    private readonly userAgent: string,
  ) {}

  addSection(name: string, report: SectionReport): void {
    this.sections.set(name, report);
  }

  build(): DemoReport {
    const allChecks: TestResult[] = [];
    const sections: Record<string, SectionReport> = {};
    for (const [name, report] of this.sections) {
      sections[name] = report;
      allChecks.push(...report.checks);
    }
    return {
      engine: 'hyperion',
      timestamp: new Date().toISOString(),
      mode: this.mode,
      userAgent: this.userAgent,
      sections,
      summary: {
        total: allChecks.length,
        pass: allChecks.filter(c => c.status === 'pass').length,
        fail: allChecks.filter(c => c.status === 'fail').length,
        skip: allChecks.filter(c => c.status === 'skip').length,
      },
    };
  }

  toJSON(): string {
    return JSON.stringify(this.build(), null, 2);
  }

  download(): void {
    const json = this.toJSON();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const filename = `hyperion-report-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/demo/report.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add ts/src/demo/report.ts ts/src/demo/report.test.ts
git commit -m "feat(demo): add ReportBuilder with JSON export and download"
```

---

## Task 3: Main Entry Point + HTML Layout

**Files:**
- Modify: `ts/index.html`
- Rewrite: `ts/src/main.ts`

**Step 1: Update index.html**

Replace `ts/index.html` with the new layout (tab bar, canvas area, check panel sidebar, instructions bar). See design doc for layout diagram.

Key DOM elements:
- `#tab-bar` — horizontal tab strip
- `#canvas-area` with `#overlay`, `canvas#canvas`, `#instructions`
- `#check-panel` with `#check-list` and `#check-summary`

**Step 2: Rewrite main.ts**

Core responsibilities:
- Create Hyperion instance, resize handler, start game loop
- Build tab bar DOM from section list using `createElement` + `textContent` (NO innerHTML)
- Dynamic import sections from `./demo/*.ts`
- `switchSection(key)`: teardown current → load new → setup → render check panel
- `renderCheckPanel(reporter)`: clear children with `while (el.firstChild) el.removeChild(el.firstChild)`, rebuild with createElement
- Periodic check panel refresh (500ms interval) for async checks
- "Export Report" button triggers `ReportBuilder.download()`
- HUD overlay via `frameEnd` hook showing mode/FPS/entity count

**IMPORTANT:** All DOM manipulation must use `createElement` + `textContent`. No `innerHTML` assignment. Use `while (parent.firstChild) parent.removeChild(parent.firstChild)` to clear containers.

**Step 3: Verify visually**

Run: `cd ts && npm run dev`
Open http://localhost:5173 — should see tab bar at top, canvas center, check panel right.

**Step 4: Commit**

```bash
git add ts/index.html ts/src/main.ts
git commit -m "feat(demo): rewrite main.ts with tab bar, check panel, and report export"
```

---

## Task 4: Primitives Section

**Files:**
- Create: `ts/src/demo/primitives.ts`

**What it tests (6 checks):**
1. Quad grid (5×5) — `entityCount >= 25`
2. Gradients (3 types) — linear, radial, conic created
3. Box shadows (3 variants) — sharp, soft, rounded created
4. Lines — 6 vertical + 4 horizontal
5. Bezier curves — arch, S-curve, wave
6. MSDF text — skip (no font atlas in demo assets)

**Implementation pattern:**
- Track all spawned entities in a module-level `entities: EntityHandle[]` array
- `setup()`: spawn entities using Hyperion's fluent API, call `report.check()` after each group
- `teardown()`: destroy all entities, reset camera
- Export as `default` for dynamic import

**Key API calls:**
- `engine.spawn().position(x,y,z).scale(sx,sy,sz)` — Quad
- `.gradient(type, angle, params)` — Gradient (types: 0=linear, 1=radial, 2=conic)
- `.boxShadow(rectW, rectH, cornerRadius, blur, r, g, b, a)` — BoxShadow
- `.line(x0, y0, x1, y1, width)` — Line
- `.bezier(p0x, p0y, p1x, p1y, p2x, p2y, width)` — Bezier

**Commit:**

```bash
git add ts/src/demo/primitives.ts
git commit -m "feat(demo): add Primitives section (quads, lines, gradients, shadows, beziers)"
```

---

## Task 5: Scene Graph Section

**Files:**
- Create: `ts/src/demo/scene-graph.ts`

**What it tests (5 checks):**
1. Parent/child hierarchy — spawn parent + 2 children with `.parent(parentId)`
2. Velocity — entity with `.velocity(2, 0, 0)`, verify position changes via SystemViews in postTick hook
3. Rotation — entity with `.rotation(0, 0, sinZ, cosZ)` (quaternion for 45° Z-rotation)
4. Scale — 4 entities with different scales (0.5, 1, 2, 3×1)
5. Nested transforms — 3-level hierarchy (grandparent → mid → leaf)

**Implementation notes:**
- Velocity check is async: register a `postTick` hook that reads `views.transforms[i*16+12]` (column 3 X), check if position changed from initial. Report pass when detected.
- Track hooks in `hooks[]` array for cleanup in `teardown()`.
- Rotation uses quaternion: for Z-axis angle θ, quat = `(0, 0, sin(θ/2), cos(θ/2))`.

**Key API calls:**
- `.parent(parentId)` — Set parent for scene graph
- `.velocity(vx, vy, vz)` — Physics velocity
- `.rotation(x, y, z, w)` — Quaternion rotation
- `engine.addHook('postTick', fn)` / `engine.removeHook('postTick', fn)`

**Commit:**

```bash
git add ts/src/demo/scene-graph.ts
git commit -m "feat(demo): add Scene Graph section (parenting, velocity, rotation, scale)"
```

---

## Task 6: Input & Selection Section

**Files:**
- Create: `ts/src/demo/input.ts`

**What it tests (6 checks):**
1. Keyboard callback — `engine.input.onKey('*', fn)`, transitions from pending to pass on any keypress
2. Click callback — `engine.input.onClick(fn)`, transitions on click
3. Pointer move callback — `engine.input.onPointerMove(fn)`, transitions on mouse move
4. Scroll callback — `engine.input.onScroll(fn)`, transitions on scroll
5. Hit testing — `engine.picking.hitTest(0, 0)`, auto-verify API doesn't throw
6. Selection toggle — `engine.selection.select(id)` → `isSelected()` → `toggle()` → `clear()`, auto-verify

**Implementation notes:**
- Checks 1-4 are interactive (pending until user performs action). The 500ms check panel refresh in main.ts will pick up state changes.
- Track all `Unsubscribe` functions returned by `onKey/onClick/onPointerMove/onScroll` for cleanup.
- Selection may be null if no renderer — skip in that case.

**Key API calls:**
- `engine.input.onKey('*', fn): Unsubscribe`
- `engine.input.onClick(fn): Unsubscribe`
- `engine.input.onPointerMove(fn): Unsubscribe`
- `engine.input.onScroll(fn): Unsubscribe`
- `engine.picking.hitTest(pixelX, pixelY): number | null`
- `engine.selection?.select(id)` / `.isSelected(id)` / `.toggle(id)` / `.clear()`

**Commit:**

```bash
git add ts/src/demo/input.ts
git commit -m "feat(demo): add Input & Selection section (keyboard, pointer, scroll, hit-test)"
```

---

## Task 7: Audio Section

**Files:**
- Create: `ts/src/demo/audio.ts`

**What it tests (4 checks):**
1. Load sound — `engine.audio.load('sfx/click.ogg')`, skip if file not found
2. Play sound — `engine.audio.play(handle, { volume: 0.5 })`, check PlaybackId returned
3. Spatial position — `engine.audio.setSoundPosition(id, 5, 0)`, verify no throw
4. Suspend/resume — `engine.audio.suspend()` → `engine.audio.resume()`, verify no throw

**Implementation notes:**
- Audio requires user gesture for AudioContext. Since `load()` lazily creates context, this section may trigger browser's audio autoplay policy. The checks handle errors gracefully.
- If `sfx/click.ogg` doesn't exist, all audio-dependent checks skip.
- `teardown()` calls `engine.audio.stopAll()`.

**Key API calls:**
- `engine.audio.load(url): Promise<SoundHandle>`
- `engine.audio.play(handle, opts?): PlaybackId | null`
- `engine.audio.setSoundPosition(id, x, y)`
- `engine.audio.suspend(): Promise<void>` / `engine.audio.resume(): Promise<void>`
- `engine.audio.stopAll()`

**Commit:**

```bash
git add ts/src/demo/audio.ts
git commit -m "feat(demo): add Audio section (load, play, spatial, lifecycle)"
```

---

## Task 8: Particles Section

**Files:**
- Create: `ts/src/demo/particles.ts`

**What it tests (4 checks):**
1. Create emitter — `engine.createParticleEmitter(config, entityId)`, check handle not null
2. Multiple emitters — create 3 emitters with different colors, verify all handles valid
3. Destroy emitter — `engine.destroyParticleEmitter(handle)`, verify no throw
4. Entity tracking — move anchor entity, particles should follow (auto-pass: API call succeeds)

**Implementation notes:**
- `createParticleEmitter()` returns `null` if no renderer (Mode A main thread). Skip all checks in that case.
- Each emitter needs an anchor entity for position tracking.
- `teardown()` destroys all emitters then all entities.

**Key API calls:**
- `engine.createParticleEmitter(config: Partial<ParticleEmitterConfig>, entityId?: number): ParticleHandle | null`
- `engine.destroyParticleEmitter(handle)`
- Anchor entity: `engine.spawn().position(x, y, 0)`

**Commit:**

```bash
git add ts/src/demo/particles.ts
git commit -m "feat(demo): add Particles section (emitters, lifecycle, tracking)"
```

---

## Task 9: Rendering FX Section

**Files:**
- Create: `ts/src/demo/rendering-fx.ts`

**What it tests (4 checks):**
1. Bloom toggle — `enableBloom()` → `disableBloom()` → `enableBloom()`, no throw
2. Outline toggle — `enableOutlines()` with entity selected, verify mutual exclusion with bloom
3. Tonemap switch — `enablePostProcessing()` cycling aces/pbr-neutral/none (may be stub — skip if not implemented)
4. Resize — `engine.resize(800, 600)` → restore, no crash

**Implementation notes:**
- Bloom and outlines are mutually exclusive. Enabling bloom disables outlines and vice versa.
- `enablePostProcessing` may be a stub — catch and skip if it throws.
- Needs `canvas` reference for resize test — use `document.getElementById('canvas')`.
- Skip renderer-dependent checks if running headless.

**Key API calls:**
- `engine.enableBloom(config?)` / `engine.disableBloom()`
- `engine.enableOutlines(options)` / `engine.disableOutlines()`
- `engine.enablePostProcessing(options)` — may be stub
- `engine.resize(width, height)`
- `engine.selection?.select(id)` — for outline visibility

**Commit:**

```bash
git add ts/src/demo/rendering-fx.ts
git commit -m "feat(demo): add Rendering FX section (bloom, outlines, tonemap, resize)"
```

---

## Task 10: Debug Tools Section

**Files:**
- Create: `ts/src/demo/debug-tools.ts`

**What it tests (5 checks):**
1. Profiler overlay — `engine.enableProfiler({ position: 'bottom-right' })`, verify call succeeds
2. Bounds visualizer — `engine.use(boundsVisualizerPlugin())`, verify plugin installs
3. ECS Inspector — `engine.use(ecsInspectorPlugin({ toggleKey: 'F12' }))`, verify installs
4. Debug camera — `engine.use(debugCameraPlugin({ enableKey: 'F1' }))`, verify installs
5. Time-travel record — `engine.debug.startRecording()` → wait 200ms → `stopRecording()`, check tape

**Implementation notes:**
- Track installed plugin names in `pluginNames[]` for cleanup via `engine.unuse(name)`.
- `teardown()` must `disableProfiler()` and `unuse()` all plugins.
- Bounds visualizer requires renderer — catch and skip if not available.
- Time-travel recording may capture 0 entries if no commands are issued during the 200ms window — that's still a pass (API functional).

**Key API calls:**
- `engine.enableProfiler(config?)` / `engine.disableProfiler()`
- `engine.use(plugin)` / `engine.unuse(name)`
- `boundsVisualizerPlugin()`, `ecsInspectorPlugin(opts)`, `debugCameraPlugin(opts)`
- `engine.debug.startRecording()` / `engine.debug.stopRecording(): CommandTape | null`

**Imports:**
```ts
import { boundsVisualizerPlugin } from '../debug/bounds-visualizer';
import { debugCameraPlugin } from '../debug/debug-camera';
import { ecsInspectorPlugin } from '../debug/ecs-inspector';
```

**Commit:**

```bash
git add ts/src/demo/debug-tools.ts
git commit -m "feat(demo): add Debug Tools section (profiler, bounds, inspector, time-travel)"
```

---

## Task 11: Lifecycle & DX Section

**Files:**
- Create: `ts/src/demo/lifecycle.ts`

**What it tests (6 checks):**
1. Spawn + destroy — `spawn()`, check `alive === true`, `.destroy()`, check `alive === false`
2. Batch operation — `engine.batch(() => spawn 50)`, verify count === 50
3. Compact — destroy 25, call `engine.compact({ entityMap: true, renderState: true })`, verify no throw
4. Immediate mode — `.positionImmediate(x, y, z)` + `.clearImmediate()`, verify no throw
5. EntityHandle.data() — `.data('key', 42)`, read back `.data('key') === 42`
6. Prefab lifecycle — `register` → `spawn` → `moveTo` → `destroyAll` → `unregister`, full cycle

**Implementation notes:**
- `teardown()` must check `e.alive` before calling `e.destroy()` (some entities already destroyed as part of tests).
- Prefab registration should use a unique name (e.g., `'demo-test'`) and unregister in teardown.
- Compact test: spawn 50, destroy 25, compact, verify remaining 25 still visible.

**Key API calls:**
- `engine.spawn(): EntityHandle` / `.destroy()` / `.alive`
- `engine.batch(fn)`
- `engine.compact(opts?)`
- `.positionImmediate(x, y, z)` / `.clearImmediate()`
- `.data(key, value)` / `.data(key)`
- `engine.prefabs.register(name, template)` / `.spawn(name, overrides)` / `.unregister(name)`
- `PrefabInstance.moveTo(x, y)` / `.destroyAll()` / `.child(key)` / `.childNames`

**Commit:**

```bash
git add ts/src/demo/lifecycle.ts
git commit -m "feat(demo): add Lifecycle section (spawn/destroy, batch, compact, immediate, prefabs)"
```

---

## Task 12: Run Full Validation Pipeline

**Step 1: Run TypeScript type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No errors (ignoring WASM import warnings)

**Step 2: Run all tests**

Run: `cd ts && npm test`
Expected: All tests pass (590+ existing + new demo/types.test.ts + demo/report.test.ts)

**Step 3: Visual verification**

Run: `cd ts && npm run dev`
Open http://localhost:5173 and:
1. Click through all 8 tabs
2. Verify each section shows correct entities
3. Verify check panel updates (green/red/yellow/gray)
4. Verify tab badges update after visiting each section
5. Click "Export Report" — JSON file downloads
6. Inspect JSON file contents

**Step 4: Fix any issues found**

Address any type errors, runtime errors, or visual glitches discovered during verification.

**Step 5: Commit fixes**

```bash
git add -u
git commit -m "fix(demo): address issues found during visual verification"
```

---

## Task 13: Final Integration Commit

**Step 1: Verify full pipeline**

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: All pass

**Step 2: Commit milestone**

```bash
git add .
git commit -m "milestone: comprehensive feature demo with 40+ auto-checks and JSON report"
```

---

## Summary

| Task | Files | Checks | Description |
|------|-------|--------|-------------|
| 1 | types.ts + test | — | DemoSection interface, TestReporter |
| 2 | report.ts + test | — | ReportBuilder, JSON export, download |
| 3 | main.ts + index.html | — | Tab bar, section switching, check panel |
| 4 | primitives.ts | 6 | Quad, Line, Gradient, BoxShadow, Bezier, MSDF |
| 5 | scene-graph.ts | 5 | Parent/child, rotation, velocity, scale, nested |
| 6 | input.ts | 6 | Keyboard, click, pointer, scroll, hit-test, selection |
| 7 | audio.ts | 4 | Load, play, spatial, suspend/resume |
| 8 | particles.ts | 4 | Create, multiple, destroy, tracking |
| 9 | rendering-fx.ts | 4 | Bloom, outlines, tonemap, resize |
| 10 | debug-tools.ts | 5 | Profiler, bounds, inspector, debug-cam, time-travel |
| 11 | lifecycle.ts | 6 | Spawn/destroy, batch, compact, immediate, data(), prefabs |
| 12 | — | — | Type-check + tests + visual verification |
| 13 | — | — | Full pipeline + milestone commit |

**Total: 40 auto-checks, 13 tasks, 10 new files + 2 modified.**

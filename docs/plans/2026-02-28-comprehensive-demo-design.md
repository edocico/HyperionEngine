# Comprehensive Feature Demo — Design Document

**Date:** 2026-02-28
**Status:** Phase 10c-DX complete, pausing engine development for consolidation.

## Goal

Replace the current `main.ts` demo with a comprehensive, tab-based feature verification harness that:
1. Covers 100% of Hyperion's current features, visually and programmatically.
2. Auto-verifies where possible (entity counts, callback firing, handle validity).
3. Produces a downloadable JSON report for debugging session tracking.
4. Serves as a living regression test that evolves with the engine.

## Architecture

**Approach:** Multi-file with dynamic imports. Each section is a self-contained module under `ts/src/demo/`. A single Hyperion instance is shared; sections set up and tear down their scenes.

### File Structure

```
ts/src/
├── main.ts                    # Tab bar + TestRunner + report system + Hyperion init
├── demo/
│   ├── types.ts               # DemoSection interface, TestResult, TestReporter
│   ├── report.ts              # TestReport builder, JSON export, file download
│   ├── primitives.ts          # Quad, Line, Gradient, BoxShadow, Bezier, MSDF
│   ├── scene-graph.ts         # Parenting, rotation, velocity, scale, nested transforms
│   ├── input.ts               # Keyboard, click, pointer, scroll, hit-test, selection
│   ├── audio.ts               # Load, play, spatial, suspend/resume
│   ├── particles.ts           # Single + multiple emitters, destroy, entity tracking
│   ├── rendering-fx.ts        # Bloom, outlines (toggle), tonemap, resize
│   ├── debug-tools.ts         # Profiler, ECS Inspector, Debug Camera, Bounds Viz, time-travel
│   └── lifecycle.ts           # Spawn/destroy, batch, compact, immediate mode, data(), prefabs
```

### Core Interface

```ts
interface DemoSection {
  name: string;
  setup(engine: Hyperion, report: TestReporter): Promise<void>;
  teardown(engine: Hyperion): void;
}

interface TestReporter {
  check(name: string, passed: boolean, detail?: string): void;
  skip(name: string, reason: string): void;
  pending(name: string): void;
}

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'pending';
  detail?: string;
}
```

### Lifecycle

1. `main.ts` creates Hyperion instance and tab bar DOM.
2. Clicking a tab calls `currentSection.teardown(engine)`, then `newSection.setup(engine, reporter)`.
3. Each `setup()` spawns entities, registers hooks, runs auto-checks, reports results.
4. Each `teardown()` cleans up (destroys entities, removes hooks, unuses plugins).
5. "Export Report" downloads the full JSON.

## Section Details

### Tab 1: Primitives (6 checks)

| Check | Type | Assertion |
|-------|------|-----------|
| Quad grid (5×5) | Auto | `entityCount >= 25` |
| Lines (V + H) | Auto | Line-type entities exist |
| Gradients (3 types) | Auto | 3 gradient entities created |
| Box shadows (3 variants) | Auto | 3 box shadow entities |
| Bezier curves (3 shapes) | Auto | 3 bezier entities |
| MSDF text | Auto/Skip | Text entity spawned, or skip "no atlas" |

### Tab 2: Scene Graph (5 checks)

| Check | Type | Assertion |
|-------|------|-----------|
| Parent/child hierarchy | Auto | Child entity's parent matches expected |
| Rotation | Auto | Transform matrix changes over ticks |
| Velocity | Auto | Position changes after N ticks |
| Scale | Auto | Transform matrix diagonal reflects scale |
| Nested transforms | Auto | Child of rotated parent propagates correctly |

### Tab 3: Input & Selection (6 checks)

| Check | Type | Assertion |
|-------|------|-----------|
| Keyboard state | Auto | Simulate keydown, check `isKeyDown` |
| Click callback | Auto | Dispatch click, verify callback fires |
| Pointer move | Auto | Dispatch pointermove, verify callback |
| Scroll | Auto | Dispatch wheel, verify callback |
| Hit testing | Auto | Spawn at known pos, hit test returns entity |
| Selection toggle | Auto | Select/deselect, check `selection.has(id)` |

### Tab 4: Audio (4 checks)

| Check | Type | Assertion |
|-------|------|-----------|
| Load sound | Auto/Skip | Handle returned or skip if no .ogg |
| Play sound | Auto | PlaybackId returned |
| Spatial position | Auto | `setSoundPosition` doesn't throw |
| Suspend/resume | Auto | Lifecycle completes without error |

### Tab 5: Particles (4 checks)

| Check | Type | Assertion |
|-------|------|-----------|
| Create emitter | Auto | ParticleHandle is not null |
| Multiple emitters | Auto | 3 handles all valid |
| Destroy emitter | Auto | Handle invalidated |
| Entity tracking | Auto | Move entity, particles follow |

### Tab 6: Rendering FX (4 checks)

| Check | Type | Assertion |
|-------|------|-----------|
| Bloom toggle | Auto | enable/disable without error |
| Outline toggle | Auto | enable/disable, mutual exclusion with bloom |
| Tonemap switch | Auto | Cycle modes without error |
| Resize | Auto | Resize canvas, no crashes |

### Tab 7: Debug Tools (5 checks)

| Check | Type | Assertion |
|-------|------|-----------|
| Profiler overlay | Auto | DOM element created by enableProfiler() |
| Bounds visualizer | Auto | Plugin loads without error |
| ECS Inspector | Auto | Plugin loads, panel DOM exists |
| Debug camera | Auto | Plugin loads without error |
| Time-travel record | Auto | Start/stop recording, tape.entries.length > 0 |

### Tab 8: Lifecycle & DX (6 checks)

| Check | Type | Assertion |
|-------|------|-----------|
| Spawn + destroy | Auto | Entity exists after spawn, gone after destroy |
| Batch operation | Auto | `batch(() => spawn 100)`, count matches |
| Compact | Auto | Spawn+destroy many, compact shrinks map |
| Immediate mode | Auto | `positionImmediate()` updates position without tick |
| EntityHandle.data() | Auto | `.data('k', v)` read back matches |
| Prefab lifecycle | Auto | register → spawn → moveTo → destroyAll |

**Total: ~40 auto-checks across 8 tabs.**

## UI Layout

```
┌──────────────────────────────────────────────────────────┐
│ [Primitives●] [SceneGraph○] [Input○] [Audio○] ... [Export]│
├──────────────────────────────────────┬───────────────────┤
│                                      │  ✓ Quad grid      │
│                                      │  ✓ Lines          │
│            Hyperion Canvas           │  ✓ Gradients      │
│                                      │  ✕ Box shadows    │
│                                      │  ⏳ Bezier        │
│                                      │                   │
│                                      │  3/5 passed       │
├──────────────────────────────────────┴───────────────────┤
│  Instructions: "Scroll to zoom — visual verification"     │
└──────────────────────────────────────────────────────────┘
```

### Tab Bar
- Horizontal strip, always visible.
- Each tab shows: name + status badge (○ not run, ● all pass green, ◐ partial yellow, ✕ any fail red).
- "Export" button at the right end.

### Check Panel (right sidebar, ~200px)
- Per-section check list with status icons.
- States: ✓ pass (green), ✕ fail (red), ⊘ skip (gray), ⏳ running (yellow).
- Summary line at bottom: "N/M passed, K skipped".

### Instructions Bar (bottom)
- Context-sensitive instructions for interactive checks.
- Shows camera controls for the current section.

## Report Format

```json
{
  "engine": "hyperion",
  "timestamp": "2026-02-28T14:30:00.000Z",
  "mode": "B",
  "userAgent": "...",
  "sections": {
    "primitives": {
      "status": "pass",
      "checks": [
        { "name": "Quad grid", "status": "pass", "detail": "25 entities" },
        { "name": "MSDF text", "status": "skip", "detail": "no font atlas" }
      ]
    }
  },
  "summary": { "total": 40, "pass": 38, "fail": 0, "skip": 2 }
}
```

File name: `hyperion-report-YYYY-MM-DD-HHmm.json`.

## Design Decisions

- **Single Hyperion instance** — Avoids N WASM loads. Sections clean up after themselves.
- **Dynamic imports** — Sections are lazy-loaded. Tab switching is fast.
- **Auto-verify first, manual fallback** — Measurable assertions run automatically. Purely visual things are manual.
- **Skip, don't fail** — Missing optional features (e.g., no .ogg file, no font atlas) are "skip", not "fail".
- **Canvas2D fallback aware** — Rendering FX section skips WebGPU-only checks when running in Canvas2D mode.
- **No new dependencies** — Pure DOM for tab bar and sidebar. No React, no UI framework.

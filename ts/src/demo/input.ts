// ts/src/demo/input.ts — Demo section: keyboard, pointer, scroll, hit-testing, and selection
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import type { Unsubscribe } from '../input-manager';

const entities: EntityHandle[] = [];
const unsubs: Unsubscribe[] = [];

const section: DemoSection = {
  name: 'input',
  label: 'Input & Selection (Keyboard / Pointer / Hit-Test)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // ── Spawn a 3x3 grid of clickable targets ────────────────────────────
    engine.batch(() => {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const x = (col - 1) * 4;
          const y = (row - 1) * 4;
          const e = engine.spawn()
            .position(x, y, 0)
            .scale(1.5, 1.5, 1);
          entities.push(e);
        }
      }
    });

    // ── 1. Keyboard callback (interactive — pending until keypress) ──────
    let keyFired = false;
    reporter.pending('Keyboard callback');
    const unsubKey = engine.input.onKey('*', (code: string) => {
      if (keyFired) return;
      keyFired = true;
      reporter.check('Keyboard callback', true, `key "${code}" pressed`);
    });
    unsubs.push(unsubKey);

    // ── 2. Click callback (interactive — pending until click) ────────────
    let clickFired = false;
    reporter.pending('Click callback');
    const unsubClick = engine.input.onClick(
      (button: number, x: number, y: number) => {
        if (clickFired) return;
        clickFired = true;
        reporter.check(
          'Click callback',
          true,
          `button=${button} at (${x.toFixed(0)}, ${y.toFixed(0)})`,
        );
      },
    );
    unsubs.push(unsubClick);

    // ── 3. Pointer move callback (interactive — pending until move) ──────
    let moveFired = false;
    reporter.pending('Pointer move callback');
    const unsubMove = engine.input.onPointerMove((x: number, y: number) => {
      if (moveFired) return;
      moveFired = true;
      reporter.check(
        'Pointer move callback',
        true,
        `pointer at (${x.toFixed(0)}, ${y.toFixed(0)})`,
      );
    });
    unsubs.push(unsubMove);

    // ── 4. Scroll callback (interactive — pending until scroll) ──────────
    let scrollFired = false;
    reporter.pending('Scroll callback');
    const unsubScroll = engine.input.onScroll(
      (deltaX: number, deltaY: number) => {
        if (scrollFired) return;
        scrollFired = true;
        reporter.check(
          'Scroll callback',
          true,
          `scroll delta=(${deltaX.toFixed(1)}, ${deltaY.toFixed(1)})`,
        );
      },
    );
    unsubs.push(unsubScroll);

    // ── 5. Hit testing (auto — verify API doesn't throw) ─────────────────
    try {
      const result = engine.picking.hitTest(0, 0);
      reporter.check(
        'Hit testing',
        true,
        `hitTest(0,0) returned ${result === null ? 'null' : result}`,
      );
    } catch (err) {
      reporter.check(
        'Hit testing',
        false,
        `hitTest threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 6. Selection toggle (auto — verify select/isSelected/toggle/clear)
    const sel = engine.selection;
    if (!sel) {
      reporter.skip('Selection toggle', 'no renderer (selection unavailable)');
    } else {
      try {
        const testId = entities[0].id;

        sel.select(testId);
        const afterSelect = sel.isSelected(testId);

        const toggleResult = sel.toggle(testId);
        const afterToggle = sel.isSelected(testId);

        sel.clear();
        const afterClear = sel.isSelected(testId);

        const ok =
          afterSelect === true &&
          toggleResult === false &&
          afterToggle === false &&
          afterClear === false;

        reporter.check(
          'Selection toggle',
          ok,
          `select=${afterSelect}, toggle=${toggleResult}, afterToggle=${afterToggle}, afterClear=${afterClear}`,
        );
      } catch (err) {
        reporter.check(
          'Selection toggle',
          false,
          `selection threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── Camera: position to show the grid ────────────────────────────────
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
  },

  teardown(engine: Hyperion) {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    for (const e of entities) e.destroy();
    entities.length = 0;
    engine.selection?.clear();
  },
};

export default section;

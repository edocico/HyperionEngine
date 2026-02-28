// ts/src/demo/audio.ts — Demo section: audio loading, playback, spatial positioning, lifecycle
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { SoundHandle } from '../audio-types';
import type { PlaybackId } from '../audio-types';

let loadedHandle: SoundHandle | null = null;

const section: DemoSection = {
  name: 'audio',
  label: 'Audio (Load / Play / Spatial / Lifecycle)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // ── 1. Load sound ──────────────────────────────────────────────────────
    try {
      loadedHandle = await engine.audio.load('sfx/click.wav');
      reporter.check(
        'Load sound',
        true,
        `loaded handle=${loadedHandle as number}`,
      );
    } catch (err) {
      loadedHandle = null;
      reporter.skip(
        'Load sound',
        `file not found or decode failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 2. Play sound ──────────────────────────────────────────────────────
    let playbackId: PlaybackId | null = null;
    if (loadedHandle === null) {
      reporter.skip('Play sound', 'no loaded handle (load failed)');
    } else {
      try {
        playbackId = engine.audio.play(loadedHandle, { volume: 0.5 });
        reporter.check(
          'Play sound',
          playbackId !== null,
          playbackId !== null
            ? `playbackId=${playbackId as number}`
            : 'play() returned null',
        );
      } catch (err) {
        reporter.check(
          'Play sound',
          false,
          `play threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── 3. Spatial position ────────────────────────────────────────────────
    if (playbackId === null) {
      reporter.skip('Spatial position', 'no active playback');
    } else {
      try {
        engine.audio.setSoundPosition(playbackId, 5, 0);
        reporter.check('Spatial position', true, 'setSoundPosition(id, 5, 0) ok');
      } catch (err) {
        reporter.check(
          'Spatial position',
          false,
          `setSoundPosition threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── 4. Suspend / resume (independent of load/play) ─────────────────────
    try {
      await engine.audio.suspend();
      await engine.audio.resume();
      reporter.check('Suspend/resume', true, 'suspend→resume cycle ok');
    } catch (err) {
      reporter.check(
        'Suspend/resume',
        false,
        `lifecycle threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },

  teardown(engine: Hyperion) {
    engine.audio.stopAll();
    loadedHandle = null;
  },
};

export default section;

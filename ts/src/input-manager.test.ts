import { describe, it, expect } from 'vitest';
import { InputManager } from './input-manager';

describe('InputManager', () => {
  describe('keyboard state', () => {
    it('tracks key down state', () => {
      const im = new InputManager();
      im.handleKeyDown('KeyA');
      expect(im.isKeyDown('KeyA')).toBe(true);
    });

    it('tracks key up state', () => {
      const im = new InputManager();
      im.handleKeyDown('KeyA');
      im.handleKeyUp('KeyA');
      expect(im.isKeyDown('KeyA')).toBe(false);
    });

    it('returns false for unpressed keys', () => {
      const im = new InputManager();
      expect(im.isKeyDown('KeyZ')).toBe(false);
    });

    it('tracks multiple simultaneous keys', () => {
      const im = new InputManager();
      im.handleKeyDown('KeyA');
      im.handleKeyDown('KeyB');
      im.handleKeyDown('ShiftLeft');
      expect(im.isKeyDown('KeyA')).toBe(true);
      expect(im.isKeyDown('KeyB')).toBe(true);
      expect(im.isKeyDown('ShiftLeft')).toBe(true);

      im.handleKeyUp('KeyB');
      expect(im.isKeyDown('KeyA')).toBe(true);
      expect(im.isKeyDown('KeyB')).toBe(false);
      expect(im.isKeyDown('ShiftLeft')).toBe(true);
    });
  });
});

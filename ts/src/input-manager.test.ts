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

  describe('pointer tracking', () => {
    it('starts at (0, 0)', () => {
      const im = new InputManager();
      expect(im.pointerX).toBe(0);
      expect(im.pointerY).toBe(0);
    });

    it('tracks pointer position', () => {
      const im = new InputManager();
      im.handlePointerMove(100, 200);
      expect(im.pointerX).toBe(100);
      expect(im.pointerY).toBe(200);
    });

    it('tracks pointer button down', () => {
      const im = new InputManager();
      im.handlePointerDown(0, 50, 60);
      expect(im.isPointerDown(0)).toBe(true);
      expect(im.pointerX).toBe(50);
      expect(im.pointerY).toBe(60);
    });

    it('tracks pointer button up', () => {
      const im = new InputManager();
      im.handlePointerDown(0, 50, 60);
      im.handlePointerUp(0, 55, 65);
      expect(im.isPointerDown(0)).toBe(false);
      expect(im.pointerX).toBe(55);
      expect(im.pointerY).toBe(65);
    });

    it('tracks scroll delta', () => {
      const im = new InputManager();
      im.handleScroll(10, 20);
      expect(im.scrollDeltaX).toBe(10);
      expect(im.scrollDeltaY).toBe(20);
    });

    it('accumulates scroll within frame', () => {
      const im = new InputManager();
      im.handleScroll(5, 10);
      im.handleScroll(3, 7);
      expect(im.scrollDeltaX).toBe(8);
      expect(im.scrollDeltaY).toBe(17);
    });

    it('resets scroll delta on resetFrame()', () => {
      const im = new InputManager();
      im.handleScroll(10, 20);
      im.resetFrame();
      expect(im.scrollDeltaX).toBe(0);
      expect(im.scrollDeltaY).toBe(0);
    });
  });
});

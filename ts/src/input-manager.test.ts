import { describe, it, expect, vi } from 'vitest';
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

  describe('callback registration', () => {
    it('fires key callback on matching keydown', () => {
      const im = new InputManager();
      const fn = vi.fn();
      im.onKey('KeyA', fn);
      im.handleKeyDown('KeyA');
      expect(fn).toHaveBeenCalledWith('KeyA');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not fire for non-matching key', () => {
      const im = new InputManager();
      const fn = vi.fn();
      im.onKey('KeyA', fn);
      im.handleKeyDown('KeyB');
      expect(fn).not.toHaveBeenCalled();
    });

    it('fires wildcard key callback for any key', () => {
      const im = new InputManager();
      const fn = vi.fn();
      im.onKey('*', fn);
      im.handleKeyDown('KeyA');
      im.handleKeyDown('Space');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenCalledWith('KeyA');
      expect(fn).toHaveBeenCalledWith('Space');
    });

    it('fires click callback with position on pointerUp', () => {
      const im = new InputManager();
      const fn = vi.fn();
      im.onClick(fn);
      im.handlePointerDown(0, 100, 200);
      im.handlePointerUp(0, 105, 205);
      expect(fn).toHaveBeenCalledWith(0, 105, 205);
    });

    it('fires pointerMove callback', () => {
      const im = new InputManager();
      const fn = vi.fn();
      im.onPointerMove(fn);
      im.handlePointerMove(42, 84);
      expect(fn).toHaveBeenCalledWith(42, 84);
    });

    it('fires scroll callback', () => {
      const im = new InputManager();
      const fn = vi.fn();
      im.onScroll(fn);
      im.handleScroll(10, -20);
      expect(fn).toHaveBeenCalledWith(10, -20);
    });

    it('removes callback via unsubscribe', () => {
      const im = new InputManager();
      const fn = vi.fn();
      const unsub = im.onKey('KeyA', fn);
      im.handleKeyDown('KeyA');
      expect(fn).toHaveBeenCalledTimes(1);

      unsub();
      im.handleKeyDown('KeyA');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('removeAllListeners clears all callbacks', () => {
      const im = new InputManager();
      const keyFn = vi.fn();
      const clickFn = vi.fn();
      const moveFn = vi.fn();
      const scrollFn = vi.fn();

      im.onKey('KeyA', keyFn);
      im.onClick(clickFn);
      im.onPointerMove(moveFn);
      im.onScroll(scrollFn);

      im.removeAllListeners();

      im.handleKeyDown('KeyA');
      im.handlePointerDown(0, 0, 0);
      im.handlePointerUp(0, 0, 0);
      im.handlePointerMove(10, 10);
      im.handleScroll(5, 5);

      expect(keyFn).not.toHaveBeenCalled();
      expect(clickFn).not.toHaveBeenCalled();
      expect(moveFn).not.toHaveBeenCalled();
      expect(scrollFn).not.toHaveBeenCalled();
    });
  });

  describe('DOM attach/detach', () => {
    /**
     * Helper: create a bare EventTarget and dispatch events with custom properties.
     * Node.js has EventTarget but not KeyboardEvent/PointerEvent/WheelEvent,
     * so we use Object.assign on plain Event instances.
     */
    function fireEvent(target: EventTarget, type: string, props: Record<string, unknown>): void {
      const event = Object.assign(new Event(type), props);
      target.dispatchEvent(event);
    }

    it('attaches and responds to keyboard events', () => {
      const im = new InputManager();
      const target = new EventTarget();
      im.attach(target);

      fireEvent(target, 'keydown', { code: 'KeyW' });
      expect(im.isKeyDown('KeyW')).toBe(true);

      fireEvent(target, 'keyup', { code: 'KeyW' });
      expect(im.isKeyDown('KeyW')).toBe(false);
    });

    it('responds to pointer events', () => {
      const im = new InputManager();
      const target = new EventTarget();
      im.attach(target);

      fireEvent(target, 'pointermove', { offsetX: 150, offsetY: 250 });
      expect(im.pointerX).toBe(150);
      expect(im.pointerY).toBe(250);

      fireEvent(target, 'pointerdown', { button: 0, offsetX: 160, offsetY: 260 });
      expect(im.isPointerDown(0)).toBe(true);

      fireEvent(target, 'pointerup', { button: 0, offsetX: 170, offsetY: 270 });
      expect(im.isPointerDown(0)).toBe(false);
    });

    it('responds to wheel events with preventDefault', () => {
      const im = new InputManager();
      const target = new EventTarget();
      im.attach(target);

      // Wheel events should call handleScroll
      fireEvent(target, 'wheel', { deltaX: 5, deltaY: -10, preventDefault: vi.fn() });
      expect(im.scrollDeltaX).toBe(5);
      expect(im.scrollDeltaY).toBe(-10);
    });

    it('detach removes listeners', () => {
      const im = new InputManager();
      const target = new EventTarget();
      im.attach(target);
      im.detach();

      fireEvent(target, 'keydown', { code: 'KeyA' });
      expect(im.isKeyDown('KeyA')).toBe(false);

      fireEvent(target, 'pointermove', { offsetX: 999, offsetY: 999 });
      expect(im.pointerX).toBe(0);
    });

    it('destroy clears state and detaches', () => {
      const im = new InputManager();
      const target = new EventTarget();
      im.attach(target);

      // Build up some state
      im.handleKeyDown('KeyA');
      im.handlePointerDown(0, 10, 20);
      im.handleScroll(5, 5);
      const fn = vi.fn();
      im.onKey('*', fn);

      im.destroy();

      // State is cleared
      expect(im.isKeyDown('KeyA')).toBe(false);
      expect(im.isPointerDown(0)).toBe(false);
      expect(im.scrollDeltaX).toBe(0);
      expect(im.scrollDeltaY).toBe(0);

      // Listeners are gone: DOM events no longer tracked
      fireEvent(target, 'keydown', { code: 'KeyB' });
      expect(im.isKeyDown('KeyB')).toBe(false);

      // Callbacks are gone
      im.handleKeyDown('Space');
      expect(fn).not.toHaveBeenCalled();
    });
  });
});

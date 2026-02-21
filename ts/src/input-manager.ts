/**
 * Manages input state (keyboard, pointer, scroll) with a polling API
 * and callback registration system.
 *
 * Lives on the main thread; wraps DOM events into engine-friendly state.
 */
export class InputManager {
  private readonly keysDown = new Set<string>();
  private readonly buttonsDown = new Set<number>();
  private _pointerX = 0;
  private _pointerY = 0;
  private _scrollDeltaX = 0;
  private _scrollDeltaY = 0;

  // ── Keyboard ──────────────────────────────────────────────────────

  /** Whether a keyboard key is currently held down. */
  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  /** Record a key press. */
  handleKeyDown(code: string): void {
    this.keysDown.add(code);
  }

  /** Record a key release. */
  handleKeyUp(code: string): void {
    this.keysDown.delete(code);
  }

  // ── Pointer ───────────────────────────────────────────────────────

  /** Current pointer X position (CSS pixels relative to target). */
  get pointerX(): number {
    return this._pointerX;
  }

  /** Current pointer Y position (CSS pixels relative to target). */
  get pointerY(): number {
    return this._pointerY;
  }

  /** Whether a pointer button is currently held down (0=left, 1=middle, 2=right). */
  isPointerDown(button: number): boolean {
    return this.buttonsDown.has(button);
  }

  /** Record pointer movement. */
  handlePointerMove(x: number, y: number): void {
    this._pointerX = x;
    this._pointerY = y;
  }

  /** Record a pointer button press. */
  handlePointerDown(button: number, x: number, y: number): void {
    this.buttonsDown.add(button);
    this._pointerX = x;
    this._pointerY = y;
  }

  /** Record a pointer button release. */
  handlePointerUp(button: number, x: number, y: number): void {
    this.buttonsDown.delete(button);
    this._pointerX = x;
    this._pointerY = y;
  }

  // ── Scroll ────────────────────────────────────────────────────────

  /** Accumulated horizontal scroll delta since last resetFrame(). */
  get scrollDeltaX(): number {
    return this._scrollDeltaX;
  }

  /** Accumulated vertical scroll delta since last resetFrame(). */
  get scrollDeltaY(): number {
    return this._scrollDeltaY;
  }

  /** Record a scroll event. Deltas accumulate until resetFrame(). */
  handleScroll(deltaX: number, deltaY: number): void {
    this._scrollDeltaX += deltaX;
    this._scrollDeltaY += deltaY;
  }

  // ── Frame lifecycle ───────────────────────────────────────────────

  /** Reset per-frame accumulators (scroll deltas). Call once per frame. */
  resetFrame(): void {
    this._scrollDeltaX = 0;
    this._scrollDeltaY = 0;
  }
}

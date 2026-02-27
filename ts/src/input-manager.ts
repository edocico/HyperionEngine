/**
 * Manages input state (keyboard, pointer, scroll) with a polling API
 * and callback registration system.
 *
 * Lives on the main thread; wraps DOM events into engine-friendly state.
 */

export type KeyCallback = (code: string) => void;
export type ClickCallback = (button: number, x: number, y: number) => void;
export type PointerMoveCallback = (x: number, y: number) => void;
export type ScrollCallback = (deltaX: number, deltaY: number) => void;
export type Unsubscribe = () => void;

export class InputManager {
  private readonly keysDown = new Set<string>();
  private readonly buttonsDown = new Set<number>();
  private _pointerX = 0;
  private _pointerY = 0;
  private _scrollDeltaX = 0;
  private _scrollDeltaY = 0;

  // Callback registries: code -> Set<callback>. '*' is the wildcard key.
  private readonly keyCallbacks = new Map<string, Set<KeyCallback>>();
  private readonly clickCallbacks = new Set<ClickCallback>();
  private readonly pointerMoveCallbacks = new Set<PointerMoveCallback>();
  private readonly scrollCallbacks = new Set<ScrollCallback>();

  // DOM attachment state
  private attachedTarget: EventTarget | null = null;
  private readonly boundHandlers = {
    keydown: (e: Event) => this.onDomKeyDown(e),
    keyup: (e: Event) => this.onDomKeyUp(e),
    pointermove: (e: Event) => this.onDomPointerMove(e),
    pointerdown: (e: Event) => this.onDomPointerDown(e),
    pointerup: (e: Event) => this.onDomPointerUp(e),
    wheel: (e: Event) => this.onDomWheel(e),
  };

  // ── Keyboard ──────────────────────────────────────────────────────

  /** Whether a keyboard key is currently held down. */
  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  /** Record a key press. Fires matching key callbacks. */
  handleKeyDown(code: string): void {
    this.keysDown.add(code);
    this.fireKeyCallbacks(code);
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

  /** Record pointer movement. Fires pointerMove callbacks. */
  handlePointerMove(x: number, y: number): void {
    this._pointerX = x;
    this._pointerY = y;
    for (const fn of this.pointerMoveCallbacks) {
      fn(x, y);
    }
  }

  /** Record a pointer button press. */
  handlePointerDown(button: number, x: number, y: number): void {
    this.buttonsDown.add(button);
    this._pointerX = x;
    this._pointerY = y;
  }

  /** Record a pointer button release. Fires click callbacks. */
  handlePointerUp(button: number, x: number, y: number): void {
    this.buttonsDown.delete(button);
    this._pointerX = x;
    this._pointerY = y;
    for (const fn of this.clickCallbacks) {
      fn(button, x, y);
    }
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

  /** Record a scroll event. Deltas accumulate until resetFrame(). Fires scroll callbacks. */
  handleScroll(deltaX: number, deltaY: number): void {
    this._scrollDeltaX += deltaX;
    this._scrollDeltaY += deltaY;
    for (const fn of this.scrollCallbacks) {
      fn(deltaX, deltaY);
    }
  }

  // ── Frame lifecycle ───────────────────────────────────────────────

  /** Reset per-frame accumulators (scroll deltas). Call once per frame. */
  resetFrame(): void {
    this._scrollDeltaX = 0;
    this._scrollDeltaY = 0;
  }

  // ── Callback registration ─────────────────────────────────────────

  /**
   * Register a callback for a specific key press.
   * Use code='*' as a wildcard to listen for any key.
   * Returns an unsubscribe function.
   */
  onKey(code: string, fn: KeyCallback): Unsubscribe {
    let set = this.keyCallbacks.get(code);
    if (!set) {
      set = new Set();
      this.keyCallbacks.set(code, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) {
        this.keyCallbacks.delete(code);
      }
    };
  }

  /** Register a callback for click events (pointerDown then pointerUp). */
  onClick(fn: ClickCallback): Unsubscribe {
    this.clickCallbacks.add(fn);
    return () => {
      this.clickCallbacks.delete(fn);
    };
  }

  /** Register a callback for pointer move events. */
  onPointerMove(fn: PointerMoveCallback): Unsubscribe {
    this.pointerMoveCallbacks.add(fn);
    return () => {
      this.pointerMoveCallbacks.delete(fn);
    };
  }

  /** Register a callback for scroll events. */
  onScroll(fn: ScrollCallback): Unsubscribe {
    this.scrollCallbacks.add(fn);
    return () => {
      this.scrollCallbacks.delete(fn);
    };
  }

  /** Remove all registered callbacks. */
  removeAllListeners(): void {
    this.keyCallbacks.clear();
    this.clickCallbacks.clear();
    this.pointerMoveCallbacks.clear();
    this.scrollCallbacks.clear();
  }

  // ── DOM attachment ────────────────────────────────────────────────

  /**
   * Attach DOM event listeners to the given target (typically a canvas or document).
   * Only one target may be attached at a time; calling attach again detaches the previous.
   */
  attach(target: EventTarget): void {
    if (this.attachedTarget) {
      this.detach();
    }
    this.attachedTarget = target;

    // Ensure the target is focusable so it receives keyboard events.
    // Elements like <canvas> are not focusable by default.
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) {
      if (!target.hasAttribute('tabindex')) {
        target.setAttribute('tabindex', '0');
      }
      target.style.outline = 'none';
      target.focus();
    }

    target.addEventListener('keydown', this.boundHandlers.keydown);
    target.addEventListener('keyup', this.boundHandlers.keyup);
    target.addEventListener('pointermove', this.boundHandlers.pointermove);
    target.addEventListener('pointerdown', this.boundHandlers.pointerdown);
    target.addEventListener('pointerup', this.boundHandlers.pointerup);
    target.addEventListener('wheel', this.boundHandlers.wheel, { passive: false });
  }

  /** Remove all DOM event listeners from the attached target. */
  detach(): void {
    const target = this.attachedTarget;
    if (!target) return;
    target.removeEventListener('keydown', this.boundHandlers.keydown);
    target.removeEventListener('keyup', this.boundHandlers.keyup);
    target.removeEventListener('pointermove', this.boundHandlers.pointermove);
    target.removeEventListener('pointerdown', this.boundHandlers.pointerdown);
    target.removeEventListener('pointerup', this.boundHandlers.pointerup);
    target.removeEventListener('wheel', this.boundHandlers.wheel);
    this.attachedTarget = null;
  }

  /** Detach from DOM, clear all state, and remove all callbacks. */
  destroy(): void {
    this.detach();
    this.keysDown.clear();
    this.buttonsDown.clear();
    this._pointerX = 0;
    this._pointerY = 0;
    this._scrollDeltaX = 0;
    this._scrollDeltaY = 0;
    this.removeAllListeners();
  }

  // ── Internal: DOM event handlers ──────────────────────────────────

  private onDomKeyDown(e: Event): void {
    const ke = e as KeyboardEvent;
    this.handleKeyDown(ke.code);
  }

  private onDomKeyUp(e: Event): void {
    const ke = e as KeyboardEvent;
    this.handleKeyUp(ke.code);
  }

  private onDomPointerMove(e: Event): void {
    const pe = e as PointerEvent;
    this.handlePointerMove(pe.offsetX, pe.offsetY);
  }

  private onDomPointerDown(e: Event): void {
    const pe = e as PointerEvent;
    this.handlePointerDown(pe.button, pe.offsetX, pe.offsetY);
    // Re-focus so keyboard events keep working after clicking away and back
    if (typeof HTMLElement !== 'undefined' && this.attachedTarget instanceof HTMLElement) {
      this.attachedTarget.focus();
    }
  }

  private onDomPointerUp(e: Event): void {
    const pe = e as PointerEvent;
    this.handlePointerUp(pe.button, pe.offsetX, pe.offsetY);
  }

  private onDomWheel(e: Event): void {
    const we = e as WheelEvent;
    if (typeof we.preventDefault === 'function') {
      we.preventDefault();
    }
    this.handleScroll(we.deltaX, we.deltaY);
  }

  // ── Internal: callback dispatch ───────────────────────────────────

  private fireKeyCallbacks(code: string): void {
    // Fire exact-match callbacks
    const exact = this.keyCallbacks.get(code);
    if (exact) {
      for (const fn of exact) {
        fn(code);
      }
    }
    // Fire wildcard callbacks
    const wildcard = this.keyCallbacks.get('*');
    if (wildcard) {
      for (const fn of wildcard) {
        fn(code);
      }
    }
  }
}

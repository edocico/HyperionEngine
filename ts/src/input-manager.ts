/**
 * Manages input state (keyboard, pointer, scroll) with a polling API
 * and callback registration system.
 *
 * Lives on the main thread; wraps DOM events into engine-friendly state.
 */
export class InputManager {
  private readonly keysDown = new Set<string>();

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
}

// event-bus.ts — Simple typed pub/sub event bus for inter-plugin communication

type Listener = (data: unknown) => void;

export class EventBus {
  private listeners = new Map<string, Listener[]>();

  on(event: string, fn: Listener): void {
    const list = this.listeners.get(event);
    if (list) { list.push(fn); }
    else { this.listeners.set(event, [fn]); }
  }

  off(event: string, fn: Listener): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  }

  once(event: string, fn: Listener): void {
    const wrapper: Listener = (data) => {
      this.off(event, wrapper);
      fn(data);
    };
    this.on(event, wrapper);
  }

  emit(event: string, data: unknown): void {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const fn of [...list]) fn(data);
  }

  destroy(): void {
    this.listeners.clear();
  }
}

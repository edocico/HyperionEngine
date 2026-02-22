import type { HyperionStats } from './types';

export interface ProfilerConfig {
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

/**
 * Lightweight performance overlay that displays live engine statistics.
 * Attach to a canvas parent via `show()`, update each frame via `update()`,
 * and tear down with `hide()` or `destroy()`.
 */
export class ProfilerOverlay {
  private container: HTMLDivElement | null = null;
  private parent: HTMLElement | null = null;
  private statsText: HTMLPreElement | null = null;
  private readonly config: ProfilerConfig;

  constructor(config?: ProfilerConfig) {
    this.config = config ?? {};
  }

  show(canvas: HTMLCanvasElement): void {
    if (this.container) return;
    this.parent = canvas.parentElement;
    if (!this.parent) return;

    this.container = document.createElement('div');
    this.container.style.cssText = this.positionStyle();
    this.container.style.position = 'absolute';
    this.container.style.background = 'rgba(0,0,0,0.75)';
    this.container.style.color = '#0f0';
    this.container.style.fontFamily = 'monospace';
    this.container.style.fontSize = '12px';
    this.container.style.padding = '8px';
    this.container.style.pointerEvents = 'none';
    this.container.style.zIndex = '9999';
    this.container.style.lineHeight = '1.4';

    this.statsText = document.createElement('pre');
    this.statsText.style.margin = '0';
    this.container.appendChild(this.statsText);

    this.parent.appendChild(this.container);
  }

  hide(): void {
    if (this.container && this.parent) {
      this.parent.removeChild(this.container);
      this.container = null;
      this.statsText = null;
      this.parent = null;
    }
  }

  update(stats: HyperionStats): void {
    if (!this.statsText) return;
    this.statsText.textContent =
      `FPS: ${stats.fps}\n` +
      `Entities: ${stats.entityCount}\n` +
      `Mode: ${stats.mode}\n` +
      `Ticks: ${stats.tickCount}\n` +
      `Frame: ${(stats.frameDt * 1000).toFixed(1)}ms\n` +
      `Avg: ${(stats.frameTimeAvg * 1000).toFixed(1)}ms\n` +
      `Max: ${(stats.frameTimeMax * 1000).toFixed(1)}ms\n` +
      `Overflow: ${stats.overflowCount}`;
  }

  destroy(): void {
    this.hide();
  }

  private positionStyle(): string {
    const pos = this.config.position ?? 'top-left';
    switch (pos) {
      case 'top-left': return 'top:0;left:0;';
      case 'top-right': return 'top:0;right:0;';
      case 'bottom-left': return 'bottom:0;left:0;';
      case 'bottom-right': return 'bottom:0;right:0;';
    }
  }
}

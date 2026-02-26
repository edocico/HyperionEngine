/**
 * ECS Inspector Plugin — HTML overlay panel for inspecting entity components.
 *
 * Toggle: F12 key (configurable).
 * Dual data channels:
 *   - Fast path: reads SystemViews.entityIds every frame for entity list
 *   - Slow path: polls WASM debug_get_components() every 200ms for selected entity detail
 *
 * DOM construction uses createElement + textContent (no innerHTML with untrusted content).
 */

import type { HyperionPlugin, PluginCleanup } from '../plugin';
import type { PluginContext } from '../plugin-context';
import type { HookFn } from '../game-loop';
import type { SystemViews } from '../system-views';
import { parseTLV } from './tlv-parser';

export interface EcsInspectorOptions {
  toggleKey?: string;
  pollIntervalMs?: number;
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
}

const PANEL_STYLE = `
  position: fixed;
  z-index: 99999;
  width: 320px;
  max-height: 480px;
  overflow-y: auto;
  background: rgba(24, 24, 32, 0.95);
  color: #e0e0e0;
  font-family: monospace;
  font-size: 12px;
  border-radius: 6px;
  padding: 8px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.5);
  pointer-events: auto;
  user-select: text;
`;

function positionStyle(pos: string): string {
  switch (pos) {
    case 'top-left':     return 'top:12px;left:12px;';
    case 'bottom-right': return 'bottom:12px;right:12px;';
    case 'bottom-left':  return 'bottom:12px;left:12px;';
    default:             return 'top:12px;right:12px;';
  }
}

export function ecsInspectorPlugin(options?: EcsInspectorOptions): HyperionPlugin {
  const toggleKey = options?.toggleKey ?? 'F12';
  const pollMs = options?.pollIntervalMs ?? 200;
  const position = options?.position ?? 'top-right';

  return {
    name: 'ecs-inspector',
    version: '1.0.0',

    install(ctx: PluginContext): PluginCleanup {
      const engine = ctx.engine as {
        input: { onKey(code: string, fn: (code: string) => void): () => void };
        selection: {
          select(id: number): void;
          deselect(id: number): void;
          selectedIds(): Set<number>;
        };
      };

      let panel: HTMLDivElement | null = null;
      let entityListEl: HTMLDivElement | null = null;
      let detailEl: HTMLDivElement | null = null;
      let headerEl: HTMLDivElement | null = null;
      let visible = false;
      let selectedEntityId: number | null = null;
      let lastPollTime = 0;
      let lastEntityIds: Uint32Array | null = null;

      function createPanel(): HTMLDivElement {
        const el = document.createElement('div');
        el.style.cssText = PANEL_STYLE + positionStyle(position);

        headerEl = document.createElement('div');
        headerEl.style.cssText = 'font-weight:bold;margin-bottom:6px;color:#88ccff;';
        headerEl.textContent = 'ECS Inspector (0 entities)';
        el.appendChild(headerEl);

        entityListEl = document.createElement('div');
        entityListEl.style.cssText = 'max-height:180px;overflow-y:auto;margin-bottom:6px;border-bottom:1px solid #444;padding-bottom:4px;';
        el.appendChild(entityListEl);

        detailEl = document.createElement('div');
        detailEl.style.cssText = 'white-space:pre-wrap;font-size:11px;color:#ccc;';
        detailEl.textContent = 'Click an entity to inspect';
        el.appendChild(detailEl);

        return el;
      }

      function updateEntityList(views: SystemViews | undefined): void {
        if (!entityListEl || !headerEl) return;
        if (!views) return;

        // Only rebuild if entity IDs changed
        if (lastEntityIds && lastEntityIds.length === views.entityIds.length) {
          let same = true;
          for (let i = 0; i < views.entityIds.length; i++) {
            if (lastEntityIds[i] !== views.entityIds[i]) { same = false; break; }
          }
          if (same) return;
        }
        lastEntityIds = new Uint32Array(views.entityIds);

        headerEl.textContent = `ECS Inspector (${views.entityCount} entities)`;

        // Rebuild list
        entityListEl.textContent = '';
        const selected = engine.selection.selectedIds();
        for (let i = 0; i < views.entityCount; i++) {
          const id = views.entityIds[i];
          const row = document.createElement('div');
          row.style.cssText = `cursor:pointer;padding:2px 4px;border-radius:3px;${selected.has(id) ? 'background:#335;' : ''}`;
          row.textContent = `Entity #${id}`;
          row.addEventListener('click', () => {
            selectedEntityId = id;
            engine.selection.select(id);
          });
          entityListEl!.appendChild(row);
        }
      }

      function updateDetail(_views: SystemViews | undefined): void {
        if (!detailEl || selectedEntityId === null) return;

        const now = performance.now();
        if (now - lastPollTime < pollMs) return;
        lastPollTime = now;

        // In a real integration, this would call WASM debug_get_components.
        // For now, the detail view shows the selected entity ID and
        // basic info from SystemViews if available.
        if (_views && selectedEntityId !== null) {
          let idx = -1;
          for (let i = 0; i < _views.entityCount; i++) {
            if (_views.entityIds[i] === selectedEntityId) { idx = i; break; }
          }
          if (idx >= 0) {
            const tx = _views.transforms[idx * 16 + 12];
            const ty = _views.transforms[idx * 16 + 13];
            const tz = _views.transforms[idx * 16 + 14];
            const r = _views.bounds[idx * 4 + 3];
            detailEl.textContent =
              `Entity #${selectedEntityId}\n` +
              `Position: (${tx.toFixed(2)}, ${ty.toFixed(2)}, ${tz.toFixed(2)})\n` +
              `Bounds radius: ${r.toFixed(2)}`;
          } else {
            detailEl.textContent = `Entity #${selectedEntityId}\n(not in current frame)`;
          }
        }
      }

      const hook: HookFn = (_dt, views) => {
        if (!visible || !panel) return;
        updateEntityList(views);
        updateDetail(views);
      };

      const unsubKey = engine.input.onKey(toggleKey, () => {
        visible = !visible;
        if (visible) {
          if (!panel) {
            panel = createPanel();
            document.body.appendChild(panel);
          }
          panel.style.display = 'block';
        } else if (panel) {
          panel.style.display = 'none';
        }
      });

      ctx.systems.addPostTick(hook);

      return () => {
        ctx.systems.removePostTick(hook);
        unsubKey();
        if (panel && panel.parentNode) {
          panel.parentNode.removeChild(panel);
        }
        panel = null;
      };
    },
  };
}

// Re-export parseTLV for consumers who want to parse debug data directly
export { parseTLV } from './tlv-parser';
export type { ParsedComponent } from './tlv-parser';

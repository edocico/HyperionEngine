/// <reference lib="webworker" />

/**
 * Render Worker (Mode A only).
 * Receives an OffscreenCanvas and renders entities using WebGPU
 * with a GPU-driven pipeline (compute culling + indirect draw).
 * Render state arrives from the ECS Worker via a MessageChannel port.
 *
 * Uses createRenderer() from renderer.ts to avoid duplicating the
 * full pipeline setup (two bind groups, TextureManager, etc.).
 */

import { Camera } from "./camera";
import { createRenderer, type Renderer } from "./renderer";

const camera = new Camera();
let renderer: Renderer | null = null;
let offscreenCanvas: OffscreenCanvas | null = null;

interface RenderState {
  entityCount: number;
  entityData: ArrayBuffer;
  texIndices: ArrayBuffer;
}

let latestRenderState: RenderState | null = null;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "init") {
    try {
      offscreenCanvas = msg.canvas as OffscreenCanvas;
      const width = msg.width as number;
      const height = msg.height as number;

      offscreenCanvas.width = width;
      offscreenCanvas.height = height;

      renderer = await createRenderer(offscreenCanvas);

      const aspect = width / height;
      camera.setOrthographic(20 * aspect, 20, 0.1, 1000);

      msg.ecsPort.onmessage = (e: MessageEvent) => {
        if (e.data.renderState) {
          latestRenderState = e.data.renderState;
        }
      };

      renderLoop();
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "error", error: String(e) });
    }
  } else if (msg.type === "resize") {
    const width = msg.width as number;
    const height = msg.height as number;
    if (offscreenCanvas) {
      offscreenCanvas.width = width;
      offscreenCanvas.height = height;
    }
    const aspect = width / height;
    camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
  }
};

function renderLoop(): void {
  function renderFrame() {
    if (renderer && latestRenderState && latestRenderState.entityCount > 0) {
      const entityData = new Float32Array(latestRenderState.entityData);
      const texIndices = new Uint32Array(latestRenderState.texIndices);

      renderer.render(entityData, latestRenderState.entityCount, camera, texIndices);
    }

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
}

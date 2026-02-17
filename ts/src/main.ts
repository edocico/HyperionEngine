import {
  detectCapabilities,
  selectExecutionMode,
  logCapabilities,
  ExecutionMode,
} from "./capabilities";
import {
  createWorkerBridge,
  createDirectBridge,
  createFullIsolationBridge,
  type EngineBridge,
} from "./worker-bridge";
import { createRenderer, type Renderer } from "./renderer";
import { Camera } from "./camera";

async function main() {
  const overlay = document.getElementById("overlay")!;
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;

  overlay.textContent = "Hyperion Engine — detecting capabilities...";

  const caps = detectCapabilities();
  const mode = selectExecutionMode(caps);
  logCapabilities(caps, mode);

  overlay.textContent = "Hyperion Engine — Mode " + mode + ", loading WASM...";

  // Create the engine bridge (mode-appropriate).
  let bridge: EngineBridge;
  let rendererOnMainThread = true;

  if (mode === ExecutionMode.FullIsolation) {
    bridge = createFullIsolationBridge(canvas);
    rendererOnMainThread = false;
  } else if (mode === ExecutionMode.PartialIsolation) {
    bridge = createWorkerBridge(mode);
  } else {
    bridge = await createDirectBridge();
  }

  await bridge.ready();

  // Initialize camera.
  const camera = new Camera();

  // Initialize the renderer (Mode B/C on Main Thread; Mode A in Render Worker).
  let renderer: Renderer | null = null;
  if (rendererOnMainThread && caps.webgpu) {
    try {
      renderer = await createRenderer(canvas);
    } catch {
      renderer = null;
    }
  }

  if (!renderer && rendererOnMainThread) {
    overlay.textContent =
      "Hyperion Engine — Mode " + mode + ", no WebGPU (rendering disabled)";
  }

  // Set canvas size.
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * dpr);
    const height = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      const aspect = width / height;
      camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
    }
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  // Spawn test entities in a grid.
  for (let i = 0; i < 50; i++) {
    bridge.commandBuffer.spawnEntity(i);
    const col = i % 10;
    const row = Math.floor(i / 10);
    bridge.commandBuffer.setPosition(i, (col - 4.5) * 2, (row - 2.5) * 2, 0);
  }

  // Main loop.
  let lastTime = performance.now();
  let frameCount = 0;
  let fpsTime = 0;
  let fps = 0;

  const modeLabels: Record<string, string> = {
    A: "A (Full Isolation)",
    B: "B (Partial Isolation)",
    C: "C (Single Thread)",
  };

  function frame(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    frameCount++;
    fpsTime += dt;
    if (fpsTime >= 1.0) {
      fps = Math.round(frameCount / fpsTime);
      frameCount = 0;
      fpsTime = 0;
    }

    bridge.tick(dt);

    if (renderer && bridge.latestRenderState && bridge.latestRenderState.count > 0) {
      renderer.render(bridge.latestRenderState.matrices, bridge.latestRenderState.count, camera);
    }

    const entityCount = bridge.latestRenderState?.count ?? 0;
    const renderTarget = rendererOnMainThread ? "Main Thread" : "Render Worker";
    overlay.textContent =
      "Hyperion Engine\n" +
      "Mode: " + modeLabels[mode] + "\n" +
      "Render: " + renderTarget + "\n" +
      "FPS: " + fps + "\n" +
      "Entities: " + entityCount;

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main();

import {
  detectCapabilities,
  selectExecutionMode,
  logCapabilities,
  ExecutionMode,
} from "./capabilities";
import { createWorkerBridge, createFullIsolationBridge, createDirectBridge, type EngineBridge } from "./worker-bridge";

async function main() {
  const info = document.getElementById("info")!;
  info.textContent = "Hyperion Engine — detecting capabilities...";

  const caps = detectCapabilities();
  const mode = selectExecutionMode(caps);
  logCapabilities(caps, mode);

  info.textContent = `Hyperion Engine — Mode ${mode}, loading WASM...`;

  let bridge: EngineBridge;

  if (mode === ExecutionMode.FullIsolation) {
    const canvas = document.getElementById("canvas") as HTMLCanvasElement;
    bridge = createFullIsolationBridge(canvas);
  } else if (mode === ExecutionMode.PartialIsolation) {
    bridge = createWorkerBridge(mode);
  } else {
    bridge = await createDirectBridge();
  }

  await bridge.ready();
  info.textContent = `Hyperion Engine — Mode ${mode}, ready`;

  // Main loop
  let lastTime = performance.now();

  function frame(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    bridge.tick(dt);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main();

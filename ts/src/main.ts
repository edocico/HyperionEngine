async function main() {
  const info = document.getElementById("info")!;
  info.textContent = "Hyperion Engine — loading WASM...";

  try {
    const wasm = await import("../wasm/hyperion_core.js");
    await wasm.default();
    const result = wasm.add(2, 3);
    info.textContent = `Hyperion Engine — WASM OK (2 + 3 = ${result})`;
  } catch (e) {
    info.textContent = `Hyperion Engine — WASM FAILED: ${e}`;
    console.error(e);
  }
}

main();

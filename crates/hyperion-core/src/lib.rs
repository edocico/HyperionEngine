use wasm_bindgen::prelude::*;

pub mod components;
pub mod ring_buffer;

/// Smoke-test export: returns a + b.
/// This validates the full WASM build pipeline.
#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

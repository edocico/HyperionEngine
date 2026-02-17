use std::ptr::addr_of_mut;

use wasm_bindgen::prelude::*;

pub mod command_processor;
pub mod components;
pub mod engine;
pub mod render_state;
pub mod ring_buffer;
pub mod systems;

use engine::Engine;
use ring_buffer::RingBufferConsumer;

static mut ENGINE: Option<Engine> = None;
static mut RING_BUFFER: Option<RingBufferConsumer> = None;

/// Initialize the engine. Called once from the Worker.
#[wasm_bindgen]
pub fn engine_init() {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        addr_of_mut!(ENGINE).write(Some(Engine::new()));
    }
}

/// Attach a ring buffer for command consumption.
/// `ptr` is a pointer into SharedArrayBuffer memory.
/// `capacity` is the data region size (total - 16 byte header).
///
/// # Safety
/// The SharedArrayBuffer must outlive the engine and `ptr` must
/// point to a valid region of at least `16 + capacity` bytes.
#[wasm_bindgen]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn engine_attach_ring_buffer(ptr: *mut u8, capacity: usize) {
    // SAFETY: wasm32 is single-threaded; RingBufferConsumer::new safety
    // requirements are upheld by the caller (JS Worker).
    unsafe {
        addr_of_mut!(RING_BUFFER).write(Some(RingBufferConsumer::new(ptr, capacity)));
    }
}

/// Run one frame update. `dt` is seconds since last frame.
/// Drains the ring buffer, processes commands, and runs the ECS tick loop.
#[wasm_bindgen]
pub fn engine_update(dt: f32) {
    // SAFETY: wasm32 is single-threaded; no concurrent access to these statics.
    unsafe {
        let commands = match &*addr_of_mut!(RING_BUFFER) {
            Some(rb) => rb.drain(),
            None => Vec::new(),
        };

        if let Some(engine) = &mut *addr_of_mut!(ENGINE) {
            engine.process_commands(&commands);
            engine.update(dt);
        }
    }
}

/// Returns the number of fixed ticks elapsed.
#[wasm_bindgen]
pub fn engine_tick_count() -> u64 {
    // SAFETY: wasm32 is single-threaded; read-only access.
    unsafe {
        match &*addr_of_mut!(ENGINE) {
            Some(e) => e.tick_count(),
            None => 0,
        }
    }
}

/// Smoke test.
#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

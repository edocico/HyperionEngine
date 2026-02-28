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
#[allow(dead_code)]
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
/// Kept for backward compatibility; prefer `engine_push_commands` instead.
///
/// # Safety
/// The SharedArrayBuffer must outlive the engine.
#[wasm_bindgen]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn engine_attach_ring_buffer(ptr: *mut u8, capacity: usize) {
    // SAFETY: wasm32 is single-threaded; pointer valid by caller contract.
    unsafe {
        addr_of_mut!(RING_BUFFER).write(Some(RingBufferConsumer::new(ptr, capacity)));
    }
}

/// Push raw command bytes into the engine.
///
/// The Worker extracts unread bytes from the SharedArrayBuffer ring buffer
/// and passes them here. wasm-bindgen handles the `&[u8]` → WASM memory
/// copy automatically.
///
/// Call this BEFORE `engine_update()` each frame.
#[wasm_bindgen]
pub fn engine_push_commands(data: &[u8]) {
    let commands = ring_buffer::parse_commands(data);
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut engine) = *addr_of_mut!(ENGINE) {
            engine.process_commands(&commands);
        }
    }
}

/// Run one frame update. `dt` is seconds since last frame.
/// Runs physics ticks, recomputes transforms, and collects render state.
///
/// Call `engine_push_commands()` first if there are commands to process.
#[wasm_bindgen]
pub fn engine_update(dt: f32) {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut engine) = *addr_of_mut!(ENGINE) {
            engine.update(dt);
        }
    }
}

/// Returns the number of fixed ticks elapsed.
#[wasm_bindgen]
pub fn engine_tick_count() -> u64 {
    // SAFETY: wasm32 is single-threaded.
    unsafe { (*addr_of_mut!(ENGINE)).as_ref().map_or(0, |e| e.tick_count()) }
}

/// Returns the number of active entities with render data.
#[wasm_bindgen]
pub fn engine_render_state_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.count())
    }
}

/// Returns a pointer to the model matrix buffer in WASM linear memory.
/// The buffer contains `engine_render_state_count() * 16` f32 values
/// (each matrix is 16 floats, column-major).
///
/// The pointer is valid until the next call to `engine_update()`.
#[wasm_bindgen]
pub fn engine_render_state_ptr() -> *const f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.as_ptr())
    }
}

/// Returns total f32 count in render state (count * 16).
#[wasm_bindgen]
pub fn engine_render_state_f32_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.f32_len())
    }
}

/// Pointer to the transforms buffer (16 f32 per entity, mat4x4).
#[wasm_bindgen]
pub fn engine_gpu_transforms_ptr() -> *const f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.gpu_transforms_ptr())
    }
}

/// Number of f32 values in the transforms buffer.
#[wasm_bindgen]
pub fn engine_gpu_transforms_f32_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_transforms_f32_len())
    }
}

/// Pointer to the bounds buffer (4 f32 per entity: xyz + radius).
#[wasm_bindgen]
pub fn engine_gpu_bounds_ptr() -> *const f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.gpu_bounds_ptr())
    }
}

/// Number of f32 values in the bounds buffer.
#[wasm_bindgen]
pub fn engine_gpu_bounds_f32_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_bounds_f32_len())
    }
}

/// Pointer to the render meta buffer (2 u32 per entity: meshHandle + renderPrimitive).
#[wasm_bindgen]
pub fn engine_gpu_render_meta_ptr() -> *const u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.gpu_render_meta_ptr())
    }
}

/// Number of u32 values in the render meta buffer.
#[wasm_bindgen]
pub fn engine_gpu_render_meta_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_render_meta_len())
    }
}

/// Number of entities in the GPU data buffer.
#[wasm_bindgen]
pub fn engine_gpu_entity_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_entity_count())
    }
}

/// Pointer to the texture layer indices buffer (one u32 per entity).
/// Indices are parallel to the other SoA GPU buffers — index i here
/// corresponds to entity i in the transforms/bounds/renderMeta buffers.
#[wasm_bindgen]
pub fn engine_gpu_tex_indices_ptr() -> *const u32 {
    // SAFETY: wasm32 is single-threaded; only one caller at a time.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.gpu_tex_indices_ptr())
    }
}

/// Number of u32 values in the texture indices buffer.
#[wasm_bindgen]
pub fn engine_gpu_tex_indices_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_tex_indices_len())
    }
}

/// Pointer to the prim params buffer (8 f32 per entity).
#[wasm_bindgen]
pub fn engine_gpu_prim_params_ptr() -> *const f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.gpu_prim_params_ptr())
    }
}

/// Number of f32 values in the prim params buffer.
#[wasm_bindgen]
pub fn engine_gpu_prim_params_f32_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_prim_params_f32_len())
    }
}

/// Pointer to the entity IDs buffer (one u32 per entity: external entity ID for picking).
/// Indices are parallel to the other SoA GPU buffers — index i here
/// corresponds to entity i in the transforms/bounds/renderMeta buffers.
#[wasm_bindgen]
pub fn engine_gpu_entity_ids_ptr() -> *const u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.gpu_entity_ids_ptr())
    }
}

/// Number of u32 values in the entity IDs buffer.
#[wasm_bindgen]
pub fn engine_gpu_entity_ids_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_entity_ids_len())
    }
}

// ── Dirty staging WASM exports ──────────────────────────────────

/// Returns the number of dirty entities from the last staging collection.
#[wasm_bindgen]
pub fn engine_dirty_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.dirty_count())
    }
}

/// Returns the dirty ratio (dirty / total) from the last staging collection.
#[wasm_bindgen]
pub fn engine_dirty_ratio() -> f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0.0, |e| e.render_state.dirty_ratio())
    }
}

/// Pointer to the staging buffer (32 u32 per dirty entity).
#[wasm_bindgen]
pub fn engine_staging_ptr() -> *const u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.staging_ptr())
    }
}

/// Number of u32 values in the staging buffer.
#[wasm_bindgen]
pub fn engine_staging_u32_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.staging_u32_len())
    }
}

/// Pointer to the dirty indices buffer (one u32 per dirty entity: destination slot).
#[wasm_bindgen]
pub fn engine_staging_indices_ptr() -> *const u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.staging_indices_ptr())
    }
}

/// Number of u32 values in the dirty indices buffer.
#[wasm_bindgen]
pub fn engine_staging_indices_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.staging_indices_len())
    }
}

/// Compact the entity map by truncating trailing empty slots.
#[wasm_bindgen]
pub fn engine_compact_entity_map() {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut e) = *addr_of_mut!(ENGINE) {
            e.entity_map.shrink_to_fit();
        }
    }
}

/// Compact the render state by releasing excess buffer memory.
#[wasm_bindgen]
pub fn engine_compact_render_state() {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut e) = *addr_of_mut!(ENGINE) {
            e.render_state.shrink_to_fit();
        }
    }
}

/// Returns the current allocated capacity of the entity map.
#[wasm_bindgen]
pub fn engine_entity_map_capacity() -> u32 {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.entity_map.capacity() as u32)
    }
}

/// Returns the extrapolated listener X position.
#[wasm_bindgen]
pub fn engine_listener_x() -> f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0.0, |e| e.listener_x())
    }
}

/// Returns the extrapolated listener Y position.
#[wasm_bindgen]
pub fn engine_listener_y() -> f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0.0, |e| e.listener_y())
    }
}

/// Returns the extrapolated listener Z position.
#[wasm_bindgen]
pub fn engine_listener_z() -> f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0.0, |e| e.listener_z())
    }
}

/// Expose WASM linear memory to JavaScript.
/// wasm-bindgen does not auto-export `WebAssembly.Memory`; callers need
/// it to create typed array views over SoA GPU buffers (transforms, bounds, etc.).
#[wasm_bindgen]
pub fn engine_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// Smoke test.
#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

// ── Dev-tools WASM exports ──────────────────────────────────────

/// Returns the number of active entities (dev-tools only).
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
pub fn engine_debug_entity_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.debug_entity_count())
    }
}

/// Write mapped external entity IDs into a caller-provided buffer.
/// `flags`: bit 0 = active_only. Returns the number of IDs written.
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn engine_debug_list_entities(out_ptr: *mut u32, out_len: u32, flags: u32) -> u32 {
    // SAFETY: wasm32 is single-threaded; pointer valid by caller contract.
    unsafe {
        let engine = match &mut *addr_of_mut!(ENGINE) {
            Some(e) => e,
            None => return 0,
        };
        let out = std::slice::from_raw_parts_mut(out_ptr, out_len as usize);
        let active_only = (flags & 1) != 0;
        engine.debug_list_entities(out, active_only)
    }
}

/// Serialize all components of the given entity into TLV format.
/// Returns the number of bytes written into `out_ptr`.
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn engine_debug_get_components(entity_id: u32, out_ptr: *mut u8, out_len: u32) -> u32 {
    // SAFETY: wasm32 is single-threaded; pointer valid by caller contract.
    unsafe {
        let engine = match &mut *addr_of_mut!(ENGINE) {
            Some(e) => e,
            None => return 0,
        };
        let out = std::slice::from_raw_parts_mut(out_ptr, out_len as usize);
        engine.debug_get_components(entity_id, out)
    }
}

/// Generate wireframe line vertices for bounding sphere visualization.
/// Returns the number of vertices written.
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn engine_debug_generate_lines(vert_ptr: *mut f32, color_ptr: *mut f32, max_verts: u32) -> u32 {
    // SAFETY: wasm32 is single-threaded; pointers valid by caller contract.
    unsafe {
        let engine = match &*addr_of_mut!(ENGINE) {
            Some(e) => e,
            None => return 0,
        };
        let verts = std::slice::from_raw_parts_mut(vert_ptr, (max_verts * 3) as usize);
        let colors = std::slice::from_raw_parts_mut(color_ptr, (max_verts * 4) as usize);
        engine.debug_generate_lines(verts, colors, max_verts)
    }
}

/// Reset the engine to its initial state (dev-tools only).
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
pub fn engine_reset() {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut e) = *addr_of_mut!(ENGINE) {
            e.reset();
        }
    }
}

/// Create a binary snapshot of the current engine state (dev-tools only).
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
pub fn engine_snapshot_create() -> Vec<u8> {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or_else(Vec::new, |e| e.snapshot_create())
    }
}

/// Restore engine state from a binary snapshot (dev-tools only).
/// Returns true on success, false on invalid data.
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
pub fn engine_snapshot_restore(data: &[u8]) -> bool {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut e) = *addr_of_mut!(ENGINE) {
            e.snapshot_restore(data)
        } else {
            false
        }
    }
}

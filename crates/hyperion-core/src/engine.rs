//! The main engine struct that ties together ECS, command processing,
//! and systems into a deterministic fixed-timestep tick loop.

use hecs::World;

use crate::components::{Active, Parent, Velocity};
use crate::render_state::RenderState;
use crate::ring_buffer::{Command, CommandType};
use crate::systems::{propagate_transforms, transform_system, transform_system_2d};

#[cfg(not(feature = "physics-2d"))]
use crate::command_processor::process_commands;
#[cfg(not(feature = "physics-2d"))]
use crate::systems::{velocity_system, velocity_system_2d};

use crate::command_processor::EntityMap;

/// Fixed timestep: 60 ticks per second.
pub const FIXED_DT: f32 = 1.0 / 60.0;

/// Snapshot format version written by `snapshot_create`.
/// v1 and v2 are still accepted on restore.
#[cfg(feature = "dev-tools")]
pub const SNAPSHOT_VERSION: u32 = 3;

/// The core engine state.
pub struct Engine {
    pub world: World,
    pub entity_map: EntityMap,
    pub render_state: RenderState,
    #[cfg(feature = "physics-2d")]
    pub physics: crate::physics::HyperionPhysicsWorld,
    /// Physics debug rendering toggle (CommandType 47, Phase 16 Track A).
    #[cfg(feature = "physics-debug")]
    pub debug_render_enabled: bool,
    /// Debug line records, 8 f32 per line: [ax, ay, bx, by, r, g, b, a].
    /// Regenerated once per frame when enabled; empty otherwise.
    #[cfg(feature = "physics-debug")]
    pub debug_lines: Vec<f32>,
    accumulator: f32,
    tick_count: u64,
    /// Bytes discarded because an unknown opcode made a batch unframeable.
    /// Surfaced to JS via `engine_dropped_command_bytes()` — before the
    /// 2026-07 audit (P2-2) this loss was completely silent.
    dropped_command_bytes: u32,
    listener_pos: [f32; 3],
    listener_prev_pos: [f32; 3],
    listener_vel: [f32; 3],
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        Self {
            world: World::new(),
            entity_map: EntityMap::new(),
            render_state: RenderState::new(),
            #[cfg(feature = "physics-2d")]
            physics: crate::physics::HyperionPhysicsWorld::new(),
            #[cfg(feature = "physics-debug")]
            debug_render_enabled: false,
            #[cfg(feature = "physics-debug")]
            debug_lines: Vec::new(),
            accumulator: 0.0,
            tick_count: 0,
            dropped_command_bytes: 0,
            listener_pos: [0.0; 3],
            listener_prev_pos: [0.0; 3],
            listener_vel: [0.0; 3],
        }
    }

    /// Apply a batch of commands to the ECS world.
    /// Called before `update()` each frame.
    pub fn process_commands(&mut self, commands: &[Command]) {
        // Handle listener position (engine-level state, not entity-specific)
        #[cfg(feature = "physics-debug")]
        for cmd in commands {
            if cmd.cmd_type == CommandType::SetPhysicsDebugRender {
                self.debug_render_enabled = cmd.payload[0] != 0;
                if !self.debug_render_enabled {
                    self.debug_lines.clear();
                }
            }
        }

        for cmd in commands {
            if cmd.cmd_type == CommandType::SetListenerPosition {
                let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                // A non-finite listener position poisons the derived velocity
                // and, through extrapolation, every later frame (P2-3).
                if !(x.is_finite() && y.is_finite() && z.is_finite()) {
                    continue;
                }
                let new_pos = [x, y, z];
                let dt = FIXED_DT;
                for ((vel, &np), &prev) in self.listener_vel.iter_mut()
                    .zip(new_pos.iter())
                    .zip(self.listener_prev_pos.iter())
                {
                    *vel = (np - prev) / dt;
                }
                self.listener_pos = new_pos;
                self.listener_prev_pos = new_pos;
            }
        }

        // ECS command processing
        #[cfg(feature = "physics-2d")]
        {
            crate::command_processor::process_commands(
                commands,
                &mut self.world,
                &mut self.entity_map,
                &mut self.render_state,
                &mut self.physics,
            );
            // Second pass: route live-body physics commands (force/impulse/damping/etc.)
            crate::physics_commands::process_physics_commands(
                commands,
                &mut self.world,
                &self.entity_map,
                &mut self.physics,
            );
        }
        #[cfg(not(feature = "physics-2d"))]
        {
            process_commands(commands, &mut self.world, &mut self.entity_map, &mut self.render_state);
        }
    }

    /// Advance the engine by `dt` seconds (variable, from requestAnimationFrame).
    /// Runs fixed-timestep physics ticks, then recomputes transforms and
    /// collects render state.
    pub fn update(&mut self, dt: f32) {
        // 0. Clear physics frame event buffers at start of frame.
        #[cfg(feature = "physics-2d")]
        {
            self.physics.frame_collision_events.clear();
            self.physics.frame_contact_force_events.clear();
        }

        // 1. Accumulate time and run fixed-timestep ticks.
        self.accumulator += dt;

        // Cap accumulator to prevent spiral of death.
        if self.accumulator > FIXED_DT * 10.0 {
            self.accumulator = FIXED_DT * 10.0;
        }

        while self.accumulator >= FIXED_DT {
            self.fixed_tick();
            self.accumulator -= FIXED_DT;
            self.tick_count += 1;
        }

        // (physics_sync_post now runs inside fixed_tick — see below)

        // 2. Recompute model matrices after all ticks.
        transform_system(&mut self.world);
        transform_system_2d(&mut self.world);

        // 2b. Propagate parent transforms for scene graph.
        {
            let ext_to_entity: std::collections::HashMap<u32, hecs::Entity> =
                self.entity_map.iter_mapped().collect();
            propagate_transforms(&mut self.world, &ext_to_entity);
        }

        // 2b-bis. Derive bounding radii from the finished world matrices.
        crate::systems::update_bounding_radii(&mut self.world);

        // 2c. Mark velocity-driven and hierarchy-propagated entities as dirty.
        // Systems (velocity_system, transform_system, propagate_transforms) modify
        // ECS components directly, bypassing command_processor dirty marking.
        self.mark_post_system_dirty();

        // 3. Collect legacy render state (flat matrix buffer).
        self.render_state.collect(&self.world);

        // 4. Flush despawns, sync dirty SoA slots, and build staging cache.
        // This replaces the legacy collect_gpu() — the retained slot mapping
        // keeps SoA buffers up-to-date incrementally via write_slot().
        self.render_state.collect_and_cache_dirty(&self.world);

        // 5. Physics debug lines: once per FRAME, not per tick (I-1).
        #[cfg(feature = "physics-debug")]
        if self.debug_render_enabled {
            let mut lines = std::mem::take(&mut self.debug_lines);
            self.physics.debug_render(&mut lines);
            self.debug_lines = lines;
        }
    }

    /// Mark entities whose SoA data changed due to systems (not commands).
    ///
    /// - Entities with non-zero velocity: velocity_system moved their Position,
    ///   transform_system recomputed their ModelMatrix.
    /// - Children of dirty parents: propagate_transforms updated their ModelMatrix.
    fn mark_post_system_dirty(&mut self) {
        // Pass 1: velocity-driven entities (both 3D and 2D — query is archetype-agnostic)
        for (entity, vel, _active) in
            self.world.query::<(hecs::Entity, &Velocity, &Active)>().iter()
        {
            if vel.0 != glam::Vec3::ZERO
                && let Some(slot) = self.render_state.get_slot(entity)
            {
                self.render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                self.render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
            }
        }

        // Pass 2: descendants of dirty parents, at ANY depth.
        //
        // `propagate_transforms` composes the whole ancestor chain (audit
        // 2026-07, P1-18), so marking only direct children left grandchildren
        // stale on the GPU while their world matrix had in fact changed. The
        // loop repeats until nothing new is marked; each iteration marks at
        // least one more level, so it terminates in at most
        // MAX_HIERARCHY_DEPTH rounds — and `SetParent` rejects cycles.
        let mut rounds = 0;
        loop {
            let mut newly_marked = 0usize;
            for (entity, parent, _active) in
                self.world.query::<(hecs::Entity, &Parent, &Active)>().iter()
            {
                if parent.0 != u32::MAX
                    && let Some(parent_entity) = self.entity_map.get(parent.0)
                    && let Some(parent_slot) = self.render_state.get_slot(parent_entity)
                    && self.render_state.dirty_tracker.is_transform_dirty(parent_slot as usize)
                    && let Some(slot) = self.render_state.get_slot(entity)
                    && !self.render_state.dirty_tracker.is_transform_dirty(slot as usize)
                {
                    self.render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                    self.render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
                    newly_marked += 1;
                }
            }
            rounds += 1;
            if newly_marked == 0 || rounds >= crate::command_processor::MAX_HIERARCHY_DEPTH {
                break;
            }
        }

        // Pass 3 (physics): mark non-sleeping physics entities as dirty.
        // physics_sync_post wrote Rapier body state back to ECS — these entities
        // need their SoA data updated.
        #[cfg(feature = "physics-2d")]
        {
            use crate::physics::PhysicsBodyHandle;
            for (entity, handle, _active) in
                self.world.query::<(hecs::Entity, &PhysicsBodyHandle, &Active)>().iter()
            {
                if let Some(body) = self.physics.rigid_body_set.get(handle.0)
                    && !body.is_sleeping()
                    && let Some(slot) = self.render_state.get_slot(entity)
                {
                    self.render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                    self.render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
                }
            }
        }
    }

    /// A single fixed-timestep tick.
    fn fixed_tick(&mut self) {
        // Physics sync: consume pending bodies/colliders, sync kinematic positions.
        #[cfg(feature = "physics-2d")]
        crate::physics::physics_sync_pre(&mut self.world, &mut self.physics, &self.entity_map, FIXED_DT);

        // Physics step.
        #[cfg(feature = "physics-2d")]
        self.physics.step();

        // Write Rapier state back to the ECS after EVERY tick, not once per
        // frame.
        //
        // `physics_sync_pre` pass 3 pushes the ECS position of kinematic bodies
        // into Rapier on every tick. With the write-back running only once per
        // frame, tick 2+ of a multi-tick frame read a stale `Transform2D` and
        // teleported the body back to where it started — so a character
        // controller moved zero net distance on any frame that ran more than
        // one fixed tick, i.e. on every 30 fps frame (audit 2026-07, P1-6).
        #[cfg(feature = "physics-2d")]
        crate::physics::physics_sync_post(&mut self.world, &self.physics);

        // Velocity integration: use filtered versions when physics is enabled
        // so PhysicsControlled entities are not double-moved.
        #[cfg(feature = "physics-2d")]
        {
            crate::systems::velocity_system_filtered(&mut self.world, FIXED_DT);
            crate::systems::velocity_system_2d_filtered(&mut self.world, FIXED_DT);
        }
        #[cfg(not(feature = "physics-2d"))]
        {
            velocity_system(&mut self.world, FIXED_DT);
            velocity_system_2d(&mut self.world, FIXED_DT);
        }

        // Listener extrapolation.
        for (pos, &vel) in self.listener_pos.iter_mut().zip(self.listener_vel.iter()) {
            *pos += vel * FIXED_DT;
        }
    }

    /// Record bytes that could not be parsed out of a command batch.
    pub fn note_dropped_command_bytes(&mut self, bytes: usize) {
        self.dropped_command_bytes = self
            .dropped_command_bytes
            .saturating_add(bytes.min(u32::MAX as usize) as u32);
    }

    /// Total command bytes discarded since engine start (or the last reset).
    ///
    /// Non-zero means the Rust and TypeScript command tables have diverged, or
    /// the stream was corrupted: everything after an unknown opcode in that
    /// batch was lost, including any `DespawnEntity`.
    pub fn dropped_command_bytes(&self) -> u32 {
        self.dropped_command_bytes
    }

    /// Commands rejected for an out-of-range external entity id
    /// (see `command_processor::MAX_EXTERNAL_ID`).
    pub fn rejected_command_count(&self) -> u32 {
        self.entity_map.rejected_ids()
    }

    /// How many fixed ticks have elapsed since engine start.
    pub fn tick_count(&self) -> u64 {
        self.tick_count
    }

    /// The interpolation alpha for rendering between ticks.
    /// Ranges from 0.0 to 1.0.
    pub fn interpolation_alpha(&self) -> f32 {
        self.accumulator / FIXED_DT
    }

    /// Returns the extrapolated listener X position.
    pub fn listener_x(&self) -> f32 {
        self.listener_pos[0]
    }

    /// Returns the extrapolated listener Y position.
    pub fn listener_y(&self) -> f32 {
        self.listener_pos[1]
    }

    /// Returns the extrapolated listener Z position.
    pub fn listener_z(&self) -> f32 {
        self.listener_pos[2]
    }
}

// ── Dev-tools debug methods ──────────────────────────────────────
#[cfg(feature = "dev-tools")]
impl Engine {
    /// Reset the engine to its initial state, clearing all entities,
    /// mappings, render state, and counters.
    pub fn reset(&mut self) {
        self.world = World::new();
        self.entity_map = EntityMap::new();
        self.render_state = RenderState::new();
        #[cfg(feature = "physics-2d")]
        {
            self.physics = crate::physics::HyperionPhysicsWorld::new();
        }
        #[cfg(feature = "physics-debug")]
        {
            self.debug_render_enabled = false;
            self.debug_lines.clear();
        }
        self.accumulator = 0.0;
        self.tick_count = 0;
        self.dropped_command_bytes = 0;
        self.listener_pos = [0.0; 3];
        self.listener_prev_pos = [0.0; 3];
        self.listener_vel = [0.0; 3];
    }

    /// Serialize the entire engine state into a binary snapshot.
    ///
    /// Format (HSNP v3):
    /// ```text
    /// [magic: 4B "HSNP"][version: u32 = 3][tick: u64][entity_count: u32]
    /// [entity_map_len: u32][entity_map: (ext_id: u32, hecs_id: u64, flags: u8) x N]
    ///                                   // flags bit0 = is_2d
    /// [per entity: hecs_id: u64, component_mask: u32, component_data...]
    /// [physics_present: u8][section_len: u32]  // section_len only when present == 1
    /// [physics section — only if physics_present == 1]
    /// [trailer — v3 only: accumulator: f32, listener_pos/prev/vel: 9 x f32]
    /// ```
    ///
    /// The v3 trailer is appended after the physics section, so a v2 reader
    /// simply ignores it and a v3 reader restores defaults when it is absent.
    /// v1 (mask u16, no map flags, no physics byte) and v2 are still accepted by
    /// `snapshot_restore` for backward compatibility, but never written.
    ///
    /// The `section_len` field was missing from the v2 doc block even though the
    /// writer always emitted it (audit 2026-07, P3-8).
    pub fn snapshot_create(&self) -> Vec<u8> {
        use crate::components::*;

        let mut buf = Vec::with_capacity(4096);

        // Header
        buf.extend_from_slice(b"HSNP");
        buf.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
        buf.extend_from_slice(&self.tick_count.to_le_bytes());

        // Entity count — we'll come back and patch this
        let entity_count_offset = buf.len();
        buf.extend_from_slice(&0u32.to_le_bytes()); // placeholder

        // Entity map: length + entries (ext_id, hecs bits, flags)
        let mapped: Vec<(u32, hecs::Entity)> = self.entity_map.iter_mapped().collect();
        buf.extend_from_slice(&(mapped.len() as u32).to_le_bytes());
        for &(ext_id, entity) in &mapped {
            buf.extend_from_slice(&ext_id.to_le_bytes());
            buf.extend_from_slice(&entity.to_bits().get().to_le_bytes());
            let flags: u8 = if self.entity_map.is_entity_2d(ext_id) { 1 } else { 0 };
            buf.push(flags);
        }

        // Per-entity component data
        let mut entity_count = 0u32;
        for entity in self.world.iter() {
            let e = entity.entity();
            entity_count += 1;

            buf.extend_from_slice(&e.to_bits().get().to_le_bytes());

            let mask_offset = buf.len();
            buf.extend_from_slice(&0u32.to_le_bytes()); // placeholder mask
            let mut mask: u32 = 0;

            // bit 0: Position (12 bytes)
            if let Ok(v) = self.world.get::<&Position>(e) {
                mask |= 1 << 0;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 1: Velocity (12 bytes)
            if let Ok(v) = self.world.get::<&Velocity>(e) {
                mask |= 1 << 1;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 2: Rotation (16 bytes)
            if let Ok(v) = self.world.get::<&Rotation>(e) {
                mask |= 1 << 2;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 3: Scale (12 bytes)
            if let Ok(v) = self.world.get::<&Scale>(e) {
                mask |= 1 << 3;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 4: ModelMatrix (64 bytes)
            if let Ok(v) = self.world.get::<&ModelMatrix>(e) {
                mask |= 1 << 4;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 5: BoundingRadius (4 bytes)
            if let Ok(v) = self.world.get::<&BoundingRadius>(e) {
                mask |= 1 << 5;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 6: TextureLayerIndex (4 bytes)
            if let Ok(v) = self.world.get::<&TextureLayerIndex>(e) {
                mask |= 1 << 6;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 7: MeshHandle (4 bytes)
            if let Ok(v) = self.world.get::<&MeshHandle>(e) {
                mask |= 1 << 7;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 8: RenderPrimitive (1 byte)
            if let Ok(v) = self.world.get::<&RenderPrimitive>(e) {
                mask |= 1 << 8;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 9: Parent (4 bytes, manual)
            if let Ok(v) = self.world.get::<&Parent>(e) {
                mask |= 1 << 9;
                buf.extend_from_slice(&v.0.to_le_bytes());
            }
            // bit 10: Active (0 bytes, marker)
            if self.world.get::<&Active>(e).is_ok() {
                mask |= 1 << 10;
            }
            // bit 11: ExternalId (4 bytes)
            if let Ok(v) = self.world.get::<&ExternalId>(e) {
                mask |= 1 << 11;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 12: PrimitiveParams (32 bytes)
            if let Ok(v) = self.world.get::<&PrimitiveParams>(e) {
                mask |= 1 << 12;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 13: LocalMatrix (64 bytes, cast_slice)
            if let Ok(v) = self.world.get::<&LocalMatrix>(e) {
                mask |= 1 << 13;
                let bytes: &[u8] = bytemuck::cast_slice(&v.0);
                buf.extend_from_slice(bytes);
            }
            // bit 14: Children (1 byte count + count*4 bytes)
            if let Ok(v) = self.world.get::<&Children>(e) {
                mask |= 1 << 14;
                buf.push(v.count);
                for i in 0..v.count as usize {
                    buf.extend_from_slice(&v.slots[i].to_le_bytes());
                }
            }
            // bit 15: Transform2D (20 bytes) — v2
            if let Ok(v) = self.world.get::<&Transform2D>(e) {
                mask |= 1 << 15;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 16: Depth (4 bytes) — v2
            if let Ok(v) = self.world.get::<&Depth>(e) {
                mask |= 1 << 16;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 17: Transparent (1 byte) — v2
            if let Ok(v) = self.world.get::<&Transparent>(e) {
                mask |= 1 << 17;
                buf.extend_from_slice(bytemuck::bytes_of(&*v));
            }
            // bit 18: OverflowChildren (u32 count + count*4 bytes) — v2
            if let Ok(v) = self.world.get::<&OverflowChildren>(e) {
                mask |= 1 << 18;
                buf.extend_from_slice(&(v.items.len() as u32).to_le_bytes());
                for id in &v.items {
                    buf.extend_from_slice(&id.to_le_bytes());
                }
            }

            // Patch mask
            buf[mask_offset..mask_offset + 4].copy_from_slice(&mask.to_le_bytes());
        }

        // Patch entity count
        buf[entity_count_offset..entity_count_offset + 4]
            .copy_from_slice(&entity_count.to_le_bytes());

        // Physics section: [present: u8][section_len: u32][section...].
        // The length prefix makes the section skippable by readers compiled
        // without physics-2d (Invariant I-4).
        #[cfg(feature = "physics-2d")]
        {
            buf.push(1u8);
            let len_offset = buf.len();
            buf.extend_from_slice(&0u32.to_le_bytes()); // placeholder
            crate::physics::snapshot::serialize_physics(&mut buf, &self.world, &self.physics);
            let section_len = (buf.len() - len_offset - 4) as u32;
            buf[len_offset..len_offset + 4].copy_from_slice(&section_len.to_le_bytes());
        }
        #[cfg(not(feature = "physics-2d"))]
        buf.push(0u8);

        // v3 trailer — frame-timing and audio-listener state.
        //
        // Neither was serialized before the 2026-07 audit (P2-6), so a restored
        // engine started with accumulator 0 and a listener at the origin: fed
        // the identical dt stream it drifted up to one full tick out of phase
        // from the engine it was cloned from, and 2D audio panning jumped.
        buf.extend_from_slice(&self.accumulator.to_le_bytes());
        for v in self
            .listener_pos
            .iter()
            .chain(self.listener_prev_pos.iter())
            .chain(self.listener_vel.iter())
        {
            buf.extend_from_slice(&v.to_le_bytes());
        }

        buf
    }

    /// Restore engine state from a binary snapshot produced by `snapshot_create`.
    /// Returns `true` on success, `false` on invalid data.
    pub fn snapshot_restore(&mut self, data: &[u8]) -> bool {
        use crate::components::*;

        // Minimum header: magic(4) + version(4) + tick(8) + entity_count(4) + map_len(4) = 24
        if data.len() < 24 {
            return false;
        }

        // Validate magic
        if &data[0..4] != b"HSNP" {
            return false;
        }

        let mut cursor = 4;

        macro_rules! read_pod {
            ($t:ty) => {{
                let size = std::mem::size_of::<$t>();
                if cursor + size > data.len() { return false; }
                let val: $t = bytemuck::pod_read_unaligned(&data[cursor..cursor + size]);
                cursor += size;
                val
            }};
        }

        let version = read_pod!(u32);
        if version != 1 && version != 2 && version != SNAPSHOT_VERSION {
            return false;
        }
        // v2 and v3 share the entity/physics layout; v3 only appends a trailer.
        let v2 = version >= 2;

        let tick = read_pod!(u64);
        let entity_count = read_pod!(u32);

        // Entity map. v2 entries carry a flags byte (bit0 = is_2d).
        let map_len = read_pod!(u32) as usize;
        // Validate the claimed length against the bytes actually present BEFORE
        // sizing the allocation. `Vec::with_capacity(map_len)` on an unvalidated
        // u32 turned a 24-byte hostile buffer into a 64 GiB allocation request,
        // i.e. an abort rather than the documented `false` (audit 2026-07, P0-3b).
        let entry_size = if v2 { 13 } else { 12 }; // ext_id(4) + hecs(8) [+ flags(1)]
        match map_len.checked_mul(entry_size) {
            Some(needed) if data.len().saturating_sub(cursor) >= needed => {}
            _ => return false,
        }
        let mut ext_to_old_hecs: Vec<(u32, u64, u8)> = Vec::with_capacity(map_len);
        for _ in 0..map_len {
            let ext_id = read_pod!(u32);
            let hecs_bits = read_pod!(u64);
            let flags = if v2 { read_pod!(u8) } else { 0u8 };
            ext_to_old_hecs.push((ext_id, hecs_bits, flags));
        }

        // Rebuild world and entity map
        let mut new_world = World::new();
        let mut new_entity_map = EntityMap::new();

        // Map old hecs ID → new hecs Entity so we can fix up entity_map
        let mut old_to_new: std::collections::HashMap<u64, hecs::Entity> =
            std::collections::HashMap::new();

        for _ in 0..entity_count {
            let old_hecs_bits = read_pod!(u64);
            // v1 masks are u16 (bits 0-14); v2 masks are u32 (bits 0-18).
            let mask: u32 = if v2 {
                read_pod!(u32)
            } else {
                read_pod!(u16) as u32
            };

            // Read component data
            let position = if mask & (1 << 0) != 0 { read_pod!(Position) } else { Position::default() };
            let velocity = if mask & (1 << 1) != 0 { read_pod!(Velocity) } else { Velocity::default() };
            let rotation = if mask & (1 << 2) != 0 { read_pod!(Rotation) } else { Rotation::default() };
            let scale = if mask & (1 << 3) != 0 { read_pod!(Scale) } else { Scale::default() };
            let model_matrix = if mask & (1 << 4) != 0 { read_pod!(ModelMatrix) } else { ModelMatrix::default() };
            let bounding_radius = if mask & (1 << 5) != 0 { read_pod!(BoundingRadius) } else { BoundingRadius::default() };
            let texture_layer = if mask & (1 << 6) != 0 { read_pod!(TextureLayerIndex) } else { TextureLayerIndex::default() };
            let mesh_handle = if mask & (1 << 7) != 0 { read_pod!(MeshHandle) } else { MeshHandle::default() };
            let render_prim = if mask & (1 << 8) != 0 { read_pod!(RenderPrimitive) } else { RenderPrimitive::default() };

            let parent = if mask & (1 << 9) != 0 {
                Parent(read_pod!(u32))
            } else {
                Parent::default()
            };

            let is_active = mask & (1 << 10) != 0;

            let external_id = if mask & (1 << 11) != 0 { read_pod!(ExternalId) } else { ExternalId(0) };

            let prim_params = if mask & (1 << 12) != 0 { read_pod!(PrimitiveParams) } else { PrimitiveParams::default() };

            let local_matrix = if mask & (1 << 13) != 0 {
                if cursor + 64 > data.len() { return false; }
                // `bytemuck::cast_slice` PANICS on a misaligned &[u8], and
                // `cursor` is content-dependent, so 3 alignments out of 4
                // trapped instead of returning false (audit 2026-07, P0-3c).
                let mut arr = [0.0f32; 16];
                for (i, v) in arr.iter_mut().enumerate() {
                    *v = f32::from_le_bytes(
                        data[cursor + i * 4..cursor + i * 4 + 4].try_into().unwrap(),
                    );
                }
                cursor += 64;
                Some(LocalMatrix(arr))
            } else {
                None
            };

            let children = if mask & (1 << 14) != 0 {
                if cursor >= data.len() { return false; }
                let count = data[cursor];
                cursor += 1;
                // `count` is an unvalidated u8 (0-255) written into a
                // [u32; 32]: anything above MAX_CHILDREN indexed out of
                // bounds, i.e. a WASM trap (audit 2026-07, P0-3a).
                if count as usize > Children::MAX_CHILDREN {
                    return false;
                }
                let needed = count as usize * 4;
                if cursor + needed > data.len() { return false; }
                let mut slots = [0u32; Children::MAX_CHILDREN];
                for i in 0..count as usize {
                    slots[i] = u32::from_le_bytes(
                        data[cursor + i * 4..cursor + i * 4 + 4].try_into().unwrap(),
                    );
                }
                cursor += needed;
                Some(Children { slots, count })
            } else {
                None
            };

            // v2-only components (bits 15-18); never set in v1 masks.
            let transform_2d = if mask & (1 << 15) != 0 {
                Some(read_pod!(Transform2D))
            } else {
                None
            };
            let depth = if mask & (1 << 16) != 0 {
                Some(read_pod!(Depth))
            } else {
                None
            };
            let transparent = if mask & (1 << 17) != 0 {
                Some(read_pod!(Transparent))
            } else {
                None
            };
            let overflow_children = if mask & (1 << 18) != 0 {
                let count = read_pod!(u32) as usize;
                // On wasm32 `usize` is 32-bit, so `count * 4` wraps and the
                // guard passes for count >= 0x4000_0000 (audit 2026-07, P2-10).
                match count.checked_mul(4) {
                    Some(needed) if data.len().saturating_sub(cursor) >= needed => {}
                    _ => return false,
                }
                let mut items = Vec::with_capacity(count);
                for i in 0..count {
                    items.push(u32::from_le_bytes(
                        data[cursor + i * 4..cursor + i * 4 + 4].try_into().unwrap(),
                    ));
                }
                cursor += count * 4;
                Some(OverflowChildren { items })
            } else {
                None
            };

            // Spawn with the archetype matching the original entity:
            // Transform2D present => compact 2D archetype (mirrors SpawnEntity
            // with payload[0]=1), otherwise the 3D archetype.
            let new_entity = if let Some(t2d) = transform_2d {
                new_world.spawn((
                    t2d,
                    velocity,
                    model_matrix,
                    bounding_radius,
                    texture_layer,
                    mesh_handle,
                    render_prim,
                    prim_params,
                    external_id,
                    parent,
                    children.unwrap_or_default(),
                ))
            } else {
                new_world.spawn((
                    position,
                    velocity,
                    rotation,
                    scale,
                    model_matrix,
                    bounding_radius,
                    texture_layer,
                    mesh_handle,
                    render_prim,
                    prim_params,
                    external_id,
                    parent,
                    children.unwrap_or_default(),
                ))
            };

            // Optionally add Active
            if is_active {
                let _ = new_world.insert_one(new_entity, Active);
            }

            // Optionally add LocalMatrix
            if let Some(lm) = local_matrix {
                let _ = new_world.insert_one(new_entity, lm);
            }

            // Optionally add v2 components
            if let Some(d) = depth {
                let _ = new_world.insert_one(new_entity, d);
            }
            if let Some(t) = transparent {
                let _ = new_world.insert_one(new_entity, t);
            }
            if let Some(oc) = overflow_children {
                let _ = new_world.insert_one(new_entity, oc);
            }

            old_to_new.insert(old_hecs_bits, new_entity);
        }

        // v2: physics section [present: u8][section_len: u32][section...].
        // Bounds are validated here; the section itself is parsed after the
        // entity map is rebuilt (it needs ext_id -> entity lookups).
        let mut physics_section: Option<(usize, usize)> = None; // (start, len)
        if v2 {
            if cursor >= data.len() {
                return false;
            }
            let physics_present = data[cursor];
            cursor += 1;
            match physics_present {
                0 => {}
                1 => {
                    if cursor + 4 > data.len() {
                        return false;
                    }
                    let section_len =
                        u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap()) as usize;
                    cursor += 4;
                    // 32-bit wrap: `cursor + section_len` overflowed on wasm32
                    // and let `&data[start..start + len]` panic with an
                    // inverted range (audit 2026-07, P2-10).
                    if data.len().saturating_sub(cursor) < section_len {
                        return false;
                    }
                    physics_section = Some((cursor, section_len));
                    cursor += section_len;
                }
                _ => return false,
            }
        }
        // v3 trailer: accumulator + listener state. Absent in v1/v2 (and in a
        // truncated v3), in which case the defaults below are used.
        let mut accumulator = 0.0f32;
        let mut listener_pos = [0.0f32; 3];
        let mut listener_prev_pos = [0.0f32; 3];
        let mut listener_vel = [0.0f32; 3];
        if version >= SNAPSHOT_VERSION && data.len().saturating_sub(cursor) >= 40 {
            let mut read_f32 = || {
                let v = f32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap());
                cursor += 4;
                v
            };
            accumulator = read_f32();
            for v in listener_pos.iter_mut() {
                *v = read_f32();
            }
            for v in listener_prev_pos.iter_mut() {
                *v = read_f32();
            }
            for v in listener_vel.iter_mut() {
                *v = read_f32();
            }
        }
        let _ = cursor; // final cursor position — trailing bytes are ignored
        #[cfg(not(feature = "physics-2d"))]
        let _ = physics_section; // skipped-by-length on non-physics builds (I-4)

        // Rebuild entity map with new hecs entities (+ is_2d flags in v2)
        for (ext_id, old_bits, flags) in ext_to_old_hecs {
            if let Some(&new_entity) = old_to_new.get(&old_bits) {
                let _ = new_entity_map.insert(ext_id, new_entity);
                new_entity_map.set_2d_flag(ext_id, flags & 1 != 0);
            }
        }
        // `insert` never advances `next_id`, so a restored map used to report
        // next_id == 0 and `allocate()` handed back an id already bound to a
        // live entity (audit 2026-07, P3-11).
        new_entity_map.reserve_ids_up_to_highest();

        // Rebuild the physics world. Always replaced wholesale — restoring
        // any snapshot on a physics build must not leak old Rapier bodies
        // (the pre-Phase-16 orphan-body bug).
        #[cfg(feature = "physics-2d")]
        let new_physics = {
            let mut new_physics = crate::physics::HyperionPhysicsWorld::new();
            if let Some((start, len)) = physics_section
                && !crate::physics::snapshot::restore_physics(
                    &data[start..start + len],
                    &mut new_world,
                    &new_entity_map,
                    &mut new_physics,
                )
            {
                return false;
            }
            new_physics
        };

        // Rebuild render state: restored entities need GPU slots, otherwise
        // they are invisible in the retained-slot upload path.
        let mut new_render_state = RenderState::new();
        for (ext_id, entity) in new_entity_map.iter_mapped().collect::<Vec<_>>() {
            let slot = new_render_state.assign_slot(entity);
            if new_entity_map.is_entity_2d(ext_id) {
                new_render_state.write_slot_2d(slot, &new_world, entity);
            } else {
                new_render_state.write_slot(slot, &new_world, entity);
            }
        }
        // Also rebuild the legacy flat matrix buffer: a host rendering through
        // it between restore and the next update() drew nothing before
        // (audit 2026-07, P3-11 sibling).
        new_render_state.collect(&new_world);

        // Replace engine state
        self.world = new_world;
        self.entity_map = new_entity_map;
        self.render_state = new_render_state;
        #[cfg(feature = "physics-2d")]
        {
            self.physics = new_physics;
        }
        self.accumulator = accumulator;
        self.tick_count = tick;
        self.listener_pos = listener_pos;
        self.listener_prev_pos = listener_prev_pos;
        self.listener_vel = listener_vel;
        #[cfg(feature = "physics-debug")]
        {
            // A restored world has no relation to the previous frame's debug
            // geometry; `reset()` already cleared it, restore did not.
            self.debug_lines.clear();
        }

        true
    }

    /// Canonical 64-bit FNV-1a hash of the simulation state (Phase 16
    /// Track B). Two engines that processed the same commands for the same
    /// number of ticks produce the same hash; any state divergence changes it.
    ///
    /// Invariant I-2: every collection is ordered by external ID / joint ID —
    /// hecs archetype iteration order must never leak into the hash. Floats
    /// are hashed by bit pattern (`to_bits`), so -0.0 vs 0.0 and NaN payload
    /// differences count as differences.
    pub fn state_hash(&self) -> u64 {
        use crate::components::*;

        const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

        struct Fnv(u64);
        impl Fnv {
            fn byte(&mut self, b: u8) {
                self.0 ^= u64::from(b);
                self.0 = self.0.wrapping_mul(FNV_PRIME);
            }
            fn u32(&mut self, v: u32) {
                for b in v.to_le_bytes() {
                    self.byte(b);
                }
            }
            fn u64(&mut self, v: u64) {
                for b in v.to_le_bytes() {
                    self.byte(b);
                }
            }
            fn f32(&mut self, v: f32) {
                self.u32(v.to_bits());
            }
        }

        let mut h = Fnv(FNV_OFFSET);
        h.u64(self.tick_count);

        // ── ECS state, ordered by external ID ──
        let mut mapped: Vec<(u32, hecs::Entity)> = self.entity_map.iter_mapped().collect();
        mapped.sort_unstable_by_key(|(ext, _)| *ext);

        for (ext_id, entity) in mapped {
            h.u32(ext_id);
            if let Ok(t2d) = self.world.get::<&Transform2D>(entity) {
                h.byte(1); // archetype tag
                h.f32(t2d.x);
                h.f32(t2d.y);
                h.f32(t2d.rot);
                h.f32(t2d.sx);
                h.f32(t2d.sy);
            } else {
                h.byte(0);
                if let Ok(p) = self.world.get::<&Position>(entity) {
                    h.f32(p.0.x);
                    h.f32(p.0.y);
                    h.f32(p.0.z);
                }
                if let Ok(r) = self.world.get::<&Rotation>(entity) {
                    h.f32(r.0.x);
                    h.f32(r.0.y);
                    h.f32(r.0.z);
                    h.f32(r.0.w);
                }
                if let Ok(sc) = self.world.get::<&Scale>(entity) {
                    h.f32(sc.0.x);
                    h.f32(sc.0.y);
                    h.f32(sc.0.z);
                }
            }
            if let Ok(v) = self.world.get::<&Velocity>(entity) {
                h.f32(v.0.x);
                h.f32(v.0.y);
                h.f32(v.0.z);
            }
            if let Ok(d) = self.world.get::<&Depth>(entity) {
                h.f32(d.0);
            }

            // Hierarchy and activation.
            //
            // Omitting these made the determinism harness blind to exactly the
            // divergences it exists to catch: `propagate_transforms` writes only
            // `ModelMatrix`, never `Position`, so a re-parent changed nothing
            // this hash could see — permanently, not just on the first tick.
            // Losing `Active` was invisible for the same reason
            // (audit 2026-07, P2-7).
            h.byte(u8::from(self.world.get::<&Active>(entity).is_ok()));
            let parent = self
                .world
                .get::<&Parent>(entity)
                .map(|p| p.0)
                .unwrap_or(u32::MAX);
            h.u32(parent);
            // Children are hashed in sorted order: the inline array's swap-remove
            // makes the stored order depend on removal history, which is NOT
            // simulation state and must never leak into the hash (Invariant I-2).
            let mut kids: Vec<u32> = self
                .world
                .get::<&Children>(entity)
                .map(|c| c.as_slice().to_vec())
                .unwrap_or_default();
            if let Ok(ov) = self.world.get::<&OverflowChildren>(entity) {
                kids.extend_from_slice(&ov.items);
            }
            kids.sort_unstable();
            h.u32(kids.len() as u32);
            for k in kids {
                h.u32(k);
            }
        }

        // ── Physics state, ordered by external ID / joint ID ──
        #[cfg(feature = "physics-2d")]
        {
            use crate::physics::PhysicsBodyHandle;

            let mut bodies: Vec<(u32, rapier2d::prelude::RigidBodyHandle)> = self
                .world
                .query::<(&ExternalId, &PhysicsBodyHandle)>()
                .iter()
                .map(|(ext, handle)| (ext.0, handle.0))
                .collect();
            bodies.sort_unstable_by_key(|(ext, _)| *ext);

            for (ext_id, handle) in bodies {
                let body = &self.physics.rigid_body_set[handle];
                h.u32(ext_id);
                let t = body.translation();
                h.f32(t.x);
                h.f32(t.y);
                h.f32(body.rotation().angle());
                let lv = body.linvel();
                h.f32(lv.x);
                h.f32(lv.y);
                h.f32(body.angvel());
                h.byte(u8::from(body.is_sleeping()));
            }

            let mut joint_ids: Vec<u32> = self.physics.joint_map.keys().copied().collect();
            joint_ids.sort_unstable();
            for joint_id in joint_ids {
                let entry = &self.physics.joint_map[&joint_id];
                h.u32(joint_id);
                h.byte(entry.kind);
                h.u32(entry.entity_a);
                h.u32(entry.entity_b);
            }

            let mut cc_ids: Vec<u32> = self.physics.character_map.keys().copied().collect();
            cc_ids.sort_unstable();
            for ext_id in cc_ids {
                let entry = &self.physics.character_map[&ext_id];
                h.u32(ext_id);
                h.byte(u8::from(entry.state.grounded));
                h.byte(u8::from(entry.state.is_sliding_down_slope));
            }
        }

        h.0
    }

    /// Returns the number of active entities in the ECS world.
    pub fn debug_entity_count(&self) -> u32 {
        crate::systems::count_active(&self.world) as u32
    }

    /// Writes mapped external entity IDs into `out`, returning the count written.
    /// If `active_only` is true, only entities with the `Active` component are included.
    pub fn debug_list_entities(&self, out: &mut [u32], active_only: bool) -> u32 {
        let mut written = 0usize;
        for (ext_id, entity) in self.entity_map.iter_mapped() {
            if written >= out.len() {
                break;
            }
            if active_only && self.world.get::<&crate::components::Active>(entity).is_err() {
                continue;
            }
            out[written] = ext_id;
            written += 1;
        }
        written as u32
    }

    /// Generate wireframe line vertices for bounding sphere visualization.
    /// Each entity produces a 16-segment circle approximation (32 vertices = 16 line pairs).
    /// Returns the number of vertices written.
    ///
    /// `vert_out`: 3 f32 per vertex (x, y, z)
    /// `color_out`: 4 f32 per vertex (r, g, b, a)
    /// `max_verts`: maximum number of vertices to write
    pub fn debug_generate_lines(
        &self,
        vert_out: &mut [f32],
        color_out: &mut [f32],
        max_verts: u32,
    ) -> u32 {
        use crate::components::{Active, BoundingRadius, ModelMatrix};
        use std::f32::consts::TAU;

        const SEGMENTS: usize = 16;
        const VERTS_PER_ENTITY: usize = SEGMENTS * 2; // 2 endpoints per line segment

        let max = max_verts as usize;
        let mut written = 0usize;

        // Driven by the WORLD MATRIX, not `Position`.
        //
        // The old query required `Position`, which the `Transform2D` archetype
        // does not have — so the bounding-sphere overlay was completely empty in
        // a 2D scene, the primary archetype (audit 2026-07, P2-8). Reading the
        // matrix also puts the circle where the entity actually renders,
        // inherited parent transforms included.
        for (entity, matrix, radius) in self
            .world
            .query::<(hecs::Entity, &ModelMatrix, &BoundingRadius)>()
            .iter()
        {
            if written + VERTS_PER_ENTITY > max {
                break;
            }

            // Check if vert_out and color_out have space
            let v_end = (written + VERTS_PER_ENTITY) * 3;
            let c_end = (written + VERTS_PER_ENTITY) * 4;
            if v_end > vert_out.len() || c_end > color_out.len() {
                break;
            }

            // Translation column of the world matrix.
            let cx = matrix.0[12];
            let cy = matrix.0[13];
            let cz = matrix.0[14];
            let r = radius.0;

            // Color: green for active, yellow for inactive
            let is_active = self.world.get::<&Active>(entity).is_ok();
            let (cr, cg, cb, ca) = if is_active {
                (0.0, 1.0, 0.0, 0.8)
            } else {
                (1.0, 1.0, 0.0, 0.6)
            };

            // Generate circle line segments
            for seg in 0..SEGMENTS {
                let a0 = TAU * (seg as f32) / (SEGMENTS as f32);
                let a1 = TAU * ((seg + 1) as f32) / (SEGMENTS as f32);

                let vi = (written + seg * 2) * 3;
                let ci = (written + seg * 2) * 4;

                // Start point
                vert_out[vi] = cx + r * a0.cos();
                vert_out[vi + 1] = cy + r * a0.sin();
                vert_out[vi + 2] = cz;

                color_out[ci] = cr;
                color_out[ci + 1] = cg;
                color_out[ci + 2] = cb;
                color_out[ci + 3] = ca;

                // End point
                vert_out[vi + 3] = cx + r * a1.cos();
                vert_out[vi + 4] = cy + r * a1.sin();
                vert_out[vi + 5] = cz;

                color_out[ci + 4] = cr;
                color_out[ci + 5] = cg;
                color_out[ci + 6] = cb;
                color_out[ci + 7] = ca;
            }

            written += VERTS_PER_ENTITY;
        }

        written as u32
    }

    /// Serialize all components of the entity with the given external ID into
    /// TLV (Type-Length-Value) format. Returns the number of bytes written.
    ///
    /// TLV entry: `[type: u8][length: u16 LE][data: length bytes]`
    ///
    /// Component type IDs:
    ///   Position=1, Velocity=2, Rotation=3, Scale=4, ModelMatrix=5,
    ///   BoundingRadius=6, TextureLayerIndex=7, MeshHandle=8, RenderPrimitive=9,
    ///   Parent=10, Active=11, ExternalId=12, PrimitiveParams=13,
    ///   LocalMatrix=14, Children=15
    pub fn debug_get_components(&self, external_id: u32, out: &mut [u8]) -> u32 {
        use crate::components::*;

        let entity = match self.entity_map.get(external_id) {
            Some(e) => e,
            None => return 0,
        };

        let mut cursor = 0usize;

        // Helper: write a TLV entry from raw bytes
        let write_tlv = |typ: u8, data: &[u8], buf: &mut [u8], pos: &mut usize| -> bool {
            let needed = 3 + data.len(); // 1 type + 2 length + data
            if *pos + needed > buf.len() {
                return false;
            }
            buf[*pos] = typ;
            let len = data.len() as u16;
            buf[*pos + 1] = len as u8;
            buf[*pos + 2] = (len >> 8) as u8;
            buf[*pos + 3..*pos + 3 + data.len()].copy_from_slice(data);
            *pos += needed;
            true
        };

        // Pod components: use bytemuck::bytes_of
        // Collapsed if-let chains to satisfy clippy::collapsible_if
        if let Ok(v) = self.world.get::<&Position>(entity)
            && !write_tlv(1, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&Velocity>(entity)
            && !write_tlv(2, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&Rotation>(entity)
            && !write_tlv(3, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&Scale>(entity)
            && !write_tlv(4, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&ModelMatrix>(entity)
            && !write_tlv(5, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&BoundingRadius>(entity)
            && !write_tlv(6, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&TextureLayerIndex>(entity)
            && !write_tlv(7, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&MeshHandle>(entity)
            && !write_tlv(8, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&RenderPrimitive>(entity)
            && !write_tlv(9, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        // Parent: manual serialization (not Pod)
        if let Ok(v) = self.world.get::<&Parent>(entity)
            && !write_tlv(10, &v.0.to_le_bytes(), out, &mut cursor) { return cursor as u32; }
        // Active: marker component, zero-length data
        if self.world.get::<&Active>(entity).is_ok()
            && !write_tlv(11, &[], out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&ExternalId>(entity)
            && !write_tlv(12, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&PrimitiveParams>(entity)
            && !write_tlv(13, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        // LocalMatrix: manual serialization (not Pod)
        if let Ok(v) = self.world.get::<&LocalMatrix>(entity) {
            let bytes: &[u8] = bytemuck::cast_slice(&v.0);
            if !write_tlv(14, bytes, out, &mut cursor) { return cursor as u32; }
        }
        // Children: count (u8) + child IDs (count × u32 LE)
        if let Ok(v) = self.world.get::<&Children>(entity) {
            let count = v.count as usize;
            let data_len = 1 + count * 4;
            let mut data = vec![0u8; data_len];
            data[0] = v.count;
            for i in 0..count {
                data[1 + i * 4..1 + i * 4 + 4].copy_from_slice(&v.slots[i].to_le_bytes());
            }
            if !write_tlv(15, &data, out, &mut cursor) { return cursor as u32; }
        }

        // v2 archetype components (audit 2026-07, P2-8).
        //
        // These had no TLV type at all, so a 2D entity — the archetype the
        // codebase itself calls "99% of entities" — was exported with NO
        // positional data whatsoever: it has no `Position`, and `Transform2D`
        // was not emitted. `snapshot_create` and `state_hash` were both extended
        // for v2; this exporter was not.
        if let Ok(v) = self.world.get::<&Transform2D>(entity)
            && !write_tlv(16, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&Depth>(entity)
            && !write_tlv(17, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&Transparent>(entity)
            && !write_tlv(18, bytemuck::bytes_of(&*v), out, &mut cursor) { return cursor as u32; }
        if let Ok(v) = self.world.get::<&OverflowChildren>(entity) {
            let mut data = Vec::with_capacity(4 + v.items.len() * 4);
            data.extend_from_slice(&(v.items.len() as u32).to_le_bytes());
            for id in &v.items {
                data.extend_from_slice(&id.to_le_bytes());
            }
            if !write_tlv(19, &data, out, &mut cursor) { return cursor as u32; }
        }

        cursor as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ring_buffer::{Command, CommandType};

    fn spawn_cmd(id: u32) -> Command {
        Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: id,
            payload: [0; 16],
        }
    }

    fn make_position_cmd(id: u32, x: f32, y: f32, z: f32) -> Command {
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&x.to_le_bytes());
        payload[4..8].copy_from_slice(&y.to_le_bytes());
        payload[8..12].copy_from_slice(&z.to_le_bytes());
        Command {
            cmd_type: CommandType::SetPosition,
            entity_id: id,
            payload,
        }
    }

    fn velocity_cmd(id: u32, vx: f32, vy: f32, vz: f32) -> Command {
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&vx.to_le_bytes());
        payload[4..8].copy_from_slice(&vy.to_le_bytes());
        payload[8..12].copy_from_slice(&vz.to_le_bytes());
        Command {
            cmd_type: CommandType::SetVelocity,
            entity_id: id,
            payload,
        }
    }

    #[test]
    fn engine_processes_commands_and_ticks() {
        let mut engine = Engine::new();

        // Spawn entity and set velocity.
        engine.process_commands(&[spawn_cmd(0), velocity_cmd(0, 60.0, 0.0, 0.0)]);

        // Run for exactly 1 fixed tick (1/60th second).
        engine.update(FIXED_DT);

        let entity = engine.entity_map.get(0).unwrap();
        let pos = engine.world.get::<&crate::components::Position>(entity).unwrap();
        assert!((pos.0.x - 1.0).abs() < 0.001);
    }

    #[test]
    fn fixed_timestep_accumulates() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), velocity_cmd(0, 60.0, 0.0, 0.0)]);

        // Run for half a tick — should not advance physics.
        engine.update(FIXED_DT * 0.5);
        assert_eq!(engine.tick_count(), 0);

        // Run for another half — now one full tick should fire.
        engine.update(FIXED_DT * 0.5);
        assert_eq!(engine.tick_count(), 1);
    }

    #[test]
    fn spiral_of_death_capped() {
        let mut engine = Engine::new();
        // Pass a huge dt — should be capped to 10 ticks max.
        engine.update(100.0);
        assert!(engine.tick_count() <= 10);
    }

    #[test]
    fn model_matrix_updated_after_tick() {
        let mut engine = Engine::new();
        let mut pos_cmd = Command {
            cmd_type: CommandType::SetPosition,
            entity_id: 0,
            payload: [0; 16],
        };
        pos_cmd.payload[0..4].copy_from_slice(&5.0f32.to_le_bytes());
        pos_cmd.payload[4..8].copy_from_slice(&10.0f32.to_le_bytes());
        pos_cmd.payload[8..12].copy_from_slice(&15.0f32.to_le_bytes());

        engine.process_commands(&[spawn_cmd(0), pos_cmd]);
        engine.update(FIXED_DT);

        let entity = engine.entity_map.get(0).unwrap();
        let matrix = engine.world.get::<&crate::components::ModelMatrix>(entity).unwrap();
        assert!((matrix.0[12] - 5.0).abs() < 0.001);
        assert!((matrix.0[13] - 10.0).abs() < 0.001);
        assert!((matrix.0[14] - 15.0).abs() < 0.001);
    }

    #[test]
    fn render_state_collected_after_update() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), spawn_cmd(1)]);
        engine.update(FIXED_DT);

        assert_eq!(engine.render_state.count(), 2);
        assert!(!engine.render_state.as_ptr().is_null());
    }

    #[test]
    fn engine_propagates_parent_transforms() {
        let mut engine = Engine::new();

        engine.process_commands(&[spawn_cmd(0), spawn_cmd(1)]);

        let mut pos_payload = [0u8; 16];
        pos_payload[0..4].copy_from_slice(&10.0f32.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::SetPosition,
            entity_id: 0,
            payload: pos_payload,
        }]);

        let mut child_pos = [0u8; 16];
        child_pos[0..4].copy_from_slice(&5.0f32.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::SetPosition,
            entity_id: 1,
            payload: child_pos,
        }]);

        let mut parent_payload = [0u8; 16];
        parent_payload[0..4].copy_from_slice(&0u32.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::SetParent,
            entity_id: 1,
            payload: parent_payload,
        }]);

        engine.update(FIXED_DT);

        let child_entity = engine.entity_map.get(1).unwrap();
        let matrix = engine
            .world
            .get::<&crate::components::ModelMatrix>(child_entity)
            .unwrap();
        assert!((matrix.0[12] - 15.0).abs() < 0.001);
    }

    #[test]
    fn engine_listener_defaults_to_origin() {
        let engine = Engine::new();
        assert_eq!(engine.listener_x(), 0.0);
        assert_eq!(engine.listener_y(), 0.0);
        assert_eq!(engine.listener_z(), 0.0);
    }

    #[test]
    fn engine_listener_extrapolates_position() {
        let mut engine = Engine::new();

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10.0f32.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::SetListenerPosition,
            entity_id: 0,
            payload,
        }]);

        // Velocity = (10 - 0) / (1/60) = 600 units/sec
        // After 1 tick, position: 10 + 600 * (1/60) = 20
        engine.update(FIXED_DT);

        assert!((engine.listener_x() - 20.0).abs() < 0.1);
    }

    #[test]
    fn engine_processes_set_listener_position() {
        let mut engine = Engine::new();

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&5.0f32.to_le_bytes());
        payload[4..8].copy_from_slice(&10.0f32.to_le_bytes());
        payload[8..12].copy_from_slice(&0.0f32.to_le_bytes());

        let cmd = Command {
            cmd_type: CommandType::SetListenerPosition,
            entity_id: 0,
            payload,
        };
        engine.process_commands(&[cmd]);

        assert!((engine.listener_x() - 5.0).abs() < 0.001);
        assert!((engine.listener_y() - 10.0).abs() < 0.001);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn debug_entity_count_returns_active_count() {
        let mut engine = Engine::new();
        assert_eq!(engine.debug_entity_count(), 0);
        let cmds = vec![spawn_cmd(0), spawn_cmd(1), spawn_cmd(2)];
        engine.process_commands(&cmds);
        assert_eq!(engine.debug_entity_count(), 3);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn debug_list_entities_returns_all_mapped_ids() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), spawn_cmd(1), spawn_cmd(2)]);
        let mut out = vec![0u32; 10];
        let count = engine.debug_list_entities(&mut out, false);
        assert_eq!(count, 3);
        let mut ids: Vec<u32> = out[..count as usize].to_vec();
        ids.sort();
        assert_eq!(ids, vec![0, 1, 2]);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn debug_get_components_returns_tlv_data() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), make_position_cmd(0, 5.0, 10.0, 15.0)]);
        engine.update(1.0 / 60.0);
        let mut out = vec![0u8; 1024];
        let bytes_written = engine.debug_get_components(0, &mut out);
        assert!(bytes_written > 0);
        // First TLV entry is decodable
        let comp_type = out[0];
        let data_len = u16::from_le_bytes([out[1], out[2]]) as usize;
        assert!((1..=19).contains(&comp_type));
        assert!(data_len > 0);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn debug_generate_lines_produces_circle_vertices() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), make_position_cmd(0, 10.0, 20.0, 0.0)]);
        engine.update(1.0 / 60.0);
        let mut verts = vec![0.0f32; 16 * 2 * 3]; // 16 segments * 2 endpoints * 3 floats
        let mut colors = vec![0.0f32; 16 * 2 * 4]; // 16 segments * 2 endpoints * 4 RGBA
        let count = engine.debug_generate_lines(&mut verts, &mut colors, 16 * 2);
        assert!(count > 0, "should produce at least some line vertices");
        assert_eq!(count % 2, 0, "line vertices come in pairs");
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn debug_generate_lines_respects_max_verts() {
        let mut engine = Engine::new();
        for i in 0..100 {
            engine.process_commands(&[spawn_cmd(i)]);
        }
        engine.update(1.0 / 60.0);
        let max = 64; // much less than 100 entities * 32 verts
        let mut verts = vec![0.0f32; max * 3];
        let mut colors = vec![0.0f32; max * 4];
        let count = engine.debug_generate_lines(&mut verts, &mut colors, max as u32);
        assert!(count <= max as u32);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn debug_generate_lines_empty_world() {
        let engine = Engine::new();
        let mut verts = vec![0.0f32; 96];
        let mut colors = vec![0.0f32; 128];
        let count = engine.debug_generate_lines(&mut verts, &mut colors, 32);
        assert_eq!(count, 0);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn reset_clears_world_and_tick_count() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), spawn_cmd(1), spawn_cmd(2)]);
        engine.update(1.0 / 60.0);
        assert!(engine.tick_count() > 0);
        assert!(engine.entity_map.get(0).is_some());
        engine.reset();
        assert_eq!(engine.tick_count(), 0);
        assert!(engine.entity_map.get(0).is_none());
        assert_eq!(crate::systems::count_active(&engine.world), 0);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_create_produces_valid_bytes() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), make_position_cmd(0, 5.0, 10.0, 0.0)]);
        engine.update(1.0 / 60.0);
        let snapshot = engine.snapshot_create();
        assert!(!snapshot.is_empty());
        assert_eq!(&snapshot[0..4], b"HSNP");
        let version = u32::from_le_bytes(snapshot[4..8].try_into().unwrap());
        assert_eq!(version, SNAPSHOT_VERSION);
        let tick = u64::from_le_bytes(snapshot[8..16].try_into().unwrap());
        assert!(tick > 0);
        let entity_count = u32::from_le_bytes(snapshot[16..20].try_into().unwrap());
        assert_eq!(entity_count, 1);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_roundtrip_preserves_state() {
        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_cmd(0),
            make_position_cmd(0, 5.0, 10.0, 0.0),
            spawn_cmd(1),
            make_position_cmd(1, 20.0, 30.0, 0.0),
        ]);
        engine.update(1.0 / 60.0);
        let snapshot = engine.snapshot_create();
        engine.process_commands(&[make_position_cmd(0, 999.0, 999.0, 0.0)]);
        engine.update(1.0 / 60.0);
        assert!(engine.snapshot_restore(&snapshot));
        let e0 = engine.entity_map.get(0).unwrap();
        let pos0 = engine.world.get::<&crate::components::Position>(e0).unwrap();
        assert!((pos0.0.x - 5.0).abs() < 0.5);
        let e1 = engine.entity_map.get(1).unwrap();
        let pos1 = engine.world.get::<&crate::components::Position>(e1).unwrap();
        assert!((pos1.0.x - 20.0).abs() < 0.5);
        assert_eq!(engine.tick_count(), 1);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_restore_rejects_invalid_magic() {
        let mut engine = Engine::new();
        let bad_data = b"BADDxxxxxxxxxxxxxxxxxxxxxxxx";
        assert!(!engine.snapshot_restore(bad_data));
    }

    // ── Snapshot v2 tests (Phase 16) ────────────────────────────────

    #[cfg(feature = "dev-tools")]
    fn spawn_2d_cmd_dt(id: u32) -> Command {
        let mut payload = [0u8; 16];
        payload[0] = 1; // 2D archetype
        Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: id,
            payload,
        }
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_v2_2d_entity_roundtrip() {
        use crate::components::{Position, Transform2D};
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_2d_cmd_dt(0), make_position_cmd(0, 7.0, 8.0, 0.0)]);
        let snapshot = engine.snapshot_create();

        // Mutate, then restore.
        engine.process_commands(&[make_position_cmd(0, 999.0, 999.0, 0.0)]);
        assert!(engine.snapshot_restore(&snapshot));

        let e = engine.entity_map.get(0).unwrap();
        let t2d = engine.world.get::<&Transform2D>(e).unwrap();
        assert_eq!(t2d.x, 7.0);
        assert_eq!(t2d.y, 8.0);
        assert_eq!(t2d.sx, 1.0);
        // 2D archetype: no Position component (would be a phantom 3D leak).
        drop(t2d);
        assert!(engine.world.get::<&Position>(e).is_err());
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_v2_preserves_is_2d_flag_and_command_routing() {
        use crate::components::Transform2D;
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_2d_cmd_dt(0), spawn_cmd(1)]);
        let snapshot = engine.snapshot_create();
        assert!(engine.snapshot_restore(&snapshot));

        assert!(engine.entity_map.is_entity_2d(0));
        assert!(!engine.entity_map.is_entity_2d(1));

        // Post-restore commands must still route to Transform2D for 2D entities.
        engine.process_commands(&[make_position_cmd(0, 42.0, 43.0, 0.0)]);
        let e = engine.entity_map.get(0).unwrap();
        let t2d = engine.world.get::<&Transform2D>(e).unwrap();
        assert_eq!(t2d.x, 42.0);
        assert_eq!(t2d.y, 43.0);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_v2_depth_and_transparent_roundtrip() {
        use crate::components::{Depth, Transparent};
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0)]);
        let e = engine.entity_map.get(0).unwrap();
        engine.world.insert_one(e, Depth(3.5)).unwrap();
        engine.world.insert_one(e, Transparent(1)).unwrap();

        let snapshot = engine.snapshot_create();
        assert!(engine.snapshot_restore(&snapshot));

        let e = engine.entity_map.get(0).unwrap();
        assert_eq!(engine.world.get::<&Depth>(e).unwrap().0, 3.5);
        assert_eq!(engine.world.get::<&Transparent>(e).unwrap().0, 1);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_v2_overflow_children_roundtrip() {
        use crate::components::OverflowChildren;
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0)]);
        let e = engine.entity_map.get(0).unwrap();
        let items: Vec<u32> = (100..140).collect(); // 40 overflow children
        engine
            .world
            .insert_one(e, OverflowChildren { items: items.clone() })
            .unwrap();

        let snapshot = engine.snapshot_create();
        assert!(engine.snapshot_restore(&snapshot));

        let e = engine.entity_map.get(0).unwrap();
        let oc = engine.world.get::<&OverflowChildren>(e).unwrap();
        assert_eq!(oc.items, items);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_v1_backward_compat() {
        // Hand-built v1 snapshot: 1 entity with Position + ExternalId.
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"HSNP");
        buf.extend_from_slice(&1u32.to_le_bytes()); // version 1
        buf.extend_from_slice(&77u64.to_le_bytes()); // tick
        buf.extend_from_slice(&1u32.to_le_bytes()); // entity_count
        buf.extend_from_slice(&1u32.to_le_bytes()); // map_len
        buf.extend_from_slice(&0u32.to_le_bytes()); // ext_id 0
        let old_bits: u64 = (1 << 32) | 42;
        buf.extend_from_slice(&old_bits.to_le_bytes());
        // NOTE: v1 has no flags byte here.
        buf.extend_from_slice(&old_bits.to_le_bytes()); // per-entity hecs bits
        let mask: u16 = (1 << 0) | (1 << 11); // Position + ExternalId
        buf.extend_from_slice(&mask.to_le_bytes()); // v1: u16 mask
        buf.extend_from_slice(&5.0f32.to_le_bytes()); // Position.x
        buf.extend_from_slice(&6.0f32.to_le_bytes()); // Position.y
        buf.extend_from_slice(&7.0f32.to_le_bytes()); // Position.z
        buf.extend_from_slice(&0u32.to_le_bytes()); // ExternalId(0)
        // NOTE: v1 has no physics_present byte.

        let mut engine = Engine::new();
        assert!(engine.snapshot_restore(&buf));
        assert_eq!(engine.tick_count(), 77);
        let e = engine.entity_map.get(0).unwrap();
        let pos = engine.world.get::<&crate::components::Position>(e).unwrap();
        assert_eq!(pos.0.x, 5.0);
        assert_eq!(pos.0.z, 7.0);
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_restore_rejects_future_version() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0)]);
        let mut snapshot = engine.snapshot_create();
        snapshot[4..8].copy_from_slice(&(SNAPSHOT_VERSION + 1).to_le_bytes());
        assert!(!engine.snapshot_restore(&snapshot));
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_v2_rejects_unknown_physics_section() {
        // Hand-built snapshot claiming a physics section that isn't there.
        // Layout-independent so it keeps working across format revisions.
        let mut snapshot = Vec::new();
        snapshot.extend_from_slice(b"HSNP");
        snapshot.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
        snapshot.extend_from_slice(&0u64.to_le_bytes()); // tick
        snapshot.extend_from_slice(&0u32.to_le_bytes()); // entity_count
        snapshot.extend_from_slice(&0u32.to_le_bytes()); // map_len
        snapshot.push(1u8); // physics_present
        snapshot.extend_from_slice(&100u32.to_le_bytes()); // section_len, but no bytes follow
        let mut engine = Engine::new();
        assert!(!engine.snapshot_restore(&snapshot));
    }

    /// A `section_len` that overflows 32-bit `usize` arithmetic must be
    /// rejected, not accepted into an inverted slice range (audit 2026-07,
    /// P2-10 — only reachable on wasm32, but the guard is target-independent).
    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_rejects_overflowing_physics_section_len() {
        let mut snapshot = Vec::new();
        snapshot.extend_from_slice(b"HSNP");
        snapshot.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
        snapshot.extend_from_slice(&0u64.to_le_bytes());
        snapshot.extend_from_slice(&0u32.to_le_bytes());
        snapshot.extend_from_slice(&0u32.to_le_bytes());
        snapshot.push(1u8);
        snapshot.extend_from_slice(&u32::MAX.to_le_bytes());
        snapshot.extend_from_slice(&[0u8; 32]);
        let mut engine = Engine::new();
        assert!(!engine.snapshot_restore(&snapshot));
    }

    /// A hostile `map_len` must be rejected against the bytes actually present
    /// instead of sizing a `Vec::with_capacity` allocation (audit 2026-07, P0-3b).
    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_rejects_oversized_entity_map_len() {
        let mut snapshot = Vec::new();
        snapshot.extend_from_slice(b"HSNP");
        snapshot.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
        snapshot.extend_from_slice(&0u64.to_le_bytes());
        snapshot.extend_from_slice(&0u32.to_le_bytes());
        snapshot.extend_from_slice(&u32::MAX.to_le_bytes()); // map_len
        let mut engine = Engine::new();
        assert!(!engine.snapshot_restore(&snapshot));
    }

    /// `Children.count` is an unvalidated byte from the wire written into a
    /// `[u32; 32]`; anything above the cap must be rejected, not indexed
    /// out of bounds (audit 2026-07, P0-3a).
    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_rejects_oversized_children_count() {
        let mut snapshot = Vec::new();
        snapshot.extend_from_slice(b"HSNP");
        snapshot.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
        snapshot.extend_from_slice(&0u64.to_le_bytes());
        snapshot.extend_from_slice(&1u32.to_le_bytes()); // entity_count
        snapshot.extend_from_slice(&0u32.to_le_bytes()); // map_len
        snapshot.extend_from_slice(&7u64.to_le_bytes()); // hecs id
        snapshot.extend_from_slice(&(1u32 << 14).to_le_bytes()); // Children only
        snapshot.push(200); // count > MAX_CHILDREN
        snapshot.extend_from_slice(&[0u8; 800]);
        let mut engine = Engine::new();
        assert!(!engine.snapshot_restore(&snapshot));
    }

    /// `LocalMatrix` used `bytemuck::cast_slice`, which panics when the byte
    /// slice is not 4-byte aligned. The cursor is content-dependent, so 3
    /// alignments out of 4 trapped (audit 2026-07, P0-3c).
    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_local_matrix_survives_every_alignment() {
        for pad in 0..4u32 {
            let mut snapshot = Vec::new();
            snapshot.extend_from_slice(b"HSNP");
            snapshot.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
            snapshot.extend_from_slice(&0u64.to_le_bytes());
            snapshot.extend_from_slice(&1u32.to_le_bytes());
            snapshot.extend_from_slice(&pad.to_le_bytes()); // map_len shifts alignment
            for i in 0..pad {
                snapshot.extend_from_slice(&i.to_le_bytes());
                snapshot.extend_from_slice(&0u64.to_le_bytes());
                snapshot.push(0);
            }
            snapshot.extend_from_slice(&7u64.to_le_bytes());
            snapshot.extend_from_slice(&(1u32 << 13).to_le_bytes()); // LocalMatrix
            snapshot.extend_from_slice(&[0u8; 64]);
            let mut engine = Engine::new();
            // Must not panic; the value returned is irrelevant.
            let _ = engine.snapshot_restore(&snapshot);
        }
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn snapshot_restore_reassigns_render_slots() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), spawn_cmd(1), spawn_2d_cmd_dt(2)]);
        let snapshot = engine.snapshot_create();

        let mut fresh = Engine::new();
        assert!(fresh.snapshot_restore(&snapshot));
        // Restored entities must be visible in the retained-slot GPU path.
        assert_eq!(fresh.render_state.gpu_entity_count(), 3);
    }

    // ── Physics integration tests ──────────────────────────────────

    #[cfg(feature = "physics-2d")]
    fn spawn_2d_cmd(id: u32) -> Command {
        let mut payload = [0u8; 16];
        payload[0] = 1; // 2D
        Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: id,
            payload,
        }
    }

    #[cfg(feature = "physics-2d")]
    fn create_rigid_body_cmd(id: u32, body_type: u8) -> Command {
        let mut payload = [0u8; 16];
        payload[0] = body_type;
        Command {
            cmd_type: CommandType::CreateRigidBody,
            entity_id: id,
            payload,
        }
    }

    #[cfg(feature = "physics-2d")]
    fn create_circle_collider_cmd(id: u32, radius: f32) -> Command {
        let mut payload = [0u8; 16];
        payload[0] = 0; // circle
        payload[1..5].copy_from_slice(&radius.to_le_bytes());
        Command {
            cmd_type: CommandType::CreateCollider,
            entity_id: id,
            payload,
        }
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn ball_falls_under_gravity() {
        let mut engine = Engine::new();

        // Spawn 2D entity + dynamic body + circle collider
        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 0)]); // dynamic
        engine.process_commands(&[create_circle_collider_cmd(0, 10.0)]);

        // Run 10 frames
        for _ in 0..10 {
            engine.update(FIXED_DT);
        }

        // Ball should have fallen (gravity.y = 980)
        let entity = engine.entity_map.get(0).unwrap();
        let t = engine.world.get::<&crate::components::Transform2D>(entity).unwrap();
        assert!(t.y > 1.0, "ball should have fallen: y={}", t.y);
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn despawn_removes_rapier_body() {
        let mut engine = Engine::new();

        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 0)]);
        engine.process_commands(&[create_circle_collider_cmd(0, 5.0)]);
        engine.update(FIXED_DT);
        assert_eq!(engine.physics.body_count(), 1);

        // Despawn
        engine.process_commands(&[Command {
            cmd_type: CommandType::DespawnEntity,
            entity_id: 0,
            payload: [0; 16],
        }]);
        engine.update(FIXED_DT);
        assert_eq!(engine.physics.body_count(), 0);
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn destroy_rigid_body_removes_from_rapier() {
        let mut engine = Engine::new();

        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 0)]);
        engine.process_commands(&[create_circle_collider_cmd(0, 5.0)]);
        engine.update(FIXED_DT);
        assert_eq!(engine.physics.body_count(), 1);

        // DestroyRigidBody
        engine.process_commands(&[Command {
            cmd_type: CommandType::DestroyRigidBody,
            entity_id: 0,
            payload: [0; 16],
        }]);
        assert_eq!(engine.physics.body_count(), 0);

        // Entity still exists in ECS
        assert!(engine.entity_map.get(0).is_some());
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn physics_does_not_move_non_physics_entity() {
        let mut engine = Engine::new();

        // Spawn 2D entity WITHOUT physics — should stay at origin
        engine.process_commands(&[spawn_2d_cmd(0)]);

        for _ in 0..10 {
            engine.update(FIXED_DT);
        }

        let entity = engine.entity_map.get(0).unwrap();
        let t = engine.world.get::<&crate::components::Transform2D>(entity).unwrap();
        assert!((t.y - 0.0).abs() < 0.01, "non-physics entity should not move: y={}", t.y);
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn velocity_on_non_physics_entity_still_works() {
        let mut engine = Engine::new();

        // Spawn 2D entity with velocity but NO physics body
        engine.process_commands(&[spawn_2d_cmd(0)]);
        let mut vel_payload = [0u8; 16];
        vel_payload[0..4].copy_from_slice(&60.0f32.to_le_bytes());
        vel_payload[4..8].copy_from_slice(&0.0f32.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::SetVelocity,
            entity_id: 0,
            payload: vel_payload,
        }]);

        engine.update(FIXED_DT);

        let entity = engine.entity_map.get(0).unwrap();
        let t = engine.world.get::<&crate::components::Transform2D>(entity).unwrap();
        assert!(t.x > 0.5, "velocity entity should move: x={}", t.x);
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn physics_reset_clears_rapier_state() {
        // This test requires dev-tools for the reset method.
        // Only run if both features are available.
        #[cfg(feature = "dev-tools")]
        {
            let mut engine = Engine::new();
            engine.process_commands(&[spawn_2d_cmd(0)]);
            engine.process_commands(&[create_rigid_body_cmd(0, 0)]);
            engine.process_commands(&[create_circle_collider_cmd(0, 5.0)]);
            engine.update(FIXED_DT);
            assert_eq!(engine.physics.body_count(), 1);
            engine.reset();
            assert_eq!(engine.physics.body_count(), 0);
        }
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn character_controller_grounded_on_floor() {
        let mut engine = Engine::new();

        // Pixel-space convention (the one HyperionPhysicsWorld::new documents): gravity
        // is (0, +980), so "down" is +Y and the floor sits BELOW the character
        // at y=+50. The character controller derives its `up` from gravity
        // (audit 2026-07, P1-11), so this is now the coherent layout — before
        // the fix `up` was hardcoded to +Y, i.e. the direction gravity pulls,
        // and `grounded` could never become true in a scene built this way.

        // Create static floor at y=+50
        engine.process_commands(&[spawn_2d_cmd(100)]);
        let mut floor_pos = [0u8; 16];
        floor_pos[0..4].copy_from_slice(&0.0f32.to_le_bytes());    // x=0
        floor_pos[4..8].copy_from_slice(&50.0f32.to_le_bytes()); // y=+50 (below)
        engine.process_commands(&[Command {
            cmd_type: CommandType::SetPosition,
            entity_id: 100,
            payload: floor_pos,
        }]);
        engine.process_commands(&[create_rigid_body_cmd(100, 1)]); // 1=fixed
        let mut floor_col = [0u8; 16];
        floor_col[0] = 1; // box shape
        floor_col[1..5].copy_from_slice(&1000.0f32.to_le_bytes()); // width=1000
        floor_col[5..9].copy_from_slice(&20.0f32.to_le_bytes());   // height=20
        engine.process_commands(&[Command {
            cmd_type: CommandType::CreateCollider,
            entity_id: 100,
            payload: floor_col,
        }]);

        // Create kinematic character at y=0 (above floor)
        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 2)]); // 2=kinematic
        engine.process_commands(&[create_circle_collider_cmd(0, 10.0)]);

        // Create character controller
        engine.process_commands(&[Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        }]);

        // Initial update to create bodies + step physics (builds BVH)
        engine.update(FIXED_DT);

        // Move character downward (toward floor), large movement
        let mut move_payload = [0u8; 16];
        move_payload[0..4].copy_from_slice(&0.0f32.to_le_bytes());   // dx=0
        move_payload[4..8].copy_from_slice(&200.0f32.to_le_bytes()); // dy=+200 (down)
        engine.process_commands(&[Command {
            cmd_type: CommandType::MoveCharacter,
            entity_id: 0,
            payload: move_payload,
        }]);

        engine.update(FIXED_DT);

        // Character should be grounded.
        //
        // NOTE: `is_sliding_down_slope` is deliberately NOT asserted here.
        // Rapier sets that flag from the `else` arm of its slope handling
        // (character_controller.rs:605-615), which is also taken when there is
        // no slipping at all — so it reads `true` even on a perfectly flat
        // floor when the input pushes straight down. It is not a reliable
        // "on a slope" signal.
        let state = &engine.physics.character_map.get(&0).unwrap().state;
        assert!(state.grounded, "character standing on the floor must report grounded");
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn character_controller_move_without_floor() {
        let mut engine = Engine::new();
        engine.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0); // no gravity
        engine.physics.integration_parameters.length_unit = 100.0;

        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 2)]);
        engine.process_commands(&[create_circle_collider_cmd(0, 10.0)]);
        engine.process_commands(&[Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        }]);
        engine.update(FIXED_DT);

        let mut move_payload = [0u8; 16];
        move_payload[0..4].copy_from_slice(&50.0f32.to_le_bytes());
        move_payload[4..8].copy_from_slice(&0.0f32.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::MoveCharacter,
            entity_id: 0,
            payload: move_payload,
        }]);
        engine.update(FIXED_DT);

        assert!(!engine.physics.character_map.get(&0).unwrap().state.grounded);
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn character_controller_despawn_cleanup() {
        let mut engine = Engine::new();
        engine.physics.gravity = rapier2d::math::Vector::new(0.0, -980.0);
        engine.physics.integration_parameters.length_unit = 100.0;

        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 2)]);
        engine.process_commands(&[create_circle_collider_cmd(0, 10.0)]);
        engine.process_commands(&[Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        }]);
        engine.update(FIXED_DT);
        assert!(engine.physics.character_map.contains_key(&0));

        engine.process_commands(&[Command {
            cmd_type: CommandType::DespawnEntity,
            entity_id: 0,
            payload: [0; 16],
        }]);
        engine.update(FIXED_DT);
        assert!(!engine.physics.character_map.contains_key(&0));
    }

    // ── Physics debug rendering tests (Phase 16, Task 7) ───────────────

    #[cfg(feature = "physics-debug")]
    fn set_debug_render_cmd(enabled: bool) -> Command {
        let mut payload = [0u8; 16];
        payload[0] = u8::from(enabled);
        Command {
            cmd_type: CommandType::SetPhysicsDebugRender,
            entity_id: 0,
            payload,
        }
    }

    #[cfg(feature = "physics-debug")]
    #[test]
    fn physics_debug_lines_generated_when_enabled() {
        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 0),
            create_circle_collider_cmd(0, 10.0),
            set_debug_render_cmd(true),
        ]);
        engine.update(FIXED_DT);

        assert!(!engine.debug_lines.is_empty(), "collider should emit debug lines");
        assert_eq!(engine.debug_lines.len() % 8, 0, "8 f32 per line record");
    }

    #[cfg(feature = "physics-debug")]
    #[test]
    fn physics_debug_lines_cover_joints() {
        use crate::physics::{PendingJoint, PendingJointType};

        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 0),
            create_circle_collider_cmd(0, 10.0),
        ]);
        engine.update(FIXED_DT);
        let baseline = {
            engine.process_commands(&[set_debug_render_cmd(true)]);
            engine.update(FIXED_DT);
            engine.debug_lines.len()
        };

        engine.process_commands(&[
            spawn_2d_cmd(1),
            create_rigid_body_cmd(1, 0),
            create_circle_collider_cmd(1, 10.0),
        ]);
        engine.physics.pending_joints.push(PendingJoint {
            joint_id: 1,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Fixed,
        });
        engine.update(FIXED_DT);
        assert!(
            engine.debug_lines.len() > baseline,
            "second collider + joint should add debug lines"
        );
    }

    #[cfg(feature = "physics-debug")]
    #[test]
    fn physics_debug_disabled_clears_lines() {
        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 0),
            create_circle_collider_cmd(0, 10.0),
            set_debug_render_cmd(true),
        ]);
        engine.update(FIXED_DT);
        assert!(!engine.debug_lines.is_empty());

        engine.process_commands(&[set_debug_render_cmd(false)]);
        engine.update(FIXED_DT);
        assert!(engine.debug_lines.is_empty(), "disable must clear the buffer");
        assert!(!engine.debug_render_enabled);
    }

    #[cfg(feature = "physics-debug")]
    #[test]
    fn physics_debug_line_colors_are_rgba_in_unit_range() {
        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 0),
            create_circle_collider_cmd(0, 10.0),
            set_debug_render_cmd(true),
        ]);
        engine.update(FIXED_DT);

        for record in engine.debug_lines.chunks_exact(8) {
            for &c in &record[4..8] {
                assert!(
                    (0.0..=1.0).contains(&c),
                    "color component {c} out of RGBA unit range (HSLA leak?)"
                );
            }
        }
    }

    #[cfg(all(feature = "physics-debug", feature = "dev-tools"))]
    #[test]
    fn physics_debug_reset_clears_state() {
        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 0),
            create_circle_collider_cmd(0, 10.0),
            set_debug_render_cmd(true),
        ]);
        engine.update(FIXED_DT);
        assert!(!engine.debug_lines.is_empty());

        engine.reset();
        assert!(engine.debug_lines.is_empty());
        assert!(!engine.debug_render_enabled);
    }

    // ── State hash tests (Phase 16, Task 5) ────────────────────────────

    #[cfg(feature = "dev-tools")]
    #[test]
    fn state_hash_run_to_run_deterministic() {
        let run = || {
            let mut engine = Engine::new();
            engine.process_commands(&[
                spawn_cmd(0),
                make_position_cmd(0, 5.0, 10.0, 0.0),
                velocity_cmd(0, 3.0, -2.0, 0.0),
                spawn_2d_cmd_dt(1),
                make_position_cmd(1, 7.0, 8.0, 0.0),
            ]);
            for _ in 0..30 {
                engine.update(FIXED_DT);
            }
            engine.state_hash()
        };
        assert_eq!(run(), run());
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn state_hash_sensitive_to_state_changes() {
        let mut a = Engine::new();
        a.process_commands(&[spawn_cmd(0), make_position_cmd(0, 5.0, 10.0, 0.0)]);
        let mut b = Engine::new();
        b.process_commands(&[spawn_cmd(0), make_position_cmd(0, 5.0, 10.0, 0.0)]);
        assert_eq!(a.state_hash(), b.state_hash());

        // One extra command diverges the hash.
        b.process_commands(&[make_position_cmd(0, 5.0001, 10.0, 0.0)]);
        assert_ne!(a.state_hash(), b.state_hash());

        // Tick count is part of the state.
        let before = a.state_hash();
        a.update(FIXED_DT);
        assert_ne!(before, a.state_hash());
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn state_hash_independent_of_spawn_order() {
        // Same final state reached through different spawn order must hash
        // identically (collections are ordered by external ID, I-2).
        let mut a = Engine::new();
        a.process_commands(&[spawn_cmd(0), spawn_cmd(1)]);
        a.process_commands(&[
            make_position_cmd(0, 1.0, 2.0, 0.0),
            make_position_cmd(1, 3.0, 4.0, 0.0),
        ]);

        let mut b = Engine::new();
        b.process_commands(&[spawn_cmd(1), spawn_cmd(0)]);
        b.process_commands(&[
            make_position_cmd(1, 3.0, 4.0, 0.0),
            make_position_cmd(0, 1.0, 2.0, 0.0),
        ]);

        assert_eq!(a.state_hash(), b.state_hash());
    }

    #[cfg(feature = "dev-tools")]
    #[test]
    fn state_hash_distinguishes_negative_zero() {
        let mut a = Engine::new();
        a.process_commands(&[spawn_cmd(0), make_position_cmd(0, 0.0, 0.0, 0.0)]);
        let mut b = Engine::new();
        b.process_commands(&[spawn_cmd(0), make_position_cmd(0, -0.0, 0.0, 0.0)]);
        // Bit-pattern hashing: -0.0 != 0.0.
        assert_ne!(a.state_hash(), b.state_hash());
    }

    // ── Snapshot v2 physics section tests (Phase 16, Tasks 3-4) ────────

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    fn setup_falling_body_engine() -> Engine {
        let mut engine = Engine::new();
        engine.physics.gravity = rapier2d::math::Vector::new(0.0, -980.0);
        engine.physics.integration_parameters.length_unit = 100.0;
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 0), // dynamic
            create_circle_collider_cmd(0, 10.0),
        ]);
        // Let it fall for a few frames so it has velocity + displacement.
        for _ in 0..5 {
            engine.update(FIXED_DT);
        }
        engine
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn snapshot_physics_body_roundtrip() {
        use crate::physics::{PhysicsBodyHandle, PhysicsColliderHandle, PhysicsControlled};

        let mut engine = setup_falling_body_engine();
        assert_eq!(engine.physics.body_count(), 1);

        let e = engine.entity_map.get(0).unwrap();
        let handle = engine.world.get::<&PhysicsBodyHandle>(e).unwrap().0;
        let body = &engine.physics.rigid_body_set[handle];
        let snap_y = body.translation().y;
        let snap_vy = body.linvel().y;
        assert!(snap_vy < 0.0, "body should be falling");

        let snapshot = engine.snapshot_create();

        // Keep simulating, then restore.
        for _ in 0..10 {
            engine.update(FIXED_DT);
        }
        assert!(engine.snapshot_restore(&snapshot));

        assert_eq!(engine.physics.body_count(), 1);
        let e = engine.entity_map.get(0).unwrap();
        assert!(engine.world.get::<&PhysicsControlled>(e).is_ok());
        assert!(engine.world.get::<&PhysicsColliderHandle>(e).is_ok());
        let handle = engine.world.get::<&PhysicsBodyHandle>(e).unwrap().0;
        let body = &engine.physics.rigid_body_set[handle];
        assert_eq!(body.translation().y, snap_y);
        assert_eq!(body.linvel().y, snap_vy);
        assert_eq!(body.body_type(), rapier2d::prelude::RigidBodyType::Dynamic);

        // The restored world must keep simulating: the body keeps falling.
        engine.update(FIXED_DT);
        let body = &engine.physics.rigid_body_set[handle];
        assert!(body.translation().y < snap_y);
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn snapshot_restore_clears_orphan_bodies() {
        // Snapshot an EMPTY engine, then create a body, then restore the
        // empty snapshot: the pre-Phase-16 bug left the Rapier body alive.
        let mut engine = Engine::new();
        let empty_snapshot = engine.snapshot_create();

        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 0),
            create_circle_collider_cmd(0, 10.0),
        ]);
        engine.update(FIXED_DT);
        assert_eq!(engine.physics.body_count(), 1);

        assert!(engine.snapshot_restore(&empty_snapshot));
        assert_eq!(engine.physics.body_count(), 0);
        assert_eq!(engine.physics.collider_set.len(), 0);
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn snapshot_physics_collider_properties_roundtrip() {
        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 1), // fixed
            create_circle_collider_cmd(0, 25.0),
        ]);
        engine.update(FIXED_DT);

        let snapshot = engine.snapshot_create();
        assert!(engine.snapshot_restore(&snapshot));

        let e = engine.entity_map.get(0).unwrap();
        let col_handle = engine
            .world
            .get::<&crate::physics::PhysicsColliderHandle>(e)
            .unwrap()
            .0;
        let collider = &engine.physics.collider_set[col_handle];
        match collider.shape().as_typed_shape() {
            rapier2d::prelude::TypedShape::Ball(b) => assert_eq!(b.radius, 25.0),
            other => panic!("expected ball, got {other:?}"),
        }
        // collider_to_entity reverse map rebuilt for event translation
        let idx = col_handle.0.into_raw_parts().0 as usize;
        assert_eq!(engine.physics.collider_to_entity[idx], Some(0));
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn snapshot_physics_joint_roundtrip() {
        use crate::physics::{PendingJoint, PendingJointType, JOINT_KIND_REVOLUTE};

        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 0),
            create_circle_collider_cmd(0, 10.0),
            spawn_2d_cmd(1),
            create_rigid_body_cmd(1, 0),
            create_circle_collider_cmd(1, 10.0),
        ]);
        engine.physics.pending_joints.push(PendingJoint {
            joint_id: 7,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Revolute { anchor_ax: 3.0, anchor_ay: 4.0 },
        });
        engine.update(FIXED_DT);
        assert_eq!(engine.physics.joint_map.len(), 1);

        let snapshot = engine.snapshot_create();
        assert!(engine.snapshot_restore(&snapshot));

        assert_eq!(engine.physics.joint_map.len(), 1);
        let entry = &engine.physics.joint_map[&7];
        assert_eq!(entry.kind, JOINT_KIND_REVOLUTE);
        assert_eq!(entry.entity_a, 0);
        assert_eq!(entry.entity_b, 1);
        let joint = engine.physics.impulse_joint_set.get(entry.handle).unwrap();
        assert_eq!(joint.data.local_frame1.translation.x, 3.0);
        assert_eq!(joint.data.local_frame1.translation.y, 4.0);
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn snapshot_physics_character_controller_roundtrip() {
        let mut engine = Engine::new();
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 2), // kinematic
            create_circle_collider_cmd(0, 10.0),
            Command {
                cmd_type: CommandType::CreateCharacterController,
                entity_id: 0,
                payload: [0; 16],
            },
        ]);
        // Config: slide on, autostep on (absolute 0.35 / 0.12), snap on (0.5)
        let mut payload = [0u8; 16];
        payload[0] = 0x01 | 0x02 | 0x08;
        payload[1..5].copy_from_slice(&0.9f32.to_le_bytes());
        payload[5..9].copy_from_slice(&0.6f32.to_le_bytes());
        payload[9..11].copy_from_slice(&35u16.to_le_bytes());
        payload[11..13].copy_from_slice(&12u16.to_le_bytes());
        payload[13..15].copy_from_slice(&50u16.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::SetCharacterConfig,
            entity_id: 0,
            payload,
        }]);
        engine.update(FIXED_DT);

        let snapshot = engine.snapshot_create();
        assert!(engine.snapshot_restore(&snapshot));

        let entry = engine.physics.character_map.get(&0).unwrap();
        assert!(entry.controller.slide);
        assert_eq!(entry.controller.max_slope_climb_angle, 0.9);
        assert_eq!(entry.controller.min_slope_slide_angle, 0.6);
        let autostep = entry.controller.autostep.unwrap();
        match autostep.max_height {
            rapier2d::control::CharacterLength::Absolute(v) => assert_eq!(v, 0.35),
            other => panic!("expected absolute, got {other:?}"),
        }
        assert!(entry.controller.snap_to_ground.is_some());
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn snapshot_physics_preserves_world_config() {
        let engine = setup_falling_body_engine();
        let snapshot = engine.snapshot_create();

        let mut fresh = Engine::new();
        assert!(fresh.snapshot_restore(&snapshot));
        assert_eq!(fresh.physics.gravity.y, -980.0);
        assert_eq!(fresh.physics.integration_parameters.length_unit, 100.0);
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn snapshot_physics_restore_twice_is_deterministic() {
        // Two independent restores of the same snapshot, stepped the same
        // number of ticks, must produce identical body states (I-5).
        let engine = setup_falling_body_engine();
        let snapshot = engine.snapshot_create();

        let run = |snapshot: &[u8]| -> (f32, f32) {
            let mut e = Engine::new();
            assert!(e.snapshot_restore(snapshot));
            for _ in 0..30 {
                e.update(FIXED_DT);
            }
            let ent = e.entity_map.get(0).unwrap();
            let handle = e.world.get::<&crate::physics::PhysicsBodyHandle>(ent).unwrap().0;
            let body = &e.physics.rigid_body_set[handle];
            (body.translation().y, body.linvel().y)
        };

        let (y1, vy1) = run(&snapshot);
        let (y2, vy2) = run(&snapshot);
        assert_eq!(y1.to_bits(), y2.to_bits(), "restore-replay must be bit-identical");
        assert_eq!(vy1.to_bits(), vy2.to_bits());
    }

    // ── Restore-replay determinism via state hash (Phase 16, Task 6) ───

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    fn restore_and_run_hash(snapshot: &[u8], ticks: u32) -> u64 {
        let mut e = Engine::new();
        assert!(e.snapshot_restore(snapshot));
        for _ in 0..ticks {
            e.update(FIXED_DT);
        }
        e.state_hash()
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn restore_replay_hash_deterministic_bodies() {
        let engine = setup_falling_body_engine();
        let snapshot = engine.snapshot_create();
        assert_eq!(
            restore_and_run_hash(&snapshot, 30),
            restore_and_run_hash(&snapshot, 30)
        );
        // Different tick counts must diverge (sanity: hash is not degenerate).
        assert_ne!(
            restore_and_run_hash(&snapshot, 30),
            restore_and_run_hash(&snapshot, 31)
        );
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn restore_replay_hash_deterministic_joints() {
        use crate::physics::{PendingJoint, PendingJointType};

        let mut engine = Engine::new();
        engine.physics.gravity = rapier2d::math::Vector::new(0.0, -980.0);
        engine.physics.integration_parameters.length_unit = 100.0;
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 1), // fixed anchor
            create_circle_collider_cmd(0, 5.0),
            spawn_2d_cmd(1),
            create_rigid_body_cmd(1, 0), // dynamic pendulum bob
            create_circle_collider_cmd(1, 5.0),
        ]);
        engine.physics.pending_joints.push(PendingJoint {
            joint_id: 1,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Revolute { anchor_ax: 0.0, anchor_ay: 30.0 },
        });
        for _ in 0..5 {
            engine.update(FIXED_DT);
        }
        let snapshot = engine.snapshot_create();

        assert_eq!(
            restore_and_run_hash(&snapshot, 60),
            restore_and_run_hash(&snapshot, 60)
        );
    }

    #[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
    #[test]
    fn restore_replay_hash_deterministic_character_controller() {
        let mut engine = Engine::new();
        engine.physics.gravity = rapier2d::math::Vector::new(0.0, -980.0);
        engine.physics.integration_parameters.length_unit = 100.0;
        // Ground + kinematic character standing on it.
        engine.process_commands(&[
            spawn_2d_cmd(0),
            create_rigid_body_cmd(0, 1), // fixed ground
            create_circle_collider_cmd(0, 50.0),
            spawn_2d_cmd(1),
            create_rigid_body_cmd(1, 2), // kinematic character
            create_circle_collider_cmd(1, 10.0),
            Command {
                cmd_type: CommandType::CreateCharacterController,
                entity_id: 1,
                payload: [0; 16],
            },
        ]);
        engine.update(FIXED_DT);
        let snapshot = engine.snapshot_create();

        let run = |snapshot: &[u8]| -> u64 {
            let mut e = Engine::new();
            assert!(e.snapshot_restore(snapshot));
            for i in 0..30u32 {
                // Scripted movement: same MoveCharacter stream on both runs.
                let mut payload = [0u8; 16];
                let dx = if i % 2 == 0 { 5.0f32 } else { -3.0f32 };
                payload[0..4].copy_from_slice(&dx.to_le_bytes());
                payload[4..8].copy_from_slice(&(-2.0f32).to_le_bytes());
                e.process_commands(&[Command {
                    cmd_type: CommandType::MoveCharacter,
                    entity_id: 1,
                    payload,
                }]);
                e.update(FIXED_DT);
            }
            e.state_hash()
        };

        assert_eq!(run(&snapshot), run(&snapshot));
    }
}

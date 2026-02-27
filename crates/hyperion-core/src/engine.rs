//! The main engine struct that ties together ECS, command processing,
//! and systems into a deterministic fixed-timestep tick loop.

use hecs::World;

use crate::command_processor::{process_commands, EntityMap};
use crate::render_state::RenderState;
use crate::ring_buffer::{Command, CommandType};
use crate::systems::{propagate_transforms, transform_system, velocity_system};

/// Fixed timestep: 60 ticks per second.
pub const FIXED_DT: f32 = 1.0 / 60.0;

/// The core engine state.
pub struct Engine {
    pub world: World,
    pub entity_map: EntityMap,
    pub render_state: RenderState,
    accumulator: f32,
    tick_count: u64,
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
            accumulator: 0.0,
            tick_count: 0,
            listener_pos: [0.0; 3],
            listener_prev_pos: [0.0; 3],
            listener_vel: [0.0; 3],
        }
    }

    /// Apply a batch of commands to the ECS world.
    /// Called before `update()` each frame.
    pub fn process_commands(&mut self, commands: &[Command]) {
        for cmd in commands {
            if cmd.cmd_type == CommandType::SetListenerPosition {
                let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
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
        process_commands(commands, &mut self.world, &mut self.entity_map);
    }

    /// Advance the engine by `dt` seconds (variable, from requestAnimationFrame).
    /// Runs fixed-timestep physics ticks, then recomputes transforms and
    /// collects render state.
    pub fn update(&mut self, dt: f32) {
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

        // 2. Recompute model matrices after all ticks.
        transform_system(&mut self.world);

        // 2b. Propagate parent transforms for scene graph.
        {
            let ext_to_entity: std::collections::HashMap<u32, hecs::Entity> =
                self.entity_map.iter_mapped().collect();
            propagate_transforms(&mut self.world, &ext_to_entity);
        }

        // 3. Collect render state for GPU upload.
        self.render_state.collect(&self.world);

        // 4. Collect GPU-driven pipeline data.
        self.render_state.collect_gpu(&self.world);
    }

    /// A single fixed-timestep tick.
    fn fixed_tick(&mut self) {
        velocity_system(&mut self.world, FIXED_DT);
        for (pos, &vel) in self.listener_pos.iter_mut().zip(self.listener_vel.iter()) {
            *pos += vel * FIXED_DT;
        }
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
        self.accumulator = 0.0;
        self.tick_count = 0;
        self.listener_pos = [0.0; 3];
        self.listener_prev_pos = [0.0; 3];
        self.listener_vel = [0.0; 3];
    }

    /// Serialize the entire engine state into a binary snapshot.
    ///
    /// Format:
    /// ```text
    /// [magic: 4B "HSNP"][version: u32][tick: u64][entity_count: u32]
    /// [entity_map_len: u32][entity_map: (ext_id: u32, hecs_id: u64) x N]
    /// [per entity: hecs_id: u64, component_mask: u16, component_data...]
    /// ```
    pub fn snapshot_create(&self) -> Vec<u8> {
        use crate::components::*;

        let mut buf = Vec::with_capacity(4096);

        // Header
        buf.extend_from_slice(b"HSNP");
        buf.extend_from_slice(&1u32.to_le_bytes()); // version
        buf.extend_from_slice(&self.tick_count.to_le_bytes());

        // Entity count — we'll come back and patch this
        let entity_count_offset = buf.len();
        buf.extend_from_slice(&0u32.to_le_bytes()); // placeholder

        // Entity map: length + entries
        let mapped: Vec<(u32, hecs::Entity)> = self.entity_map.iter_mapped().collect();
        buf.extend_from_slice(&(mapped.len() as u32).to_le_bytes());
        for &(ext_id, entity) in &mapped {
            buf.extend_from_slice(&ext_id.to_le_bytes());
            buf.extend_from_slice(&entity.to_bits().get().to_le_bytes());
        }

        // Per-entity component data
        let mut entity_count = 0u32;
        for entity in self.world.iter() {
            let e = entity.entity();
            entity_count += 1;

            buf.extend_from_slice(&e.to_bits().get().to_le_bytes());

            let mask_offset = buf.len();
            buf.extend_from_slice(&0u16.to_le_bytes()); // placeholder mask
            let mut mask: u16 = 0;

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

            // Patch mask
            buf[mask_offset..mask_offset + 2].copy_from_slice(&mask.to_le_bytes());
        }

        // Patch entity count
        buf[entity_count_offset..entity_count_offset + 4]
            .copy_from_slice(&entity_count.to_le_bytes());

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
        if version != 1 {
            return false;
        }

        let tick = read_pod!(u64);
        let entity_count = read_pod!(u32);

        // Entity map
        let map_len = read_pod!(u32);
        let mut ext_to_old_hecs: Vec<(u32, u64)> = Vec::with_capacity(map_len as usize);
        for _ in 0..map_len {
            let ext_id = read_pod!(u32);
            let hecs_bits = read_pod!(u64);
            ext_to_old_hecs.push((ext_id, hecs_bits));
        }

        // Rebuild world and entity map
        let mut new_world = World::new();
        let mut new_entity_map = EntityMap::new();

        // Map old hecs ID → new hecs Entity so we can fix up entity_map
        let mut old_to_new: std::collections::HashMap<u64, hecs::Entity> =
            std::collections::HashMap::new();

        for _ in 0..entity_count {
            let old_hecs_bits = read_pod!(u64);
            let mask = read_pod!(u16);

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
                let floats: &[f32] = bytemuck::cast_slice(&data[cursor..cursor + 64]);
                let mut arr = [0.0f32; 16];
                arr.copy_from_slice(floats);
                cursor += 64;
                Some(LocalMatrix(arr))
            } else {
                None
            };

            let children = if mask & (1 << 14) != 0 {
                if cursor >= data.len() { return false; }
                let count = data[cursor];
                cursor += 1;
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

            // Spawn entity with baseline components
            let new_entity = new_world.spawn((
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
            ));

            // Optionally add Active
            if is_active {
                let _ = new_world.insert_one(new_entity, Active);
            }

            // Optionally add LocalMatrix
            if let Some(lm) = local_matrix {
                let _ = new_world.insert_one(new_entity, lm);
            }

            old_to_new.insert(old_hecs_bits, new_entity);
        }

        // Rebuild entity map with new hecs entities
        for (ext_id, old_bits) in ext_to_old_hecs {
            if let Some(&new_entity) = old_to_new.get(&old_bits) {
                new_entity_map.insert(ext_id, new_entity);
            }
        }

        // Replace engine state
        self.world = new_world;
        self.entity_map = new_entity_map;
        self.render_state = RenderState::new();
        self.accumulator = 0.0;
        self.tick_count = tick;
        self.listener_pos = [0.0; 3];
        self.listener_prev_pos = [0.0; 3];
        self.listener_vel = [0.0; 3];

        true
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
        use crate::components::{Active, BoundingRadius, Position};
        use std::f32::consts::TAU;

        const SEGMENTS: usize = 16;
        const VERTS_PER_ENTITY: usize = SEGMENTS * 2; // 2 endpoints per line segment

        let max = max_verts as usize;
        let mut written = 0usize;

        for (entity, pos, radius) in self.world.query::<(hecs::Entity, &Position, &BoundingRadius)>().iter() {
            if written + VERTS_PER_ENTITY > max {
                break;
            }

            // Check if vert_out and color_out have space
            let v_end = (written + VERTS_PER_ENTITY) * 3;
            let c_end = (written + VERTS_PER_ENTITY) * 4;
            if v_end > vert_out.len() || c_end > color_out.len() {
                break;
            }

            let cx = pos.0.x;
            let cy = pos.0.y;
            let cz = pos.0.z;
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
        assert!(comp_type >= 1 && comp_type <= 15);
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
        assert_eq!(version, 1);
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
}

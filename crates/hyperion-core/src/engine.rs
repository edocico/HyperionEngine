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
}

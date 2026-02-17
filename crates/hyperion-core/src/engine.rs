//! The main engine struct that ties together ECS, command processing,
//! and systems into a deterministic fixed-timestep tick loop.

use hecs::World;

use crate::command_processor::{process_commands, EntityMap};
use crate::render_state::RenderState;
use crate::ring_buffer::Command;
use crate::systems::{transform_system, velocity_system};

/// Fixed timestep: 60 ticks per second.
pub const FIXED_DT: f32 = 1.0 / 60.0;

/// The core engine state.
pub struct Engine {
    pub world: World,
    pub entity_map: EntityMap,
    pub render_state: RenderState,
    accumulator: f32,
    tick_count: u64,
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
        }
    }

    /// Apply a batch of commands to the ECS world.
    /// Called before `update()` each frame.
    pub fn process_commands(&mut self, commands: &[Command]) {
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

        // 3. Collect render state for GPU upload.
        self.render_state.collect(&self.world);
    }

    /// A single fixed-timestep tick.
    fn fixed_tick(&mut self) {
        velocity_system(&mut self.world, FIXED_DT);
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
}

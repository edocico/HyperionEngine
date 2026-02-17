//! Translates ring buffer commands into ECS mutations.

use hecs::World;

use crate::components::*;
use crate::ring_buffer::{Command, CommandType};

/// Maps external entity IDs (from TypeScript) to internal hecs entities.
pub struct EntityMap {
    /// Sparse map: external ID -> hecs Entity.
    /// Uses a Vec for O(1) lookup. External IDs are sequential u32s.
    map: Vec<Option<hecs::Entity>>,
    /// Free list for entity recycling.
    free_list: Vec<u32>,
    /// Next external ID to assign.
    next_id: u32,
}

impl Default for EntityMap {
    fn default() -> Self {
        Self::new()
    }
}

impl EntityMap {
    pub fn new() -> Self {
        Self {
            map: Vec::new(),
            free_list: Vec::new(),
            next_id: 0,
        }
    }

    /// Allocate a new external ID (or recycle one).
    pub fn allocate(&mut self) -> u32 {
        if let Some(id) = self.free_list.pop() {
            id
        } else {
            let id = self.next_id;
            self.next_id += 1;
            id
        }
    }

    /// Register a mapping from external ID to hecs entity.
    pub fn insert(&mut self, external_id: u32, entity: hecs::Entity) {
        let idx = external_id as usize;
        if idx >= self.map.len() {
            self.map.resize(idx + 1, None);
        }
        self.map[idx] = Some(entity);
    }

    /// Look up the hecs entity for an external ID.
    pub fn get(&self, external_id: u32) -> Option<hecs::Entity> {
        self.map.get(external_id as usize).copied().flatten()
    }

    /// Remove a mapping and add the ID to the free list.
    pub fn remove(&mut self, external_id: u32) {
        let idx = external_id as usize;
        if idx < self.map.len() {
            self.map[idx] = None;
        }
        if external_id < self.next_id {
            self.free_list.push(external_id);
        }
    }
}

/// Process a batch of commands against the ECS world.
pub fn process_commands(commands: &[Command], world: &mut World, entity_map: &mut EntityMap) {
    for cmd in commands {
        match cmd.cmd_type {
            CommandType::SpawnEntity => {
                let entity = world.spawn((
                    Position::default(),
                    Rotation::default(),
                    Scale::default(),
                    Velocity::default(),
                    ModelMatrix::default(),
                    Active,
                ));
                entity_map.insert(cmd.entity_id, entity);
            }

            CommandType::DespawnEntity => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let _ = world.despawn(entity);
                    entity_map.remove(cmd.entity_id);
                }
            }

            CommandType::SetPosition => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    if let Ok(mut pos) = world.get::<&mut Position>(entity) {
                        pos.0 = glam::Vec3::new(x, y, z);
                    }
                }
            }

            CommandType::SetRotation => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    let w = f32::from_le_bytes(cmd.payload[12..16].try_into().unwrap());
                    if let Ok(mut rot) = world.get::<&mut Rotation>(entity) {
                        rot.0 = glam::Quat::from_xyzw(x, y, z, w);
                    }
                }
            }

            CommandType::SetScale => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    if let Ok(mut scale) = world.get::<&mut Scale>(entity) {
                        scale.0 = glam::Vec3::new(x, y, z);
                    }
                }
            }

            CommandType::SetVelocity => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    if let Ok(mut vel) = world.get::<&mut Velocity>(entity) {
                        vel.0 = glam::Vec3::new(x, y, z);
                    }
                }
            }

            CommandType::Noop => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ring_buffer::CommandType;

    fn make_spawn_cmd(id: u32) -> Command {
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

    fn make_despawn_cmd(id: u32) -> Command {
        Command {
            cmd_type: CommandType::DespawnEntity,
            entity_id: id,
            payload: [0; 16],
        }
    }

    #[test]
    fn spawn_creates_entity() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);

        assert!(map.get(0).is_some());
        let entity = map.get(0).unwrap();
        assert!(world.get::<&Position>(entity).is_ok());
        assert!(world.get::<&Active>(entity).is_ok());
    }

    #[test]
    fn set_position_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);
        process_commands(
            &[make_position_cmd(0, 5.0, 10.0, 15.0)],
            &mut world,
            &mut map,
        );

        let entity = map.get(0).unwrap();
        let pos = world.get::<&Position>(entity).unwrap();
        assert_eq!(pos.0, glam::Vec3::new(5.0, 10.0, 15.0));
    }

    #[test]
    fn despawn_removes_entity() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);
        let entity = map.get(0).unwrap();

        process_commands(&[make_despawn_cmd(0)], &mut world, &mut map);

        assert!(map.get(0).is_none());
        assert!(world.get::<&Position>(entity).is_err());
    }

    #[test]
    fn entity_id_recycling() {
        let mut map = EntityMap::new();
        let id1 = map.allocate();
        let id2 = map.allocate();
        assert_eq!(id1, 0);
        assert_eq!(id2, 1);

        map.remove(id1);
        let id3 = map.allocate();
        assert_eq!(id3, 0); // recycled
    }

    #[test]
    fn commands_on_nonexistent_entity_are_ignored() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        // Setting position on entity 99 which doesn't exist should not panic.
        process_commands(
            &[make_position_cmd(99, 1.0, 2.0, 3.0)],
            &mut world,
            &mut map,
        );
        // No assertion needed -- just verifying no panic.
    }
}

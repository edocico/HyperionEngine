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

    /// Iterate over all mapped (external ID, hecs Entity) pairs.
    pub fn iter_mapped(&self) -> impl Iterator<Item = (u32, hecs::Entity)> + '_ {
        self.map
            .iter()
            .enumerate()
            .filter_map(|(idx, opt)| opt.map(|entity| (idx as u32, entity)))
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

    /// Current allocated capacity (length of the sparse map).
    pub fn capacity(&self) -> usize {
        self.map.len()
    }

    /// Shrink the sparse map by truncating trailing `None` slots,
    /// then releasing unused heap memory. Also prunes the free list
    /// to remove IDs that are no longer within bounds.
    pub fn shrink_to_fit(&mut self) {
        let last_used = self.map.iter().rposition(|opt| opt.is_some());
        match last_used {
            Some(idx) => self.map.truncate(idx + 1),
            None => self.map.clear(),
        }
        self.map.shrink_to_fit();
        self.free_list.retain(|&id| (id as usize) < self.map.len());
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
                    BoundingRadius::default(),
                    TextureLayerIndex::default(),
                    MeshHandle::default(),
                    RenderPrimitive::default(),
                    PrimitiveParams::default(),
                    ExternalId(cmd.entity_id),
                    Parent::default(),
                    Children::default(),
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

            CommandType::SetTextureLayer => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let packed = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    if let Ok(mut tex) = world.get::<&mut TextureLayerIndex>(entity) {
                        tex.0 = packed;
                    }
                }
            }

            CommandType::SetMeshHandle => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let handle = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    if let Ok(mut mh) = world.get::<&mut MeshHandle>(entity) {
                        mh.0 = handle;
                    }
                }
            }

            CommandType::SetRenderPrimitive => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let prim = cmd.payload[0];
                    if let Ok(mut rp) = world.get::<&mut RenderPrimitive>(entity) {
                        rp.0 = prim;
                    }
                }
            }

            CommandType::SetParent => {
                if let Some(child_entity) = entity_map.get(cmd.entity_id) {
                    let new_parent_id =
                        u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());

                    // Remove from old parent's Children if currently parented
                    if let Ok(old_parent) = world.get::<&Parent>(child_entity) {
                        let old_id = old_parent.0;
                        if old_id != u32::MAX
                            && let Some(old_parent_entity) = entity_map.get(old_id)
                            && let Ok(mut children) =
                                world.get::<&mut Children>(old_parent_entity)
                        {
                            children.remove(cmd.entity_id);
                        }
                    }

                    // Update child's Parent component
                    if let Ok(mut parent) = world.get::<&mut Parent>(child_entity) {
                        parent.0 = new_parent_id;
                    }

                    // Add to new parent's Children (if not u32::MAX = unparent)
                    if new_parent_id != u32::MAX
                        && let Some(parent_entity) = entity_map.get(new_parent_id)
                        && let Ok(mut children) = world.get::<&mut Children>(parent_entity)
                    {
                        children.add(cmd.entity_id);
                    }
                }
            }

            CommandType::SetPrimParams0 => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let p0 = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let p1 = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let p2 = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    let p3 = f32::from_le_bytes(cmd.payload[12..16].try_into().unwrap());
                    if let Ok(mut pp) = world.get::<&mut PrimitiveParams>(entity) {
                        pp.0[0] = p0;
                        pp.0[1] = p1;
                        pp.0[2] = p2;
                        pp.0[3] = p3;
                    }
                }
            }

            CommandType::SetPrimParams1 => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let p4 = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let p5 = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let p6 = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    let p7 = f32::from_le_bytes(cmd.payload[12..16].try_into().unwrap());
                    if let Ok(mut pp) = world.get::<&mut PrimitiveParams>(entity) {
                        pp.0[4] = p4;
                        pp.0[5] = p5;
                        pp.0[6] = p6;
                        pp.0[7] = p7;
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
    fn set_texture_layer_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);

        let packed: u32 = (2 << 16) | 10; // tier 2, layer 10
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&packed.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetTextureLayer,
            entity_id: 0,
            payload,
        };
        process_commands(&[cmd], &mut world, &mut map);

        let entity = map.get(0).unwrap();
        let tex = world.get::<&TextureLayerIndex>(entity).unwrap();
        assert_eq!(tex.0, packed);
    }

    #[test]
    fn set_mesh_handle_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&42u32.to_le_bytes());
        let cmd = Command { cmd_type: CommandType::SetMeshHandle, entity_id: 0, payload };
        process_commands(&[cmd], &mut world, &mut map);

        let entity = map.get(0).unwrap();
        let mh = world.get::<&MeshHandle>(entity).unwrap();
        assert_eq!(mh.0, 42);
    }

    #[test]
    fn set_render_primitive_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);

        let mut payload = [0u8; 16];
        payload[0] = 2; // SDFGlyph
        let cmd = Command { cmd_type: CommandType::SetRenderPrimitive, entity_id: 0, payload };
        process_commands(&[cmd], &mut world, &mut map);

        let entity = map.get(0).unwrap();
        let rp = world.get::<&RenderPrimitive>(entity).unwrap();
        assert_eq!(rp.0, 2);
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

    #[test]
    fn set_parent_adds_parent_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(
            &[make_spawn_cmd(0), make_spawn_cmd(1)],
            &mut world,
            &mut map,
        );

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&0u32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetParent,
            entity_id: 1,
            payload,
        };
        process_commands(&[cmd], &mut world, &mut map);

        let child_entity = map.get(1).unwrap();
        let parent = world.get::<&Parent>(child_entity).unwrap();
        assert_eq!(parent.0, 0);

        let parent_entity = map.get(0).unwrap();
        let children = world.get::<&Children>(parent_entity).unwrap();
        assert!(children.as_slice().contains(&1));
    }

    #[test]
    fn entity_map_shrink_to_fit() {
        let mut map = EntityMap::new();
        let mut world = World::new();

        for i in 0..100 {
            let entity = world.spawn((Position::default(), Active));
            map.insert(i, entity);
        }

        for i in 50..100 {
            map.remove(i);
        }

        let old_capacity = map.capacity();
        map.shrink_to_fit();
        assert!(map.capacity() <= 50, "capacity {} should be <= 50 (was {})", map.capacity(), old_capacity);

        for i in 0..50 {
            assert!(map.get(i).is_some());
        }
    }

    #[test]
    fn process_set_prim_params() {
        let mut world = World::new();
        let mut entity_map = EntityMap::new();

        // Spawn an entity first
        let spawn_cmd = Command { cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: [0; 16] };
        process_commands(&[spawn_cmd], &mut world, &mut entity_map);

        // Set params 0-3
        let mut payload0 = [0u8; 16];
        payload0[0..4].copy_from_slice(&1.0f32.to_le_bytes());
        payload0[4..8].copy_from_slice(&2.0f32.to_le_bytes());
        payload0[8..12].copy_from_slice(&3.0f32.to_le_bytes());
        payload0[12..16].copy_from_slice(&4.0f32.to_le_bytes());

        let cmd0 = Command { cmd_type: CommandType::SetPrimParams0, entity_id: 0, payload: payload0 };
        process_commands(&[cmd0], &mut world, &mut entity_map);

        let entity = entity_map.get(0).unwrap();
        {
            let pp = world.get::<&PrimitiveParams>(entity).unwrap();
            assert_eq!(pp.0[0], 1.0);
            assert_eq!(pp.0[1], 2.0);
            assert_eq!(pp.0[2], 3.0);
            assert_eq!(pp.0[3], 4.0);
        }

        // Set params 4-7
        let mut payload1 = [0u8; 16];
        payload1[0..4].copy_from_slice(&5.0f32.to_le_bytes());
        payload1[4..8].copy_from_slice(&6.0f32.to_le_bytes());
        payload1[8..12].copy_from_slice(&7.0f32.to_le_bytes());
        payload1[12..16].copy_from_slice(&8.0f32.to_le_bytes());

        let cmd1 = Command { cmd_type: CommandType::SetPrimParams1, entity_id: 0, payload: payload1 };
        process_commands(&[cmd1], &mut world, &mut entity_map);

        let pp = world.get::<&PrimitiveParams>(entity).unwrap();
        assert_eq!(pp.0[4], 5.0);
        assert_eq!(pp.0[5], 6.0);
        assert_eq!(pp.0[6], 7.0);
        assert_eq!(pp.0[7], 8.0);
        // Params 0-3 should still be intact
        assert_eq!(pp.0[0], 1.0);
    }

    #[test]
    fn spawn_sets_external_id() {
        let mut world = World::new();
        let mut entity_map = EntityMap::new();

        let cmd = Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: 42,
            payload: [0u8; 16],
        };
        process_commands(&[cmd], &mut world, &mut entity_map);

        let hecs_entity = entity_map.get(42).unwrap();
        let ext_id = world.get::<&ExternalId>(hecs_entity).unwrap();
        assert_eq!(ext_id.0, 42);
    }

    #[test]
    fn set_parent_with_max_sentinel_unparents() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(
            &[make_spawn_cmd(0), make_spawn_cmd(1)],
            &mut world,
            &mut map,
        );

        // Parent entity 1 to entity 0
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&0u32.to_le_bytes());
        process_commands(
            &[Command {
                cmd_type: CommandType::SetParent,
                entity_id: 1,
                payload,
            }],
            &mut world,
            &mut map,
        );

        // Unparent entity 1
        payload[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
        process_commands(
            &[Command {
                cmd_type: CommandType::SetParent,
                entity_id: 1,
                payload,
            }],
            &mut world,
            &mut map,
        );

        let child_entity = map.get(1).unwrap();
        let parent = world.get::<&Parent>(child_entity).unwrap();
        assert_eq!(parent.0, u32::MAX);

        let parent_entity = map.get(0).unwrap();
        let children = world.get::<&Children>(parent_entity).unwrap();
        assert!(!children.as_slice().contains(&1));
    }
}

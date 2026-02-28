//! Translates ring buffer commands into ECS mutations.

use hecs::World;

use crate::components::*;
use crate::render_state::RenderState;
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
///
/// Consecutive `SpawnEntity` commands are automatically detected and flushed
/// via `hecs::World::spawn_batch()`, which resizes the archetype table once
/// instead of per-entity. The optimization is transparent — same observable
/// behavior, better performance for burst spawns.
pub fn process_commands(
    commands: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
) {
    let mut i = 0;
    while i < commands.len() {
        if commands[i].cmd_type == CommandType::SpawnEntity {
            // Collect consecutive spawn commands
            let batch_start = i;
            while i < commands.len() && commands[i].cmd_type == CommandType::SpawnEntity {
                i += 1;
            }
            let batch = &commands[batch_start..i];

            if batch.len() >= 2 {
                // Batch spawn: hecs resizes archetype table once for all N entities
                flush_spawn_batch(batch, world, entity_map, render_state);
            } else {
                // Single spawn: use normal path
                process_single_command(&batch[0], world, entity_map, render_state);
            }
        } else {
            process_single_command(&commands[i], world, entity_map, render_state);
            i += 1;
        }
    }
}

/// Flush a batch of consecutive SpawnEntity commands using `spawn_batch()`.
///
/// All entities share the same 14-component archetype, so `spawn_batch()`
/// resizes the archetype's column vecs once instead of per-entity.
fn flush_spawn_batch(
    batch: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
) {
    // Build component tuples. ExternalId is set to 0 initially; corrected below.
    let archetypes = batch.iter().map(|cmd| {
        (
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
        )
    });

    // spawn_batch returns entities in insertion order
    let entities: Vec<hecs::Entity> = world.spawn_batch(archetypes).collect();

    // Wire up entity map and render state
    for (cmd, entity) in batch.iter().zip(entities.iter()) {
        entity_map.insert(cmd.entity_id, *entity);
        let slot = render_state.assign_slot(*entity);
        render_state.write_slot(slot, world, *entity);
    }
}

/// Process a single non-batch command against the ECS world.
fn process_single_command(
    cmd: &Command,
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
) {
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
            let slot = render_state.assign_slot(entity);
            render_state.write_slot(slot, world, entity);
        }

        CommandType::DespawnEntity => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                render_state.pending_despawns.push(entity);
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
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                    render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
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
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                    render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
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
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                    render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
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
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        CommandType::SetMeshHandle => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let handle = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                if let Ok(mut mh) = world.get::<&mut MeshHandle>(entity) {
                    mh.0 = handle;
                }
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        CommandType::SetRenderPrimitive => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let prim = cmd.payload[0];
                if let Ok(mut rp) = world.get::<&mut RenderPrimitive>(entity) {
                    rp.0 = prim;
                }
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        CommandType::SetParent => {
            if let Some(child_entity) = entity_map.get(cmd.entity_id) {
                let new_parent_id =
                    u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());

                // Remove from old parent's Children (or OverflowChildren) if currently parented.
                // Two-phase: extract old_id first (drops the Parent borrow), then mutate.
                let old_parent_id = world
                    .get::<&Parent>(child_entity)
                    .ok()
                    .map(|p| p.0);
                if let Some(old_id) = old_parent_id
                    && old_id != u32::MAX
                    && let Some(old_parent_entity) = entity_map.get(old_id)
                {
                    let removed_from_inline =
                        if let Ok(mut children) =
                            world.get::<&mut Children>(old_parent_entity)
                        {
                            children.remove(cmd.entity_id)
                        } else {
                            false
                        };

                    if !removed_from_inline {
                        // Try OverflowChildren
                        let should_remove_component =
                            if let Ok(mut overflow) =
                                world.get::<&mut OverflowChildren>(old_parent_entity)
                            {
                                overflow.items.retain(|&id| id != cmd.entity_id);
                                overflow.items.is_empty()
                            } else {
                                false
                            };
                        if should_remove_component {
                            let _ =
                                world.remove_one::<OverflowChildren>(old_parent_entity);
                        }
                    }
                }

                // Update child's Parent component
                if let Ok(mut parent) = world.get::<&mut Parent>(child_entity) {
                    parent.0 = new_parent_id;
                }

                // Add to new parent's Children (if not u32::MAX = unparent).
                // Two-phase approach: try inline add, then handle overflow
                // separately. We can't use a single if-let chain because the
                // RefMut<Children> borrow would keep `world` borrowed, blocking
                // the insert_one call needed for OverflowChildren.
                let mut overflow_child: Option<(hecs::Entity, u32)> = None;
                if new_parent_id != u32::MAX
                    && let Some(parent_entity) = entity_map.get(new_parent_id)
                    && let Ok(mut children) =
                        world.get::<&mut Children>(parent_entity)
                    && !children.add(cmd.entity_id)
                {
                    overflow_child = Some((parent_entity, cmd.entity_id));
                }
                // Phase 2: handle overflow outside the Children borrow scope
                if let Some((parent_entity, child_id)) = overflow_child {
                    if let Ok(mut overflow) =
                        world.get::<&mut OverflowChildren>(parent_entity)
                    {
                        overflow.items.push(child_id);
                    } else {
                        let _ = world.insert_one(
                            parent_entity,
                            OverflowChildren { items: vec![child_id] },
                        );
                    }
                }
                if let Some(slot) = render_state.get_slot(child_entity) {
                    render_state.dirty_tracker.mark_transform_dirty(slot as usize);
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
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
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
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        CommandType::Noop => {}

        CommandType::SetListenerPosition => {} // handled in Engine::process_commands
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render_state::RenderState;
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
        let mut rs = RenderState::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        assert!(map.get(0).is_some());
        let entity = map.get(0).unwrap();
        assert!(world.get::<&Position>(entity).is_ok());
        assert!(world.get::<&Active>(entity).is_ok());
    }

    #[test]
    fn set_position_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);
        process_commands(
            &[make_position_cmd(0, 5.0, 10.0, 15.0)],
            &mut world,
            &mut map,
            &mut rs,
        );

        let entity = map.get(0).unwrap();
        let pos = world.get::<&Position>(entity).unwrap();
        assert_eq!(pos.0, glam::Vec3::new(5.0, 10.0, 15.0));
    }

    #[test]
    fn despawn_removes_entity() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);
        let entity = map.get(0).unwrap();

        process_commands(&[make_despawn_cmd(0)], &mut world, &mut map, &mut rs);

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
        let mut rs = RenderState::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        let packed: u32 = (2 << 16) | 10; // tier 2, layer 10
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&packed.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetTextureLayer,
            entity_id: 0,
            payload,
        };
        process_commands(&[cmd], &mut world, &mut map, &mut rs);

        let entity = map.get(0).unwrap();
        let tex = world.get::<&TextureLayerIndex>(entity).unwrap();
        assert_eq!(tex.0, packed);
    }

    #[test]
    fn set_mesh_handle_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&42u32.to_le_bytes());
        let cmd = Command { cmd_type: CommandType::SetMeshHandle, entity_id: 0, payload };
        process_commands(&[cmd], &mut world, &mut map, &mut rs);

        let entity = map.get(0).unwrap();
        let mh = world.get::<&MeshHandle>(entity).unwrap();
        assert_eq!(mh.0, 42);
    }

    #[test]
    fn set_render_primitive_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        let mut payload = [0u8; 16];
        payload[0] = 2; // SDFGlyph
        let cmd = Command { cmd_type: CommandType::SetRenderPrimitive, entity_id: 0, payload };
        process_commands(&[cmd], &mut world, &mut map, &mut rs);

        let entity = map.get(0).unwrap();
        let rp = world.get::<&RenderPrimitive>(entity).unwrap();
        assert_eq!(rp.0, 2);
    }

    #[test]
    fn commands_on_nonexistent_entity_are_ignored() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        // Setting position on entity 99 which doesn't exist should not panic.
        process_commands(
            &[make_position_cmd(99, 1.0, 2.0, 3.0)],
            &mut world,
            &mut map,
            &mut rs,
        );
        // No assertion needed -- just verifying no panic.
    }

    #[test]
    fn set_parent_adds_parent_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        process_commands(
            &[make_spawn_cmd(0), make_spawn_cmd(1)],
            &mut world,
            &mut map,
            &mut rs,
        );

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&0u32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetParent,
            entity_id: 1,
            payload,
        };
        process_commands(&[cmd], &mut world, &mut map, &mut rs);

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
        let mut rs = RenderState::new();

        // Spawn an entity first
        let spawn_cmd = Command { cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: [0; 16] };
        process_commands(&[spawn_cmd], &mut world, &mut entity_map, &mut rs);

        // Set params 0-3
        let mut payload0 = [0u8; 16];
        payload0[0..4].copy_from_slice(&1.0f32.to_le_bytes());
        payload0[4..8].copy_from_slice(&2.0f32.to_le_bytes());
        payload0[8..12].copy_from_slice(&3.0f32.to_le_bytes());
        payload0[12..16].copy_from_slice(&4.0f32.to_le_bytes());

        let cmd0 = Command { cmd_type: CommandType::SetPrimParams0, entity_id: 0, payload: payload0 };
        process_commands(&[cmd0], &mut world, &mut entity_map, &mut rs);

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
        process_commands(&[cmd1], &mut world, &mut entity_map, &mut rs);

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
        let mut rs = RenderState::new();

        let cmd = Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: 42,
            payload: [0u8; 16],
        };
        process_commands(&[cmd], &mut world, &mut entity_map, &mut rs);

        let hecs_entity = entity_map.get(42).unwrap();
        let ext_id = world.get::<&ExternalId>(hecs_entity).unwrap();
        assert_eq!(ext_id.0, 42);
    }

    #[test]
    fn set_parent_overflow_children_beyond_32() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        // Spawn parent
        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        // Spawn 33 children and parent them all to entity 0
        for child_id in 1..=33u32 {
            process_commands(&[make_spawn_cmd(child_id)], &mut world, &mut map, &mut rs);
            let mut payload = [0u8; 16];
            payload[0..4].copy_from_slice(&0u32.to_le_bytes());
            process_commands(
                &[Command { cmd_type: CommandType::SetParent, entity_id: child_id, payload }],
                &mut world,
                &mut map,
                &mut rs,
            );
        }

        // Verify first 32 children are in Children component
        let parent_entity = map.get(0).unwrap();
        let children = world.get::<&Children>(parent_entity).unwrap();
        assert_eq!(children.count, 32);

        // Verify 33rd child is in OverflowChildren
        let overflow = world.get::<&OverflowChildren>(parent_entity).unwrap();
        assert_eq!(overflow.items.len(), 1);
        assert_eq!(overflow.items[0], 33);
    }

    #[test]
    fn remove_child_from_overflow() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        // Spawn parent + 33 children
        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);
        for child_id in 1..=33u32 {
            process_commands(&[make_spawn_cmd(child_id)], &mut world, &mut map, &mut rs);
            let mut payload = [0u8; 16];
            payload[0..4].copy_from_slice(&0u32.to_le_bytes());
            process_commands(
                &[Command { cmd_type: CommandType::SetParent, entity_id: child_id, payload }],
                &mut world,
                &mut map,
                &mut rs,
            );
        }

        // Unparent child 33 (in overflow)
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
        process_commands(
            &[Command { cmd_type: CommandType::SetParent, entity_id: 33, payload }],
            &mut world,
            &mut map,
            &mut rs,
        );

        // OverflowChildren should be removed (was only 1 item)
        let parent_entity = map.get(0).unwrap();
        assert!(world.get::<&OverflowChildren>(parent_entity).is_err());

        // Children should still have 32
        let children = world.get::<&Children>(parent_entity).unwrap();
        assert_eq!(children.count, 32);
    }

    #[test]
    fn set_parent_with_max_sentinel_unparents() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        process_commands(
            &[make_spawn_cmd(0), make_spawn_cmd(1)],
            &mut world,
            &mut map,
            &mut rs,
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
            &mut rs,
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
            &mut rs,
        );

        let child_entity = map.get(1).unwrap();
        let parent = world.get::<&Parent>(child_entity).unwrap();
        assert_eq!(parent.0, u32::MAX);

        let parent_entity = map.get(0).unwrap();
        let children = world.get::<&Children>(parent_entity).unwrap();
        assert!(!children.as_slice().contains(&1));
    }

    #[test]
    fn batch_spawn_detection() {
        let mut world = World::new();
        let mut entity_map = EntityMap::new();
        let mut rs = RenderState::new();
        let cmds = vec![make_spawn_cmd(0), make_spawn_cmd(1), make_spawn_cmd(2)];
        process_commands(&cmds, &mut world, &mut entity_map, &mut rs);
        assert_eq!(rs.gpu_entity_count(), 3);
        // All three entities should exist with correct ExternalId
        assert!(entity_map.get(0).is_some());
        assert!(entity_map.get(1).is_some());
        assert!(entity_map.get(2).is_some());
        for ext_id in 0..3u32 {
            let entity = entity_map.get(ext_id).unwrap();
            let eid = world.get::<&ExternalId>(entity).unwrap();
            assert_eq!(eid.0, ext_id);
        }
    }

    #[test]
    fn batch_spawn_interrupted_by_other_command() {
        let mut world = World::new();
        let mut entity_map = EntityMap::new();
        let mut rs = RenderState::new();
        let cmds = vec![
            make_spawn_cmd(0),
            make_spawn_cmd(1),
            make_position_cmd(0, 5.0, 0.0, 0.0), // interrupts batch
            make_spawn_cmd(2),
        ];
        process_commands(&cmds, &mut world, &mut entity_map, &mut rs);
        assert_eq!(rs.gpu_entity_count(), 3);
        let e0 = entity_map.get(0).unwrap();
        let pos = world.get::<&Position>(e0).unwrap();
        assert!((pos.0.x - 5.0).abs() < 0.001);
    }
}

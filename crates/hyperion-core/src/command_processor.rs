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
    /// Tracks whether each external ID is a 2D entity (Transform2D) vs 3D (Position+Rotation+Scale).
    /// Indexed by external ID. Default `false` = 3D.
    is_2d: Vec<bool>,
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
            is_2d: Vec::new(),
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
            self.is_2d.resize(idx + 1, false);
        }
        self.map[idx] = Some(entity);
    }

    /// Mark an external ID as 2D or 3D. Must be called after `insert()`.
    pub fn set_2d_flag(&mut self, external_id: u32, is_2d: bool) {
        let idx = external_id as usize;
        if idx < self.is_2d.len() {
            self.is_2d[idx] = is_2d;
        }
    }

    /// Returns whether the given external ID is a 2D entity.
    pub(crate) fn is_entity_2d(&self, external_id: u32) -> bool {
        self.is_2d
            .get(external_id as usize)
            .copied()
            .unwrap_or(false)
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
        if idx < self.is_2d.len() {
            self.is_2d[idx] = false;
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
        self.is_2d.truncate(self.map.len());
        self.is_2d.shrink_to_fit();
        self.free_list.retain(|&id| (id as usize) < self.map.len());
    }
}

/// Process a batch of commands against the ECS world.
///
/// Consecutive `SpawnEntity` commands are automatically detected and flushed
/// via `hecs::World::spawn_batch()`, which resizes the archetype table once
/// instead of per-entity. The optimization is transparent — same observable
/// behavior, better performance for burst spawns.
#[cfg(not(feature = "physics-2d"))]
pub fn process_commands(
    commands: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
) {
    process_commands_inner(commands, world, entity_map, render_state);
}

/// Process a batch of commands against the ECS world (physics-enabled variant).
///
/// Physics-aware: passes `&mut PhysicsWorld` to `process_single_command` so that
/// `DespawnEntity`, `DestroyRigidBody`, and `DestroyCollider` can clean up Rapier
/// state. `CreateRigidBody` and `CreateCollider` insert pending ECS components.
#[cfg(feature = "physics-2d")]
pub fn process_commands(
    commands: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
    physics: &mut crate::physics::PhysicsWorld,
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
                process_single_command_physics(&batch[0], world, entity_map, render_state, physics);
            }
        } else {
            process_single_command_physics(&commands[i], world, entity_map, render_state, physics);
            i += 1;
        }
    }
}

/// Shared implementation for non-physics `process_commands`.
#[cfg(not(feature = "physics-2d"))]
fn process_commands_inner(
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
/// 3D and 2D entities have different archetypes, so the batch is split
/// into two sub-batches. Each sub-batch resizes its archetype table once.
/// Mixed batches are handled correctly.
fn flush_spawn_batch(
    batch: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
) {
    // Partition into 3D and 2D sub-batches, preserving original indices
    let mut batch_3d: Vec<(usize, &Command)> = Vec::new();
    let mut batch_2d: Vec<(usize, &Command)> = Vec::new();
    for (i, cmd) in batch.iter().enumerate() {
        if cmd.payload[0] == 1 {
            batch_2d.push((i, cmd));
        } else {
            batch_3d.push((i, cmd));
        }
    }

    // Collect all spawned entities indexed by their position in the original batch
    let mut entities: Vec<(usize, hecs::Entity, bool)> = Vec::with_capacity(batch.len());

    // Batch-spawn 3D entities
    if batch_3d.len() >= 2 {
        let archetypes = batch_3d.iter().map(|(_, cmd)| {
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
        let spawned: Vec<hecs::Entity> = world.spawn_batch(archetypes).collect();
        for ((orig_idx, _), entity) in batch_3d.iter().zip(spawned.into_iter()) {
            entities.push((*orig_idx, entity, false));
        }
    } else {
        for &(orig_idx, cmd) in &batch_3d {
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
            entities.push((orig_idx, entity, false));
        }
    }

    // Batch-spawn 2D entities
    if batch_2d.len() >= 2 {
        let archetypes = batch_2d.iter().map(|(_, cmd)| {
            (
                Transform2D::default(),
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
        let spawned: Vec<hecs::Entity> = world.spawn_batch(archetypes).collect();
        for ((orig_idx, _), entity) in batch_2d.iter().zip(spawned.into_iter()) {
            entities.push((*orig_idx, entity, true));
        }
    } else {
        for &(orig_idx, cmd) in &batch_2d {
            let entity = world.spawn((
                Transform2D::default(),
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
            entities.push((orig_idx, entity, true));
        }
    }

    // Sort by original batch index to preserve insertion order
    entities.sort_unstable_by_key(|(idx, _, _)| *idx);

    // Wire up entity map and render state
    for (orig_idx, entity, is_2d) in &entities {
        let cmd = &batch[*orig_idx];
        entity_map.insert(cmd.entity_id, *entity);
        entity_map.set_2d_flag(cmd.entity_id, *is_2d);
        let slot = render_state.assign_slot(*entity);
        if *is_2d {
            render_state.write_slot_2d(slot, world, *entity);
        } else {
            render_state.write_slot(slot, world, *entity);
        }
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
            let is_2d = cmd.payload[0] == 1;
            let entity = if is_2d {
                world.spawn((
                    Transform2D::default(),
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
                ))
            } else {
                world.spawn((
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
                ))
            };
            entity_map.insert(cmd.entity_id, entity);
            entity_map.set_2d_flag(cmd.entity_id, is_2d);
            let slot = render_state.assign_slot(entity);
            if is_2d {
                render_state.write_slot_2d(slot, world, entity);
            } else {
                render_state.write_slot(slot, world, entity);
            }
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
                if entity_map.is_entity_2d(cmd.entity_id) {
                    if let Ok(mut t) = world.get::<&mut Transform2D>(entity) {
                        t.x = x;
                        t.y = y;
                        // z ignored for 2D entities
                    }
                } else if let Ok(mut pos) = world.get::<&mut Position>(entity) {
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
                if entity_map.is_entity_2d(cmd.entity_id) {
                    // Compatibility fallback: extract z-axis angle from quaternion
                    let angle = f32::atan2(
                        2.0 * (w * z + x * y),
                        1.0 - 2.0 * (y * y + z * z),
                    );
                    if let Ok(mut t) = world.get::<&mut Transform2D>(entity) {
                        t.rot = angle;
                    }
                } else if let Ok(mut rot) = world.get::<&mut Rotation>(entity) {
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
                if entity_map.is_entity_2d(cmd.entity_id) {
                    if let Ok(mut t) = world.get::<&mut Transform2D>(entity) {
                        t.sx = x;
                        t.sy = y;
                        // z ignored for 2D entities
                    }
                } else if let Ok(mut scale) = world.get::<&mut Scale>(entity) {
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
                    render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
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

        CommandType::SetRotation2D => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let angle = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                if entity_map.is_entity_2d(cmd.entity_id) {
                    if let Ok(mut t) = world.get::<&mut Transform2D>(entity) {
                        t.rot = angle;
                    }
                    if let Some(slot) = render_state.get_slot(entity) {
                        render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                        render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
                    }
                } else {
                    // SetRotation2D on a 3D entity is invalid — log warning and ignore.
                    #[cfg(debug_assertions)]
                    eprintln!("warning: SetRotation2D on 3D entity {}", cmd.entity_id);
                }
            }
        }

        CommandType::SetTransparent => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                if cmd.payload[0] == 1 {
                    let _ = world.insert_one(entity, Transparent(1));
                } else {
                    let _ = world.remove_one::<Transparent>(entity);
                }
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        CommandType::SetDepth => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let z = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let _ = world.insert_one(entity, Depth(z));
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        // Physics commands (17-41) — handled in process_single_command_physics
        // when physics-2d is enabled. Without physics, they are no-ops.
        CommandType::CreateRigidBody
        | CommandType::DestroyRigidBody
        | CommandType::CreateCollider
        | CommandType::DestroyCollider
        | CommandType::SetLinearDamping
        | CommandType::SetAngularDamping
        | CommandType::SetGravityScale
        | CommandType::SetCCDEnabled
        | CommandType::ApplyForce
        | CommandType::ApplyImpulse
        | CommandType::ApplyTorque
        | CommandType::SetColliderSensor
        | CommandType::SetColliderDensity
        | CommandType::SetColliderRestitution
        | CommandType::SetColliderFriction
        | CommandType::SetCollisionGroups
        | CommandType::CreateRevoluteJoint
        | CommandType::CreatePrismaticJoint
        | CommandType::CreateFixedJoint
        | CommandType::CreateRopeJoint
        | CommandType::RemoveJoint
        | CommandType::SetJointMotor
        | CommandType::SetJointLimits
        | CommandType::CreateSpringJoint
        | CommandType::SetSpringParams
        | CommandType::SetJointAnchorB
        | CommandType::SetJointAnchorA => {}
    }
}

/// Physics-aware variant of `process_single_command`.
///
/// Delegates all non-physics commands to the base `process_single_command`,
/// but intercepts `DespawnEntity` (for Rapier cleanup), `CreateRigidBody`,
/// `CreateCollider`, `DestroyRigidBody`, and `DestroyCollider`.
#[cfg(feature = "physics-2d")]
fn process_single_command_physics(
    cmd: &Command,
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
    physics: &mut crate::physics::PhysicsWorld,
) {
    match cmd.cmd_type {
        // DespawnEntity: clean up Rapier state before despawning the ECS entity.
        CommandType::DespawnEntity => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                despawn_physics_cleanup(world, entity, physics);
                render_state.pending_despawns.push(entity);
                let _ = world.despawn(entity);
                entity_map.remove(cmd.entity_id);
            }
        }

        // CreateRigidBody: insert PendingRigidBody component (consumed by physics_sync_pre)
        CommandType::CreateRigidBody => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let body_type = cmd.payload[0];
                let _ = world.insert_one(entity, crate::physics::PendingRigidBody::new(body_type));
            }
        }

        // CreateCollider: insert PendingCollider component (consumed by physics_sync_pre)
        CommandType::CreateCollider => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let pending = crate::physics::PendingCollider::from_payload(&cmd.payload);
                let _ = world.insert_one(entity, pending);
            }
        }

        // DestroyRigidBody: remove Rapier body + ECS handles
        CommandType::DestroyRigidBody => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                despawn_physics_cleanup(world, entity, physics);
                let _ = world.remove_one::<crate::physics::PhysicsBodyHandle>(entity);
                let _ = world.remove_one::<crate::physics::PhysicsColliderHandle>(entity);
                let _ = world.remove_one::<crate::physics::PhysicsControlled>(entity);
            }
        }

        // DestroyCollider: remove a single collider from Rapier
        CommandType::DestroyCollider => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                // Extract the handle value before dropping the borrow on `world`.
                let col_h = world
                    .get::<&crate::physics::PhysicsColliderHandle>(entity)
                    .ok()
                    .map(|c| c.0);
                if let Some(h) = col_h {
                    let idx = h.0.into_raw_parts().0 as usize;
                    if idx < physics.collider_to_entity.len() {
                        physics.collider_to_entity[idx] = None;
                    }
                    physics.collider_set.remove(
                        h,
                        &mut physics.island_manager,
                        &mut physics.rigid_body_set,
                        true,
                    );
                    let _ = world.remove_one::<crate::physics::PhysicsColliderHandle>(entity);
                }
            }
        }

        // CreateRevoluteJoint: stage a revolute PendingJoint
        CommandType::CreateRevoluteJoint => {
            let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
            let entity_b_ext = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
            let anchor_ax = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
            let anchor_ay = f32::from_le_bytes(cmd.payload[12..16].try_into().unwrap());
            physics.pending_joints.push(crate::physics::PendingJoint {
                joint_id,
                entity_a_ext: cmd.entity_id,
                entity_b_ext,
                joint_type: crate::physics::PendingJointType::Revolute { anchor_ax, anchor_ay },
            });
        }

        // CreatePrismaticJoint: stage a prismatic PendingJoint
        CommandType::CreatePrismaticJoint => {
            let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
            let entity_b_ext = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
            let axis_x = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
            let axis_y = f32::from_le_bytes(cmd.payload[12..16].try_into().unwrap());
            physics.pending_joints.push(crate::physics::PendingJoint {
                joint_id,
                entity_a_ext: cmd.entity_id,
                entity_b_ext,
                joint_type: crate::physics::PendingJointType::Prismatic { axis_x, axis_y },
            });
        }

        // CreateFixedJoint: stage a fixed PendingJoint
        CommandType::CreateFixedJoint => {
            let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
            let entity_b_ext = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
            physics.pending_joints.push(crate::physics::PendingJoint {
                joint_id,
                entity_a_ext: cmd.entity_id,
                entity_b_ext,
                joint_type: crate::physics::PendingJointType::Fixed,
            });
        }

        // CreateRopeJoint: stage a rope PendingJoint
        CommandType::CreateRopeJoint => {
            let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
            let entity_b_ext = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
            let max_dist = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
            physics.pending_joints.push(crate::physics::PendingJoint {
                joint_id,
                entity_a_ext: cmd.entity_id,
                entity_b_ext,
                joint_type: crate::physics::PendingJointType::Rope { max_dist },
            });
        }

        // CreateSpringJoint: stage a spring PendingJoint
        CommandType::CreateSpringJoint => {
            let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
            let entity_b_ext = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
            let rest_length = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
            physics.pending_joints.push(crate::physics::PendingJoint {
                joint_id,
                entity_a_ext: cmd.entity_id,
                entity_b_ext,
                joint_type: crate::physics::PendingJointType::Spring { rest_length },
            });
        }

        // All other commands: delegate to the base (non-physics) handler
        _ => {
            process_single_command(cmd, world, entity_map, render_state);
        }
    }
}

/// Clean up Rapier state for an entity being despawned or having its body destroyed.
///
/// Clears reverse-map entries for all colliders attached to the body,
/// then removes the body (which cascades collider + joint removal in Rapier).
#[cfg(feature = "physics-2d")]
fn despawn_physics_cleanup(
    world: &hecs::World,
    entity: hecs::Entity,
    physics: &mut crate::physics::PhysicsWorld,
) {
    if let Ok(handle) = world.get::<&crate::physics::PhysicsBodyHandle>(entity) {
        let body_handle = handle.0;
        drop(handle);
        // Clear reverse map entries for all attached colliders
        if let Some(body) = physics.rigid_body_set.get(body_handle) {
            for &col_handle in body.colliders() {
                let idx = col_handle.0.into_raw_parts().0 as usize;
                if idx < physics.collider_to_entity.len() {
                    physics.collider_to_entity[idx] = None;
                }
            }
        }
        // Remove body (cascades collider + joint removal)
        physics.rigid_body_set.remove(
            body_handle,
            &mut physics.island_manager,
            &mut physics.collider_set,
            &mut physics.impulse_joint_set,
            &mut physics.multibody_joint_set,
            true, // remove_attached_colliders
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render_state::RenderState;
    use crate::ring_buffer::CommandType;

    /// Test helper: calls `process_commands` with the correct signature
    /// regardless of whether `physics-2d` feature is enabled.
    fn run_commands(
        commands: &[Command],
        world: &mut World,
        entity_map: &mut EntityMap,
        render_state: &mut RenderState,
    ) {
        #[cfg(feature = "physics-2d")]
        {
            let mut physics = crate::physics::PhysicsWorld::new();
            process_commands(commands, world, entity_map, render_state, &mut physics);
        }
        #[cfg(not(feature = "physics-2d"))]
        {
            process_commands(commands, world, entity_map, render_state);
        }
    }

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

        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

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

        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);
        run_commands(
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

        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);
        let entity = map.get(0).unwrap();

        run_commands(&[make_despawn_cmd(0)], &mut world, &mut map, &mut rs);

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

        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        let packed: u32 = (2 << 16) | 10; // tier 2, layer 10
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&packed.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetTextureLayer,
            entity_id: 0,
            payload,
        };
        run_commands(&[cmd], &mut world, &mut map, &mut rs);

        let entity = map.get(0).unwrap();
        let tex = world.get::<&TextureLayerIndex>(entity).unwrap();
        assert_eq!(tex.0, packed);
    }

    #[test]
    fn set_mesh_handle_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&42u32.to_le_bytes());
        let cmd = Command { cmd_type: CommandType::SetMeshHandle, entity_id: 0, payload };
        run_commands(&[cmd], &mut world, &mut map, &mut rs);

        let entity = map.get(0).unwrap();
        let mh = world.get::<&MeshHandle>(entity).unwrap();
        assert_eq!(mh.0, 42);
    }

    #[test]
    fn set_render_primitive_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        let mut payload = [0u8; 16];
        payload[0] = 2; // SDFGlyph
        let cmd = Command { cmd_type: CommandType::SetRenderPrimitive, entity_id: 0, payload };
        run_commands(&[cmd], &mut world, &mut map, &mut rs);

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
        run_commands(
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

        run_commands(
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
        run_commands(&[cmd], &mut world, &mut map, &mut rs);

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
        run_commands(&[spawn_cmd], &mut world, &mut entity_map, &mut rs);

        // Set params 0-3
        let mut payload0 = [0u8; 16];
        payload0[0..4].copy_from_slice(&1.0f32.to_le_bytes());
        payload0[4..8].copy_from_slice(&2.0f32.to_le_bytes());
        payload0[8..12].copy_from_slice(&3.0f32.to_le_bytes());
        payload0[12..16].copy_from_slice(&4.0f32.to_le_bytes());

        let cmd0 = Command { cmd_type: CommandType::SetPrimParams0, entity_id: 0, payload: payload0 };
        run_commands(&[cmd0], &mut world, &mut entity_map, &mut rs);

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
        run_commands(&[cmd1], &mut world, &mut entity_map, &mut rs);

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
        run_commands(&[cmd], &mut world, &mut entity_map, &mut rs);

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
        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        // Spawn 33 children and parent them all to entity 0
        for child_id in 1..=33u32 {
            run_commands(&[make_spawn_cmd(child_id)], &mut world, &mut map, &mut rs);
            let mut payload = [0u8; 16];
            payload[0..4].copy_from_slice(&0u32.to_le_bytes());
            run_commands(
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
        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);
        for child_id in 1..=33u32 {
            run_commands(&[make_spawn_cmd(child_id)], &mut world, &mut map, &mut rs);
            let mut payload = [0u8; 16];
            payload[0..4].copy_from_slice(&0u32.to_le_bytes());
            run_commands(
                &[Command { cmd_type: CommandType::SetParent, entity_id: child_id, payload }],
                &mut world,
                &mut map,
                &mut rs,
            );
        }

        // Unparent child 33 (in overflow)
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
        run_commands(
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

        run_commands(
            &[make_spawn_cmd(0), make_spawn_cmd(1)],
            &mut world,
            &mut map,
            &mut rs,
        );

        // Parent entity 1 to entity 0
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&0u32.to_le_bytes());
        run_commands(
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
        run_commands(
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
        run_commands(&cmds, &mut world, &mut entity_map, &mut rs);
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
        run_commands(&cmds, &mut world, &mut entity_map, &mut rs);
        assert_eq!(rs.gpu_entity_count(), 3);
        let e0 = entity_map.get(0).unwrap();
        let pos = world.get::<&Position>(e0).unwrap();
        assert!((pos.0.x - 5.0).abs() < 0.001);
    }

    // -- 2D / 3D routing tests (Phase 13 Task 4) --

    fn make_spawn_2d_cmd(id: u32) -> Command {
        let mut payload = [0u8; 16];
        payload[0] = 1; // 2D flag
        Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: id,
            payload,
        }
    }

    #[test]
    fn spawn_2d_entity_creates_transform2d() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(&[make_spawn_2d_cmd(1)], &mut world, &mut map, &mut rs);
        let ent = map.get(1).unwrap();
        assert!(world.get::<&Transform2D>(ent).is_ok());
        assert!(world.get::<&Position>(ent).is_err()); // NOT 3D
    }

    #[test]
    fn spawn_3d_entity_creates_position() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(&[make_spawn_cmd(1)], &mut world, &mut map, &mut rs);
        let ent = map.get(1).unwrap();
        assert!(world.get::<&Position>(ent).is_ok());
        assert!(world.get::<&Transform2D>(ent).is_err()); // NOT 2D
    }

    #[test]
    fn set_position_on_2d_entity_updates_transform2d() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(
            &[make_spawn_2d_cmd(1), make_position_cmd(1, 10.0, 20.0, 99.0)],
            &mut world,
            &mut map,
            &mut rs,
        );
        let ent = map.get(1).unwrap();
        let t = world.get::<&Transform2D>(ent).unwrap();
        assert!((t.x - 10.0).abs() < 1e-7);
        assert!((t.y - 20.0).abs() < 1e-7);
        // z (99.0) is ignored for 2D
    }

    #[test]
    fn set_position_on_3d_entity_updates_position() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(
            &[make_spawn_cmd(1), make_position_cmd(1, 10.0, 20.0, 30.0)],
            &mut world,
            &mut map,
            &mut rs,
        );
        let ent = map.get(1).unwrap();
        let pos = world.get::<&Position>(ent).unwrap();
        assert_eq!(pos.0, glam::Vec3::new(10.0, 20.0, 30.0));
    }

    #[test]
    fn set_rotation_2d_updates_transform2d() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut angle_payload = [0u8; 16];
        angle_payload[0..4].copy_from_slice(&1.5f32.to_le_bytes());
        run_commands(
            &[
                make_spawn_2d_cmd(1),
                Command {
                    cmd_type: CommandType::SetRotation2D,
                    entity_id: 1,
                    payload: angle_payload,
                },
            ],
            &mut world,
            &mut map,
            &mut rs,
        );
        let ent = map.get(1).unwrap();
        let t = world.get::<&Transform2D>(ent).unwrap();
        assert!((t.rot - 1.5).abs() < 1e-7);
    }

    #[test]
    fn set_rotation_2d_on_3d_entity_is_ignored() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut angle_payload = [0u8; 16];
        angle_payload[0..4].copy_from_slice(&1.5f32.to_le_bytes());
        run_commands(
            &[
                make_spawn_cmd(1),
                Command {
                    cmd_type: CommandType::SetRotation2D,
                    entity_id: 1,
                    payload: angle_payload,
                },
            ],
            &mut world,
            &mut map,
            &mut rs,
        );
        // 3D entity should NOT have Transform2D
        let ent = map.get(1).unwrap();
        assert!(world.get::<&Transform2D>(ent).is_err());
        // Rotation should still be identity (untouched)
        let rot = world.get::<&Rotation>(ent).unwrap();
        assert_eq!(rot.0, glam::Quat::IDENTITY);
    }

    #[test]
    fn set_rotation_2d_on_3d_entity_does_not_dirty() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        // Spawn 3D entity
        run_commands(&[make_spawn_cmd(1)], &mut world, &mut map, &mut rs);

        // Clear any dirty bits from spawn
        rs.dirty_tracker.clear();

        // Send SetRotation2D to 3D entity — should be ignored, no dirty marking
        let mut angle_payload = [0u8; 16];
        angle_payload[0..4].copy_from_slice(&1.5f32.to_le_bytes());
        run_commands(
            &[Command {
                cmd_type: CommandType::SetRotation2D,
                entity_id: 1,
                payload: angle_payload,
            }],
            &mut world,
            &mut map,
            &mut rs,
        );

        // Entity should NOT be dirty since SetRotation2D on 3D is ignored
        let ent = map.get(1).unwrap();
        if let Some(slot) = rs.get_slot(ent) {
            assert!(
                !rs.dirty_tracker.is_transform_dirty(slot as usize),
                "3D entity should not be dirty after ignored SetRotation2D"
            );
        }
    }

    #[test]
    fn set_rotation_quat_on_2d_entity_extracts_angle() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        // Quaternion for 90 degrees around Z: (0, 0, sin(45°), cos(45°))
        let angle = std::f32::consts::FRAC_PI_2;
        let qz = (angle / 2.0).sin();
        let qw = (angle / 2.0).cos();
        let mut rot_payload = [0u8; 16];
        rot_payload[0..4].copy_from_slice(&0.0f32.to_le_bytes()); // qx
        rot_payload[4..8].copy_from_slice(&0.0f32.to_le_bytes()); // qy
        rot_payload[8..12].copy_from_slice(&qz.to_le_bytes());    // qz
        rot_payload[12..16].copy_from_slice(&qw.to_le_bytes());   // qw
        run_commands(
            &[
                make_spawn_2d_cmd(1),
                Command {
                    cmd_type: CommandType::SetRotation,
                    entity_id: 1,
                    payload: rot_payload,
                },
            ],
            &mut world,
            &mut map,
            &mut rs,
        );
        let ent = map.get(1).unwrap();
        let t = world.get::<&Transform2D>(ent).unwrap();
        assert!((t.rot - angle).abs() < 1e-5);
    }

    #[test]
    fn set_scale_on_2d_entity_updates_transform2d() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut scale_payload = [0u8; 16];
        scale_payload[0..4].copy_from_slice(&2.0f32.to_le_bytes());
        scale_payload[4..8].copy_from_slice(&3.0f32.to_le_bytes());
        scale_payload[8..12].copy_from_slice(&99.0f32.to_le_bytes()); // z ignored
        run_commands(
            &[
                make_spawn_2d_cmd(1),
                Command {
                    cmd_type: CommandType::SetScale,
                    entity_id: 1,
                    payload: scale_payload,
                },
            ],
            &mut world,
            &mut map,
            &mut rs,
        );
        let ent = map.get(1).unwrap();
        let t = world.get::<&Transform2D>(ent).unwrap();
        assert!((t.sx - 2.0).abs() < 1e-7);
        assert!((t.sy - 3.0).abs() < 1e-7);
    }

    #[test]
    fn set_depth_adds_depth_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut depth_payload = [0u8; 16];
        depth_payload[0..4].copy_from_slice(&5.0f32.to_le_bytes());
        run_commands(
            &[
                make_spawn_2d_cmd(1),
                Command {
                    cmd_type: CommandType::SetDepth,
                    entity_id: 1,
                    payload: depth_payload,
                },
            ],
            &mut world,
            &mut map,
            &mut rs,
        );
        let ent = map.get(1).unwrap();
        let d = world.get::<&Depth>(ent).unwrap();
        assert!((d.0 - 5.0).abs() < 1e-7);
    }

    #[test]
    fn set_depth_works_on_3d_entity_too() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut depth_payload = [0u8; 16];
        depth_payload[0..4].copy_from_slice(&7.0f32.to_le_bytes());
        run_commands(
            &[
                make_spawn_cmd(1),
                Command {
                    cmd_type: CommandType::SetDepth,
                    entity_id: 1,
                    payload: depth_payload,
                },
            ],
            &mut world,
            &mut map,
            &mut rs,
        );
        let ent = map.get(1).unwrap();
        let d = world.get::<&Depth>(ent).unwrap();
        assert!((d.0 - 7.0).abs() < 1e-7);
    }

    #[test]
    fn set_transparent_toggles_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut on_payload = [0u8; 16];
        on_payload[0] = 1;
        run_commands(
            &[
                make_spawn_2d_cmd(1),
                Command {
                    cmd_type: CommandType::SetTransparent,
                    entity_id: 1,
                    payload: on_payload,
                },
            ],
            &mut world,
            &mut map,
            &mut rs,
        );
        let ent = map.get(1).unwrap();
        assert!(world.get::<&Transparent>(ent).is_ok());

        // Toggle off
        run_commands(
            &[Command {
                cmd_type: CommandType::SetTransparent,
                entity_id: 1,
                payload: [0u8; 16],
            }],
            &mut world,
            &mut map,
            &mut rs,
        );
        assert!(world.get::<&Transparent>(ent).is_err());
    }

    #[test]
    fn is_entity_2d_flag_tracks_correctly() {
        let mut map = EntityMap::new();
        let mut world = World::new();
        let e1 = world.spawn((Transform2D::default(), Active));
        map.insert(1, e1);
        map.set_2d_flag(1, true);
        assert!(map.is_entity_2d(1));
        assert!(!map.is_entity_2d(0)); // unset ID

        // Remove clears flag
        map.remove(1);
        assert!(!map.is_entity_2d(1));
    }

    #[test]
    fn batch_spawn_mixed_2d_and_3d() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let cmds = vec![
            make_spawn_cmd(0),     // 3D
            make_spawn_2d_cmd(1),  // 2D
            make_spawn_cmd(2),     // 3D
            make_spawn_2d_cmd(3),  // 2D
        ];
        run_commands(&cmds, &mut world, &mut map, &mut rs);

        // All 4 entities should exist
        assert_eq!(rs.gpu_entity_count(), 4);
        for id in 0..4u32 {
            assert!(map.get(id).is_some());
        }

        // 3D entities have Position, no Transform2D
        let e0 = map.get(0).unwrap();
        assert!(world.get::<&Position>(e0).is_ok());
        assert!(world.get::<&Transform2D>(e0).is_err());
        let e2 = map.get(2).unwrap();
        assert!(world.get::<&Position>(e2).is_ok());
        assert!(world.get::<&Transform2D>(e2).is_err());

        // 2D entities have Transform2D, no Position
        let e1 = map.get(1).unwrap();
        assert!(world.get::<&Transform2D>(e1).is_ok());
        assert!(world.get::<&Position>(e1).is_err());
        let e3 = map.get(3).unwrap();
        assert!(world.get::<&Transform2D>(e3).is_ok());
        assert!(world.get::<&Position>(e3).is_err());

        // is_2d flags
        assert!(!map.is_entity_2d(0));
        assert!(map.is_entity_2d(1));
        assert!(!map.is_entity_2d(2));
        assert!(map.is_entity_2d(3));
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn create_revolute_joint_stages_pending() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut physics = crate::physics::PhysicsWorld::new();

        // Spawn entity 0 (entity_a for the joint)
        let spawn = Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: 0,
            payload: [0; 16],
        };
        process_commands(&[spawn], &mut world, &mut map, &mut rs, &mut physics);

        // CreateRevoluteJoint: joint_id=42, entity_b=1, anchor=(5.0, 10.0)
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&42u32.to_le_bytes());  // joint_id
        payload[4..8].copy_from_slice(&1u32.to_le_bytes());   // entity_b
        payload[8..12].copy_from_slice(&5.0f32.to_le_bytes()); // anchor_ax
        payload[12..16].copy_from_slice(&10.0f32.to_le_bytes()); // anchor_ay
        let cmd = Command {
            cmd_type: CommandType::CreateRevoluteJoint,
            entity_id: 0,
            payload,
        };
        process_commands(&[cmd], &mut world, &mut map, &mut rs, &mut physics);

        assert_eq!(physics.pending_joints.len(), 1);
        let pj = &physics.pending_joints[0];
        assert_eq!(pj.joint_id, 42);
        assert_eq!(pj.entity_a_ext, 0);
        assert_eq!(pj.entity_b_ext, 1);
        match &pj.joint_type {
            crate::physics::PendingJointType::Revolute { anchor_ax, anchor_ay } => {
                assert!((anchor_ax - 5.0).abs() < f32::EPSILON);
                assert!((anchor_ay - 10.0).abs() < f32::EPSILON);
            }
            _ => panic!("expected Revolute joint type"),
        }
    }
}

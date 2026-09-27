//! Translates ring buffer commands into ECS mutations.

use hecs::World;

use crate::components::*;
use crate::render_state::RenderState;
use crate::ring_buffer::{Command, CommandType};

/// Read three consecutive little-endian f32s, rejecting non-finite input.
///
/// NaN and infinity used to flow straight from the wire into components and from
/// there into `ModelMatrix`, `gpu_bounds`, `gpu_depths` (which feeds the GPU
/// radix sort — a NaN key corrupts the whole back-to-front order) and, through
/// `propagate_transforms`, into every descendant's matrix
/// (audit 2026-07, P2-3).
fn read_vec3(payload: &[u8; 16]) -> Option<(f32, f32, f32)> {
    let x = f32::from_le_bytes(payload[0..4].try_into().unwrap());
    let y = f32::from_le_bytes(payload[4..8].try_into().unwrap());
    let z = f32::from_le_bytes(payload[8..12].try_into().unwrap());
    (x.is_finite() && y.is_finite() && z.is_finite()).then_some((x, y, z))
}

/// Read four consecutive little-endian f32s, rejecting non-finite input.
fn read_vec4(payload: &[u8; 16], offset: usize) -> Option<[f32; 4]> {
    let mut out = [0.0f32; 4];
    for (i, v) in out.iter_mut().enumerate() {
        let o = offset + i * 4;
        *v = f32::from_le_bytes(payload[o..o + 4].try_into().unwrap());
        if !v.is_finite() {
            return None;
        }
    }
    Some(out)
}

/// Read a single little-endian f32, rejecting non-finite input.
fn read_f32(payload: &[u8; 16]) -> Option<f32> {
    let v = f32::from_le_bytes(payload[0..4].try_into().unwrap());
    v.is_finite().then_some(v)
}

/// Maximum ancestor chain length walked by hierarchy operations.
/// Bounds both cycle detection here and world-matrix propagation in
/// `systems::propagate_transforms`, which uses the same limit.
pub const MAX_HIERARCHY_DEPTH: usize = 64;

/// Highest accepted external entity id.
///
/// `EntityMap` is a sparse `Vec` indexed by the id, so an unbounded id is an
/// unbounded allocation driven straight from the wire. 1 M entities is far past
/// anything the engine can simulate (the ring-buffer benchmark tops out at 10 k)
/// while keeping the worst-case map at 8 MB instead of 34 GB.
pub const MAX_EXTERNAL_ID: u32 = 1_048_575; // 2^20 - 1

/// Maps external entity IDs (from TypeScript) to internal hecs entities.
///
/// It binds the ids the TypeScript side chooses and allocates none: the only
/// allocator is TypeScript's. The Rust one it used to carry (`allocate()` over a
/// free list) had no caller, and handed out LIVE ids — `insert` never told it
/// which ids were taken (removed 2026-09-27).
pub struct EntityMap {
    /// Sparse map: external ID -> hecs Entity.
    /// Uses a Vec for O(1) lookup. External IDs are sequential u32s.
    map: Vec<Option<hecs::Entity>>,
    /// Tracks whether each external ID is a 2D entity (Transform2D) vs 3D (Position+Rotation+Scale).
    /// Indexed by external ID. Default `false` = 3D.
    is_2d: Vec<bool>,
    /// Count of `insert` calls rejected for exceeding `MAX_EXTERNAL_ID`.
    rejected_ids: u32,
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
            is_2d: Vec::new(),
            rejected_ids: 0,
        }
    }

    /// Register a mapping from external ID to hecs entity.
    ///
    /// Returns `false` when `external_id` exceeds [`MAX_EXTERNAL_ID`] — the
    /// mapping is then not created and the caller must treat the spawn as
    /// rejected.
    ///
    /// The sparse `Vec` is indexed directly by the id, so before the 2026-07
    /// audit (P0-4) six bytes on the wire (`SpawnEntity` with id 10_000_000)
    /// allocated ~85 MB of WASM heap, and on wasm32 — where `usize` is 32-bit
    /// and release builds have `overflow-checks` off — `idx + 1` for
    /// `id == u32::MAX` wrapped to 0, wiping every mapping and then indexing
    /// out of bounds. The cap makes both unreachable.
    pub fn insert(&mut self, external_id: u32, entity: hecs::Entity) -> bool {
        let idx = external_id as usize;
        if external_id > MAX_EXTERNAL_ID {
            self.rejected_ids = self.rejected_ids.saturating_add(1);
            return false;
        }
        if idx >= self.map.len() {
            // Grow geometrically rather than exactly to the requested index, so
            // a sparse-but-legal id pattern doesn't rebuild the Vec each time.
            let new_len = (idx + 1).max(self.map.len() * 2).min(MAX_EXTERNAL_ID as usize + 1);
            self.map.resize(new_len, None);
            self.is_2d.resize(new_len, false);
        }
        self.map[idx] = Some(entity);
        true
    }

    /// Number of rejected commands: an `insert` whose external id exceeded
    /// [`MAX_EXTERNAL_ID`], or a `SetRenderPrimitive` past the last type.
    /// Surfaced to JS via `engine_rejected_command_count`.
    pub fn rejected_ids(&self) -> u32 {
        self.rejected_ids
    }

    /// True when `external_id` is within the accepted range. Spawn paths check
    /// this *before* creating the hecs entity, so a rejected id never leaves an
    /// unmapped entity behind in the world.
    pub fn accepts_id(&self, external_id: u32) -> bool {
        external_id <= MAX_EXTERNAL_ID
    }

    /// Record a rejected command: an out-of-range id or render primitive.
    pub(crate) fn note_rejected_id(&mut self) {
        self.rejected_ids = self.rejected_ids.saturating_add(1);
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

    /// Remove a mapping.
    pub fn remove(&mut self, external_id: u32) {
        let idx = external_id as usize;
        if idx < self.map.len() {
            self.map[idx] = None;
        }
        if idx < self.is_2d.len() {
            self.is_2d[idx] = false;
        }
    }

    /// Current allocated capacity (length of the sparse map).
    pub fn capacity(&self) -> usize {
        self.map.len()
    }

    /// Shrink the sparse map by truncating trailing `None` slots,
    /// then releasing unused heap memory.
    pub fn shrink_to_fit(&mut self) {
        let last_used = self.map.iter().rposition(|opt| opt.is_some());
        match last_used {
            Some(idx) => self.map.truncate(idx + 1),
            None => self.map.clear(),
        }
        self.map.shrink_to_fit();
        self.is_2d.truncate(self.map.len());
        self.is_2d.shrink_to_fit();
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
/// Physics-aware: passes `&mut HyperionPhysicsWorld` to `process_single_command` so that
/// `DespawnEntity`, `DestroyRigidBody`, and `DestroyCollider` can clean up Rapier
/// state. `CreateRigidBody` and `CreateCollider` insert pending ECS components.
#[cfg(feature = "physics-2d")]
pub fn process_commands(
    commands: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
    physics: &mut crate::physics::HyperionPhysicsWorld,
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
                flush_spawn_batch(batch, world, entity_map, render_state, physics);
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

// ── Hierarchy helpers (audit 2026-07, P2-1) ─────────────────────
//
// Before the audit the scene graph had no lifecycle at all: `DespawnEntity`
// left dangling `Parent` links and stale `Children` entries, `SetParent`
// accepted self-parenting and A↔B cycles, and a despawn/respawn round trip
// could put the same child id in `Children` twice — after which no command
// could remove it. These four helpers are the single place link bookkeeping
// happens.

/// Detach `child_ext_id` from the parent it currently records, keeping both
/// directions of the link consistent.
fn detach_from_parent(world: &mut World, entity_map: &EntityMap, child_entity: hecs::Entity) {
    let child_ext_id = match world.get::<&ExternalId>(child_entity) {
        Ok(e) => e.0,
        Err(_) => return,
    };
    let old_parent_id = world.get::<&Parent>(child_entity).ok().map(|p| p.0);
    let Some(old_id) = old_parent_id else { return };
    if old_id == u32::MAX {
        return;
    }
    if let Some(old_parent_entity) = entity_map.get(old_id) {
        remove_child_id(world, old_parent_entity, child_ext_id);
    }
    if let Ok(mut parent) = world.get::<&mut Parent>(child_entity) {
        parent.0 = u32::MAX;
    }
}

/// Remove `child_ext_id` from a parent's inline `Children` and, if present,
/// from its `OverflowChildren` heap list.
fn remove_child_id(world: &mut World, parent_entity: hecs::Entity, child_ext_id: u32) {
    if let Ok(mut children) = world.get::<&mut Children>(parent_entity) {
        children.remove(child_ext_id);
    }
    let overflow_now_empty = if let Ok(mut overflow) =
        world.get::<&mut OverflowChildren>(parent_entity)
    {
        overflow.items.retain(|&id| id != child_ext_id);
        overflow.items.is_empty()
    } else {
        false
    };
    if overflow_now_empty {
        let _ = world.remove_one::<OverflowChildren>(parent_entity);
    }
}

/// Add `child_ext_id` to a parent's child list, spilling to `OverflowChildren`
/// past 32 entries. Never inserts a duplicate.
fn add_child_id(world: &mut World, parent_entity: hecs::Entity, child_ext_id: u32) {
    let mut needs_overflow = false;
    if let Ok(mut children) = world.get::<&mut Children>(parent_entity) {
        if children.contains(child_ext_id) {
            return;
        }
        if !children.add(child_ext_id) {
            needs_overflow = true;
        }
    }
    if !needs_overflow {
        return;
    }
    if let Ok(mut overflow) = world.get::<&mut OverflowChildren>(parent_entity) {
        if !overflow.items.contains(&child_ext_id) {
            overflow.items.push(child_ext_id);
        }
    } else {
        let _ = world.insert_one(parent_entity, OverflowChildren { items: vec![child_ext_id] });
    }
}

/// True when parenting `child_ext_id` under `new_parent_id` would create a
/// cycle (including self-parenting). Walks the ancestor chain with a hard cap
/// so an already-corrupt graph can never spin forever.
fn would_create_cycle(
    world: &World,
    entity_map: &EntityMap,
    child_ext_id: u32,
    new_parent_id: u32,
) -> bool {
    if new_parent_id == child_ext_id {
        return true;
    }
    let mut cursor = new_parent_id;
    for _ in 0..MAX_HIERARCHY_DEPTH {
        if cursor == u32::MAX {
            return false;
        }
        let Some(entity) = entity_map.get(cursor) else {
            return false;
        };
        let Ok(parent) = world.get::<&Parent>(entity) else {
            return false;
        };
        let next = parent.0;
        drop(parent);
        if next == child_ext_id {
            return true;
        }
        cursor = next;
    }
    // Depth cap hit: treat as a cycle rather than accepting an unbounded chain.
    true
}

/// Remove every hierarchy link touching `entity`, in both directions.
///
/// Called before the entity leaves the world so its parent stops listing it and
/// its children become roots instead of pointing at a dead — and later recycled
/// — external id (audit 2026-07, P2-1b, P2-1c).
fn unlink_hierarchy(
    world: &mut World,
    entity_map: &EntityMap,
    render_state: &mut RenderState,
    entity: hecs::Entity,
) {
    detach_from_parent(world, entity_map, entity);

    let mut child_ids: Vec<u32> = world
        .get::<&Children>(entity)
        .map(|c| c.as_slice().to_vec())
        .unwrap_or_default();
    if let Ok(overflow) = world.get::<&OverflowChildren>(entity) {
        child_ids.extend_from_slice(&overflow.items);
    }
    for child_id in child_ids {
        if let Some(child_entity) = entity_map.get(child_id)
            && let Ok(mut parent) = world.get::<&mut Parent>(child_entity)
        {
            parent.0 = u32::MAX;
            // The orphan is a root now: its world transform is its local one.
            // Without this, its GPU row and culling sphere stayed at the dead
            // parent's world position until something else dirtied it. The
            // descendant pass of `mark_post_system_dirty` carries the mark on to
            // the grandchildren.
            if let Some(slot) = render_state.get_slot(child_entity) {
                render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
            }
        }
    }
}

/// Retire the entity currently mapped to `external_id`, if any, before a new
/// spawn reuses that id.
///
/// Before the 2026-07 audit (P2-4) `entity_map.insert` simply overwrote the
/// mapping: the previous entity stayed alive, `Active`, with a `ModelMatrix`
/// and a GPU slot, but became unreachable from the map — so no `DespawnEntity`
/// could ever remove it and it rendered forever. Any external-id reuse from the
/// TS side (reconnect, hot-reload, pool churn) leaked one entity per spawn.
///
/// Returns `true` when a previous entity was retired.
fn retire_previous_binding(
    external_id: u32,
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
) -> bool {
    match entity_map.get(external_id) {
        Some(previous) => {
            render_state.queue_despawn(previous);
            unlink_hierarchy(world, entity_map, render_state, previous);
            let _ = world.despawn(previous);
            entity_map.remove(external_id);
            true
        }
        None => false,
    }
}

/// Physics half of `retire_previous_binding`, for physics builds.
///
/// A spawn for an id that is still bound retires the old entity, and its
/// Rapier state must go with it exactly as on a despawn. Without this the old
/// body and colliders stayed in the simulation, colliding, with no entity
/// pointing at them, and every registration keyed by the external id (character
/// controller, joints, pending moves and teleports) passed to the new entity
/// (id reuse, 2026-09-27, verify_reuse R3). Call it BEFORE
/// `retire_previous_binding`, which unmaps the id.
#[cfg(feature = "physics-2d")]
fn retire_previous_physics(
    external_id: u32,
    world: &World,
    entity_map: &EntityMap,
    physics: &mut crate::physics::HyperionPhysicsWorld,
) {
    if let Some(previous) = entity_map.get(external_id) {
        despawn_physics_cleanup(world, previous, physics);
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
    #[cfg(feature = "physics-2d")] physics: &mut crate::physics::HyperionPhysicsWorld,
) {
    // Retire any live binding for the ids about to be (re)spawned, so a
    // duplicate spawn cannot orphan an entity (audit 2026-07, P2-4).
    for cmd in batch {
        if entity_map.accepts_id(cmd.entity_id) {
            #[cfg(feature = "physics-2d")]
            retire_previous_physics(cmd.entity_id, world, entity_map, physics);
            retire_previous_binding(cmd.entity_id, world, entity_map, render_state);
        }
    }

    // A run can name one id twice. Only the LAST of its spawns creates an
    // entity, as when they arrive one at a time and each retires the one
    // before. Spawning both left the first alive, rendering and unmapped, so no
    // DespawnEntity could reach it (id reuse, 2026-09-27, verify_reuse R4).
    let mut seen = std::collections::HashSet::with_capacity(batch.len());
    let mut superseded = vec![false; batch.len()];
    for (i, cmd) in batch.iter().enumerate().rev() {
        superseded[i] = !seen.insert(cmd.entity_id);
    }

    // Partition into 3D and 2D sub-batches, preserving original indices.
    // Out-of-range ids are dropped here (audit 2026-07, P0-4).
    let mut batch_3d: Vec<(usize, &Command)> = Vec::new();
    let mut batch_2d: Vec<(usize, &Command)> = Vec::new();
    for (i, cmd) in batch.iter().enumerate() {
        if !entity_map.accepts_id(cmd.entity_id) {
            entity_map.note_rejected_id();
            continue;
        }
        if superseded[i] {
            continue;
        }
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
        for ((orig_idx, _), entity) in batch_3d.iter().zip(spawned) {
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
        for ((orig_idx, _), entity) in batch_2d.iter().zip(spawned) {
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
        let _ = entity_map.insert(cmd.entity_id, *entity);
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
            // Out-of-range ids are rejected before anything is created, so no
            // unmapped entity is ever left in the world (audit 2026-07, P0-4).
            if !entity_map.accepts_id(cmd.entity_id) {
                entity_map.note_rejected_id();
                return;
            }
            // A spawn for an id that is still bound retires the old entity
            // first, otherwise it stays alive and rendering but unreachable
            // from the map (audit 2026-07, P2-4).
            retire_previous_binding(cmd.entity_id, world, entity_map, render_state);
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
            let _ = entity_map.insert(cmd.entity_id, entity);
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
                render_state.queue_despawn(entity);
                unlink_hierarchy(world, entity_map, render_state, entity);
                let _ = world.despawn(entity);
                entity_map.remove(cmd.entity_id);
            }
        }

        CommandType::SetPosition => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let Some((x, y, z)) = read_vec3(&cmd.payload) else { return };
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
                let Some([x, y, z, w]) = read_vec4(&cmd.payload, 0) else { return };
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
                let Some((x, y, z)) = read_vec3(&cmd.payload) else { return };
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
                let Some((x, y, z)) = read_vec3(&cmd.payload) else { return };
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
                // Types run 0..=PRIM_TYPE_LIGHT2D. cull.wgsl clamps anything
                // larger to the last type, so an out-of-range value would be
                // drawn as a Light2D. Rejected, and the entity keeps its type.
                if prim > crate::components::PRIM_TYPE_LIGHT2D {
                    entity_map.note_rejected_id();
                    return;
                }
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

                // Reject self-parenting and cycles. Accepting them produced a
                // permanently wrong world matrix (`M * M` for a self-parent) and
                // left a structure that any depth-first walk would loop on
                // (audit 2026-07, P2-1a).
                if new_parent_id != u32::MAX
                    && would_create_cycle(world, entity_map, cmd.entity_id, new_parent_id)
                {
                    return;
                }

                // Reject a parent that does not exist: writing `Parent`
                // unconditionally while skipping the reciprocal `Children`
                // insert left a half-link that silently completed itself if the
                // id was spawned later (audit 2026-07, P2-1 note).
                if new_parent_id != u32::MAX && entity_map.get(new_parent_id).is_none() {
                    return;
                }

                detach_from_parent(world, entity_map, child_entity);

                if let Ok(mut parent) = world.get::<&mut Parent>(child_entity) {
                    parent.0 = new_parent_id;
                }

                if new_parent_id != u32::MAX
                    && let Some(parent_entity) = entity_map.get(new_parent_id)
                {
                    add_child_id(world, parent_entity, cmd.entity_id);
                }

                if let Some(slot) = render_state.get_slot(child_entity) {
                    render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                    render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
                }
            }
        }

        CommandType::SetPrimParams0 => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let Some([p0, p1, p2, p3]) = read_vec4(&cmd.payload, 0) else { return };
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
                let Some([p4, p5, p6, p7]) = read_vec4(&cmd.payload, 0) else { return };
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
                let Some(angle) = read_f32(&cmd.payload) else { return };
                if entity_map.is_entity_2d(cmd.entity_id) {
                    if let Ok(mut t) = world.get::<&mut Transform2D>(entity) {
                        t.rot = angle;
                    }
                } else if let Ok(mut rot) = world.get::<&mut Rotation>(entity) {
                    // A 2D angle on a 3D entity is a rotation about Z, the
                    // screen normal, and it replaces the whole quaternion: the
                    // same "set the angle" that SetRotation means on a 2D
                    // entity. engine.spawn() only makes 3D entities, so this
                    // is what EntityHandle.rotation(angle) does in practice
                    // (it used to be ignored, 2026-09-26).
                    rot.0 = glam::Quat::from_rotation_z(angle);
                }
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                    render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
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
                // A NaN depth is a poisoned GPU radix-sort key: it corrupts the
                // whole back-to-front transparency order, not just this entity.
                let Some(z) = read_f32(&cmd.payload) else { return };
                let _ = world.insert_one(entity, Depth(z));
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        // Pin an explicit cull/pick radius (audit 2026-07, P1-17).
        // A negative value clears the override and restores automatic
        // derivation from the entity's world matrix.
        CommandType::SetBoundingRadius => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let r = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                if r.is_finite() && r >= 0.0 {
                    let _ = world.insert_one(entity, BoundingRadius(r));
                    let _ = world.insert_one(entity, BoundsOverride);
                } else {
                    // Negative / non-finite: back to automatic derivation.
                    let _ = world.remove_one::<BoundsOverride>(entity);
                }
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
                }
            }
        }

        // Physics commands (17-41, 48-52) — handled in process_single_command_physics
        // and process_physics_commands when physics-2d is enabled.
        // Without physics, they are no-ops.
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
        | CommandType::SetJointAnchorA
        // Physics: character controller — handled by physics command processor
        | CommandType::CreateCharacterController
        | CommandType::SetCharacterConfig
        | CommandType::MoveCharacter
        // Audit 2026-07 physics additions
        | CommandType::SetColliderEvents
        | CommandType::TeleportBody
        | CommandType::DestroyCharacterController
        | CommandType::SetCharacterUp => {}

        // Handled in Engine::process_commands (engine-level flag, Phase 16)
        CommandType::SetPhysicsDebugRender => {}

        // ── Phase 17: lighting ──
        //
        // `LightFlags` is inserted rather than mutated in place: `insert_one`
        // on an entity that already has it overwrites, which is what a
        // last-write-wins coalescable command means. Reading first preserves
        // the bits this command does not own.
        // Payload: type(u8), blend(u8), mask(u16 LE). `lightType` needs 3 bits
        // and `blendMode` 2, so bit 7 of each of the first two bytes is spare
        // and carries "preserve the stored value, ignore mine".
        //
        // That is what lets `EntityHandle.lightLayers()` change only the mask
        // without the caller having to restate the light's shape — statelessly,
        // rather than by remembering the last values on a pooled handle.
        CommandType::SetLightFlags => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let mut flags = world
                    .get::<&LightFlags>(entity)
                    .map(|f| *f)
                    .unwrap_or_default();
                let light_type = if cmd.payload[0] & 0x80 != 0 {
                    flags.light_type_raw()
                } else {
                    cmd.payload[0]
                };
                let blend = if cmd.payload[1] & 0x80 != 0 {
                    flags.blend_mode_raw()
                } else {
                    cmd.payload[1]
                };
                let mask = u16::from_le_bytes([cmd.payload[2], cmd.payload[3]]);
                // Out-of-range values are masked, not rejected: the field is
                // 3 and 2 bits wide and a wider value would otherwise bleed
                // into the neighbouring field.
                flags.set_light(light_type, blend, mask);
                let _ = world.insert_one(entity, flags);
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        // Payload: bits 0-1 are the values (castsShadow, receivesLight); bits
        // 2-3 mean "preserve this one, ignore my value for it".
        //
        // The preserve bits exist because the fluent API exposes
        // `.castsShadow()` and `.receivesLight()` as separate calls, and a
        // command carrying only values would make each one silently clear the
        // other. Default 0 = write both, which is the plain form.
        CommandType::SetLightingFlags => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                let bits = cmd.payload[0];
                let mut flags = world
                    .get::<&LightFlags>(entity)
                    .map(|f| *f)
                    .unwrap_or_default();
                if bits & 0b0100 == 0 {
                    flags.set_casts_shadow(bits & 0b01 != 0);
                }
                if bits & 0b1000 == 0 {
                    flags.set_receives_light(bits & 0b10 != 0);
                }
                let _ = world.insert_one(entity, flags);
                if let Some(slot) = render_state.get_slot(entity) {
                    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
                }
            }
        }

        // Engine-level (entity_id = 0 sentinel), intercepted in
        // `Engine::process_commands` before ECS dispatch — same shape as
        // `SetPhysicsDebugRender`. These arms exist only for exhaustiveness.
        CommandType::SetAmbientLight | CommandType::SetLightingBackend => {}
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
    physics: &mut crate::physics::HyperionPhysicsWorld,
) {
    match cmd.cmd_type {
        // SpawnEntity: a spawn on a live id retires the old entity, physics
        // included (verify_reuse R3); the base handler does the rest.
        CommandType::SpawnEntity => {
            retire_previous_physics(cmd.entity_id, world, entity_map, physics);
            process_single_command(cmd, world, entity_map, render_state);
        }

        // DespawnEntity: clean up Rapier state before despawning the ECS entity.
        CommandType::DespawnEntity => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                despawn_physics_cleanup(world, entity, physics);
                render_state.queue_despawn(entity);
                unlink_hierarchy(world, entity_map, render_state, entity);
                let _ = world.despawn(entity);
                entity_map.remove(cmd.entity_id);
            }
        }

        // CreateRigidBody: insert PendingRigidBody component (consumed by physics_sync_pre)
        CommandType::CreateRigidBody => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                // Replacing a live body must tear the old one down first.
                // Without this the second call inserted a SECOND Rapier body and
                // just overwrote the component, leaving the first body and its
                // collider unreachable from the ECS — still simulating, still
                // colliding, and surviving the entity's despawn forever
                // (audit 2026-07, P1-5).
                if world.get::<&crate::physics::PhysicsBodyHandle>(entity).is_ok() {
                    physics_detach_body(world, entity, physics);
                }
                let body_type = cmd.payload[0];
                let _ = world.insert_one(entity, crate::physics::PendingRigidBody::new(body_type));
            }
        }

        // CreateCollider: insert PendingCollider component (consumed by physics_sync_pre)
        CommandType::CreateCollider => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                // Same overwrite hazard as CreateRigidBody: drop the previous
                // collider instead of orphaning it on the body (P1-5).
                remove_live_collider(world, entity, physics);
                let pending = crate::physics::PendingCollider::from_payload(&cmd.payload);
                let _ = world.insert_one(entity, pending);
            }
        }

        // DestroyRigidBody: remove Rapier body + ECS handles.
        //
        // The entity survives, so its character controller must too: reusing the
        // full despawn cleanup here silently deregistered it, which broke the
        // natural "swap body type" sequence DestroyRigidBody + CreateRigidBody
        // (audit 2026-07, P1-12).
        CommandType::DestroyRigidBody => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                physics_detach_body(world, entity, physics);
            }
        }

        // DestroyCollider: remove a single collider from Rapier
        CommandType::DestroyCollider => {
            if let Some(entity) = entity_map.get(cmd.entity_id) {
                remove_live_collider(world, entity, physics);
                let _ = world.remove_one::<crate::physics::PendingCollider>(entity);
            }
        }

        // CreateRevoluteJoint: stage a revolute PendingJoint
        CommandType::CreateRevoluteJoint => {
            if joint_command_rejected(cmd, entity_map, physics) {
                return;
            }
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
            if joint_command_rejected(cmd, entity_map, physics) {
                return;
            }
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
            if joint_command_rejected(cmd, entity_map, physics) {
                return;
            }
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
            if joint_command_rejected(cmd, entity_map, physics) {
                return;
            }
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
            if joint_command_rejected(cmd, entity_map, physics) {
                return;
            }
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

        // Position/rotation writes on a Rapier-owned body must also reposition
        // the body, otherwise the ECS value is silently reverted by the next
        // write-back — there was no reposition path for dynamic or fixed bodies
        // at all (audit 2026-07, P1-9).
        CommandType::SetPosition
        | CommandType::SetRotation2D
        | CommandType::SetRotation
        | CommandType::TeleportBody => {
            process_single_command(cmd, world, entity_map, render_state); // no-op for TeleportBody
            let Some(entity) = entity_map.get(cmd.entity_id) else { return };

            // One reposition per body until the next tick, MERGED in call
            // order: the last call wins field by field, and a zeroed velocity
            // stays zeroed. TeleportBody used to be pushed in a second pass,
            // after every SetPosition/rotation of the batch, so
            // `teleport(t).position(p)` ended at t (review 2026-09-26).
            let earlier = physics
                .pending_teleports
                .iter()
                .rev()
                .find(|t| t.ext_id == cmd.entity_id)
                .map(|t| (t.x, t.y, t.rot, t.zero_velocity));

            // SetPosition and the rotations reposition a live body, or merge
            // into a reposition already queued (a teleport in the creation
            // batch); otherwise Pass 1 builds the body from the ECS pose.
            // A teleport is queued for any entity: its body may come later
            // in the same batch.
            let is_teleport = matches!(cmd.cmd_type, CommandType::TeleportBody);
            if !is_teleport
                && earlier.is_none()
                && world.get::<&crate::physics::PhysicsControlled>(entity).is_err()
            {
                return;
            }

            let (pose_x, pose_y, pose_rot) = read_entity_pose(world, entity);
            // A rotation keeps the position a queued reposition already
            // holds (the ECS pose lags a teleport until it is applied).
            let queued_xy = earlier.map(|(x, y, _, _)| (x, y)).unwrap_or((pose_x, pose_y));
            // A rotation takes its angle from the command: the pose of a 3D
            // entity carries none. One the base handler rejected (non-finite)
            // queues nothing, so it cancels nothing.
            let (x, y, rot, zero) = match cmd.cmd_type {
                CommandType::TeleportBody => {
                    let f = |o: usize| f32::from_le_bytes(cmd.payload[o..o + 4].try_into().unwrap());
                    let (x, y, rot) = (f(0), f(4), f(8));
                    if !x.is_finite() || !y.is_finite() || !rot.is_finite() {
                        return;
                    }
                    (x, y, Some(rot), cmd.payload[12] & 0x01 != 0)
                }
                CommandType::SetRotation2D => match read_f32(&cmd.payload) {
                    Some(a) => (queued_xy.0, queued_xy.1, Some(a), false),
                    None => return,
                },
                CommandType::SetRotation => match read_vec4(&cmd.payload, 0)
                    .and_then(|[qx, qy, qz, qw]| Rotation(glam::Quat::from_xyzw(qx, qy, qz, qw)).z_angle())
                {
                    Some(a) => (queued_xy.0, queued_xy.1, Some(a), false),
                    None => return,
                },
                // SetPosition: the base handler already wrote the new position
                // into the pose. A rotation queued earlier (explicit) wins
                // over the pose's, which lags a pending teleport.
                _ => (pose_x, pose_y, earlier.and_then(|(_, _, r, _)| r).or(pose_rot), false),
            };
            if !x.is_finite() || !y.is_finite() {
                return;
            }
            physics.pending_teleports.retain(|t| t.ext_id != cmd.entity_id);
            physics.pending_teleports.push(crate::physics::PendingTeleport {
                ext_id: cmd.entity_id,
                x,
                y,
                rot,
                // A plain SetPosition is a reposition, not a respawn: momentum
                // is kept, unless a teleport of the same batch cleared it.
                zero_velocity: zero || earlier.is_some_and(|(_, _, _, z)| z),
            });
        }

        // All other commands: delegate to the base (non-physics) handler
        _ => {
            process_single_command(cmd, world, entity_map, render_state);
        }
    }
}

/// Whether a `Create*Joint` command must be dropped instead of staged.
///
/// - Its joint id is live or pending. Reusing a live joint id used to overwrite
///   the map entry and drop the only handle to the previous Rapier joint, which
///   kept constraining its bodies with no way to remove it (P1-10).
/// - Entity A (the command's entity id) or entity B (payload bytes 4..8) is not
///   mapped. A pending joint resolves its ends by external id only at the next
///   tick, so a joint to a dead id bound whatever entity took that id before
///   then (id reuse, 2026-09-27, verify_reuse R2). Rejected like a `SetParent`
///   to a missing parent; an end spawned earlier in the batch is mapped.
#[cfg(feature = "physics-2d")]
fn joint_command_rejected(
    cmd: &Command,
    entity_map: &EntityMap,
    physics: &crate::physics::HyperionPhysicsWorld,
) -> bool {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let entity_b_ext = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    physics.joint_map.contains_key(&joint_id)
        || physics.pending_joints.iter().any(|p| p.joint_id == joint_id)
        || entity_map.get(cmd.entity_id).is_none()
        || entity_map.get(entity_b_ext).is_none()
}

/// Clean up Rapier state for an entity leaving the world: a despawn, or a spawn
/// that retires it (`retire_previous_physics`).
///
/// Drops every registration keyed by its external id (joints, pending joints,
/// character controller, pending moves and teleports), then removes the body,
/// which cascades collider and joint removal in Rapier. The collider reverse
/// map is left as it is: see `remove_body_and_colliders`.
#[cfg(feature = "physics-2d")]
pub fn despawn_physics_cleanup(
    world: &hecs::World,
    entity: hecs::Entity,
    physics: &mut crate::physics::HyperionPhysicsWorld,
) {
    // External-id-keyed cleanup runs UNCONDITIONALLY.
    //
    // It used to sit inside the `PhysicsBodyHandle` guard, but bodies only
    // materialise during `update()`: an entity created and destroyed in the same
    // batch left a live `character_map` entry keyed by an external id the map
    // immediately recycled, so a later, unrelated entity inherited a controller
    // the game never created (audit 2026-07, P1-12).
    if let Ok(ext_id) = world.get::<&ExternalId>(entity) {
        let eid = ext_id.0;
        drop(ext_id);
        physics.joint_map.retain(|_, entry| entry.entity_a != eid && entry.entity_b != eid);
        physics.pending_joints.retain(|p| p.entity_a_ext != eid && p.entity_b_ext != eid);
        physics.character_map.remove(&eid);
        physics.pending_moves.retain(|(id, _, _)| *id != eid);
        physics.pending_teleports.retain(|t| t.ext_id != eid);
    }
    remove_body_and_colliders(world, entity, physics);
}

/// Remove the entity's Rapier body (and its colliders) plus the ECS handles,
/// leaving every external-id-keyed registration (character controller) intact.
#[cfg(feature = "physics-2d")]
fn physics_detach_body(
    world: &mut World,
    entity: hecs::Entity,
    physics: &mut crate::physics::HyperionPhysicsWorld,
) -> bool {
    // A body carries its joints: Rapier cascades their removal, so the joint
    // bookkeeping has to follow even though the entity itself survives.
    if let Ok(ext_id) = world.get::<&ExternalId>(entity) {
        let eid = ext_id.0;
        drop(ext_id);
        physics.joint_map.retain(|_, entry| entry.entity_a != eid && entry.entity_b != eid);
        physics.pending_joints.retain(|p| p.entity_a_ext != eid && p.entity_b_ext != eid);
    }
    let removed = remove_body_and_colliders(world, entity, physics);
    let _ = world.remove_one::<crate::physics::PhysicsBodyHandle>(entity);
    let _ = world.remove_one::<crate::physics::PhysicsColliderHandle>(entity);
    let _ = world.remove_one::<crate::physics::PhysicsControlled>(entity);
    let _ = world.remove_one::<crate::physics::PendingRigidBody>(entity);
    let _ = world.remove_one::<crate::physics::PendingCollider>(entity);
    removed
}

/// Current pose of an entity, from whichever transform archetype it uses.
#[cfg(feature = "physics-2d")]
fn read_entity_pose(world: &World, entity: hecs::Entity) -> (f32, f32, Option<f32>) {
    if let Ok(t) = world.get::<&Transform2D>(entity) {
        return (t.x, t.y, Some(t.rot));
    }
    if let Ok(p) = world.get::<&Position>(entity) {
        return (p.0.x, p.0.y, None);
    }
    (0.0, 0.0, None)
}

/// Drop the entity's live collider (if any) without touching its body.
#[cfg(feature = "physics-2d")]
fn remove_live_collider(
    world: &mut World,
    entity: hecs::Entity,
    physics: &mut crate::physics::HyperionPhysicsWorld,
) {
    let col_h = world
        .get::<&crate::physics::PhysicsColliderHandle>(entity)
        .ok()
        .map(|c| c.0);
    if let Some(h) = col_h {
        // Reverse-map entry intentionally left in place — see
        // `remove_body_and_colliders` for why (P1-14c).
        physics.collider_set.remove(
            h,
            &mut physics.island_manager,
            &mut physics.rigid_body_set,
            true,
        );
        let _ = world.remove_one::<crate::physics::PhysicsColliderHandle>(entity);
    }
}

/// Shared body teardown: removes the body, which cascades collider and joint
/// removal inside Rapier. The collider reverse map is left as it is (see below).
#[cfg(feature = "physics-2d")]
fn remove_body_and_colliders(
    world: &hecs::World,
    entity: hecs::Entity,
    physics: &mut crate::physics::HyperionPhysicsWorld,
) -> bool {
    let Ok(handle) = world.get::<&crate::physics::PhysicsBodyHandle>(entity) else {
        return false;
    };
    let body_handle = handle.0;
    drop(handle);
    // The collider -> entity reverse map is deliberately NOT cleared here.
    //
    // Rapier emits the matching `CollisionEvent::Stopped` on the *next* step,
    // after the body is gone. Wiping the map first made that lookup fail, so the
    // event was dropped — including the notification the surviving entity needs,
    // which left client-side "who am I overlapping" state leaking forever
    // (audit 2026-07, P1-14c).
    //
    // The stale entry is NOT always harmless. Rapier frees the arena index at
    // once and reuses it (LIFO), and `collider_handle_to_entity` looks up by
    // index alone, ignoring the generation. A collider created before that next
    // step (Pass 2 of `physics_sync_pre`: in this frame, or in a later one if
    // this one runs no tick) overwrites the entry, and the removed collider's
    // Stopped event is then reported against the NEW collider's entity:
    // despawn(1) + a collider for 3 in the same frame gave Stopped(3, 2).
    // Known, not fixed (id-reuse design §3): the map needs the generation.
    // Once that step has run, the entry is read again only for a collider
    // that recycles the index, and Pass 2 overwrites it when that one is made.
    physics.rigid_body_set.remove(
        body_handle,
        &mut physics.island_manager,
        &mut physics.collider_set,
        &mut physics.impulse_joint_set,
        &mut physics.multibody_joint_set,
        true, // remove_attached_colliders
    );
    true
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
            let mut physics = crate::physics::HyperionPhysicsWorld::new();
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
    fn set_render_primitive_out_of_range_is_rejected_and_counted() {
        // cull.wgsl clamps the type to NUM_PRIM_TYPES - 1, so a 7 used to be
        // drawn as a Light2D: an invisible light lighting whatever its
        // primParams[3] said (review 2026-09-26).
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);

        let mut payload = [0u8; 16];
        payload[0] = crate::components::PRIM_TYPE_LIGHT2D;
        let valid = Command { cmd_type: CommandType::SetRenderPrimitive, entity_id: 0, payload };
        payload[0] = crate::components::PRIM_TYPE_LIGHT2D + 1;
        let invalid = Command { cmd_type: CommandType::SetRenderPrimitive, entity_id: 0, payload };
        run_commands(&[valid, invalid], &mut world, &mut map, &mut rs);

        let entity = map.get(0).unwrap();
        assert_eq!(world.get::<&RenderPrimitive>(entity).unwrap().0, crate::components::PRIM_TYPE_LIGHT2D);
        assert_eq!(map.rejected_ids(), 1);
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

    // EntityHandle.rotation(angle) sends SetRotation2D, and engine.spawn()
    // makes 3D entities: until 2026-09-26 the one-argument form was ignored on
    // every entity the public API could create. It is now a rotation about Z,
    // mirroring SetRotation on a 2D entity (which keeps the quaternion's Z angle).
    #[test]
    fn set_rotation_2d_on_3d_entity_rotates_about_z() {
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
        // Still a 3D entity: no Transform2D appears.
        let ent = map.get(1).unwrap();
        assert!(world.get::<&Transform2D>(ent).is_err());
        let rot = world.get::<&Rotation>(ent).unwrap();
        assert!(rot.0.abs_diff_eq(glam::Quat::from_rotation_z(1.5), 1e-6), "got {:?}", rot.0);
    }

    #[test]
    fn set_rotation_2d_replaces_a_3d_tilt_and_ignores_a_non_finite_angle() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(&[make_spawn_cmd(1)], &mut world, &mut map, &mut rs);
        let tilt = glam::Quat::from_rotation_x(0.7);
        world.get::<&mut Rotation>(map.get(1).unwrap()).unwrap().0 = tilt;

        let mut nan = [0u8; 16];
        nan[0..4].copy_from_slice(&f32::NAN.to_le_bytes());
        run_commands(&[Command { cmd_type: CommandType::SetRotation2D, entity_id: 1, payload: nan }],
            &mut world, &mut map, &mut rs);
        assert_eq!(world.get::<&Rotation>(map.get(1).unwrap()).unwrap().0, tilt);

        let mut angle = [0u8; 16];
        angle[0..4].copy_from_slice(&0.5f32.to_le_bytes());
        run_commands(&[Command { cmd_type: CommandType::SetRotation2D, entity_id: 1, payload: angle }],
            &mut world, &mut map, &mut rs);
        // A 2D angle SETS the rotation, like on a 2D entity: the tilt is gone.
        let rot = world.get::<&Rotation>(map.get(1).unwrap()).unwrap().0;
        assert!(rot.abs_diff_eq(glam::Quat::from_rotation_z(0.5), 1e-6), "got {rot:?}");
    }

    #[test]
    fn set_rotation_2d_on_3d_entity_marks_it_dirty() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();

        // Spawn 3D entity
        run_commands(&[make_spawn_cmd(1)], &mut world, &mut map, &mut rs);

        // Clear any dirty bits from spawn
        rs.dirty_tracker.clear();

        // SetRotation2D on a 3D entity changes its rotation: the GPU row must follow.
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

        let ent = map.get(1).unwrap();
        let slot = rs.get_slot(ent).expect("a spawned entity has a GPU slot") as usize;
        assert!(rs.dirty_tracker.is_transform_dirty(slot), "transform must be re-uploaded");
        assert!(rs.dirty_tracker.is_bounds_dirty(slot), "bounds must be re-uploaded");
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

    // ── Phase 17: lighting command handlers (53-56) ──

    fn light_flags_cmd(id: u32, light_type: u8, blend: u8, mask: u16) -> Command {
        let mut payload = [0u8; 16];
        payload[0] = light_type;
        payload[1] = blend;
        payload[2..4].copy_from_slice(&mask.to_le_bytes());
        Command {
            cmd_type: CommandType::SetLightFlags,
            entity_id: id,
            payload,
        }
    }

    fn lighting_flags_cmd(id: u32, bits: u8) -> Command {
        let mut payload = [0u8; 16];
        payload[0] = bits;
        Command {
            cmd_type: CommandType::SetLightingFlags,
            entity_id: id,
            payload,
        }
    }

    #[test]
    fn set_light_flags_writes_type_blend_and_mask() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(
            &[make_spawn_cmd(0), light_flags_cmd(0, 1, 2, 0xBEEF)],
            &mut world,
            &mut map,
            &mut rs,
        );

        let e = map.get(0).unwrap();
        let flags = *world.get::<&LightFlags>(e).unwrap();
        assert_eq!(flags.light_type_raw(), 1);
        assert_eq!(flags.blend_mode_raw(), 2);
        assert_eq!(flags.light_mask(), 0xBEEF);
    }

    #[test]
    fn set_light_flags_masks_out_of_range_fields() {
        // lightType is 3 bits and blendMode 2. A wider value must be masked,
        // not written through, or it bleeds into the neighbouring field.
        //
        // 0x7F, not 0xFF: bit 7 of each byte now means "preserve", so 0xFF
        // would exercise that path instead of the masking one.
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(
            &[make_spawn_cmd(0), light_flags_cmd(0, 0x7F, 0x7F, 0)],
            &mut world,
            &mut map,
            &mut rs,
        );

        let e = map.get(0).unwrap();
        let flags = *world.get::<&LightFlags>(e).unwrap();
        assert_eq!(flags.light_type_raw(), 0b111);
        assert_eq!(flags.blend_mode_raw(), 0b11);
        assert_eq!(flags.light_mask(), 0, "mask field must be untouched");
    }

    #[test]
    fn lighting_flags_and_light_flags_do_not_clobber_each_other() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(
            &[
                make_spawn_cmd(0),
                lighting_flags_cmd(0, 0b11), // castsShadow + receivesLight
                light_flags_cmd(0, 3, 1, 0x00FF),
            ],
            &mut world,
            &mut map,
            &mut rs,
        );

        let e = map.get(0).unwrap();
        let flags = *world.get::<&LightFlags>(e).unwrap();
        assert!(flags.casts_shadow(), "bit 9 survived SetLightFlags");
        assert!(flags.receives_light(), "bit 10 survived SetLightFlags");
        assert_eq!(flags.light_type_raw(), 3);
        assert_eq!(flags.light_mask(), 0x00FF);

        // …and the reverse order, since both are last-write-wins coalescable.
        run_commands(&[lighting_flags_cmd(0, 0b01)], &mut world, &mut map, &mut rs);
        let flags = *world.get::<&LightFlags>(e).unwrap();
        assert!(flags.casts_shadow());
        assert!(!flags.receives_light(), "bit 10 cleared");
        assert_eq!(flags.light_type_raw(), 3, "light fields survived");
        assert_eq!(flags.light_mask(), 0x00FF);
    }

    #[test]
    fn lighting_flags_preserve_bits_make_the_two_flags_independent() {
        // Payload bits 2-3 mean "preserve". Without them the fluent API's
        // `.castsShadow()` and `.receivesLight()` would each clear the other,
        // because one command carries both bits.
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(
            &[
                make_spawn_cmd(0),
                lighting_flags_cmd(0, 0b0001),          // casts = true, write both
                lighting_flags_cmd(0, 0b0010 | 0b0100), // receives = true, preserve casts
            ],
            &mut world,
            &mut map,
            &mut rs,
        );
        let e = map.get(0).unwrap();
        let flags = *world.get::<&LightFlags>(e).unwrap();
        assert!(flags.casts_shadow(), "preserved across the second command");
        assert!(flags.receives_light());

        // Preserve receivesLight while clearing castsShadow.
        run_commands(&[lighting_flags_cmd(0, 0b1000)], &mut world, &mut map, &mut rs);
        let flags = *world.get::<&LightFlags>(e).unwrap();
        assert!(!flags.casts_shadow());
        assert!(flags.receives_light(), "preserved");
    }

    #[test]
    fn set_light_flags_preserve_bits_change_only_the_mask() {
        // Bit 7 of the type and blend bytes means "preserve". This is what lets
        // `EntityHandle.lightLayers()` be stateless.
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(
            &[make_spawn_cmd(0), light_flags_cmd(0, 2, 1, 0x000F)],
            &mut world,
            &mut map,
            &mut rs,
        );
        run_commands(
            &[light_flags_cmd(0, 0x80, 0x80, 0xF000)],
            &mut world,
            &mut map,
            &mut rs,
        );

        let e = map.get(0).unwrap();
        let flags = *world.get::<&LightFlags>(e).unwrap();
        assert_eq!(flags.light_type_raw(), 2, "shape preserved");
        assert_eq!(flags.blend_mode_raw(), 1, "blend preserved");
        assert_eq!(flags.light_mask(), 0xF000, "mask replaced");
    }

    #[test]
    fn lighting_commands_mark_meta_dirty() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(&[make_spawn_cmd(0)], &mut world, &mut map, &mut rs);
        rs.dirty_tracker.clear();

        run_commands(
            &[light_flags_cmd(0, 0, 0, 0x0001)],
            &mut world,
            &mut map,
            &mut rs,
        );
        let e = map.get(0).unwrap();
        let slot = rs.get_slot(e).unwrap() as usize;
        assert!(
            rs.dirty_tracker.is_meta_dirty(slot),
            "without this the light never reaches the GPU and nothing errors"
        );
    }

    #[test]
    fn lighting_commands_on_unknown_entity_are_ignored() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        run_commands(
            &[light_flags_cmd(99, 1, 1, 0xFFFF), lighting_flags_cmd(99, 0b11)],
            &mut world,
            &mut map,
            &mut rs,
        );
        assert!(map.get(99).is_none());
        assert_eq!(world.len(), 0);
    }

    #[test]
    fn engine_level_lighting_commands_do_not_reach_the_ecs() {
        // 55 and 56 use the entity_id = 0 sentinel, which is also a perfectly
        // valid external id. They must not be mistaken for entity commands.
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut ambient = [0u8; 16];
        ambient[0..4].copy_from_slice(&0.5f32.to_le_bytes());
        run_commands(
            &[
                make_spawn_cmd(0),
                Command {
                    cmd_type: CommandType::SetAmbientLight,
                    entity_id: 0,
                    payload: ambient,
                },
                Command {
                    cmd_type: CommandType::SetLightingBackend,
                    entity_id: 0,
                    payload: [1; 16],
                },
            ],
            &mut world,
            &mut map,
            &mut rs,
        );

        let e = map.get(0).unwrap();
        assert!(
            world.get::<&LightFlags>(e).is_err(),
            "engine-level commands must not attach LightFlags to entity 0"
        );
    }

    #[cfg(feature = "physics-2d")]
    #[test]
    fn create_revolute_joint_stages_pending() {
        let mut world = World::new();
        let mut map = EntityMap::new();
        let mut rs = RenderState::new();
        let mut physics = crate::physics::HyperionPhysicsWorld::new();

        // Spawn entities 0 and 1 (entity_a and entity_b for the joint): a joint
        // with an unmapped end is rejected (verify_reuse R2).
        let spawn = |id| Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: id,
            payload: [0; 16],
        };
        process_commands(&[spawn(0), spawn(1)], &mut world, &mut map, &mut rs, &mut physics);

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

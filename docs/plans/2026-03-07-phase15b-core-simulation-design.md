# Phase 15b — Core Simulation: Design Document

> **Date**: 2026-03-07
> **Status**: Approved
> **Scope**: PhysicsWorld struct, tick loop integration, sync pre/post, command routing, despawn cleanup, velocity filtering, EntityHandle fluent API, WASM exports
> **Prerequisites**: Phase 15a complete (25 CommandTypes 17-41, dual WASM build, PendingRigidBody/PendingCollider types, producer methods)
> **Design doc parent**: `docs/plans/2026-03-07-phase15-physics-rapier2d-design.md`

---

## 1. Errata from Phase 15 Design Doc

The original design doc has known errors corrected by the spike and this design:

| Original Design Doc | Corrected (This Doc) |
|---|---|
| CommandType range 14-39 | 17-41 (14-16 occupied by SetRotation2D/SetTransparent/SetDepth) |
| `&gravity` (reference) | Use `&self.gravity` in call site — safe regardless of actual signature, aligns with official docs |
| `vector![].into()` / `point![].into()` | `Vec2::new(x, y)` everywhere — Rapier 0.32 accepts glam Vec2 directly |
| `wasm-bindgen` feature | Does not exist in rapier2d 0.32 — removed from Cargo.toml |
| `broad_phase.as_query_pipeline()` | Unverified — use persistent `QueryPipeline` with `.update()` (safe default, simplify in 15c if ephemeral API works) |
| `query_mut().without()` chaining | hecs does not support this — use `Without<Q, F>` type wrapper |
| `'fixed'` body type in TS API | `'static'` (industry convention: Box2D, Unity, Godot) |
| `physics: Option<PhysicsWorld>` | Direct `#[cfg]` field, no Option (compile-time invariant) |

---

## 2. PhysicsWorld Struct

```rust
#[cfg(feature = "physics-2d")]
pub struct PhysicsWorld {
    // Rapier core (12 step() params)
    pub gravity: glam::Vec2,
    pub integration_parameters: IntegrationParameters,
    pub physics_pipeline: PhysicsPipeline,
    pub island_manager: IslandManager,
    pub broad_phase: DefaultBroadPhase,
    pub narrow_phase: NarrowPhase,
    pub rigid_body_set: RigidBodySet,
    pub collider_set: ColliderSet,
    pub impulse_joint_set: ImpulseJointSet,
    pub multibody_joint_set: MultibodyJointSet,
    pub ccd_solver: CCDSolver,

    // Scene queries — persistent, .update() once per frame after last step
    pub query_pipeline: QueryPipeline,

    // Event collection (std::sync::mpsc — confirmed by spike)
    collision_send: Sender<CollisionEvent>,
    collision_recv: Receiver<CollisionEvent>,
    force_send: Sender<ContactForceEvent>,
    force_recv: Receiver<ContactForceEvent>,

    // Frame event buffers — cleared in engine_update(), accumulated across N ticks
    pub frame_collision_events: Vec<HyperionCollisionEvent>,
    pub frame_contact_force_events: Vec<HyperionContactForceEvent>,

    // Reverse map: ColliderHandle index -> external entity ID (for event translation)
    pub collider_to_entity: Vec<Option<u32>>,
}
```

### 2.1 Design Decisions

**Direct `#[cfg]` field on Engine, no `Option`** — The `physics-2d` feature is a compile-time invariant corresponding to the dual-WASM-build strategy. If you compile with `physics-2d`, you want physics; if not, use the standard binary. `Option` models a runtime optionality that does not exist in this design. A `PhysicsWorld` with empty Rapier sets (`Vec::new()`, `::default()`) has negligible cost.

**ECS components only for handles, no parallel map** — `PhysicsBodyHandle` and `PhysicsColliderHandle` are hecs components. Lookup via `world.get::<&PhysicsBodyHandle>(entity)` is O(1) in hecs (entity allocator -> archetype slot -> component storage). No parallel `Vec<Option<RigidBodyHandle>>` needed — it would duplicate entity_map indexing and create sync burden on despawn. The hot path (`physics_sync_post`) uses hecs query iteration, which is identical regardless of handle storage strategy.

**Persistent QueryPipeline** — The spike did not validate `broad_phase.as_query_pipeline()`. Using persistent `QueryPipeline` with `.update()` after the last step is the safe default. If a micro-spike in 15c reveals the ephemeral API works, the field is removed — a simplification, not a breaking change.

### 2.2 Initialization

Two-phase initialization:

1. `Engine::new()` creates `PhysicsWorld` with defaults (gravity=`(0, 980)`, `length_unit=100.0`)
2. TypeScript calls `engine_physics_configure(gx, gy, ppm)` after `engine_init()`

Separate WASM export avoids `#[cfg]` on `wasm_bindgen` function parameters (which may not behave correctly):

```rust
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_configure(gravity_x: f32, gravity_y: f32, pixels_per_meter: f32) {
    // SAFETY: wasm32 is single-threaded
    unsafe {
        let engine = ENGINE.as_mut().unwrap();
        engine.physics.gravity = glam::Vec2::new(gravity_x, gravity_y);
        engine.physics.integration_parameters.length_unit = pixels_per_meter;
    }
}
```

### 2.3 Engine Struct

```rust
pub struct Engine {
    pub world: World,
    pub entity_map: EntityMap,
    pub render_state: RenderState,
    accumulator: f32,
    tick_count: u64,
    listener_pos: [f32; 3],
    listener_prev_pos: [f32; 3],
    listener_vel: [f32; 3],

    #[cfg(feature = "physics-2d")]
    pub physics: PhysicsWorld,
}
```

---

## 3. Tick Loop Integration

### 3.1 Updated `Engine::update()`

```rust
pub fn update(&mut self, dt: f32) {
    // 0. Clear per-frame event buffers
    #[cfg(feature = "physics-2d")]
    {
        self.physics.frame_collision_events.clear();
        self.physics.frame_contact_force_events.clear();
    }

    // 1. Process ring buffer commands (BEFORE tick loop)
    //    Inserts PendingRigidBody/PendingCollider, modifies pending overrides,
    //    handles despawn cleanup
    process_commands(
        commands,
        &mut self.world,
        &mut self.entity_map,
        &mut self.render_state,
    );
    #[cfg(feature = "physics-2d")]
    process_physics_commands(
        commands,
        &mut self.world,
        &self.entity_map,
        &mut self.physics,
    );

    // 2. Accumulate time, cap spiral of death
    self.accumulator += dt;
    if self.accumulator > FIXED_DT * 10.0 {
        self.accumulator = FIXED_DT * 10.0;
    }

    // 3. Fixed-timestep loop
    while self.accumulator >= FIXED_DT {
        self.fixed_tick();
        self.accumulator -= FIXED_DT;
        self.tick_count += 1;
    }

    // 4. Physics post-loop (once per frame)
    #[cfg(feature = "physics-2d")]
    {
        physics_sync_post(&mut self.world, &self.physics);
        self.physics.query_pipeline.update(
            &self.physics.rigid_body_set,
            &self.physics.collider_set,
        );
    }

    // 5. Transforms (once per frame — unchanged)
    transform_system(&mut self.world);
    transform_system_2d(&mut self.world);
    {
        let ext_to_entity: HashMap<u32, hecs::Entity> =
            self.entity_map.iter_mapped().collect();
        propagate_transforms(&mut self.world, &ext_to_entity);
    }

    // 6. Dirty marking + collect (unchanged)
    self.mark_post_system_dirty();
    self.render_state.collect(&self.world);
    self.render_state.collect_and_cache_dirty(&self.world);
}
```

### 3.2 Updated `fixed_tick()`

```rust
fn fixed_tick(&mut self) {
    // Physics block (contiguous)
    #[cfg(feature = "physics-2d")]
    {
        physics_sync_pre(&mut self.world, &mut self.physics, &self.entity_map);
        self.physics.step();
    }

    // Non-physics velocity integration
    #[cfg(feature = "physics-2d")]
    {
        velocity_system_filtered(&mut self.world, FIXED_DT);
        velocity_system_2d_filtered(&mut self.world, FIXED_DT);
    }
    #[cfg(not(feature = "physics-2d"))]
    {
        velocity_system(&mut self.world, FIXED_DT);
        velocity_system_2d(&mut self.world, FIXED_DT);
    }

    // Listener extrapolation (unchanged)
    for (pos, &vel) in self.listener_pos.iter_mut().zip(self.listener_vel.iter()) {
        *pos += vel * FIXED_DT;
    }
}
```

### 3.3 Design Rationale: Split Tick Loop

**`physics_sync_pre` + `step()` run per-tick** (inside `fixed_tick`):
- Rapier step must run at fixed timestep for deterministic simulation
- `physics_sync_pre` consumes `PendingRigidBody`/`PendingCollider` (only meaningful on first tick, no-op on subsequent ticks — query returns empty)
- `physics_sync_pre` syncs kinematic body targets from ECS positions (same target every tick since `process_commands` runs once before the loop)

**`physics_sync_post` runs once per frame** (after tick loop):
- Rapier is self-sufficient between steps — its internal `rigid_body_set` feeds the next step directly
- ECS positions are only needed for rendering (final frame state) and TypeScript game logic (post-update)
- No game logic runs between fixed ticks, so intermediate ECS positions are never read

**Cost savings** (at N=3 ticks, 1000 physics bodies, 10k total entities):
- `physics_sync_post`: 2000 writes eliminated (2× per body × 2 ticks saved)
- `transform_system`: 20k Mat4 operations eliminated (10k entities × 2 ticks saved)

**Documented invariant**: Children of physics parents in the scene graph see only the final frame position (not per-tick intermediate states). Rendering uses final state — visually identical to per-tick propagation.

---

## 4. physics_sync_pre

Runs per-tick inside `fixed_tick()`. Three responsibilities:

### 4.1 Consume PendingRigidBody -> Rapier Body

```rust
#[cfg(feature = "physics-2d")]
fn physics_sync_pre(world: &mut World, physics: &mut PhysicsWorld, entity_map: &EntityMap) {
    let mut cmd = hecs::CommandBuffer::new();

    // Pass 1: Consume PendingRigidBody (query includes position for initial translation)
    for (entity, (pending, t2d, pos)) in world.query_mut::<(
        hecs::Entity,
        (&PendingRigidBody, Option<&Transform2D>, Option<&Position>),
    )>() {
        let translation = match (t2d, pos) {
            (Some(t), _) => Vec2::new(t.x, t.y),
            (_, Some(p)) => Vec2::new(p.0.x, p.0.y),
            _ => Vec2::ZERO,
        };

        let rb = match pending.body_type {
            0 => RigidBodyBuilder::dynamic(),
            1 => RigidBodyBuilder::fixed(),
            2 => RigidBodyBuilder::kinematic_position_based(),
            _ => continue,
        }
        .translation(translation)
        .gravity_scale(pending.gravity_scale)
        .linear_damping(pending.linear_damping)
        .angular_damping(pending.angular_damping)
        .ccd_enabled(pending.ccd_enabled)
        .build();

        let handle = physics.rigid_body_set.insert(rb);

        // Deferred mutations (can't mutate world during query_mut)
        cmd.insert(entity, (PhysicsBodyHandle(handle), PhysicsControlled));
        cmd.remove::<(PendingRigidBody,)>(entity);
    }

    cmd.run_on(world);

    // Pass 2: Consume PendingCollider (separate pass — entities now have PhysicsBodyHandle)
    let mut cmd2 = hecs::CommandBuffer::new();

    for (entity, (pending, body_handle)) in world.query_mut::<(
        hecs::Entity,
        (&PendingCollider, &PhysicsBodyHandle),
    )>() {
        if let Some(builder) = build_collider_shape(pending) {
            let collider = builder.build();
            let col_handle = physics.collider_set.insert_with_parent(
                collider,
                body_handle.0,
                &mut physics.rigid_body_set,
            );

            // Reverse map for event translation
            let idx = col_handle.0.into_raw_parts().0 as usize;
            if idx >= physics.collider_to_entity.len() {
                physics.collider_to_entity.resize(idx + 1, None);
            }
            if let Ok(ext_id) = world.get::<&ExternalId>(entity) {
                physics.collider_to_entity[idx] = Some(ext_id.0);
            }

            cmd2.insert_one(entity, PhysicsColliderHandle(col_handle));
            cmd2.remove::<(PendingCollider,)>(entity);
        }
    }

    cmd2.run_on(world);

    // Pass 3: Kinematic body sync — ECS position -> set_next_kinematic_translation
    for (t2d, handle) in world.query_mut::<(&Transform2D, &PhysicsBodyHandle)>() {
        let body = &mut physics.rigid_body_set[handle.0];
        if body.body_type() == RigidBodyType::KinematicPositionBased {
            body.set_next_kinematic_translation(Vec2::new(t2d.x, t2d.y));
        }
    }
    // Equivalent for 3D entities:
    for (pos, handle) in world.query_mut::<(&Position, &PhysicsBodyHandle)>() {
        let body = &mut physics.rigid_body_set[handle.0];
        if body.body_type() == RigidBodyType::KinematicPositionBased {
            body.set_next_kinematic_translation(Vec2::new(pos.0.x, pos.0.y));
        }
    }
}
```

### 4.2 ColliderHandle Index Extraction

The pattern `col_handle.0.into_raw_parts().0` extracts the raw index from Rapier's generational arena handle. **This is not verified by the spike** — add to 15c micro-spike checklist. If the API differs, use whatever index accessor `ColliderHandle` exposes (possibly `.index()` or `.0`).

### 4.3 Shape Dispatch

```rust
fn build_collider_shape(pending: &PendingCollider) -> Option<ColliderBuilder> {
    let p = &pending.shape_params;
    let builder = match pending.shape_type {
        0 => ColliderBuilder::ball(p[0]),                        // circle: radius
        1 => ColliderBuilder::cuboid(p[0] / 2.0, p[1] / 2.0),   // box: half-extents from full size
        2 => ColliderBuilder::capsule_y(p[0], p[1]),             // capsule: half_height, radius
        _ => return None,
    };
    // NOTE: cuboid takes half-extents but TS API uses full { width, height }.
    // Division by 2 happens here to keep the TS API intuitive.

    let mut builder = builder
        .density(pending.density)
        .restitution(pending.restitution)
        .friction(pending.friction)
        .sensor(pending.is_sensor)
        .collision_groups(InteractionGroups::new(
            Group::from_bits_truncate(pending.groups & 0xFFFF),   // membership (low 16 bits)
            Group::from_bits_truncate(pending.groups >> 16),       // filter (high 16 bits)
        ));
    // NOTE: Group::from_bits_truncate takes u32, not u16.
    // Packing membership=low16, filter=high16 limits to 16 groups (sufficient for 95%+ 2D cases).
    // Full 32-group support would require two separate commands in a future milestone.

    // ActiveEvents from bitfield
    let mut events = ActiveEvents::empty();
    if pending.active_events & 0x01 != 0 {
        events |= ActiveEvents::COLLISION_EVENTS;
    }
    if pending.active_events & 0x02 != 0 {
        events |= ActiveEvents::CONTACT_FORCE_EVENTS;
    }
    if events != ActiveEvents::empty() {
        builder = builder.active_events(events);
    }

    Some(builder)
}
```

Segment and Triangle shapes deferred to 15d (segment needs 2-command pattern due to 16-byte payload limit).

---

## 5. physics_sync_post

Runs once per frame after the tick loop. Writes final Rapier state back to ECS.

```rust
#[cfg(feature = "physics-2d")]
fn physics_sync_post(world: &mut World, physics: &PhysicsWorld) {
    // Path 2D: Transform2D entities
    for (t2d, handle) in world.query_mut::<(&mut Transform2D, &PhysicsBodyHandle)>() {
        let body = &physics.rigid_body_set[handle.0];
        if body.is_sleeping() { continue; }
        let pos = body.translation();       // &Vec2 (glam)
        t2d.x = pos.x;
        t2d.y = pos.y;
        t2d.rot = body.rotation().angle();  // Rot2 -> f32
    }

    // Path 3D: Position + Rotation entities
    for (pos, rot, handle) in
        world.query_mut::<(&mut Position, &mut Rotation, &PhysicsBodyHandle)>()
    {
        let body = &physics.rigid_body_set[handle.0];
        if body.is_sleeping() { continue; }
        let t = body.translation();
        pos.0.x = t.x;
        pos.0.y = t.y;
        rot.0 = glam::Quat::from_rotation_z(body.rotation().angle());
    }
}
```

**Future optimization**: Collect dirty slots during `physics_sync_post` (entities where `!body.is_sleeping()`) and pass to `mark_post_system_dirty`, avoiding the redundant query in pass 3.

---

## 6. PhysicsWorld::step()

```rust
pub fn step(&mut self) {
    // ChannelEventCollector is ephemeral — created per step, costs an Arc::clone per Sender
    let event_handler = ChannelEventCollector::new(
        self.collision_send.clone(),
        self.force_send.clone(),
    );

    self.physics_pipeline.step(
        &self.gravity,
        &self.integration_parameters,
        &mut self.island_manager,
        &mut self.broad_phase,
        &mut self.narrow_phase,
        &mut self.rigid_body_set,
        &mut self.collider_set,
        &mut self.impulse_joint_set,
        &mut self.multibody_joint_set,
        &mut self.ccd_solver,
        &(),              // PhysicsHooks — none for now
        &event_handler,
    );

    // Accumulative drain — NO clear here (that's in engine_update, before tick loop)
    while let Ok(event) = self.collision_recv.try_recv() {
        self.translate_and_push_collision(event);
    }
    while let Ok(event) = self.force_recv.try_recv() {
        self.translate_and_push_contact_force(event);
    }
}
```

Event drain accumulates across N fixed ticks. The event ordering in the buffer is chronologically correct (tick 1 events, then tick 2 events, etc.).

---

## 7. Command Routing — Two-Pass Architecture

### 7.1 Design Decision

The existing `process_commands` function (4-param signature) is **unchanged**. Physics command routing uses a separate `process_physics_commands` function called after `process_commands` in `Engine::update()`. This avoids:

- Duplicating the entire 15+ match-arm function body
- Modifying a working function with zero risk of regression
- Adding `PhysicsWorld` as a parameter to the non-physics build

The second pass over ~100-1000 commands per frame is negligible: the array is in L1 cache from the first pass, and branch prediction on the `_ => {}` default arm is perfect after a few frames.

### 7.2 process_commands — Pending-Stage Physics Commands

Added match arms in existing `process_commands` for physics commands that only modify ECS components (no `PhysicsWorld` access needed):

```rust
// In process_commands (existing function, new match arms):
#[cfg(feature = "physics-2d")]
CommandType::CreateRigidBody => {
    let body_type = cmd.payload[0];
    let _ = world.insert_one(entity, PendingRigidBody::new(body_type));
}

#[cfg(feature = "physics-2d")]
CommandType::CreateCollider => {
    let pending = PendingCollider::from_payload(&cmd.payload);
    let _ = world.insert_one(entity, pending);
}

#[cfg(feature = "physics-2d")]
CommandType::SetGravityScale => {
    let value = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    if let Ok(mut pending) = world.get::<&mut PendingRigidBody>(entity) {
        pending.gravity_scale = value;
    }
    // Live body case handled by process_physics_commands
}

// Similar pattern for SetLinearDamping (pending path)
// Similar pattern for collider override commands on PendingCollider
```

### 7.3 process_physics_commands — Live-Body Commands

```rust
#[cfg(feature = "physics-2d")]
pub fn process_physics_commands(
    commands: &[Command],
    world: &mut World,
    entity_map: &EntityMap,
    physics: &mut PhysicsWorld,
) {
    for cmd in commands {
        let entity = match entity_map.get(cmd.entity_id) {
            Some(e) => e,
            None => continue,
        };

        match cmd.cmd_type {
            CommandType::SetGravityScale => {
                let value = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                if let Ok(handle) = world.get::<&PhysicsBodyHandle>(entity) {
                    if let Some(rb) = physics.rigid_body_set.get_mut(handle.0) {
                        rb.set_gravity_scale(value, true);
                    }
                }
            }
            CommandType::ApplyForce => {
                let fx = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let fy = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                if let Ok(handle) = world.get::<&PhysicsBodyHandle>(entity) {
                    if let Some(rb) = physics.rigid_body_set.get_mut(handle.0) {
                        rb.add_force(Vec2::new(fx, fy), true);
                    }
                }
            }
            CommandType::ApplyImpulse => {
                let ix = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let iy = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                if let Ok(handle) = world.get::<&PhysicsBodyHandle>(entity) {
                    if let Some(rb) = physics.rigid_body_set.get_mut(handle.0) {
                        rb.apply_impulse(Vec2::new(ix, iy), true);
                    }
                }
            }
            // ... other live-body commands (SetLinearDamping, ApplyTorque, etc.)
            _ => {} // non-physics commands ignored
        }
    }
}
```

The two-pass order guarantees correctness: pending overrides (pass 1) are applied before `physics_sync_pre` creates the body. Live-body commands (pass 2) are no-ops if the entity only has `PendingRigidBody` (no `PhysicsBodyHandle` yet).

---

## 8. Despawn Cleanup

Before `world.despawn(entity)` in the `DespawnEntity` handler of `process_commands`:

```rust
CommandType::DespawnEntity => {
    if let Some(entity) = entity_map.get(cmd.entity_id) {
        // Physics cleanup: remove Rapier body (cascades to colliders + joints)
        #[cfg(feature = "physics-2d")]
        if let Ok(handle) = world.get::<&PhysicsBodyHandle>(entity) {
            // Clear reverse map BEFORE Rapier removes colliders
            let body = &physics.rigid_body_set[handle.0];
            for &collider_handle in body.colliders() {
                // ColliderHandle index extraction — verify in 15c micro-spike
                let idx = collider_handle.0.into_raw_parts().0 as usize;
                if idx < physics.collider_to_entity.len() {
                    physics.collider_to_entity[idx] = None;
                }
            }
            // Remove body — Rapier cascades to colliders and joints
            physics.rigid_body_set.remove(
                handle.0,
                &mut physics.island_manager,
                &mut physics.collider_set,
                &mut physics.impulse_joint_set,
                &mut physics.multibody_joint_set,
                true, // wake_up touching bodies
            );
        }

        // Clean up pending components (entity despawned before reaching Rapier)
        #[cfg(feature = "physics-2d")]
        {
            let _ = world.remove_one::<PendingRigidBody>(entity);
            let _ = world.remove_one::<PendingCollider>(entity);
        }

        // Existing: despawn from ECS, render_state cleanup, entity_map removal
        // ...
    }
}
```

**Note**: Despawn cleanup in `process_commands` needs `&mut PhysicsWorld`. This is the ONE exception to the "two-pass" architecture — it runs in pass 1 because it must happen BEFORE `world.despawn()`. The `process_commands` function signature gains a conditional physics parameter for this:

```rust
#[cfg(feature = "physics-2d")]
pub fn process_commands(
    commands: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
    physics: &mut PhysicsWorld,  // needed for despawn cleanup only
) { ... }

#[cfg(not(feature = "physics-2d"))]
pub fn process_commands(
    commands: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
) { ... }
```

Alternatively, despawn cleanup can be extracted to a helper called from `Engine::process_commands` before delegating to the module-level function. This avoids `#[cfg]` on the signature.

**Explicit cleanup over lazy** — ColliderHandle uses a generational arena. A recycled handle pointing to `collider_to_entity[idx]` with a stale entity ID would silently map events to the wrong entity. Explicit `None` on despawn prevents this.

---

## 9. Velocity System Filtering

Two new system variants using `hecs::Without<Q, F>` type wrapper (compile-time archetype matching, no dynamic borrow overhead):

```rust
// systems.rs

#[cfg(feature = "physics-2d")]
pub fn velocity_system_filtered(world: &mut World, dt: f32) {
    for (pos, vel) in world.query_mut::<Without<(&mut Position, &Velocity), &PhysicsControlled>>()
    {
        pos.0 += vel.0 * dt;
    }
}

#[cfg(feature = "physics-2d")]
pub fn velocity_system_2d_filtered(world: &mut World, dt: f32) {
    for (t2d, vel) in world.query_mut::<Without<(&mut Transform2D, &Velocity), &PhysicsControlled>>()
    {
        t2d.x += vel.0.x * dt;
        t2d.y += vel.0.y * dt;
    }
}
```

The existing `velocity_system` and `velocity_system_2d` remain untouched. `fixed_tick()` selects via `#[cfg]`:

```rust
#[cfg(feature = "physics-2d")]
{
    velocity_system_filtered(&mut self.world, FIXED_DT);
    velocity_system_2d_filtered(&mut self.world, FIXED_DT);
}
#[cfg(not(feature = "physics-2d"))]
{
    velocity_system(&mut self.world, FIXED_DT);
    velocity_system_2d(&mut self.world, FIXED_DT);
}
```

**PhysicsControlled and velocity_system operate on disjoint entity sets** — velocity_system skips entities with `PhysicsControlled`, and only physics entities have `PhysicsControlled`. The ordering between `physics_sync_pre`/`step` and `velocity_system` inside `fixed_tick` is irrelevant, but kept contiguous for readability (physics block first, then velocity).

---

## 10. mark_post_system_dirty Extension

```rust
fn mark_post_system_dirty(&mut self) {
    // Existing pass 1: velocity-driven entities (non-zero Velocity → transform+bounds dirty)
    // Existing pass 2: children of dirty parents (single-level propagation)

    // NEW pass 3: physics-controlled non-sleeping bodies
    #[cfg(feature = "physics-2d")]
    for (entity, handle, _controlled) in
        self.world.query::<(hecs::Entity, &PhysicsBodyHandle, &PhysicsControlled)>().iter()
    {
        if !self.physics.rigid_body_set[handle.0].is_sleeping() {
            if let Some(slot) = self.render_state.get_slot(entity) {
                self.render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                self.render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
            }
        }
    }
}
```

---

## 11. Updated PendingCollider

```rust
#[cfg(feature = "physics-2d")]
pub struct PendingCollider {
    pub shape_type: u8,          // 0=circle, 1=box, 2=capsule
    pub shape_params: [f32; 4],  // shape-dependent
    pub density: f32,            // default 1.0
    pub restitution: f32,        // default 0.0
    pub friction: f32,           // default 0.5
    pub is_sensor: bool,         // default false
    pub groups: u32,             // default 0xFFFF_FFFF (all groups)
    pub active_events: u8,       // bit 0=COLLISION_EVENTS, bit 1=CONTACT_FORCE_EVENTS
}
```

**ActiveEvents requirement**: Rapier only generates collision events if at least one collider in the pair has `ActiveEvents::COLLISION_EVENTS`. Without this flag, the mpsc channels stay empty — silent failure.

**Sensor auto-enables collision events** (TypeScript side): A sensor without events is almost always a bug. The TS facade sets `active_events |= 0x01` automatically when `sensor: true`. Contact force events are opt-in via `contactForceEvents: true`.

---

## 12. EntityHandle Fluent API (15b Minimal Surface)

```typescript
// Body creation
rigidBody(type: 'dynamic' | 'static' | 'kinematic'): this

// Collider creation (3 shapes)
collider(shape: 'circle', opts: { radius: number }): this
collider(shape: 'box', opts: { width: number; height: number }): this
collider(shape: 'capsule', opts: { halfHeight: number; radius: number }): this

// Body properties
gravityScale(scale: number): this
linearDamping(damping: number): this

// Forces (runtime, non-coalescable)
applyForce(fx: number, fy: number): this
applyImpulse(ix: number, iy: number): this
```

**Deferred to later milestones:**
- 15d: Joints (revolute, prismatic, fixed, rope, motor, limits), segment/triangle shapes
- 15e: Character controller (moveCharacter, characterConfig)
- Future: destroyRigidBody, destroyCollider, angularDamping, ccdEnabled, colliderDensity, colliderRestitution, colliderFriction, collisionGroups, applyTorque, colliderSensor

**Type mapping**: `'dynamic'→0, 'static'→1, 'kinematic'→2`

**Multi-command pattern**: `.rigidBody('dynamic').gravityScale(1.0).linearDamping(0.5)` generates 3 ring buffer commands (1B + 4B + 4B). The ring buffer uses 1-5% of capacity at 10k entities — cost is negligible.

Example:
```typescript
const player = engine.spawn()
  .position(100, 200, 0)
  .rigidBody('dynamic')
  .gravityScale(1.0)
  .linearDamping(0.5)
  .collider('box', { width: 32, height: 48 });

// Runtime:
player.applyForce(0, -500);
```

---

## 13. WASM Exports (15b)

```rust
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_configure(gravity_x: f32, gravity_y: f32, pixels_per_meter: f32)

#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_body_count() -> u32  // active rigid body count
```

Event exports, scene query exports, and debug rendering exports deferred to 15c/15f.

---

## 14. Test Strategy

| Area | Rust tests | TS tests |
|------|-----------|----------|
| PhysicsWorld::new() + defaults | 2 | — |
| PhysicsWorld::step() runs without panic | 1 | — |
| physics_sync_pre consumes Pending -> Rapier body | 3 (dynamic, fixed, kinematic) | — |
| physics_sync_pre consumes PendingCollider (3 shapes) | 3 | — |
| physics_sync_post writes back Transform2D | 2 (awake, sleeping skip) | — |
| physics_sync_post writes back Position+Rotation | 2 | — |
| process_commands CreateRigidBody inserts Pending | 1 | — |
| process_physics_commands ApplyForce on live body | 1 | — |
| velocity_system_filtered skips PhysicsControlled | 2 | — |
| Despawn cleanup removes Rapier body | 2 | — |
| mark_post_system_dirty marks non-sleeping | 1 | — |
| engine_physics_configure WASM export | 1 | — |
| Ball falls under gravity (E2E) | 1 | — |
| EntityHandle .rigidBody() + .collider() | — | 3 |
| EntityHandle .applyForce() serialization | — | 2 |
| EntityHandle .gravityScale() serialization | — | 1 |
| Sensor auto-enables collision events | — | 1 |
| **Total** | **~22** | **~7** |

---

## 15. Files Touched

| File | Change |
|------|--------|
| `crates/hyperion-core/src/physics.rs` | Expand: PhysicsWorld struct, step(), physics_sync_pre, physics_sync_post, shape dispatch |
| `crates/hyperion-core/src/engine.rs` | Modify: Engine struct + update() + fixed_tick() + mark_post_system_dirty() |
| `crates/hyperion-core/src/systems.rs` | Add: velocity_system_filtered, velocity_system_2d_filtered |
| `crates/hyperion-core/src/command_processor.rs` | Modify: add pending-stage physics match arms + despawn cleanup |
| `crates/hyperion-core/src/physics_commands.rs` | Create: process_physics_commands (live-body command routing) |
| `crates/hyperion-core/src/lib.rs` | Add: engine_physics_configure WASM export, mod physics_commands |
| `ts/src/entity-handle.ts` | Add: physics fluent methods (minimal set) |
| `ts/src/entity-handle.test.ts` | Add: physics method tests |

---

## 16. Micro-Spike Checklist (for 15c)

Before starting 15c, validate:

1. `ColliderHandle` index extraction: `col_handle.0.into_raw_parts().0` compiles and returns correct index
2. `QueryPipeline::update()` API: verify exact parameter list for rapier2d 0.32
3. `broad_phase.as_query_pipeline()`: does it exist? If yes, eliminate persistent QueryPipeline field
4. `InteractionGroups::new()` parameter types: confirm both args are `Group` (u32 bitflags)

---

## 17. Decision Summary

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `#[cfg]` direct field on Engine, no Option | Compile-time invariant, zero Option noise |
| 2 | `engine_physics_configure()` separate WASM export | Avoids `#[cfg]` on wasm_bindgen params |
| 3 | ECS components only for handles | O(1) hecs lookup, no sync burden |
| 4 | PreparedQuery for sync_post (future opt) | Caches archetype resolution per-frame |
| 5 | Split tick loop: per-tick + once-per-frame | 2N fewer transform_system calls |
| 6 | Event clear in engine_update() | Accumulative drain across N ticks |
| 7 | Persistent QueryPipeline | Safe default, simplify in 15c |
| 8 | Two-pass command routing | Zero modification to existing process_commands |
| 9 | `hecs::Without<Q, F>` type wrapper | Compile-time archetype matching |
| 10 | `'static'` in TS API | Industry convention |
| 11 | ActiveEvents on PendingCollider | Required for event generation |
| 12 | `&self.gravity` in step() | Safe regardless of actual signature |
| 13 | Minimal API surface for 15b | Joints→15d, character→15e |
| 14 | `Vec2::new()` everywhere | No nalgebra macros in Hyperion code |
| 15 | Explicit collider_to_entity cleanup | Prevents stale-handle-recycling bugs |

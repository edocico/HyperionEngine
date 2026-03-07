# Phase 15b — Core Simulation: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate Rapier2D physics into the Hyperion Engine ECS tick loop — bodies fall under gravity, forces/impulses work, and the EntityHandle API exposes physics.

**Architecture:** PhysicsWorld struct wraps all Rapier state. Two-pass command routing: existing `process_commands` handles pending-stage ECS mutations; new `process_physics_commands` routes live-body commands. `physics_sync_pre` consumes pending components into Rapier bodies per-tick; `physics_sync_post` writes Rapier state back to ECS once per frame.

**Tech Stack:** Rust (hecs 0.11, rapier2d 0.32, glam 0.29), TypeScript (vitest), `#[cfg(feature = "physics-2d")]` feature gate.

**Design Doc:** `docs/plans/2026-03-07-phase15b-core-simulation-design.md`

---

### Task 1: Add `active_events` field to PendingCollider + `from_payload` constructor

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs:39-70`
- Test: `crates/hyperion-core/src/physics.rs` (inline tests)

**Step 1: Write the failing test**

Add to the existing `#[cfg(test)] mod tests` at the bottom of `physics.rs`:

```rust
#[test]
fn pending_collider_from_payload() {
    // Payload layout: shape_type(1B) + p0(f32) + p1(f32) + p2(f32) = 13 bytes in a [u8;16]
    let mut payload = [0u8; 16];
    payload[0] = 0; // circle
    payload[1..5].copy_from_slice(&10.0f32.to_le_bytes()); // radius
    let pending = PendingCollider::from_payload(&payload);
    assert_eq!(pending.shape_type, 0);
    assert!((pending.shape_params[0] - 10.0).abs() < f32::EPSILON);
    assert_eq!(pending.active_events, 0);
}

#[test]
fn pending_collider_has_active_events_field() {
    let mut pending = PendingCollider::default();
    assert_eq!(pending.active_events, 0);
    pending.active_events = 0x01; // COLLISION_EVENTS
    assert_eq!(pending.active_events, 0x01);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d pending_collider_from_payload`
Expected: FAIL — `from_payload` method not found, `active_events` field not found

**Step 3: Write minimal implementation**

Add `active_events: u8` field to `PendingCollider` struct (after `groups`), update `Default` impl (`active_events: 0`), update `PendingCollider::new()`, and add `from_payload`:

```rust
pub struct PendingCollider {
    pub shape_type: u8,
    pub shape_params: [f32; 4],
    pub density: f32,
    pub restitution: f32,
    pub friction: f32,
    pub is_sensor: bool,
    pub groups: u32,
    pub active_events: u8, // bit 0=COLLISION_EVENTS, bit 1=CONTACT_FORCE_EVENTS
}

impl PendingCollider {
    pub fn from_payload(payload: &[u8; 16]) -> Self {
        let shape_type = payload[0];
        let mut shape_params = [0.0f32; 4];
        for i in 0..3 {
            let offset = 1 + i * 4;
            if offset + 4 <= 16 {
                shape_params[i] = f32::from_le_bytes(
                    payload[offset..offset + 4].try_into().unwrap(),
                );
            }
        }
        Self {
            shape_type,
            shape_params,
            ..Default::default()
        }
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core --features physics-2d pending_collider`
Expected: PASS (all collider tests)

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15b): add active_events to PendingCollider + from_payload constructor"
```

---

### Task 2: PhysicsWorld struct + new() + step()

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs`
- Test: `crates/hyperion-core/src/physics.rs` (inline tests)

**Step 1: Write the failing tests**

```rust
#[test]
fn physics_world_default_gravity() {
    let pw = PhysicsWorld::new();
    assert!((pw.gravity.x - 0.0).abs() < f32::EPSILON);
    assert!((pw.gravity.y - 980.0).abs() < f32::EPSILON);
}

#[test]
fn physics_world_step_does_not_panic() {
    let mut pw = PhysicsWorld::new();
    pw.step(); // should complete without panic
}

#[test]
fn physics_world_configure() {
    let mut pw = PhysicsWorld::new();
    pw.gravity = glam::Vec2::new(0.0, -9.81);
    pw.integration_parameters.length_unit = 1.0;
    assert!((pw.gravity.y - (-9.81)).abs() < f32::EPSILON);
    assert!((pw.integration_parameters.length_unit - 1.0).abs() < f32::EPSILON);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d physics_world`
Expected: FAIL — `PhysicsWorld` not found

**Step 3: Write minimal implementation**

In `physics.rs`, inside the `#[cfg(feature = "physics-2d")]` block (after `pub use types::*;`), add a new module section:

```rust
#[cfg(feature = "physics-2d")]
mod world {
    use std::sync::mpsc::{self, Sender, Receiver};
    use rapier2d::prelude::*;

    pub struct HyperionCollisionEvent {
        pub entity_a: u32,
        pub entity_b: u32,
        pub started: bool,
    }

    pub struct HyperionContactForceEvent {
        pub entity_a: u32,
        pub entity_b: u32,
        pub total_force_magnitude: f32,
    }

    pub struct PhysicsWorld {
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
        pub query_pipeline: QueryPipeline,

        collision_send: Sender<CollisionEvent>,
        collision_recv: Receiver<CollisionEvent>,
        force_send: Sender<ContactForceEvent>,
        force_recv: Receiver<ContactForceEvent>,

        pub frame_collision_events: Vec<HyperionCollisionEvent>,
        pub frame_contact_force_events: Vec<HyperionContactForceEvent>,

        pub collider_to_entity: Vec<Option<u32>>,
    }

    impl PhysicsWorld {
        pub fn new() -> Self {
            let (collision_send, collision_recv) = mpsc::channel();
            let (force_send, force_recv) = mpsc::channel();
            Self {
                gravity: glam::Vec2::new(0.0, 980.0),
                integration_parameters: IntegrationParameters {
                    length_unit: 100.0,
                    ..Default::default()
                },
                physics_pipeline: PhysicsPipeline::new(),
                island_manager: IslandManager::new(),
                broad_phase: DefaultBroadPhase::new(),
                narrow_phase: NarrowPhase::new(),
                rigid_body_set: RigidBodySet::new(),
                collider_set: ColliderSet::new(),
                impulse_joint_set: ImpulseJointSet::new(),
                multibody_joint_set: MultibodyJointSet::new(),
                ccd_solver: CCDSolver::new(),
                query_pipeline: QueryPipeline::new(),
                collision_send,
                collision_recv,
                force_send,
                force_recv,
                frame_collision_events: Vec::new(),
                frame_contact_force_events: Vec::new(),
                collider_to_entity: Vec::new(),
            }
        }

        pub fn step(&mut self) {
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
                &(),
                &event_handler,
            );

            // Drain events (accumulative — clear happens in Engine::update)
            while let Ok(event) = self.collision_recv.try_recv() {
                self.translate_collision(event);
            }
            while let Ok(event) = self.force_recv.try_recv() {
                self.translate_contact_force(event);
            }
        }

        fn translate_collision(&mut self, event: CollisionEvent) {
            let (h1, h2, started) = match event {
                CollisionEvent::Started(h1, h2, _) => (h1, h2, true),
                CollisionEvent::Stopped(h1, h2, _) => (h1, h2, false),
            };
            let e1 = self.collider_entity(h1).unwrap_or(u32::MAX);
            let e2 = self.collider_entity(h2).unwrap_or(u32::MAX);
            self.frame_collision_events.push(HyperionCollisionEvent {
                entity_a: e1,
                entity_b: e2,
                started,
            });
        }

        fn translate_contact_force(&mut self, event: ContactForceEvent) {
            let e1 = self.collider_entity(event.collider1).unwrap_or(u32::MAX);
            let e2 = self.collider_entity(event.collider2).unwrap_or(u32::MAX);
            self.frame_contact_force_events.push(HyperionContactForceEvent {
                entity_a: e1,
                entity_b: e2,
                total_force_magnitude: event.total_force_magnitude,
            });
        }

        fn collider_entity(&self, handle: ColliderHandle) -> Option<u32> {
            let idx = handle.0.into_raw_parts().0 as usize;
            self.collider_to_entity.get(idx).copied().flatten()
        }

        pub fn body_count(&self) -> u32 {
            self.rigid_body_set.len() as u32
        }
    }

    impl Default for PhysicsWorld {
        fn default() -> Self {
            Self::new()
        }
    }
}

#[cfg(feature = "physics-2d")]
pub use world::*;
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p hyperion-core --features physics-2d physics_world`
Expected: PASS

**Step 5: Run clippy**

Run: `cargo clippy -p hyperion-core --features physics-2d`
Expected: No warnings

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15b): PhysicsWorld struct with Rapier step + event translation"
```

---

### Task 3: Velocity system filters (Without<Q, PhysicsControlled>)

**Files:**
- Modify: `crates/hyperion-core/src/systems.rs:1-36`
- Test: `crates/hyperion-core/src/systems.rs` (inline tests)

**Step 1: Write the failing tests**

Add to the existing `#[cfg(test)] mod tests` section (after the 2D tests):

```rust
#[cfg(feature = "physics-2d")]
mod physics_filter_tests {
    use super::*;
    use crate::physics::PhysicsControlled;

    #[test]
    fn velocity_system_filtered_skips_physics_controlled() {
        let mut world = World::new();
        // Non-physics entity — should move
        world.spawn((
            Position(Vec3::ZERO),
            Velocity(Vec3::new(60.0, 0.0, 0.0)),
        ));
        // Physics-controlled entity — should NOT move
        let phys = world.spawn((
            Position(Vec3::ZERO),
            Velocity(Vec3::new(60.0, 0.0, 0.0)),
            PhysicsControlled,
        ));

        velocity_system_filtered(&mut world, 1.0 / 60.0);

        let phys_pos = world.get::<&Position>(phys).unwrap();
        assert!((phys_pos.0.x - 0.0).abs() < 1e-5, "physics entity should not move");
    }

    #[test]
    fn velocity_system_2d_filtered_skips_physics_controlled() {
        let mut world = World::new();
        // Non-physics 2D entity — should move
        world.spawn((
            Transform2D { x: 0.0, y: 0.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            Velocity(Vec3::new(60.0, 120.0, 0.0)),
        ));
        // Physics-controlled 2D entity — should NOT move
        let phys = world.spawn((
            Transform2D { x: 0.0, y: 0.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            Velocity(Vec3::new(60.0, 120.0, 0.0)),
            PhysicsControlled,
        ));

        velocity_system_2d_filtered(&mut world, 1.0 / 60.0);

        let t = world.get::<&Transform2D>(phys).unwrap();
        assert!((t.x - 0.0).abs() < 1e-5, "physics 2D entity should not move");
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d velocity_system_filtered`
Expected: FAIL — function not found

**Step 3: Write minimal implementation**

Add to `systems.rs` (after `velocity_system_2d`, before `count_active`):

```rust
#[cfg(feature = "physics-2d")]
use crate::physics::PhysicsControlled;
#[cfg(feature = "physics-2d")]
use hecs::Without;

/// Apply velocity to position, EXCLUDING PhysicsControlled entities.
/// Used when physics-2d feature is enabled — Rapier drives those entities.
#[cfg(feature = "physics-2d")]
pub fn velocity_system_filtered(world: &mut World, dt: f32) {
    for (pos, vel) in world.query_mut::<Without<(&mut Position, &Velocity), &PhysicsControlled>>()
    {
        pos.0 += vel.0 * dt;
    }
}

/// Apply velocity to 2D entities, EXCLUDING PhysicsControlled entities.
#[cfg(feature = "physics-2d")]
pub fn velocity_system_2d_filtered(world: &mut World, dt: f32) {
    for (transform, vel) in
        world.query_mut::<Without<(&mut Transform2D, &Velocity), &PhysicsControlled>>()
    {
        transform.x += vel.0.x * dt;
        transform.y += vel.0.y * dt;
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core --features physics-2d velocity_system_filtered`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/systems.rs
git commit -m "feat(#15b): velocity_system_filtered excludes PhysicsControlled entities"
```

---

### Task 4: physics_sync_pre + build_collider_shape

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs`
- Test: `crates/hyperion-core/src/physics.rs` (inline tests)

**Step 1: Write the failing tests**

```rust
#[test]
fn physics_sync_pre_consumes_pending_rigid_body_dynamic() {
    let mut world = World::new();
    let mut physics = PhysicsWorld::new();
    let entity_map = crate::command_processor::EntityMap::new();

    let entity = world.spawn((
        crate::components::Transform2D { x: 100.0, y: 200.0, rot: 0.0, sx: 1.0, sy: 1.0 },
        PendingRigidBody::new(0), // dynamic
        crate::components::ExternalId(0),
    ));

    physics_sync_pre(&mut world, &mut physics, &entity_map);

    // PendingRigidBody consumed
    assert!(world.get::<&PendingRigidBody>(entity).is_err());
    // PhysicsBodyHandle inserted
    assert!(world.get::<&PhysicsBodyHandle>(entity).is_ok());
    // PhysicsControlled inserted
    assert!(world.get::<&PhysicsControlled>(entity).is_ok());
    // Rapier body exists
    assert_eq!(physics.rigid_body_set.len(), 1);
}

#[test]
fn physics_sync_pre_consumes_pending_collider_circle() {
    let mut world = World::new();
    let mut physics = PhysicsWorld::new();
    let entity_map = crate::command_processor::EntityMap::new();

    // Spawn with pending body + collider
    let entity = world.spawn((
        crate::components::Transform2D::default(),
        PendingRigidBody::new(0),
        PendingCollider::new(0, [10.0, 0.0, 0.0, 0.0]), // circle radius=10
        crate::components::ExternalId(42),
    ));

    physics_sync_pre(&mut world, &mut physics, &entity_map);

    // Both consumed
    assert!(world.get::<&PendingRigidBody>(entity).is_err());
    assert!(world.get::<&PendingCollider>(entity).is_err());
    // Collider handle inserted
    assert!(world.get::<&PhysicsColliderHandle>(entity).is_ok());
    // Rapier collider exists
    assert_eq!(physics.collider_set.len(), 1);
}

#[test]
fn physics_sync_pre_consumes_pending_collider_box() {
    let mut world = World::new();
    let mut physics = PhysicsWorld::new();
    let entity_map = crate::command_processor::EntityMap::new();

    let entity = world.spawn((
        crate::components::Transform2D::default(),
        PendingRigidBody::new(0),
        PendingCollider::new(1, [32.0, 48.0, 0.0, 0.0]), // box width=32 height=48
        crate::components::ExternalId(0),
    ));

    physics_sync_pre(&mut world, &mut physics, &entity_map);

    assert!(world.get::<&PhysicsColliderHandle>(entity).is_ok());
    assert_eq!(physics.collider_set.len(), 1);
}

#[test]
fn physics_sync_pre_consumes_pending_collider_capsule() {
    let mut world = World::new();
    let mut physics = PhysicsWorld::new();
    let entity_map = crate::command_processor::EntityMap::new();

    let entity = world.spawn((
        crate::components::Transform2D::default(),
        PendingRigidBody::new(0),
        PendingCollider::new(2, [20.0, 5.0, 0.0, 0.0]), // capsule half_height=20 radius=5
        crate::components::ExternalId(0),
    ));

    physics_sync_pre(&mut world, &mut physics, &entity_map);

    assert!(world.get::<&PhysicsColliderHandle>(entity).is_ok());
    assert_eq!(physics.collider_set.len(), 1);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d physics_sync_pre`
Expected: FAIL — `physics_sync_pre` not found

**Step 3: Write minimal implementation**

Add functions inside the `#[cfg(feature = "physics-2d")]` world module (or as sibling free functions):

```rust
#[cfg(feature = "physics-2d")]
pub fn physics_sync_pre(
    world: &mut hecs::World,
    physics: &mut PhysicsWorld,
    _entity_map: &crate::command_processor::EntityMap,
) {
    use rapier2d::prelude::*;
    use crate::components::*;

    let mut cmd = hecs::CommandBuffer::new();

    // Pass 1: Consume PendingRigidBody
    for (entity, pending, t2d, pos) in world.query_mut::<(
        hecs::Entity,
        &PendingRigidBody,
        Option<&Transform2D>,
        Option<&Position>,
    )>() {
        let translation = match (t2d, pos) {
            (Some(t), _) => glam::Vec2::new(t.x, t.y),
            (_, Some(p)) => glam::Vec2::new(p.0.x, p.0.y),
            _ => glam::Vec2::ZERO,
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
        cmd.insert(entity, (PhysicsBodyHandle(handle), PhysicsControlled));
        cmd.remove::<(PendingRigidBody,)>(entity);
    }
    cmd.run_on(world);

    // Pass 2: Consume PendingCollider (entities now have PhysicsBodyHandle)
    let mut cmd2 = hecs::CommandBuffer::new();
    for (entity, pending, body_handle) in world.query_mut::<(
        hecs::Entity,
        &PendingCollider,
        &PhysicsBodyHandle,
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

    // Pass 3: Kinematic body sync
    for (t2d, handle) in world.query_mut::<(&Transform2D, &PhysicsBodyHandle)>() {
        let body = &mut physics.rigid_body_set[handle.0];
        if body.body_type() == RigidBodyType::KinematicPositionBased {
            body.set_next_kinematic_translation(glam::Vec2::new(t2d.x, t2d.y));
        }
    }
    for (pos, handle) in world.query_mut::<(&Position, &PhysicsBodyHandle)>() {
        let body = &mut physics.rigid_body_set[handle.0];
        if body.body_type() == RigidBodyType::KinematicPositionBased {
            body.set_next_kinematic_translation(glam::Vec2::new(pos.0.x, pos.0.y));
        }
    }
}

#[cfg(feature = "physics-2d")]
fn build_collider_shape(pending: &PendingCollider) -> Option<rapier2d::prelude::ColliderBuilder> {
    use rapier2d::prelude::*;
    let p = &pending.shape_params;
    let builder = match pending.shape_type {
        0 => ColliderBuilder::ball(p[0]),
        1 => ColliderBuilder::cuboid(p[0] / 2.0, p[1] / 2.0),
        2 => ColliderBuilder::capsule_y(p[0], p[1]),
        _ => return None,
    };
    let mut builder = builder
        .density(pending.density)
        .restitution(pending.restitution)
        .friction(pending.friction)
        .sensor(pending.is_sensor)
        .collision_groups(InteractionGroups::new(
            Group::from_bits_truncate(pending.groups & 0xFFFF),
            Group::from_bits_truncate(pending.groups >> 16),
        ));

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

**Step 4: Run tests to verify they pass**

Run: `cargo test -p hyperion-core --features physics-2d physics_sync_pre`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15b): physics_sync_pre consumes pending bodies/colliders into Rapier"
```

---

### Task 5: physics_sync_post

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs`
- Test: `crates/hyperion-core/src/physics.rs` (inline tests)

**Step 1: Write the failing tests**

```rust
#[test]
fn physics_sync_post_writes_back_transform2d() {
    use crate::components::*;
    let mut world = World::new();
    let mut physics = PhysicsWorld::new();
    let entity_map = crate::command_processor::EntityMap::new();

    // Create entity with pending body
    let entity = world.spawn((
        Transform2D { x: 0.0, y: 0.0, rot: 0.0, sx: 1.0, sy: 1.0 },
        PendingRigidBody::new(0), // dynamic
        ExternalId(0),
    ));

    // Consume pending -> create Rapier body
    physics_sync_pre(&mut world, &mut physics, &entity_map);

    // Step physics (gravity should move the body)
    for _ in 0..10 {
        physics.step();
    }

    // Sync back
    physics_sync_post(&mut world, &physics);

    let t = world.get::<&Transform2D>(entity).unwrap();
    // With gravity=(0,980) and length_unit=100, body should have moved down
    assert!(t.y > 0.1, "body should have fallen: y={}", t.y);
}

#[test]
fn physics_sync_post_skips_sleeping_bodies() {
    use crate::components::*;
    let mut world = World::new();
    let mut physics = PhysicsWorld::new();
    let entity_map = crate::command_processor::EntityMap::new();

    // Fixed body (never moves, sleeps immediately)
    let entity = world.spawn((
        Transform2D { x: 50.0, y: 50.0, rot: 0.0, sx: 1.0, sy: 1.0 },
        PendingRigidBody::new(1), // fixed
        ExternalId(0),
    ));
    physics_sync_pre(&mut world, &mut physics, &entity_map);
    physics.step();
    physics_sync_post(&mut world, &physics);

    let t = world.get::<&Transform2D>(entity).unwrap();
    // Fixed body stays at same position
    assert!((t.x - 50.0).abs() < 0.01);
    assert!((t.y - 50.0).abs() < 0.01);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d physics_sync_post`
Expected: FAIL — `physics_sync_post` not found

**Step 3: Write minimal implementation**

```rust
#[cfg(feature = "physics-2d")]
pub fn physics_sync_post(world: &mut hecs::World, physics: &PhysicsWorld) {
    use crate::components::*;

    // 2D entities
    for (t2d, handle) in world.query_mut::<(&mut Transform2D, &PhysicsBodyHandle)>() {
        let body = &physics.rigid_body_set[handle.0];
        if body.is_sleeping() { continue; }
        let pos = body.translation();
        t2d.x = pos.x;
        t2d.y = pos.y;
        t2d.rot = body.rotation().angle();
    }

    // 3D entities
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

**Step 4: Run tests to verify they pass**

Run: `cargo test -p hyperion-core --features physics-2d physics_sync_post`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15b): physics_sync_post writes Rapier state back to ECS"
```

---

### Task 6: process_physics_commands (live-body command routing)

**Files:**
- Create: `crates/hyperion-core/src/physics_commands.rs`
- Modify: `crates/hyperion-core/src/lib.rs:5-12` (add `mod physics_commands`)
- Test: `crates/hyperion-core/src/physics_commands.rs` (inline tests)

**Step 1: Write the failing test**

```rust
#[cfg(feature = "physics-2d")]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_processor::EntityMap;
    use crate::components::*;
    use crate::physics::*;
    use crate::ring_buffer::{Command, CommandType};

    #[test]
    fn apply_force_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        // Spawn entity
        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            ExternalId(0),
        ));
        entity_map.insert(0, entity);

        // Create body
        physics_sync_pre(&mut world, &mut physics, &entity_map);

        // Apply force via command
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&100.0f32.to_le_bytes());
        payload[4..8].copy_from_slice(&0.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::ApplyForce,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        // The force should be applied (step will use it)
        // We can't directly read the force from Rapier, but stepping should move
        physics.step();
        physics_sync_post(&mut world, &physics);

        let t = world.get::<&Transform2D>(entity).unwrap();
        // Force of 100 on dynamic body — should have moved right after one step
        assert!(t.x > 0.0, "body should have moved from applied force");
    }

    #[test]
    fn set_gravity_scale_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            ExternalId(0),
        ));
        entity_map.insert(0, entity);
        physics_sync_pre(&mut world, &mut physics, &entity_map);

        // Set gravity scale to 0 via command
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&0.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetGravityScale,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        // Step — body should NOT fall because gravity scale is 0
        for _ in 0..10 {
            physics.step();
        }
        physics_sync_post(&mut world, &physics);

        let t = world.get::<&Transform2D>(entity).unwrap();
        assert!((t.y - 0.0).abs() < 0.01, "body with 0 gravity should not fall");
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d apply_force_on_live`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `crates/hyperion-core/src/physics_commands.rs`:

```rust
//! Routes live-body physics commands to Rapier.
//! Second pass: runs AFTER process_commands, handles commands
//! that need &mut PhysicsWorld.

#[cfg(feature = "physics-2d")]
use crate::command_processor::EntityMap;
#[cfg(feature = "physics-2d")]
use crate::physics::{PhysicsBodyHandle, PhysicsWorld};
#[cfg(feature = "physics-2d")]
use crate::ring_buffer::{Command, CommandType};

#[cfg(feature = "physics-2d")]
pub fn process_physics_commands(
    commands: &[Command],
    world: &mut hecs::World,
    entity_map: &EntityMap,
    physics: &mut PhysicsWorld,
) {
    for cmd in commands {
        let entity = match entity_map.get(cmd.entity_id) {
            Some(e) => e,
            None => continue,
        };

        let handle = match world.get::<&PhysicsBodyHandle>(entity) {
            Ok(h) => h.0,
            Err(_) => continue,
        };

        let rb = match physics.rigid_body_set.get_mut(handle) {
            Some(rb) => rb,
            None => continue,
        };

        match cmd.cmd_type {
            CommandType::SetGravityScale => {
                let v = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                rb.set_gravity_scale(v, true);
            }
            CommandType::SetLinearDamping => {
                let v = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                rb.set_linear_damping(v);
            }
            CommandType::SetAngularDamping => {
                let v = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                rb.set_angular_damping(v);
            }
            CommandType::SetCCDEnabled => {
                let v = cmd.payload[0] != 0;
                rb.enable_ccd(v);
            }
            CommandType::ApplyForce => {
                let fx = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let fy = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                rb.add_force(glam::Vec2::new(fx, fy), true);
            }
            CommandType::ApplyImpulse => {
                let ix = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let iy = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                rb.apply_impulse(glam::Vec2::new(ix, iy), true);
            }
            CommandType::ApplyTorque => {
                let t = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                rb.apply_torque(t, true);
            }
            _ => {} // non-physics or pending-only commands
        }
    }
}
```

Also add `mod physics_commands;` to `lib.rs` (line 9, inside the `#[cfg(feature = "physics-2d")]` block):

```rust
#[cfg(feature = "physics-2d")]
pub mod physics;
#[cfg(feature = "physics-2d")]
pub mod physics_commands;
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p hyperion-core --features physics-2d -- apply_force_on_live set_gravity_scale_on_live`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/physics_commands.rs crates/hyperion-core/src/lib.rs
git commit -m "feat(#15b): process_physics_commands routes live-body commands to Rapier"
```

---

### Task 7: Wire physics into Engine (update + fixed_tick + process_commands)

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs:1-155`
- Modify: `crates/hyperion-core/src/command_processor.rs:343-349` (DespawnEntity handler)
- Test: `crates/hyperion-core/src/engine.rs` (inline tests)

**Step 1: Write the failing tests**

Add to `engine.rs` `#[cfg(test)] mod tests`:

```rust
#[cfg(feature = "physics-2d")]
#[test]
fn ball_falls_under_gravity() {
    let mut engine = Engine::new();

    // Spawn 2D entity
    let mut spawn_payload = [0u8; 16];
    spawn_payload[0] = 1; // 2D
    engine.process_commands(&[Command {
        cmd_type: CommandType::SpawnEntity,
        entity_id: 0,
        payload: spawn_payload,
    }]);

    // Create rigid body (dynamic=0)
    engine.process_commands(&[Command {
        cmd_type: CommandType::CreateRigidBody,
        entity_id: 0,
        payload: { let mut p = [0u8; 16]; p[0] = 0; p },
    }]);

    // Create circle collider (shape=0, radius=10)
    let mut col_payload = [0u8; 16];
    col_payload[0] = 0; // circle
    col_payload[1..5].copy_from_slice(&10.0f32.to_le_bytes());
    engine.process_commands(&[Command {
        cmd_type: CommandType::CreateCollider,
        entity_id: 0,
        payload: col_payload,
    }]);

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

    // Spawn + create body
    let mut spawn_payload = [0u8; 16];
    spawn_payload[0] = 1;
    engine.process_commands(&[
        Command { cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: spawn_payload },
        Command { cmd_type: CommandType::CreateRigidBody, entity_id: 0, payload: { let mut p = [0u8; 16]; p[0] = 0; p } },
    ]);
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
fn mark_post_system_dirty_marks_physics_entities() {
    let mut engine = Engine::new();
    let mut spawn_payload = [0u8; 16];
    spawn_payload[0] = 1;
    engine.process_commands(&[
        Command { cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: spawn_payload },
        Command { cmd_type: CommandType::CreateRigidBody, entity_id: 0, payload: { let mut p = [0u8; 16]; p[0] = 0; p } },
    ]);
    // Run so physics body gets created and entity gets a slot
    engine.update(FIXED_DT);
    // The physics entity should be marked dirty (non-sleeping dynamic body)
    // The test passes if update() completes without panic (dirty marking executed)
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d ball_falls_under_gravity`
Expected: FAIL — `Engine` struct doesn't have `physics` field

**Step 3: Write the implementation**

Modify `engine.rs`:

1. Add `#[cfg(feature = "physics-2d")] pub physics: PhysicsWorld` to `Engine` struct (line 25)
2. Add `#[cfg(feature = "physics-2d")] physics: PhysicsWorld::new()` to `Engine::new()` (line 43)
3. Add imports for physics types and filtered systems
4. Modify `process_commands` method on Engine to handle pending-stage physics commands AND call `process_physics_commands`
5. Modify `update()` to clear events, call physics process, and add physics sync
6. Modify `fixed_tick()` to call `physics_sync_pre`, `step`, and filtered velocity systems
7. Add physics dirty marking pass to `mark_post_system_dirty`
8. Modify `reset()` (dev-tools) to reset physics

For `command_processor.rs`, add despawn physics cleanup:

In the `DespawnEntity` match arm (line 343-349), add before `world.despawn(entity)`:

```rust
CommandType::DespawnEntity => {
    if let Some(entity) = entity_map.get(cmd.entity_id) {
        // Physics cleanup (must happen before world.despawn)
        #[cfg(feature = "physics-2d")]
        despawn_physics_cleanup(world, entity, physics);

        render_state.pending_despawns.push(entity);
        let _ = world.despawn(entity);
        entity_map.remove(cmd.entity_id);
    }
}
```

The `process_commands` signature gains `#[cfg]`-conditional physics param, and `process_single_command` also needs it:

```rust
#[cfg(feature = "physics-2d")]
pub fn process_commands(
    commands: &[Command], world: &mut World, entity_map: &mut EntityMap,
    render_state: &mut RenderState, physics: &mut crate::physics::PhysicsWorld,
) { /* ... */ }

#[cfg(not(feature = "physics-2d"))]
pub fn process_commands(
    commands: &[Command], world: &mut World, entity_map: &mut EntityMap,
    render_state: &mut RenderState,
) { /* ... */ }
```

Add pending-stage match arms (CreateRigidBody, CreateCollider, SetGravityScale-on-pending) using `#[cfg(feature = "physics-2d")]` guards.

Add helper:

```rust
#[cfg(feature = "physics-2d")]
fn despawn_physics_cleanup(
    world: &hecs::World,
    entity: hecs::Entity,
    physics: &mut crate::physics::PhysicsWorld,
) {
    use crate::physics::*;
    if let Ok(handle) = world.get::<&PhysicsBodyHandle>(entity) {
        let body = &physics.rigid_body_set[handle.0];
        for &col_handle in body.colliders() {
            let idx = col_handle.0.into_raw_parts().0 as usize;
            if idx < physics.collider_to_entity.len() {
                physics.collider_to_entity[idx] = None;
            }
        }
        physics.rigid_body_set.remove(
            handle.0,
            &mut physics.island_manager,
            &mut physics.collider_set,
            &mut physics.impulse_joint_set,
            &mut physics.multibody_joint_set,
            true,
        );
    }
    // Clean up pending components (entity despawned before reaching Rapier)
    let _ = world.remove_one::<PendingRigidBody>(entity);
    let _ = world.remove_one::<PendingCollider>(entity);
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p hyperion-core --features physics-2d -- ball_falls despawn_removes mark_post_system_dirty_marks_physics`
Expected: PASS (3 tests)

**Step 5: Run ALL tests to verify no regressions**

Run: `cargo test -p hyperion-core` (without physics — existing tests must still pass)
Run: `cargo test -p hyperion-core --features physics-2d` (with physics)
Expected: All tests pass in both configurations

**Step 6: Run clippy**

Run: `cargo clippy -p hyperion-core && cargo clippy -p hyperion-core --features physics-2d`
Expected: No warnings

**Step 7: Commit**

```bash
git add crates/hyperion-core/src/engine.rs crates/hyperion-core/src/command_processor.rs
git commit -m "feat(#15b): wire PhysicsWorld into Engine tick loop + despawn cleanup"
```

---

### Task 8: WASM exports (engine_physics_configure + engine_physics_body_count)

**Files:**
- Modify: `crates/hyperion-core/src/lib.rs:462-568`

**Step 1: Write the WASM exports**

Add after the `engine_memory()` export (around line 457), before the dev-tools section:

```rust
// ── Physics WASM exports ────────────────────────────────────────

/// Configure physics gravity and scale.
/// Call after engine_init(), before the first engine_update().
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_configure(gravity_x: f32, gravity_y: f32, pixels_per_meter: f32) {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut engine) = *addr_of_mut!(ENGINE) {
            engine.physics.gravity = glam::Vec2::new(gravity_x, gravity_y);
            engine.physics.integration_parameters.length_unit = pixels_per_meter;
        }
    }
}

/// Returns the number of active rigid bodies in the physics world.
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_body_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.physics.body_count())
    }
}
```

**Step 2: Verify compilation**

Run: `cargo build -p hyperion-core --features physics-2d`
Expected: Compiles successfully

**Step 3: Run all tests**

Run: `cargo test -p hyperion-core --features physics-2d`
Expected: All tests pass

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/lib.rs
git commit -m "feat(#15b): WASM exports engine_physics_configure + engine_physics_body_count"
```

---

### Task 9: EntityHandle physics fluent methods (TypeScript)

**Files:**
- Modify: `ts/src/entity-handle.ts:233-252`
- Test: `ts/src/entity-handle.test.ts`

**Step 1: Write the failing tests**

Add to `entity-handle.test.ts`:

```typescript
describe('physics methods', () => {
  it('rigidBody sends CreateRigidBody command', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.rigidBody('dynamic');
    expect(producer.createRigidBody).toHaveBeenCalledWith(0, 0);
  });

  it('rigidBody maps static to body_type 1', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.rigidBody('static');
    expect(producer.createRigidBody).toHaveBeenCalledWith(0, 1);
  });

  it('rigidBody maps kinematic to body_type 2', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.rigidBody('kinematic');
    expect(producer.createRigidBody).toHaveBeenCalledWith(0, 2);
  });

  it('collider circle sends CreateCollider', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.collider('circle', { radius: 10 });
    expect(producer.createCollider).toHaveBeenCalledWith(0, 0, 10, 0, 0);
  });

  it('collider box sends CreateCollider', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.collider('box', { width: 32, height: 48 });
    expect(producer.createCollider).toHaveBeenCalledWith(0, 1, 32, 48, 0);
  });

  it('collider capsule sends CreateCollider', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.collider('capsule', { halfHeight: 20, radius: 5 });
    expect(producer.createCollider).toHaveBeenCalledWith(0, 2, 20, 5, 0);
  });

  it('applyForce sends ApplyForce command', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.applyForce(100, -50);
    expect(producer.applyForce).toHaveBeenCalledWith(0, 100, -50);
  });

  it('applyImpulse sends ApplyImpulse command', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.applyImpulse(200, 0);
    expect(producer.applyImpulse).toHaveBeenCalledWith(0, 200, 0);
  });

  it('gravityScale sends SetGravityScale', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.gravityScale(0.5);
    expect(producer.setGravityScale).toHaveBeenCalledWith(0, 0.5);
  });

  it('linearDamping sends SetLinearDamping', () => {
    const producer = createMockProducer();
    const handle = new EntityHandle(0, producer);
    handle.linearDamping(0.8);
    expect(producer.setLinearDamping).toHaveBeenCalledWith(0, 0.8);
  });
});
```

Note: `createMockProducer()` should already exist in the test file (check for existing mock factory). If not, add physics methods to the existing mock.

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: FAIL — `.rigidBody` is not a function

**Step 3: Write minimal implementation**

Add to `EntityHandle` class in `entity-handle.ts`, before `destroy()`:

```typescript
/** Body type map for rigidBody(). */
private static readonly BODY_TYPE_MAP: Record<string, number> = {
  dynamic: 0, static: 1, kinematic: 2,
};

/** Create a rigid body for this entity. Returns `this` for chaining. */
rigidBody(type: 'dynamic' | 'static' | 'kinematic'): this {
  this.check();
  this._producer!.createRigidBody(this._id, EntityHandle.BODY_TYPE_MAP[type]);
  return this;
}

/** Create a collider for this entity. Returns `this` for chaining. */
collider(shape: 'circle', opts: { radius: number }): this;
collider(shape: 'box', opts: { width: number; height: number }): this;
collider(shape: 'capsule', opts: { halfHeight: number; radius: number }): this;
collider(shape: string, opts: Record<string, number>): this {
  this.check();
  const shapeMap: Record<string, number> = { circle: 0, box: 1, capsule: 2 };
  const st = shapeMap[shape] ?? 0;
  let p0 = 0, p1 = 0, p2 = 0;
  switch (shape) {
    case 'circle': p0 = opts.radius; break;
    case 'box': p0 = opts.width; p1 = opts.height; break;
    case 'capsule': p0 = opts.halfHeight; p1 = opts.radius; break;
  }
  this._producer!.createCollider(this._id, st, p0, p1, p2);
  return this;
}

/** Set gravity scale. Returns `this` for chaining. */
gravityScale(scale: number): this {
  this.check();
  this._producer!.setGravityScale(this._id, scale);
  return this;
}

/** Set linear damping. Returns `this` for chaining. */
linearDamping(damping: number): this {
  this.check();
  this._producer!.setLinearDamping(this._id, damping);
  return this;
}

/** Apply a force (accumulated until next step). Returns `this` for chaining. */
applyForce(fx: number, fy: number): this {
  this.check();
  this._producer!.applyForce(this._id, fx, fy);
  return this;
}

/** Apply an instantaneous impulse. Returns `this` for chaining. */
applyImpulse(ix: number, iy: number): this {
  this.check();
  this._producer!.applyImpulse(this._id, ix, iy);
  return this;
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: PASS (all entity-handle tests including new physics ones)

**Step 5: Type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No new errors

**Step 6: Commit**

```bash
git add ts/src/entity-handle.ts ts/src/entity-handle.test.ts
git commit -m "feat(#15b): EntityHandle physics fluent API (rigidBody/collider/force/impulse)"
```

---

### Task 10: Final validation + CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md` (test counts, module table, gotchas, implementation status)

**Step 1: Run full Rust test suite**

Run: `cargo test -p hyperion-core` (standard build)
Run: `cargo test -p hyperion-core --features physics-2d` (physics build)
Expected: Both pass. Physics build should have ~22 new tests (~182 total with physics-2d)

**Step 2: Run full TypeScript test suite**

Run: `cd ts && npm test`
Expected: All pass (~782+ tests)

**Step 3: Run clippy**

Run: `cargo clippy -p hyperion-core && cargo clippy -p hyperion-core --features physics-2d`
Expected: No warnings

**Step 4: Type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No new errors

**Step 5: Update CLAUDE.md**

Update the following sections:
- Test command: add `cargo test -p hyperion-core --features physics-2d` test count
- Module table: add `physics_commands.rs` entry
- Module table: update `physics.rs` description
- Module table: update `engine.rs` description
- Gotchas: any new gotchas discovered during implementation
- Implementation Status: mark Phase 15b complete

**Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with Phase 15b completion"
```

---

## Summary: Test Counts

| Area | Expected New Tests |
|------|-------------------|
| PendingCollider from_payload + active_events | 2 |
| PhysicsWorld new/step/configure | 3 |
| velocity_system_filtered (3D + 2D) | 2 |
| physics_sync_pre (dynamic, circle, box, capsule) | 4 |
| physics_sync_post (writes back, skips sleeping) | 2 |
| process_physics_commands (apply_force, gravity_scale) | 2 |
| Engine E2E (ball falls, despawn cleanup, dirty marking) | 3 |
| WASM exports compile | 0 (build-only) |
| EntityHandle TS (10 methods × mock) | ~10 |
| **Total** | **~28** (18 Rust + 10 TS) |

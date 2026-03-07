//! Rapier2D physics integration.
//!
//! All types and functions in this module are behind `#[cfg(feature = "physics-2d")]`.

#[cfg(feature = "physics-2d")]
pub mod types {
    /// Pending rigid body creation. Accumulates override commands before
    /// physics_sync_pre() creates the actual Rapier body.
    pub struct PendingRigidBody {
        pub body_type: u8, // 0=dynamic, 1=fixed, 2=kinematic
        pub gravity_scale: f32,
        pub linear_damping: f32,
        pub angular_damping: f32,
        pub ccd_enabled: bool,
    }

    impl Default for PendingRigidBody {
        fn default() -> Self {
            Self {
                body_type: 0,
                gravity_scale: 1.0,
                linear_damping: 0.0,
                angular_damping: 0.0,
                ccd_enabled: false,
            }
        }
    }

    impl PendingRigidBody {
        pub fn new(body_type: u8) -> Self {
            Self {
                body_type,
                ..Default::default()
            }
        }
    }

    /// Pending collider creation. Consumed in physics_sync_pre().
    pub struct PendingCollider {
        pub shape_type: u8,
        pub shape_params: [f32; 4],
        pub density: f32,
        pub restitution: f32,
        pub friction: f32,
        pub is_sensor: bool,
        pub groups: u32,
        /// bit 0=COLLISION_EVENTS, bit 1=CONTACT_FORCE_EVENTS
        pub active_events: u8,
    }

    impl Default for PendingCollider {
        fn default() -> Self {
            Self {
                shape_type: 0,
                shape_params: [0.0; 4],
                density: 1.0,
                restitution: 0.0,
                friction: 0.5,
                is_sensor: false,
                groups: 0xFFFF_FFFF,
                active_events: 0,
            }
        }
    }

    impl PendingCollider {
        pub fn new(shape_type: u8, params: [f32; 4]) -> Self {
            Self {
                shape_type,
                shape_params: params,
                ..Default::default()
            }
        }

        /// Construct from a 16-byte ring buffer payload.
        /// Layout: `[shape_type: u8][param0: f32 LE][param1: f32 LE][param2: f32 LE]`
        pub fn from_payload(payload: &[u8; 16]) -> Self {
            let shape_type = payload[0];
            let mut shape_params = [0.0f32; 4];
            for (i, param) in shape_params.iter_mut().enumerate().take(3) {
                let offset = 1 + i * 4;
                if offset + 4 <= 16 {
                    *param = f32::from_le_bytes(
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

    /// Handle to a live Rapier RigidBody.
    pub struct PhysicsBodyHandle(pub rapier2d::prelude::RigidBodyHandle);

    /// Handle to a live Rapier Collider.
    pub struct PhysicsColliderHandle(pub rapier2d::prelude::ColliderHandle);

    /// Marker: entity position/rotation driven by Rapier. velocity_system skips these.
    pub struct PhysicsControlled;
}

#[cfg(feature = "physics-2d")]
pub use types::*;

// ---------------------------------------------------------------------------
// PhysicsWorld — wraps ALL Rapier simulation state
// ---------------------------------------------------------------------------

#[cfg(feature = "physics-2d")]
mod world {
    use rapier2d::prelude::*;

    /// Collision event translated to external entity IDs.
    #[derive(Debug, Clone, PartialEq)]
    pub struct HyperionCollisionEvent {
        pub entity_a: u32,
        pub entity_b: u32,
        pub started: bool,
    }

    /// Contact force event translated to external entity IDs.
    #[derive(Debug, Clone, PartialEq)]
    pub struct HyperionContactForceEvent {
        pub entity_a: u32,
        pub entity_b: u32,
        pub total_force_magnitude: f32,
    }

    /// Wraps the complete Rapier2D simulation state.
    ///
    /// All fields are public so that `physics_sync_pre` / `physics_sync_post`
    /// (Task 3+) can directly access body/collider sets.
    ///
    /// NOTE: `gravity` is stored as `rapier2d::math::Vector` (rapier's glam 0.30
    /// `Vec2`), not our crate's `glam::Vec2` (0.29). This avoids version-mismatch
    /// conversions on every `step()` call.
    ///
    /// NOTE: `QueryPipeline` is NOT stored — in rapier2d 0.32 it is a short-lived
    /// view obtained from `BroadPhaseBvh::as_query_pipeline()`. Create it on-the-fly
    /// when raycasts are needed.
    pub struct PhysicsWorld {
        // Rapier core
        pub gravity: Vector,
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

        // Events (std::sync::mpsc — confirmed by spike)
        collision_send: std::sync::mpsc::Sender<CollisionEvent>,
        collision_recv: std::sync::mpsc::Receiver<CollisionEvent>,
        force_send: std::sync::mpsc::Sender<ContactForceEvent>,
        force_recv: std::sync::mpsc::Receiver<ContactForceEvent>,

        // Frame event buffers — cleared in Engine::update(), accumulated across N ticks
        pub frame_collision_events: Vec<HyperionCollisionEvent>,
        pub frame_contact_force_events: Vec<HyperionContactForceEvent>,

        // Reverse map: ColliderHandle index -> external entity ID (for event translation)
        pub collider_to_entity: Vec<Option<u32>>,
    }

    impl PhysicsWorld {
        /// Create a new physics world with pixel-space defaults.
        ///
        /// - `gravity`: (0, 980) — down in pixel coordinates
        /// - `length_unit`: 100.0 — 100 pixels per physics meter
        pub fn new() -> Self {
            let (collision_send, collision_recv) = std::sync::mpsc::channel();
            let (force_send, force_recv) = std::sync::mpsc::channel();

            Self {
                gravity: Vector::new(0.0, 980.0),
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
                collision_send,
                collision_recv,
                force_send,
                force_recv,
                frame_collision_events: Vec::new(),
                frame_contact_force_events: Vec::new(),
                collider_to_entity: Vec::new(),
            }
        }

        /// Advance the physics simulation by one integration step.
        ///
        /// Drains Rapier event channels and translates ColliderHandle pairs
        /// into external entity IDs via `collider_to_entity`. Events are
        /// **accumulated** into `frame_collision_events` /
        /// `frame_contact_force_events` (caller clears per frame).
        pub fn step(&mut self) {
            let event_handler = ChannelEventCollector::new(
                self.collision_send.clone(),
                self.force_send.clone(),
            );

            self.physics_pipeline.step(
                self.gravity,
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

            // Drain collision events (accumulative across ticks within a frame)
            while let Ok(event) = self.collision_recv.try_recv() {
                self.translate_collision(event);
            }

            // Drain contact force events
            while let Ok(event) = self.force_recv.try_recv() {
                self.translate_contact_force(event);
            }
        }

        /// Number of rigid bodies currently in the simulation.
        pub fn body_count(&self) -> u32 {
            self.rigid_body_set.len() as u32
        }

        // --- Private event translation helpers ---

        fn collider_handle_to_entity(&self, handle: ColliderHandle) -> Option<u32> {
            let idx = handle.0.into_raw_parts().0 as usize;
            self.collider_to_entity.get(idx).copied().flatten()
        }

        fn translate_collision(&mut self, event: CollisionEvent) {
            let h1 = event.collider1();
            let h2 = event.collider2();

            if let (Some(entity_a), Some(entity_b)) =
                (self.collider_handle_to_entity(h1), self.collider_handle_to_entity(h2))
            {
                self.frame_collision_events.push(HyperionCollisionEvent {
                    entity_a,
                    entity_b,
                    started: event.started(),
                });
            }
        }

        fn translate_contact_force(&mut self, event: ContactForceEvent) {
            if let (Some(entity_a), Some(entity_b)) = (
                self.collider_handle_to_entity(event.collider1),
                self.collider_handle_to_entity(event.collider2),
            ) {
                self.frame_contact_force_events.push(HyperionContactForceEvent {
                    entity_a,
                    entity_b,
                    total_force_magnitude: event.total_force_magnitude,
                });
            }
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

// ---------------------------------------------------------------------------
// physics_sync_pre — consume pending bodies/colliders into Rapier
// ---------------------------------------------------------------------------

#[cfg(feature = "physics-2d")]
pub fn physics_sync_pre(
    world: &mut hecs::World,
    physics: &mut PhysicsWorld,
    _entity_map: &crate::command_processor::EntityMap,
) {
    use rapier2d::prelude::*;
    use crate::components::*;

    let mut cmd = hecs::CommandBuffer::new();

    // Pass 1: Consume PendingRigidBody → create Rapier rigid body
    for (entity, pending, t2d, pos) in world.query_mut::<(
        hecs::Entity,
        &PendingRigidBody,
        Option<&Transform2D>,
        Option<&Position>,
    )>() {
        let translation = match (t2d, pos) {
            (Some(t), _) => Vector::new(t.x, t.y),
            (_, Some(p)) => Vector::new(p.0.x, p.0.y),
            _ => Vector::ZERO,
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
    for (entity, pending, body_handle, ext_id) in world.query_mut::<(
        hecs::Entity,
        &PendingCollider,
        &PhysicsBodyHandle,
        Option<&ExternalId>,
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
            if let Some(eid) = ext_id {
                physics.collider_to_entity[idx] = Some(eid.0);
            }

            cmd2.insert_one(entity, PhysicsColliderHandle(col_handle));
            cmd2.remove::<(PendingCollider,)>(entity);
        }
    }
    cmd2.run_on(world);

    // Pass 3: Kinematic body sync — push ECS position into Rapier
    for (t2d, handle) in world.query_mut::<(&Transform2D, &PhysicsBodyHandle)>() {
        let body = &mut physics.rigid_body_set[handle.0];
        if body.body_type() == RigidBodyType::KinematicPositionBased {
            body.set_next_kinematic_translation(Vector::new(t2d.x, t2d.y));
        }
    }
    for (pos, handle) in world.query_mut::<(&Position, &PhysicsBodyHandle)>() {
        let body = &mut physics.rigid_body_set[handle.0];
        if body.body_type() == RigidBodyType::KinematicPositionBased {
            body.set_next_kinematic_translation(Vector::new(pos.0.x, pos.0.y));
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
            InteractionTestMode::And,
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

#[cfg(feature = "physics-2d")]
#[cfg(test)]
mod tests {
    use super::types::*;
    use super::world::*;

    #[test]
    fn pending_rigid_body_defaults() {
        let pending = PendingRigidBody::default();
        assert_eq!(pending.body_type, 0);
        assert_eq!(pending.gravity_scale, 1.0);
        assert_eq!(pending.linear_damping, 0.0);
        assert_eq!(pending.angular_damping, 0.0);
        assert!(!pending.ccd_enabled);
    }

    #[test]
    fn pending_collider_defaults() {
        let pending = PendingCollider::default();
        assert_eq!(pending.shape_type, 0);
        assert_eq!(pending.density, 1.0);
        assert_eq!(pending.restitution, 0.0);
        assert!((pending.friction - 0.5).abs() < f32::EPSILON);
        assert!(!pending.is_sensor);
        assert_eq!(pending.groups, 0xFFFF_FFFF);
    }

    #[test]
    fn pending_rigid_body_new_sets_body_type() {
        let pending = PendingRigidBody::new(1); // fixed
        assert_eq!(pending.body_type, 1);
        assert_eq!(pending.gravity_scale, 1.0); // other fields default
    }

    #[test]
    fn pending_collider_from_payload() {
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
        pending.active_events = 0x01;
        assert_eq!(pending.active_events, 0x01);
    }

    // --- PhysicsWorld tests ---

    #[test]
    fn physics_world_default_gravity() {
        let pw = PhysicsWorld::new();
        assert!((pw.gravity.x - 0.0).abs() < f32::EPSILON);
        assert!((pw.gravity.y - 980.0).abs() < f32::EPSILON);
    }

    #[test]
    fn physics_world_default_length_unit() {
        let pw = PhysicsWorld::new();
        assert!((pw.integration_parameters.length_unit - 100.0).abs() < f32::EPSILON);
    }

    #[test]
    fn physics_world_step_does_not_panic() {
        let mut pw = PhysicsWorld::new();
        pw.step();
    }

    #[test]
    fn physics_world_configure() {
        use rapier2d::prelude::Vector;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, -9.81);
        pw.integration_parameters.length_unit = 1.0;
        assert!((pw.gravity.y - (-9.81)).abs() < f32::EPSILON);
        assert!((pw.integration_parameters.length_unit - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn physics_world_body_count_empty() {
        let pw = PhysicsWorld::new();
        assert_eq!(pw.body_count(), 0);
    }

    #[test]
    fn physics_world_body_count_after_insert() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        let rb = RigidBodyBuilder::dynamic().build();
        pw.rigid_body_set.insert(rb);
        assert_eq!(pw.body_count(), 1);
    }

    #[test]
    fn physics_world_default_trait() {
        let pw = PhysicsWorld::default();
        assert!((pw.gravity.y - 980.0).abs() < f32::EPSILON);
        assert_eq!(pw.body_count(), 0);
    }

    #[test]
    fn physics_world_step_moves_dynamic_body() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        // Gravity is (0, 980) — body should fall (y increases)
        let rb = RigidBodyBuilder::dynamic()
            .translation(Vector::new(0.0, 0.0))
            .build();
        let handle = pw.rigid_body_set.insert(rb);
        // Attach a collider to give the body mass
        let collider = ColliderBuilder::ball(5.0).density(1.0).build();
        pw.collider_set.insert_with_parent(collider, handle, &mut pw.rigid_body_set);
        // Step several times to accumulate visible movement
        for _ in 0..10 {
            pw.step();
        }
        let body = &pw.rigid_body_set[handle];
        assert!(
            body.translation().y > 0.0,
            "body should have moved under gravity; y = {}",
            body.translation().y
        );
    }

    #[test]
    fn physics_world_events_empty_without_collisions() {
        let mut pw = PhysicsWorld::new();
        pw.step();
        assert!(pw.frame_collision_events.is_empty());
        assert!(pw.frame_contact_force_events.is_empty());
    }

    #[test]
    fn physics_world_collision_event_translation() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();

        // Create two dynamic bodies that overlap, with collision events enabled
        let rb_a = RigidBodyBuilder::dynamic()
            .translation(Vector::new(0.0, 0.0))
            .build();
        let handle_a = pw.rigid_body_set.insert(rb_a);
        let col_a = ColliderBuilder::ball(10.0)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .build();
        let col_handle_a = pw.collider_set.insert_with_parent(
            col_a,
            handle_a,
            &mut pw.rigid_body_set,
        );

        let rb_b = RigidBodyBuilder::dynamic()
            .translation(Vector::new(5.0, 0.0)) // overlapping
            .build();
        let handle_b = pw.rigid_body_set.insert(rb_b);
        let col_b = ColliderBuilder::ball(10.0)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .build();
        let col_handle_b = pw.collider_set.insert_with_parent(
            col_b,
            handle_b,
            &mut pw.rigid_body_set,
        );

        // Register reverse mapping
        let idx_a = col_handle_a.0.into_raw_parts().0 as usize;
        let idx_b = col_handle_b.0.into_raw_parts().0 as usize;
        let max_idx = idx_a.max(idx_b);
        pw.collider_to_entity.resize(max_idx + 1, None);
        pw.collider_to_entity[idx_a] = Some(100); // external entity id
        pw.collider_to_entity[idx_b] = Some(200);

        // Step should generate a collision Started event
        pw.step();

        assert!(
            !pw.frame_collision_events.is_empty(),
            "expected at least one collision event from overlapping bodies"
        );
        let evt = &pw.frame_collision_events[0];
        // The two entities should be 100 and 200 (order may vary)
        let ids = [evt.entity_a, evt.entity_b];
        assert!(ids.contains(&100));
        assert!(ids.contains(&200));
        assert!(evt.started);
    }

    #[test]
    fn physics_world_events_skipped_without_mapping() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();

        // Create overlapping bodies with collision events, but NO reverse mapping
        let rb_a = RigidBodyBuilder::dynamic()
            .translation(Vector::new(0.0, 0.0))
            .build();
        let handle_a = pw.rigid_body_set.insert(rb_a);
        let col_a = ColliderBuilder::ball(10.0)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .build();
        pw.collider_set.insert_with_parent(
            col_a,
            handle_a,
            &mut pw.rigid_body_set,
        );

        let rb_b = RigidBodyBuilder::dynamic()
            .translation(Vector::new(5.0, 0.0))
            .build();
        let handle_b = pw.rigid_body_set.insert(rb_b);
        let col_b = ColliderBuilder::ball(10.0)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .build();
        pw.collider_set.insert_with_parent(
            col_b,
            handle_b,
            &mut pw.rigid_body_set,
        );

        // collider_to_entity is empty — events should be silently dropped
        pw.step();
        assert!(
            pw.frame_collision_events.is_empty(),
            "events should be dropped when collider_to_entity mapping is absent"
        );
    }

    #[test]
    fn physics_world_events_accumulate_across_steps() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();

        // Create overlapping bodies
        let rb_a = RigidBodyBuilder::dynamic()
            .translation(Vector::new(0.0, 0.0))
            .build();
        let handle_a = pw.rigid_body_set.insert(rb_a);
        let col_a = ColliderBuilder::ball(10.0)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .build();
        let col_handle_a = pw.collider_set.insert_with_parent(
            col_a,
            handle_a,
            &mut pw.rigid_body_set,
        );

        let rb_b = RigidBodyBuilder::dynamic()
            .translation(Vector::new(5.0, 0.0))
            .build();
        let handle_b = pw.rigid_body_set.insert(rb_b);
        let col_b = ColliderBuilder::ball(10.0)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .build();
        let col_handle_b = pw.collider_set.insert_with_parent(
            col_b,
            handle_b,
            &mut pw.rigid_body_set,
        );

        // Register mapping
        let idx_a = col_handle_a.0.into_raw_parts().0 as usize;
        let idx_b = col_handle_b.0.into_raw_parts().0 as usize;
        let max_idx = idx_a.max(idx_b);
        pw.collider_to_entity.resize(max_idx + 1, None);
        pw.collider_to_entity[idx_a] = Some(10);
        pw.collider_to_entity[idx_b] = Some(20);

        // Step twice — events should accumulate
        pw.step();
        let count_after_first = pw.frame_collision_events.len();
        pw.step();
        // After second step, we should have at least as many events
        // (bodies may separate and re-collide, or just the initial Started stays)
        assert!(pw.frame_collision_events.len() >= count_after_first);
    }

    // --- physics_sync_pre tests ---

    #[test]
    fn physics_sync_pre_consumes_pending_rigid_body_dynamic() {
        use hecs::World;
        let mut world = World::new();
        let mut physics = PhysicsWorld::new();
        let entity_map = crate::command_processor::EntityMap::new();

        let entity = world.spawn((
            crate::components::Transform2D { x: 100.0, y: 200.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            PendingRigidBody::new(0), // dynamic
            crate::components::ExternalId(0),
        ));

        super::physics_sync_pre(&mut world, &mut physics, &entity_map);

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
        use hecs::World;
        let mut world = World::new();
        let mut physics = PhysicsWorld::new();
        let entity_map = crate::command_processor::EntityMap::new();

        let entity = world.spawn((
            crate::components::Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [10.0, 0.0, 0.0, 0.0]),
            crate::components::ExternalId(42),
        ));

        super::physics_sync_pre(&mut world, &mut physics, &entity_map);

        assert!(world.get::<&PendingRigidBody>(entity).is_err());
        assert!(world.get::<&PendingCollider>(entity).is_err());
        assert!(world.get::<&PhysicsColliderHandle>(entity).is_ok());
        assert_eq!(physics.collider_set.len(), 1);
    }

    #[test]
    fn physics_sync_pre_consumes_pending_collider_box() {
        use hecs::World;
        let mut world = World::new();
        let mut physics = PhysicsWorld::new();
        let entity_map = crate::command_processor::EntityMap::new();

        let entity = world.spawn((
            crate::components::Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(1, [32.0, 48.0, 0.0, 0.0]),
            crate::components::ExternalId(0),
        ));

        super::physics_sync_pre(&mut world, &mut physics, &entity_map);

        assert!(world.get::<&PhysicsColliderHandle>(entity).is_ok());
        assert_eq!(physics.collider_set.len(), 1);
    }

    #[test]
    fn physics_sync_pre_consumes_pending_collider_capsule() {
        use hecs::World;
        let mut world = World::new();
        let mut physics = PhysicsWorld::new();
        let entity_map = crate::command_processor::EntityMap::new();

        let entity = world.spawn((
            crate::components::Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(2, [20.0, 5.0, 0.0, 0.0]),
            crate::components::ExternalId(0),
        ));

        super::physics_sync_pre(&mut world, &mut physics, &entity_map);

        assert!(world.get::<&PhysicsColliderHandle>(entity).is_ok());
        assert_eq!(physics.collider_set.len(), 1);
    }
}

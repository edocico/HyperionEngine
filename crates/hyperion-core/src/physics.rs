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

    /// State result from the last `move_shape()` call.
    #[derive(Default)]
    pub struct CharacterState {
        pub grounded: bool,
        pub is_sliding_down_slope: bool,
    }

    /// A character controller entry: Rapier KCC + last-frame state.
    pub struct CharacterEntry {
        pub controller: rapier2d::control::KinematicCharacterController,
        pub state: CharacterState,
    }

    /// A live joint tracked in PhysicsWorld.joint_map.
    pub struct JointEntry {
        pub handle: rapier2d::prelude::ImpulseJointHandle,
        pub entity_a: u32,
        pub entity_b: u32,
        /// Joint kind, recorded at creation (Phase 16, snapshot readback).
        /// 0=Revolute, 1=Prismatic, 2=Fixed, 3=Rope, 4=Spring.
        /// Deriving the kind from a live `GenericJoint`'s locked-axes mask is
        /// fragile; one byte at creation time is not.
        pub kind: u8,
    }

    /// `JointEntry.kind` discriminants.
    pub const JOINT_KIND_REVOLUTE: u8 = 0;
    pub const JOINT_KIND_PRISMATIC: u8 = 1;
    pub const JOINT_KIND_FIXED: u8 = 2;
    pub const JOINT_KIND_ROPE: u8 = 3;
    pub const JOINT_KIND_SPRING: u8 = 4;

    /// The type of joint to create, parsed from ring buffer payloads.
    pub enum PendingJointType {
        Revolute { anchor_ax: f32, anchor_ay: f32 },
        Prismatic { axis_x: f32, axis_y: f32 },
        Fixed,
        Rope { max_dist: f32 },
        Spring { rest_length: f32 },
    }

    /// A pending joint creation. Consumed in physics_sync_pre() step 4.
    pub struct PendingJoint {
        pub joint_id: u32,
        pub entity_a_ext: u32,
        pub entity_b_ext: u32,
        pub joint_type: PendingJointType,
    }
}

#[cfg(feature = "physics-2d")]
pub use types::*;

// ---------------------------------------------------------------------------
// PhysicsWorld — wraps ALL Rapier simulation state
// ---------------------------------------------------------------------------

#[cfg(feature = "physics-2d")]
mod world {
    use rapier2d::prelude::*;
    use std::ptr::addr_of_mut;

    // SAFETY: wasm32 is single-threaded; static buffers accessed only from main thread.
    pub(crate) static mut RAYCAST_RESULT: [f32; 3] = [0.0; 3]; // [toi, normal_x, normal_y]
    pub(crate) static mut OVERLAP_RESULTS: Vec<u32> = Vec::new();

    /// Collision event translated to external entity IDs.
    #[repr(C)]
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct HyperionCollisionEvent {
        pub entity_a: u32,       // 4B
        pub entity_b: u32,       // 4B
        pub event_type: u8,      // 1B (0=started, 1=stopped)
        pub is_sensor: u8,       // 1B
        pub _pad: [u8; 2],       // 2B alignment
    }  // 12 bytes total, 4-byte aligned

    /// Contact force event translated to external entity IDs.
    #[repr(C)]
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct HyperionContactForceEvent {
        pub entity_a: u32,                  // 4B
        pub entity_b: u32,                  // 4B
        pub total_force_magnitude: f32,     // 4B
        pub max_force_direction_x: f32,     // 4B
        pub max_force_direction_y: f32,     // 4B
    }  // 20 bytes total, naturally aligned

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

        // Joint tracking
        pub joint_map: std::collections::HashMap<u32, super::types::JointEntry>,
        pub pending_joints: Vec<super::types::PendingJoint>,

        /// Character controller entries keyed by external entity ID.
        pub character_map: std::collections::HashMap<u32, super::types::CharacterEntry>,
        /// Pending MoveCharacter commands: (ext_id, dx, dy).
        /// Populated by process_commands, consumed in physics_sync_pre Pass 5.
        pub pending_moves: Vec<(u32, f32, f32)>,
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
                joint_map: std::collections::HashMap::new(),
                pending_joints: Vec::new(),
                character_map: std::collections::HashMap::new(),
                pending_moves: Vec::new(),
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

        /// Cast a ray and return the external entity ID of the closest hit, or -1.
        /// Results (toi, normal) written to RAYCAST_RESULT static buffer.
        pub fn raycast(&self, ox: f32, oy: f32, dx: f32, dy: f32, max_toi: f32) -> i32 {
            let qp = self.broad_phase.as_query_pipeline(
                self.narrow_phase.query_dispatcher(),
                &self.rigid_body_set,
                &self.collider_set,
                QueryFilter::default(),
            );
            let ray = Ray::new(Vector::new(ox, oy), Vector::new(dx, dy));
            match qp.cast_ray_and_get_normal(&ray, max_toi, true) {
                Some((col_handle, hit)) => {
                    // SAFETY: wasm32 is single-threaded
                    unsafe {
                        *addr_of_mut!(RAYCAST_RESULT) = [
                            hit.time_of_impact,
                            hit.normal.x,
                            hit.normal.y,
                        ];
                    }
                    self.collider_handle_to_entity(col_handle)
                        .map(|id| id as i32)
                        .unwrap_or(-1)
                }
                None => -1,
            }
        }

        /// Find all entities whose colliders overlap the given AABB.
        /// Returns the count; entity IDs written to OVERLAP_RESULTS (deduplicated).
        pub fn overlap_aabb(&self, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> u32 {
            let qp = self.broad_phase.as_query_pipeline(
                self.narrow_phase.query_dispatcher(),
                &self.rigid_body_set,
                &self.collider_set,
                QueryFilter::default(),
            );
            let aabb = Aabb::new(Vector::new(min_x, min_y), Vector::new(max_x, max_y));
            // SAFETY: wasm32 is single-threaded
            let results = unsafe { &mut *addr_of_mut!(OVERLAP_RESULTS) };
            results.clear();
            for (col_handle, _collider) in qp.intersect_aabb_conservative(aabb) {
                if let Some(ext_id) = self.collider_handle_to_entity(col_handle) {
                    results.push(ext_id);
                }
            }
            results.sort_unstable();
            results.dedup();
            results.len() as u32
        }

        /// Find all entities whose colliders overlap a circle at (cx, cy) with given radius.
        /// Returns the count; entity IDs written to OVERLAP_RESULTS (deduplicated, shared with overlap_aabb).
        pub fn overlap_circle(&self, cx: f32, cy: f32, radius: f32) -> u32 {
            let qp = self.broad_phase.as_query_pipeline(
                self.narrow_phase.query_dispatcher(),
                &self.rigid_body_set,
                &self.collider_set,
                QueryFilter::default(),
            );
            let shape = Ball::new(radius);
            let pose = Pose::translation(cx, cy);
            // SAFETY: wasm32 is single-threaded
            let results = unsafe { &mut *addr_of_mut!(OVERLAP_RESULTS) };
            results.clear();
            for (col_handle, _collider) in qp.intersect_shape(pose, &shape) {
                if let Some(ext_id) = self.collider_handle_to_entity(col_handle) {
                    results.push(ext_id);
                }
            }
            results.sort_unstable();
            results.dedup();
            results.len() as u32
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
                    event_type: if event.started() { 0 } else { 1 },
                    is_sensor: if event.sensor() { 1 } else { 0 },
                    _pad: [0; 2],
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
                    max_force_direction_x: event.max_force_direction.x,
                    max_force_direction_y: event.max_force_direction.y,
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
    entity_map: &crate::command_processor::EntityMap,
    dt: f32,
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

    // Pass 4: Consume pending joints (AFTER all bodies exist in Rapier)
    for pending in physics.pending_joints.drain(..) {
        let entity_a = match entity_map.get(pending.entity_a_ext) {
            Some(e) => e,
            None => continue,
        };
        let handle_a = match world.get::<&PhysicsBodyHandle>(entity_a) {
            Ok(h) => h.0,
            Err(_) => continue,
        };
        let entity_b = match entity_map.get(pending.entity_b_ext) {
            Some(e) => e,
            None => continue,
        };
        let handle_b = match world.get::<&PhysicsBodyHandle>(entity_b) {
            Ok(h) => h.0,
            Err(_) => continue,
        };

        let (joint, kind): (GenericJoint, u8) = match pending.joint_type {
            PendingJointType::Revolute { anchor_ax, anchor_ay } => (
                RevoluteJointBuilder::new()
                    .local_anchor1(point![anchor_ax, anchor_ay].into())
                    .build()
                    .into(),
                JOINT_KIND_REVOLUTE,
            ),
            PendingJointType::Prismatic { axis_x, axis_y } => (
                PrismaticJointBuilder::new(vector![axis_x, axis_y].into())
                    .build()
                    .into(),
                JOINT_KIND_PRISMATIC,
            ),
            PendingJointType::Fixed => (FixedJointBuilder::new().build().into(), JOINT_KIND_FIXED),
            PendingJointType::Rope { max_dist } => {
                (RopeJointBuilder::new(max_dist).build().into(), JOINT_KIND_ROPE)
            }
            PendingJointType::Spring { rest_length } => (
                SpringJointBuilder::new(rest_length, 100.0, 5.0).build().into(),
                JOINT_KIND_SPRING,
            ),
        };

        let jh = physics.impulse_joint_set.insert(handle_a, handle_b, joint, true);
        physics.joint_map.insert(pending.joint_id, JointEntry {
            handle: jh,
            entity_a: pending.entity_a_ext,
            entity_b: pending.entity_b_ext,
            kind,
        });
    }

    // Pass 5: Character controller moves.
    // Invariant: CC moves once per frame. pending_moves is populated by
    // process_commands (1x/frame) and drained here on the first tick.
    for (ext_id, dx, dy) in physics.pending_moves.drain(..) {
        let Some(entry) = physics.character_map.get_mut(&ext_id) else { continue };
        let Some(entity) = entity_map.get(ext_id) else { continue };
        let Ok(body_handle) = world.get::<&PhysicsBodyHandle>(entity) else { continue };

        let body = &physics.rigid_body_set[body_handle.0];
        if !body.is_kinematic() { continue; }
        let colliders_slice = body.colliders();
        if colliders_slice.is_empty() { continue; }

        // Copy shape + pos out of borrowed state BEFORE creating QueryPipeline.
        // as_query_pipeline() borrows rigid_body_set + collider_set — overlapping
        // borrows with shape/pos would fail the borrow checker.
        let collider = &physics.collider_set[colliders_slice[0]];
        let shape = collider.shared_shape().clone();
        let pos = *body.position(); // Isometry is Copy

        let qp = physics.broad_phase.as_query_pipeline(
            physics.narrow_phase.query_dispatcher(),
            &physics.rigid_body_set,
            &physics.collider_set,
            QueryFilter::default().exclude_rigid_body(body_handle.0),
        );

        let desired = Vector::new(dx, dy);
        let corrected = entry.controller.move_shape(
            dt,
            &qp, &*shape, &pos, desired, |_| {},
        );

        let body_mut = &mut physics.rigid_body_set[body_handle.0];
        let cur_translation = body_mut.translation();
        let new_pos = Vector::new(
            cur_translation.x + corrected.translation.x,
            cur_translation.y + corrected.translation.y,
        );
        body_mut.set_next_kinematic_translation(new_pos);

        entry.state.grounded = corrected.grounded;
        entry.state.is_sliding_down_slope = corrected.is_sliding_down_slope;
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

// ---------------------------------------------------------------------------
// physics_sync_post — write Rapier body state back to ECS components
// ---------------------------------------------------------------------------

#[cfg(feature = "physics-2d")]
pub fn physics_sync_post(world: &mut hecs::World, physics: &PhysicsWorld) {
    use crate::components::*;

    // 2D entities
    for (t2d, handle) in world.query_mut::<(&mut Transform2D, &PhysicsBodyHandle)>() {
        let body = &physics.rigid_body_set[handle.0];
        if body.is_sleeping() {
            continue;
        }
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
        if body.is_sleeping() {
            continue;
        }
        let t = body.translation();
        pos.0.x = t.x;
        pos.0.y = t.y;
        rot.0 = glam::Quat::from_rotation_z(body.rotation().angle());
    }
}

// ---------------------------------------------------------------------------
// snapshot — physics section serialization (Phase 16 Track C)
//
// Rebuild-from-state: records are read back from the live Rapier sets at
// snapshot time and the world is rebuilt from them on restore. Solver caches
// (warm-start impulses, manifolds, islands) are intentionally NOT serialized:
// two restores of the same snapshot are identical to each other, but not to
// the uninterrupted original run (design doc §3.6, Invariant I-5).
// ---------------------------------------------------------------------------

#[cfg(all(feature = "physics-2d", feature = "dev-tools"))]
pub mod snapshot {
    use super::*;
    use crate::command_processor::EntityMap;
    use crate::components::ExternalId;
    use hecs::World;
    use rapier2d::control::{CharacterAutostep, CharacterLength};
    use rapier2d::prelude::*;

    // Per-axis serialized joint state: motor (5 f32) + limits (2 f32).
    const AXES: usize = 3; // 2D: LinX, LinY, AngX

    fn push_f32(buf: &mut Vec<u8>, v: f32) {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    fn push_u32(buf: &mut Vec<u8>, v: u32) {
        buf.extend_from_slice(&v.to_le_bytes());
    }

    struct Reader<'a> {
        data: &'a [u8],
        cursor: usize,
    }
    impl<'a> Reader<'a> {
        fn u8(&mut self) -> Option<u8> {
            let v = *self.data.get(self.cursor)?;
            self.cursor += 1;
            Some(v)
        }
        fn u32(&mut self) -> Option<u32> {
            let s = self.data.get(self.cursor..self.cursor + 4)?;
            self.cursor += 4;
            Some(u32::from_le_bytes(s.try_into().unwrap()))
        }
        fn f32(&mut self) -> Option<f32> {
            let s = self.data.get(self.cursor..self.cursor + 4)?;
            self.cursor += 4;
            Some(f32::from_le_bytes(s.try_into().unwrap()))
        }
    }

    fn character_length_parts(cl: &CharacterLength) -> (bool, f32) {
        match cl {
            CharacterLength::Relative(v) => (true, *v),
            CharacterLength::Absolute(v) => (false, *v),
        }
    }

    /// Serialize the physics section (bodies, colliders, joints, character
    /// controllers) into `buf`. Records are ordered by external ID / joint ID
    /// so the byte stream is deterministic (Invariant I-2).
    pub fn serialize_physics(
        buf: &mut Vec<u8>,
        world: &World,
        physics: &PhysicsWorld,
    ) {
        // ── World config (engine_physics_configure knobs) ──
        push_f32(buf, physics.gravity.x);
        push_f32(buf, physics.gravity.y);
        push_f32(buf, physics.integration_parameters.length_unit);

        // ── Bodies ──
        let mut bodies: Vec<(u32, RigidBodyHandle)> = world
            .query::<(&ExternalId, &PhysicsBodyHandle)>()
            .iter()
            .map(|(ext, h)| (ext.0, h.0))
            .collect();
        bodies.sort_unstable_by_key(|(ext, _)| *ext);

        push_u32(buf, bodies.len() as u32);
        for (ext_id, handle) in &bodies {
            let body = &physics.rigid_body_set[*handle];
            push_u32(buf, *ext_id);
            let body_type: u8 = match body.body_type() {
                RigidBodyType::Dynamic => 0,
                RigidBodyType::Fixed => 1,
                RigidBodyType::KinematicPositionBased => 2,
                RigidBodyType::KinematicVelocityBased => 3,
            };
            buf.push(body_type);
            let mut flags = 0u8;
            if body.is_sleeping() {
                flags |= 1;
            }
            if body.is_ccd_enabled() {
                flags |= 2;
            }
            buf.push(flags);
            let t = body.translation();
            push_f32(buf, t.x);
            push_f32(buf, t.y);
            push_f32(buf, body.rotation().angle());
            let lv = body.linvel();
            push_f32(buf, lv.x);
            push_f32(buf, lv.y);
            push_f32(buf, body.angvel());
            push_f32(buf, body.gravity_scale());
            push_f32(buf, body.linear_damping());
            push_f32(buf, body.angular_damping());
        }

        // ── Colliders ──
        let mut colliders: Vec<(u32, ColliderHandle)> = world
            .query::<(&ExternalId, &PhysicsColliderHandle)>()
            .iter()
            .map(|(ext, h)| (ext.0, h.0))
            .collect();
        colliders.sort_unstable_by_key(|(ext, _)| *ext);

        push_u32(buf, colliders.len() as u32);
        for (ext_id, handle) in &colliders {
            let collider = &physics.collider_set[*handle];
            push_u32(buf, *ext_id);
            let (shape_type, params): (u8, [f32; 3]) = match collider.shape().as_typed_shape() {
                TypedShape::Ball(b) => (0, [b.radius, 0.0, 0.0]),
                TypedShape::Cuboid(c) => (1, [c.half_extents.x, c.half_extents.y, 0.0]),
                TypedShape::Capsule(c) => (2, [c.half_height(), c.radius, 0.0]),
                // Unreachable today: build_collider_shape only creates the
                // three shapes above. Serialize as a zero-size ball rather
                // than corrupting the stream.
                _ => (0, [0.0, 0.0, 0.0]),
            };
            buf.push(shape_type);
            buf.push(u8::from(collider.is_sensor()));
            for p in params {
                push_f32(buf, p);
            }
            push_f32(buf, collider.density());
            push_f32(buf, collider.friction());
            push_f32(buf, collider.restitution());
            let groups = collider.collision_groups();
            push_u32(buf, groups.memberships.bits());
            push_u32(buf, groups.filter.bits());
            push_u32(buf, collider.active_events().bits());
        }

        // ── Joints ──
        let mut joint_ids: Vec<u32> = physics.joint_map.keys().copied().collect();
        joint_ids.sort_unstable();

        push_u32(buf, joint_ids.len() as u32);
        for joint_id in &joint_ids {
            let entry = &physics.joint_map[joint_id];
            push_u32(buf, *joint_id);
            buf.push(entry.kind);
            push_u32(buf, entry.entity_a);
            push_u32(buf, entry.entity_b);

            // A removed Rapier joint with a stale map entry is a bug, but
            // serialize defaults rather than panicking inside a snapshot.
            let data: GenericJoint = physics
                .impulse_joint_set
                .get(entry.handle)
                .map(|j| j.data)
                .unwrap_or_default();

            let f1 = &data.local_frame1;
            push_f32(buf, f1.translation.x);
            push_f32(buf, f1.translation.y);
            push_f32(buf, f1.rotation.angle());
            let f2 = &data.local_frame2;
            push_f32(buf, f2.translation.x);
            push_f32(buf, f2.translation.y);
            push_f32(buf, f2.rotation.angle());

            buf.push(data.locked_axes.bits());
            buf.push(data.limit_axes.bits());
            buf.push(data.motor_axes.bits());
            buf.push(data.coupled_axes.bits());
            buf.push(u8::from(data.contacts_enabled));

            for i in 0..AXES {
                let m = &data.motors[i];
                push_f32(buf, m.target_vel);
                push_f32(buf, m.target_pos);
                push_f32(buf, m.stiffness);
                push_f32(buf, m.damping);
                push_f32(buf, m.max_force);
                buf.push(match m.model {
                    MotorModel::AccelerationBased => 0,
                    MotorModel::ForceBased => 1,
                });
                let l = &data.limits[i];
                push_f32(buf, l.min);
                push_f32(buf, l.max);
            }
        }

        // ── Character controllers ──
        let mut cc_ids: Vec<u32> = physics.character_map.keys().copied().collect();
        cc_ids.sort_unstable();

        push_u32(buf, cc_ids.len() as u32);
        for ext_id in &cc_ids {
            let entry = &physics.character_map[ext_id];
            let c = &entry.controller;
            push_u32(buf, *ext_id);

            let mut flags = 0u8;
            if c.slide {
                flags |= 0x01;
            }
            let (mut step_h, mut step_w) = (0.0f32, 0.0f32);
            if let Some(autostep) = &c.autostep {
                flags |= 0x02;
                if autostep.include_dynamic_bodies {
                    flags |= 0x04;
                }
                let (rel_h, h) = character_length_parts(&autostep.max_height);
                let (rel_w, w) = character_length_parts(&autostep.min_width);
                if rel_h {
                    flags |= 0x10;
                }
                if rel_w {
                    flags |= 0x20;
                }
                step_h = h;
                step_w = w;
            }
            let mut snap_d = 0.0f32;
            if let Some(snap) = &c.snap_to_ground {
                flags |= 0x08;
                let (rel_s, s) = character_length_parts(snap);
                if rel_s {
                    flags |= 0x40;
                }
                snap_d = s;
            }
            buf.push(flags);
            push_f32(buf, c.max_slope_climb_angle);
            push_f32(buf, c.min_slope_slide_angle);
            push_f32(buf, step_h);
            push_f32(buf, step_w);
            push_f32(buf, snap_d);

            let mut state = 0u8;
            if entry.state.grounded {
                state |= 1;
            }
            if entry.state.is_sliding_down_slope {
                state |= 2;
            }
            buf.push(state);
        }
    }

    /// Rebuild a fresh `PhysicsWorld` from a serialized physics section and
    /// re-insert handle components on the restored entities.
    ///
    /// Returns `false` on malformed data. `physics` must be a fresh
    /// `PhysicsWorld::new()` (the caller replaces the old one wholesale —
    /// this is what fixes the pre-Phase-16 orphan-body bug).
    pub fn restore_physics(
        section: &[u8],
        world: &mut World,
        entity_map: &EntityMap,
        physics: &mut PhysicsWorld,
    ) -> bool {
        let mut r = Reader { data: section, cursor: 0 };
        macro_rules! read {
            ($m:ident) => {
                match r.$m() {
                    Some(v) => v,
                    None => return false,
                }
            };
        }

        // ── World config ──
        let gx = read!(f32);
        let gy = read!(f32);
        let length_unit = read!(f32);
        physics.gravity = Vector::new(gx, gy);
        physics.integration_parameters.length_unit = length_unit;

        // ── Bodies ──
        let body_count = read!(u32);
        for _ in 0..body_count {
            let ext_id = read!(u32);
            let body_type = read!(u8);
            let flags = read!(u8);
            let tx = read!(f32);
            let ty = read!(f32);
            let rot = read!(f32);
            let lvx = read!(f32);
            let lvy = read!(f32);
            let angv = read!(f32);
            let gravity_scale = read!(f32);
            let lin_damping = read!(f32);
            let ang_damping = read!(f32);

            let Some(entity) = entity_map.get(ext_id) else {
                continue;
            };

            let builder = match body_type {
                0 => RigidBodyBuilder::dynamic(),
                1 => RigidBodyBuilder::fixed(),
                2 => RigidBodyBuilder::kinematic_position_based(),
                3 => RigidBodyBuilder::kinematic_velocity_based(),
                _ => return false,
            };
            let rb = builder
                .translation(Vector::new(tx, ty))
                .rotation(rot)
                .linvel(Vector::new(lvx, lvy))
                .angvel(angv)
                .gravity_scale(gravity_scale)
                .linear_damping(lin_damping)
                .angular_damping(ang_damping)
                .ccd_enabled(flags & 2 != 0)
                .build();

            let handle = physics.rigid_body_set.insert(rb);
            if flags & 1 != 0 {
                physics.rigid_body_set[handle].sleep();
            }
            let _ = world.insert(entity, (PhysicsBodyHandle(handle), PhysicsControlled));
        }

        // ── Colliders ──
        let collider_count = read!(u32);
        for _ in 0..collider_count {
            let ext_id = read!(u32);
            let shape_type = read!(u8);
            let is_sensor = read!(u8);
            let p0 = read!(f32);
            let p1 = read!(f32);
            let _p2 = read!(f32);
            let density = read!(f32);
            let friction = read!(f32);
            let restitution = read!(f32);
            let memberships = read!(u32);
            let filter = read!(u32);
            let active_events = read!(u32);

            let Some(entity) = entity_map.get(ext_id) else {
                continue;
            };
            let Ok(body_handle) = world.get::<&PhysicsBodyHandle>(entity).map(|h| h.0) else {
                continue;
            };

            let builder = match shape_type {
                0 => ColliderBuilder::ball(p0),
                1 => ColliderBuilder::cuboid(p0, p1),
                2 => ColliderBuilder::capsule_y(p0, p1),
                _ => return false,
            };
            let collider = builder
                .sensor(is_sensor != 0)
                .density(density)
                .friction(friction)
                .restitution(restitution)
                .collision_groups(InteractionGroups::new(
                    Group::from_bits_truncate(memberships),
                    Group::from_bits_truncate(filter),
                    InteractionTestMode::And,
                ))
                .active_events(ActiveEvents::from_bits_truncate(active_events))
                .build();

            let col_handle = physics.collider_set.insert_with_parent(
                collider,
                body_handle,
                &mut physics.rigid_body_set,
            );

            // Reverse map for event translation (mirrors physics_sync_pre).
            let idx = col_handle.0.into_raw_parts().0 as usize;
            if idx >= physics.collider_to_entity.len() {
                physics.collider_to_entity.resize(idx + 1, None);
            }
            physics.collider_to_entity[idx] = Some(ext_id);

            let _ = world.insert_one(entity, PhysicsColliderHandle(col_handle));
        }

        // ── Joints ──
        let joint_count = read!(u32);
        for _ in 0..joint_count {
            let joint_id = read!(u32);
            let kind = read!(u8);
            let entity_a = read!(u32);
            let entity_b = read!(u32);
            let f1x = read!(f32);
            let f1y = read!(f32);
            let f1a = read!(f32);
            let f2x = read!(f32);
            let f2y = read!(f32);
            let f2a = read!(f32);
            let locked = read!(u8);
            let limit_axes = read!(u8);
            let motor_axes = read!(u8);
            let coupled = read!(u8);
            let contacts = read!(u8);

            let mut motors = [JointMotor::default(); AXES];
            let mut limits = [JointLimits::default(); AXES];
            for i in 0..AXES {
                motors[i].target_vel = read!(f32);
                motors[i].target_pos = read!(f32);
                motors[i].stiffness = read!(f32);
                motors[i].damping = read!(f32);
                motors[i].max_force = read!(f32);
                motors[i].model = match read!(u8) {
                    0 => MotorModel::AccelerationBased,
                    1 => MotorModel::ForceBased,
                    _ => return false,
                };
                limits[i].min = read!(f32);
                limits[i].max = read!(f32);
            }

            let (Some(ea), Some(eb)) = (entity_map.get(entity_a), entity_map.get(entity_b))
            else {
                continue;
            };
            let (Ok(ha), Ok(hb)) = (
                world.get::<&PhysicsBodyHandle>(ea).map(|h| h.0),
                world.get::<&PhysicsBodyHandle>(eb).map(|h| h.0),
            ) else {
                continue;
            };

            let Some(locked_axes) = JointAxesMask::from_bits(locked) else {
                return false;
            };
            let mut data = GenericJoint::new(locked_axes);
            data.local_frame1 = Pose::new(Vector::new(f1x, f1y), f1a);
            data.local_frame2 = Pose::new(Vector::new(f2x, f2y), f2a);
            data.limit_axes = JointAxesMask::from_bits(limit_axes).unwrap_or(locked_axes);
            data.motor_axes = JointAxesMask::from_bits(motor_axes).unwrap_or(locked_axes);
            data.coupled_axes = JointAxesMask::from_bits(coupled).unwrap_or(locked_axes);
            data.contacts_enabled = contacts != 0;
            data.motors = motors;
            data.limits = limits;

            let handle = physics.impulse_joint_set.insert(ha, hb, data, true);
            physics.joint_map.insert(
                joint_id,
                JointEntry { handle, entity_a, entity_b, kind },
            );
        }

        // ── Character controllers ──
        let cc_count = read!(u32);
        for _ in 0..cc_count {
            let ext_id = read!(u32);
            let flags = read!(u8);
            let climb = read!(f32);
            let slide_angle = read!(f32);
            let step_h = read!(f32);
            let step_w = read!(f32);
            let snap_d = read!(f32);
            let state = read!(u8);

            let controller = rapier2d::control::KinematicCharacterController {
                slide: flags & 0x01 != 0,
                max_slope_climb_angle: climb,
                min_slope_slide_angle: slide_angle,
                autostep: if flags & 0x02 != 0 {
                    Some(CharacterAutostep {
                        max_height: if flags & 0x10 != 0 {
                            CharacterLength::Relative(step_h)
                        } else {
                            CharacterLength::Absolute(step_h)
                        },
                        min_width: if flags & 0x20 != 0 {
                            CharacterLength::Relative(step_w)
                        } else {
                            CharacterLength::Absolute(step_w)
                        },
                        include_dynamic_bodies: flags & 0x04 != 0,
                    })
                } else {
                    None
                },
                snap_to_ground: if flags & 0x08 != 0 {
                    Some(if flags & 0x40 != 0 {
                        CharacterLength::Relative(snap_d)
                    } else {
                        CharacterLength::Absolute(snap_d)
                    })
                } else {
                    None
                },
                ..Default::default()
            };

            physics.character_map.insert(
                ext_id,
                CharacterEntry {
                    controller,
                    state: CharacterState {
                        grounded: state & 1 != 0,
                        is_sliding_down_slope: state & 2 != 0,
                    },
                },
            );
        }

        // The entire section must have been consumed.
        r.cursor == section.len()
    }
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
        assert_eq!(evt.event_type, 0);
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

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

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

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

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

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

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

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        assert!(world.get::<&PhysicsColliderHandle>(entity).is_ok());
        assert_eq!(physics.collider_set.len(), 1);
    }

    // --- physics_sync_post tests ---

    #[test]
    fn physics_sync_post_writes_back_transform2d() {
        use hecs::World;
        use crate::components::*;
        let mut world = World::new();
        let mut physics = PhysicsWorld::new();
        let entity_map = crate::command_processor::EntityMap::new();

        // Create entity with pending body + collider (collider gives mass)
        let entity = world.spawn((
            Transform2D { x: 0.0, y: 0.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            PendingRigidBody::new(0), // dynamic
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]), // circle r=5
            ExternalId(0),
        ));

        // Consume pending -> create Rapier body + collider
        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        // Step physics (gravity should move the body)
        for _ in 0..10 {
            physics.step();
        }

        // Sync back
        super::physics_sync_post(&mut world, &physics);

        let t = world.get::<&Transform2D>(entity).unwrap();
        // With gravity=(0,980) and length_unit=100, body should have moved down
        assert!(t.y > 0.1, "body should have fallen: y={}", t.y);
    }

    #[test]
    fn physics_sync_post_skips_sleeping_bodies() {
        use hecs::World;
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
        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);
        physics.step();
        super::physics_sync_post(&mut world, &physics);

        let t = world.get::<&Transform2D>(entity).unwrap();
        // Fixed body stays at same position
        assert!((t.x - 50.0).abs() < 0.01);
        assert!((t.y - 50.0).abs() < 0.01);
    }

    #[test]
    fn collision_event_repr_c_size() {
        assert_eq!(std::mem::size_of::<HyperionCollisionEvent>(), 12);
    }

    #[test]
    fn collision_event_has_is_sensor_field() {
        let evt = HyperionCollisionEvent {
            entity_a: 1,
            entity_b: 2,
            event_type: 0,
            is_sensor: 1,
            _pad: [0; 2],
        };
        assert_eq!(evt.is_sensor, 1);
        assert_eq!(evt.event_type, 0);
    }

    #[test]
    fn contact_force_event_repr_c_size() {
        assert_eq!(std::mem::size_of::<HyperionContactForceEvent>(), 20);
    }

    #[test]
    fn sensor_event_flagged_correctly() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0);

        // Body A: dynamic with sensor collider
        let rb_a = RigidBodyBuilder::dynamic()
            .translation(Vector::new(0.0, 0.0))
            .build();
        let handle_a = pw.rigid_body_set.insert(rb_a);
        let col_a = ColliderBuilder::ball(10.0)
            .sensor(true)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .build();
        let col_handle_a = pw.collider_set.insert_with_parent(
            col_a, handle_a, &mut pw.rigid_body_set,
        );

        // Body B: dynamic with normal collider, overlapping
        let rb_b = RigidBodyBuilder::dynamic()
            .translation(Vector::new(5.0, 0.0))
            .build();
        let handle_b = pw.rigid_body_set.insert(rb_b);
        let col_b = ColliderBuilder::ball(10.0)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            .build();
        let col_handle_b = pw.collider_set.insert_with_parent(
            col_b, handle_b, &mut pw.rigid_body_set,
        );

        // Register reverse mapping
        let idx_a = col_handle_a.0.into_raw_parts().0 as usize;
        let idx_b = col_handle_b.0.into_raw_parts().0 as usize;
        let max_idx = idx_a.max(idx_b);
        pw.collider_to_entity.resize(max_idx + 1, None);
        pw.collider_to_entity[idx_a] = Some(10);
        pw.collider_to_entity[idx_b] = Some(20);

        pw.step();

        assert!(
            !pw.frame_collision_events.is_empty(),
            "expected sensor collision event"
        );
        let evt = &pw.frame_collision_events[0];
        assert_eq!(evt.is_sensor, 1, "sensor flag should be set");
        assert_eq!(evt.event_type, 0, "should be a started event");
    }

    // --- Raycast tests ---

    #[test]
    fn raycast_hits_collider() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0);

        // Static body with circle at (100, 0), radius 10
        let rb = RigidBodyBuilder::fixed()
            .translation(Vector::new(100.0, 0.0))
            .build();
        let handle = pw.rigid_body_set.insert(rb);
        let col = ColliderBuilder::ball(10.0).build();
        let col_handle = pw.collider_set.insert_with_parent(
            col, handle, &mut pw.rigid_body_set,
        );
        let idx = col_handle.0.into_raw_parts().0 as usize;
        pw.collider_to_entity.resize(idx + 1, None);
        pw.collider_to_entity[idx] = Some(42);

        // Step once so BVH is built
        pw.step();

        // Ray from origin → +X, should hit at toi ~ 90 (100 - 10 radius)
        let entity_id = pw.raycast(0.0, 0.0, 1.0, 0.0, 200.0);
        assert_eq!(entity_id, 42);

        let result = unsafe { *std::ptr::addr_of!(super::world::RAYCAST_RESULT) };
        assert!((result[0] - 90.0).abs() < 1.0, "toi should be ~90, got {}", result[0]);
    }

    #[test]
    fn raycast_misses_empty_world() {
        let mut pw = PhysicsWorld::new();
        pw.step();

        let entity_id = pw.raycast(0.0, 0.0, 1.0, 0.0, 100.0);
        assert_eq!(entity_id, -1);
    }

    // --- AABB overlap tests ---

    #[test]
    fn overlap_aabb_finds_entities() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0);

        for (x, ext_id) in [(50.0, 10u32), (80.0, 20u32)] {
            let rb = RigidBodyBuilder::fixed()
                .translation(Vector::new(x, 0.0))
                .build();
            let handle = pw.rigid_body_set.insert(rb);
            let col = ColliderBuilder::ball(5.0).build();
            let col_handle = pw.collider_set.insert_with_parent(
                col, handle, &mut pw.rigid_body_set,
            );
            let idx = col_handle.0.into_raw_parts().0 as usize;
            if idx >= pw.collider_to_entity.len() {
                pw.collider_to_entity.resize(idx + 1, None);
            }
            pw.collider_to_entity[idx] = Some(ext_id);
        }

        pw.step();

        let count = pw.overlap_aabb(0.0, -50.0, 100.0, 50.0);
        assert!(count >= 2, "expected at least 2 entities, got {}", count);

        let results = unsafe { &*std::ptr::addr_of!(super::world::OVERLAP_RESULTS) };
        assert!(results.contains(&10));
        assert!(results.contains(&20));
    }

    #[test]
    fn overlap_aabb_deduplicates() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0);

        let rb = RigidBodyBuilder::fixed()
            .translation(Vector::new(50.0, 0.0))
            .build();
        let handle = pw.rigid_body_set.insert(rb);

        let col1 = ColliderBuilder::ball(5.0).build();
        let ch1 = pw.collider_set.insert_with_parent(col1, handle, &mut pw.rigid_body_set);
        let col2 = ColliderBuilder::ball(3.0).build();
        let ch2 = pw.collider_set.insert_with_parent(col2, handle, &mut pw.rigid_body_set);

        for ch in [ch1, ch2] {
            let idx = ch.0.into_raw_parts().0 as usize;
            if idx >= pw.collider_to_entity.len() {
                pw.collider_to_entity.resize(idx + 1, None);
            }
            pw.collider_to_entity[idx] = Some(99);
        }

        pw.step();

        let count = pw.overlap_aabb(0.0, -50.0, 100.0, 50.0);
        let results = unsafe { &*std::ptr::addr_of!(super::world::OVERLAP_RESULTS) };
        let occurrences = results.iter().filter(|&&id| id == 99).count();
        assert_eq!(occurrences, 1, "entity should be deduplicated, found {} times", occurrences);
        assert_eq!(count as usize, results.len());
    }

    // --- Circle overlap tests ---

    #[test]
    fn overlap_circle_finds_entities() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0);

        let rb = RigidBodyBuilder::fixed()
            .translation(Vector::new(50.0, 0.0))
            .build();
        let handle = pw.rigid_body_set.insert(rb);
        let col = ColliderBuilder::ball(5.0).build();
        let col_handle = pw.collider_set.insert_with_parent(
            col, handle, &mut pw.rigid_body_set,
        );
        let idx = col_handle.0.into_raw_parts().0 as usize;
        pw.collider_to_entity.resize(idx + 1, None);
        pw.collider_to_entity[idx] = Some(77);

        pw.step();

        let count = pw.overlap_circle(50.0, 0.0, 20.0);
        assert!(count >= 1, "expected at least 1 entity, got {}", count);
        let results = unsafe { &*std::ptr::addr_of!(super::world::OVERLAP_RESULTS) };
        assert!(results.contains(&77));
    }

    #[test]
    fn overlap_circle_excludes_outside() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0);

        let rb = RigidBodyBuilder::fixed()
            .translation(Vector::new(1000.0, 1000.0))
            .build();
        let handle = pw.rigid_body_set.insert(rb);
        let col = ColliderBuilder::ball(5.0).build();
        let col_handle = pw.collider_set.insert_with_parent(
            col, handle, &mut pw.rigid_body_set,
        );
        let idx = col_handle.0.into_raw_parts().0 as usize;
        pw.collider_to_entity.resize(idx + 1, None);
        pw.collider_to_entity[idx] = Some(88);

        pw.step();

        let count = pw.overlap_circle(0.0, 0.0, 10.0);
        assert_eq!(count, 0, "expected 0 entities, got {}", count);
    }

    // --- Joint type tests ---

    #[test]
    fn joint_entry_fields() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        // Create two bodies so we can get a real ImpulseJointHandle
        let rb_a = RigidBodyBuilder::dynamic().build();
        let h_a = pw.rigid_body_set.insert(rb_a);
        let rb_b = RigidBodyBuilder::dynamic().build();
        let h_b = pw.rigid_body_set.insert(rb_b);
        let joint = RevoluteJointBuilder::new().build();
        let jh = pw.impulse_joint_set.insert(h_a, h_b, joint, true);

        let entry = JointEntry {
            handle: jh,
            entity_a: 10,
            entity_b: 20,
            kind: JOINT_KIND_REVOLUTE,
        };
        assert_eq!(entry.entity_a, 10);
        assert_eq!(entry.entity_b, 20);
        assert_eq!(entry.handle, jh);
    }

    #[test]
    fn pending_joint_staging_buffer() {
        let mut pw = PhysicsWorld::new();
        assert!(pw.pending_joints.is_empty());

        pw.pending_joints.push(PendingJoint {
            joint_id: 1,
            entity_a_ext: 100,
            entity_b_ext: 200,
            joint_type: PendingJointType::Revolute { anchor_ax: 5.0, anchor_ay: 10.0 },
        });
        assert_eq!(pw.pending_joints.len(), 1);
        assert_eq!(pw.pending_joints[0].joint_id, 1);
        assert_eq!(pw.pending_joints[0].entity_a_ext, 100);
        assert_eq!(pw.pending_joints[0].entity_b_ext, 200);
    }

    // --- Joint consumption tests (physics_sync_pre step 4) ---

    /// Helper: create two entities with bodies+colliders, register in entity_map.
    fn setup_two_body_entities() -> (
        hecs::World,
        PhysicsWorld,
        crate::command_processor::EntityMap,
    ) {
        use crate::components::*;

        let mut world = hecs::World::new();
        let mut physics = PhysicsWorld::new();
        let mut entity_map = crate::command_processor::EntityMap::new();

        // Entity A (ext_id=0)
        let ea = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, ea);

        // Entity B (ext_id=1)
        let eb = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(1),
        ));
        entity_map.insert(1, eb);

        // Consume bodies + colliders (passes 1-3)
        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);
        assert_eq!(physics.rigid_body_set.len(), 2);
        assert_eq!(physics.collider_set.len(), 2);

        (world, physics, entity_map)
    }

    #[test]
    fn revolute_joint_creates_rapier_joint() {
        let (mut world, mut physics, entity_map) = setup_two_body_entities();

        physics.pending_joints.push(PendingJoint {
            joint_id: 1,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Revolute { anchor_ax: 0.0, anchor_ay: 0.0 },
        });

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        assert!(physics.pending_joints.is_empty(), "pending_joints should be drained");
        assert_eq!(physics.joint_map.len(), 1);
        assert!(physics.joint_map.contains_key(&1));
        let entry = &physics.joint_map[&1];
        assert_eq!(entry.entity_a, 0);
        assert_eq!(entry.entity_b, 1);
        assert!(physics.impulse_joint_set.get(entry.handle).is_some());
    }

    #[test]
    fn prismatic_joint_creation() {
        let (mut world, mut physics, entity_map) = setup_two_body_entities();

        physics.pending_joints.push(PendingJoint {
            joint_id: 2,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Prismatic { axis_x: 1.0, axis_y: 0.0 },
        });

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        assert_eq!(physics.joint_map.len(), 1);
        assert!(physics.joint_map.contains_key(&2));
        assert!(physics.impulse_joint_set.get(physics.joint_map[&2].handle).is_some());
    }

    #[test]
    fn fixed_joint_creation() {
        let (mut world, mut physics, entity_map) = setup_two_body_entities();

        physics.pending_joints.push(PendingJoint {
            joint_id: 3,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Fixed,
        });

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        assert_eq!(physics.joint_map.len(), 1);
        assert!(physics.joint_map.contains_key(&3));
        assert!(physics.impulse_joint_set.get(physics.joint_map[&3].handle).is_some());
    }

    #[test]
    fn rope_joint_creation() {
        let (mut world, mut physics, entity_map) = setup_two_body_entities();

        physics.pending_joints.push(PendingJoint {
            joint_id: 4,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Rope { max_dist: 50.0 },
        });

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        assert_eq!(physics.joint_map.len(), 1);
        assert!(physics.joint_map.contains_key(&4));
        assert!(physics.impulse_joint_set.get(physics.joint_map[&4].handle).is_some());
    }

    #[test]
    fn spring_joint_creation() {
        let (mut world, mut physics, entity_map) = setup_two_body_entities();

        physics.pending_joints.push(PendingJoint {
            joint_id: 5,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Spring { rest_length: 30.0 },
        });

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        assert_eq!(physics.joint_map.len(), 1);
        assert!(physics.joint_map.contains_key(&5));
        assert!(physics.impulse_joint_set.get(physics.joint_map[&5].handle).is_some());
    }

    #[test]
    fn joint_entry_records_kind_per_type() {
        let (mut world, mut physics, entity_map) = setup_two_body_entities();

        let types = [
            PendingJointType::Revolute { anchor_ax: 0.0, anchor_ay: 0.0 },
            PendingJointType::Prismatic { axis_x: 1.0, axis_y: 0.0 },
            PendingJointType::Fixed,
            PendingJointType::Rope { max_dist: 50.0 },
            PendingJointType::Spring { rest_length: 30.0 },
        ];
        for (i, joint_type) in types.into_iter().enumerate() {
            physics.pending_joints.push(PendingJoint {
                joint_id: i as u32 + 1,
                entity_a_ext: 0,
                entity_b_ext: 1,
                joint_type,
            });
        }

        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        assert_eq!(physics.joint_map.len(), 5);
        assert_eq!(physics.joint_map[&1].kind, JOINT_KIND_REVOLUTE);
        assert_eq!(physics.joint_map[&2].kind, JOINT_KIND_PRISMATIC);
        assert_eq!(physics.joint_map[&3].kind, JOINT_KIND_FIXED);
        assert_eq!(physics.joint_map[&4].kind, JOINT_KIND_ROPE);
        assert_eq!(physics.joint_map[&5].kind, JOINT_KIND_SPRING);
    }

    #[test]
    fn joint_consumption_order() {
        use crate::components::*;

        // Stage pending bodies, colliders, AND joints all at once,
        // then run physics_sync_pre — bodies must be consumed (step 1)
        // before joints can look up PhysicsBodyHandle (step 4).
        let mut world = hecs::World::new();
        let mut physics = PhysicsWorld::new();
        let mut entity_map = crate::command_processor::EntityMap::new();

        let ea = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, ea);

        let eb = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(1),
        ));
        entity_map.insert(1, eb);

        // Stage joint BEFORE bodies are consumed
        physics.pending_joints.push(PendingJoint {
            joint_id: 99,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Revolute { anchor_ax: 0.0, anchor_ay: 0.0 },
        });

        // Single call should handle bodies (step 1), colliders (step 2),
        // kinematic sync (step 3), then joints (step 4).
        super::physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        // Bodies created
        assert_eq!(physics.rigid_body_set.len(), 2);
        // Joint created (depends on bodies existing first)
        assert_eq!(physics.joint_map.len(), 1);
        assert!(physics.joint_map.contains_key(&99));
    }
}

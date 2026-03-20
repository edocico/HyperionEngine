//! Routes live-body physics commands to Rapier.
//! Second pass: runs AFTER process_commands, handles commands
//! that need &mut PhysicsWorld.

#[cfg(feature = "physics-2d")]
use crate::command_processor::EntityMap;
#[cfg(feature = "physics-2d")]
use crate::physics::{PhysicsBodyHandle, PhysicsWorld};
#[cfg(feature = "physics-2d")]
use crate::physics::types::{CharacterEntry, CharacterState};
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
        // Joint commands: use joint_map, not body handle
        match cmd.cmd_type {
            CommandType::RemoveJoint => {
                let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                if let Some(entry) = physics.joint_map.remove(&joint_id) {
                    physics.impulse_joint_set.remove(entry.handle, true);
                }
                continue;
            }
            CommandType::SetJointMotor => {
                let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let target_vel = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                let max_force = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                if let Some(entry) = physics.joint_map.get(&joint_id)
                    && let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle, true)
                {
                    joint.data.set_motor_velocity(rapier2d::prelude::JointAxis::AngX, target_vel, max_force);
                }
                continue;
            }
            CommandType::SetJointLimits => {
                let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let min = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                let max = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                if let Some(entry) = physics.joint_map.get(&joint_id)
                    && let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle, true)
                {
                    joint.data.set_limits(rapier2d::prelude::JointAxis::AngX, [min, max]);
                }
                continue;
            }
            CommandType::SetSpringParams => {
                let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let stiffness = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                let damping = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                if let Some(entry) = physics.joint_map.get(&joint_id)
                    && let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle, true)
                {
                    joint.data.set_motor_velocity(rapier2d::prelude::JointAxis::LinX, 0.0, stiffness);
                    joint.data.set_motor_velocity(rapier2d::prelude::JointAxis::LinY, 0.0, damping);
                }
                continue;
            }
            CommandType::SetJointAnchorA => {
                let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let ax = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                let ay = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                if let Some(entry) = physics.joint_map.get(&joint_id)
                    && let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle, true)
                {
                    joint.data.set_local_anchor1(rapier2d::math::Vector::new(ax, ay));
                }
                continue;
            }
            CommandType::SetJointAnchorB => {
                let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let bx = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                let by = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                if let Some(entry) = physics.joint_map.get(&joint_id)
                    && let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle, true)
                {
                    joint.data.set_local_anchor2(rapier2d::math::Vector::new(bx, by));
                }
                continue;
            }
            // ── Character controller ──
            CommandType::CreateCharacterController => {
                physics.character_map.entry(cmd.entity_id).or_insert(CharacterEntry {
                    controller: rapier2d::control::KinematicCharacterController::default(),
                    state: CharacterState::default(),
                });
                continue;
            }
            CommandType::SetCharacterConfig => {
                if let Some(entry) = physics.character_map.get_mut(&cmd.entity_id) {
                    let flags = cmd.payload[0];
                    let climb = f32::from_le_bytes(cmd.payload[1..5].try_into().unwrap());
                    let slide_angle = f32::from_le_bytes(cmd.payload[5..9].try_into().unwrap());
                    let step_h = u16::from_le_bytes(cmd.payload[9..11].try_into().unwrap());
                    let step_w = u16::from_le_bytes(cmd.payload[11..13].try_into().unwrap());
                    let snap_d = u16::from_le_bytes(cmd.payload[13..15].try_into().unwrap());

                    entry.controller.slide = flags & 0x01 != 0;
                    entry.controller.max_slope_climb_angle = climb;
                    entry.controller.min_slope_slide_angle = slide_angle;

                    entry.controller.autostep = if flags & 0x02 != 0 {
                        use rapier2d::control::CharacterAutostep;
                        use rapier2d::control::CharacterLength;
                        Some(CharacterAutostep {
                            max_height: if flags & 0x10 != 0 {
                                CharacterLength::Relative(f32::from(step_h) / 100.0)
                            } else {
                                CharacterLength::Absolute(f32::from(step_h) / 100.0)
                            },
                            min_width: if flags & 0x20 != 0 {
                                CharacterLength::Relative(f32::from(step_w) / 100.0)
                            } else {
                                CharacterLength::Absolute(f32::from(step_w) / 100.0)
                            },
                            include_dynamic_bodies: flags & 0x04 != 0,
                        })
                    } else { None };

                    entry.controller.snap_to_ground = if flags & 0x08 != 0 {
                        use rapier2d::control::CharacterLength;
                        Some(if flags & 0x40 != 0 {
                            CharacterLength::Relative(f32::from(snap_d) / 100.0)
                        } else {
                            CharacterLength::Absolute(f32::from(snap_d) / 100.0)
                        })
                    } else { None };
                }
                continue;
            }
            CommandType::MoveCharacter => {
                let dx = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let dy = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                physics.pending_moves.push((cmd.entity_id, dx, dy));
                continue;
            }
            _ => {}
        }

        // Body-based commands: need entity → body handle lookup
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
                rb.add_force(rapier2d::math::Vector::new(fx, fy), true);
            }
            CommandType::ApplyImpulse => {
                let ix = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let iy = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                rb.apply_impulse(rapier2d::math::Vector::new(ix, iy), true);
            }
            CommandType::ApplyTorque => {
                let t = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                rb.apply_torque_impulse(t, true);
            }
            _ => {} // non-physics or pending-only commands
        }
    }
}

#[cfg(feature = "physics-2d")]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::*;
    use crate::physics::*;

    #[test]
    fn apply_force_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        // Spawn entity
        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]), // circle r=5 for mass
            ExternalId(0),
        ));
        entity_map.insert(0, entity);

        // Create body
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

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

        // Step + sync back
        physics.step();
        physics_sync_post(&mut world, &physics);

        let t = world.get::<&Transform2D>(entity).unwrap();
        assert!(t.x > 0.0, "body should have moved from applied force: x={}", t.x);
    }

    #[test]
    fn set_gravity_scale_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]), // circle r=5 for mass
            ExternalId(0),
        ));
        entity_map.insert(0, entity);
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        // Set gravity scale to 0
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&0.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetGravityScale,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        // Step -- body should NOT fall
        for _ in 0..10 {
            physics.step();
        }
        physics_sync_post(&mut world, &physics);

        let t = world.get::<&Transform2D>(entity).unwrap();
        assert!((t.y - 0.0).abs() < 0.01, "body with 0 gravity should not fall: y={}", t.y);
    }

    #[test]
    fn apply_impulse_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();
        // Zero gravity so impulse effect is isolated
        physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, entity);
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&0.0f32.to_le_bytes());
        payload[4..8].copy_from_slice(&50.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::ApplyImpulse,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        physics.step();
        physics_sync_post(&mut world, &physics);

        let t = world.get::<&Transform2D>(entity).unwrap();
        assert!(t.y > 0.0, "body should have moved from impulse: y={}", t.y);
    }

    #[test]
    fn apply_torque_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();
        physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, entity);
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&1000.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::ApplyTorque,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        physics.step();
        physics_sync_post(&mut world, &physics);

        let t = world.get::<&Transform2D>(entity).unwrap();
        assert!(t.rot.abs() > 0.0, "body should have rotated from torque: rot={}", t.rot);
    }

    #[test]
    fn set_linear_damping_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, entity);
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&5.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetLinearDamping,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        let handle = world.get::<&PhysicsBodyHandle>(entity).unwrap();
        let rb = physics.rigid_body_set.get(handle.0).unwrap();
        assert!((rb.linear_damping() - 5.0).abs() < f32::EPSILON);
    }

    #[test]
    fn set_angular_damping_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, entity);
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&3.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::SetAngularDamping,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        let handle = world.get::<&PhysicsBodyHandle>(entity).unwrap();
        let rb = physics.rigid_body_set.get(handle.0).unwrap();
        assert!((rb.angular_damping() - 3.0).abs() < f32::EPSILON);
    }

    #[test]
    fn set_ccd_enabled_on_live_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, entity);
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        let mut payload = [0u8; 16];
        payload[0] = 1;
        let cmd = Command {
            cmd_type: CommandType::SetCCDEnabled,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        let handle = world.get::<&PhysicsBodyHandle>(entity).unwrap();
        let rb = physics.rigid_body_set.get(handle.0).unwrap();
        assert!(rb.is_ccd_enabled());
    }

    #[test]
    fn skips_unknown_entity() {
        let mut world = hecs::World::new();
        let entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&100.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::ApplyForce,
            entity_id: 999,
            payload,
        };
        // Should not panic
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
    }

    #[test]
    fn skips_entity_without_physics_body() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        // Entity with no PhysicsBodyHandle
        let entity = world.spawn((Transform2D::default(), ExternalId(0)));
        entity_map.insert(0, entity);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&100.0f32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::ApplyForce,
            entity_id: 0,
            payload,
        };
        // Should not panic
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
    }

    #[test]
    fn ignores_non_physics_commands() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, entity);
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        let cmd = Command {
            cmd_type: CommandType::SetPosition,
            entity_id: 0,
            payload: [0u8; 16],
        };
        // Should not panic or alter physics state
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
    }

    // -- Helper: two bodies with a joint -----------------------------------

    fn setup_two_bodies_with_joint(joint_id: u32) -> (hecs::World, EntityMap, PhysicsWorld) {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();
        physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);

        let _ea = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(0),
        ));
        entity_map.insert(0, _ea);

        let _eb = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
            ExternalId(1),
        ));
        entity_map.insert(1, _eb);

        // Create bodies + colliders
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        // Add a revolute joint
        physics.pending_joints.push(PendingJoint {
            joint_id,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Revolute { anchor_ax: 0.0, anchor_ay: 0.0 },
        });
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);
        assert_eq!(physics.joint_map.len(), 1);

        (world, entity_map, physics)
    }

    // -- Task 6 tests: RemoveJoint + despawn cascade ----------------------

    #[test]
    fn remove_joint_explicit() {
        let (mut world, entity_map, mut physics) = setup_two_bodies_with_joint(10);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10u32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::RemoveJoint,
            entity_id: 0, // entity_id unused for RemoveJoint
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        assert!(physics.joint_map.is_empty(), "joint_map should be empty after RemoveJoint");
        assert_eq!(physics.impulse_joint_set.len(), 0, "Rapier joint should be removed");
    }

    #[test]
    fn despawn_cascade_removes_joint_entries() {
        let (world, _entity_map, mut physics) = setup_two_bodies_with_joint(10);

        // Despawn entity_a (ext_id=0)
        let ea = _entity_map.get(0).unwrap();
        crate::command_processor::despawn_physics_cleanup(&world, ea, &mut physics);

        assert!(physics.joint_map.is_empty(), "joint_map should be empty after despawning entity_a");
    }

    #[test]
    fn despawn_entity_b_removes_joint_entries() {
        let (world, _entity_map, mut physics) = setup_two_bodies_with_joint(10);

        // Despawn entity_b (ext_id=1)
        let eb = _entity_map.get(1).unwrap();
        crate::command_processor::despawn_physics_cleanup(&world, eb, &mut physics);

        assert!(physics.joint_map.is_empty(), "joint_map should be empty after despawning entity_b");
    }

    #[test]
    fn remove_then_despawn_no_panic() {
        let (mut world, entity_map, mut physics) = setup_two_bodies_with_joint(10);

        // Remove joint first
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10u32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::RemoveJoint,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        // Then despawn entity — should not panic
        let ea = entity_map.get(0).unwrap();
        crate::command_processor::despawn_physics_cleanup(&world, ea, &mut physics);
    }

    #[test]
    fn multi_joint_single_entity() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();
        physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);

        // 3 entities
        for i in 0..3u32 {
            let e = world.spawn((
                Transform2D::default(),
                PendingRigidBody::new(0),
                PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]),
                ExternalId(i),
            ));
            entity_map.insert(i, e);
        }
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        // Joint 1: A(0) <-> B(1)
        physics.pending_joints.push(PendingJoint {
            joint_id: 1,
            entity_a_ext: 0,
            entity_b_ext: 1,
            joint_type: PendingJointType::Revolute { anchor_ax: 0.0, anchor_ay: 0.0 },
        });
        // Joint 2: A(0) <-> C(2)
        physics.pending_joints.push(PendingJoint {
            joint_id: 2,
            entity_a_ext: 0,
            entity_b_ext: 2,
            joint_type: PendingJointType::Revolute { anchor_ax: 1.0, anchor_ay: 0.0 },
        });
        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);
        assert_eq!(physics.joint_map.len(), 2);

        // Remove joint 1 only
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&1u32.to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::RemoveJoint,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        assert_eq!(physics.joint_map.len(), 1, "one joint should remain");
        assert!(physics.joint_map.contains_key(&2), "joint 2 should still exist");
        assert!(!physics.joint_map.contains_key(&1), "joint 1 should be removed");
    }

    // -- Task 7 tests: Set joint commands ---------------------------------

    #[test]
    fn set_joint_motor() {
        let (mut world, entity_map, mut physics) = setup_two_bodies_with_joint(10);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10u32.to_le_bytes());
        payload[4..8].copy_from_slice(&5.0f32.to_le_bytes());  // target_vel
        payload[8..12].copy_from_slice(&100.0f32.to_le_bytes()); // max_force
        let cmd = Command {
            cmd_type: CommandType::SetJointMotor,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        // Joint should still exist and have been modified (no panic)
        assert!(physics.joint_map.contains_key(&10));
    }

    #[test]
    fn set_joint_limits() {
        let (mut world, entity_map, mut physics) = setup_two_bodies_with_joint(10);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10u32.to_le_bytes());
        payload[4..8].copy_from_slice(&(-1.0f32).to_le_bytes()); // min
        payload[8..12].copy_from_slice(&1.0f32.to_le_bytes());   // max
        let cmd = Command {
            cmd_type: CommandType::SetJointLimits,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        assert!(physics.joint_map.contains_key(&10));
    }

    #[test]
    fn set_spring_params() {
        let (mut world, entity_map, mut physics) = setup_two_bodies_with_joint(10);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10u32.to_le_bytes());
        payload[4..8].copy_from_slice(&200.0f32.to_le_bytes()); // stiffness
        payload[8..12].copy_from_slice(&10.0f32.to_le_bytes()); // damping
        let cmd = Command {
            cmd_type: CommandType::SetSpringParams,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        assert!(physics.joint_map.contains_key(&10));
    }

    #[test]
    fn set_joint_anchor_a() {
        let (mut world, entity_map, mut physics) = setup_two_bodies_with_joint(10);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10u32.to_le_bytes());
        payload[4..8].copy_from_slice(&2.0f32.to_le_bytes()); // ax
        payload[8..12].copy_from_slice(&3.0f32.to_le_bytes()); // ay
        let cmd = Command {
            cmd_type: CommandType::SetJointAnchorA,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        assert!(physics.joint_map.contains_key(&10));
    }

    #[test]
    fn set_joint_anchor_b() {
        let (mut world, entity_map, mut physics) = setup_two_bodies_with_joint(10);

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10u32.to_le_bytes());
        payload[4..8].copy_from_slice(&4.0f32.to_le_bytes()); // bx
        payload[8..12].copy_from_slice(&5.0f32.to_le_bytes()); // by
        let cmd = Command {
            cmd_type: CommandType::SetJointAnchorB,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        assert!(physics.joint_map.contains_key(&10));
    }

    #[test]
    fn set_commands_on_missing_joint_no_panic() {
        let mut world = hecs::World::new();
        let entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();

        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&999u32.to_le_bytes());
        payload[4..8].copy_from_slice(&1.0f32.to_le_bytes());
        payload[8..12].copy_from_slice(&2.0f32.to_le_bytes());

        // All joint set commands should silently skip missing joints
        for cmd_type in [
            CommandType::SetJointMotor,
            CommandType::SetJointLimits,
            CommandType::SetSpringParams,
            CommandType::SetJointAnchorA,
            CommandType::SetJointAnchorB,
            CommandType::RemoveJoint,
        ] {
            let cmd = Command {
                cmd_type,
                entity_id: 0,
                payload,
            };
            process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
        }
    }

    // -- Helper: single kinematic entity ---------------------------------

    fn setup_kinematic_entity() -> (hecs::World, EntityMap, PhysicsWorld) {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();
        physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);

        let entity = world.spawn((
            Transform2D::default(),
            PendingRigidBody::new(2), // 2 = kinematic
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]), // circle r=5
            ExternalId(0),
        ));
        entity_map.insert(0, entity);

        physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);

        (world, entity_map, physics)
    }

    // -- Task 4 tests: character controller commands ----------------------

    #[test]
    fn create_character_controller_inserts_entry() {
        let (mut world, entity_map, mut physics) = setup_kinematic_entity();
        let cmd = Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
        assert!(physics.character_map.contains_key(&0));
    }

    #[test]
    fn set_character_config_updates_kcc_fields() {
        let (mut world, entity_map, mut physics) = setup_kinematic_entity();
        let create = Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        };
        process_physics_commands(&[create], &mut world, &entity_map, &mut physics);

        let mut payload = [0u8; 16];
        payload[0] = 0x01 | 0x02 | 0x04 | 0x08 | 0x40; // slide + autostep + dyn + snap + snap_rel
        payload[1..5].copy_from_slice(&(std::f32::consts::FRAC_PI_3).to_le_bytes());
        payload[5..9].copy_from_slice(&(std::f32::consts::FRAC_PI_6).to_le_bytes());
        payload[9..11].copy_from_slice(&800u16.to_le_bytes());
        payload[11..13].copy_from_slice(&400u16.to_le_bytes());
        payload[13..15].copy_from_slice(&50u16.to_le_bytes());

        let config_cmd = Command {
            cmd_type: CommandType::SetCharacterConfig,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[config_cmd], &mut world, &entity_map, &mut physics);

        let entry = physics.character_map.get(&0).unwrap();
        assert!(entry.controller.slide);
        assert!((entry.controller.max_slope_climb_angle - std::f32::consts::FRAC_PI_3).abs() < 1e-5);
        assert!((entry.controller.min_slope_slide_angle - std::f32::consts::FRAC_PI_6).abs() < 1e-5);
        assert!(entry.controller.autostep.is_some());
        assert!(entry.controller.snap_to_ground.is_some());
    }

    #[test]
    fn move_character_pushes_pending_move() {
        let (mut world, entity_map, mut physics) = setup_kinematic_entity();
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10.0f32.to_le_bytes());
        payload[4..8].copy_from_slice(&(-5.0f32).to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::MoveCharacter,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
        assert_eq!(physics.pending_moves.len(), 1);
        assert_eq!(physics.pending_moves[0], (0, 10.0, -5.0));
    }
}

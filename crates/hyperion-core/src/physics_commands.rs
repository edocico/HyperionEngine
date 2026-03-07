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
        physics_sync_pre(&mut world, &mut physics, &entity_map);

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
        physics_sync_pre(&mut world, &mut physics, &entity_map);

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
        physics_sync_pre(&mut world, &mut physics, &entity_map);

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
        physics_sync_pre(&mut world, &mut physics, &entity_map);

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
        physics_sync_pre(&mut world, &mut physics, &entity_map);

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
        physics_sync_pre(&mut world, &mut physics, &entity_map);

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
        physics_sync_pre(&mut world, &mut physics, &entity_map);

        let cmd = Command {
            cmd_type: CommandType::SetPosition,
            entity_id: 0,
            payload: [0u8; 16],
        };
        // Should not panic or alter physics state
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
    }
}

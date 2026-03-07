//! ECS systems that operate on component queries.

use std::collections::HashMap;

use glam::Mat4;
use hecs::World;

use crate::components::{Active, ModelMatrix, Parent, Position, Rotation, Scale, Transform2D, Velocity};

#[cfg(feature = "physics-2d")]
use crate::physics::PhysicsControlled;
#[cfg(feature = "physics-2d")]
use hecs::Without;

/// Apply velocity to position. Runs once per fixed-timestep tick.
pub fn velocity_system(world: &mut World, dt: f32) {
    for (pos, vel) in world.query_mut::<(&mut Position, &Velocity)>() {
        pos.0 += vel.0 * dt;
    }
}

/// Recompute model matrices from Position, Rotation, Scale.
/// Runs after all spatial mutations for the current tick.
pub fn transform_system(world: &mut World) {
    for (pos, rot, scale, matrix) in
        world.query_mut::<(&Position, &Rotation, &Scale, &mut ModelMatrix)>()
    {
        let m = Mat4::from_scale_rotation_translation(scale.0, rot.0, pos.0);
        matrix.0 = m.to_cols_array();
    }
}

/// Apply velocity to 2D entities (hot path).
/// Only modifies x/y; vel.0.z is ignored for 2D entities.
pub fn velocity_system_2d(world: &mut World, dt: f32) {
    for (transform, vel) in world.query_mut::<(&mut Transform2D, &Velocity)>() {
        transform.x += vel.0.x * dt;
        transform.y += vel.0.y * dt;
        // vel.0.z ignored for 2D entities
    }
}

/// Build ModelMatrix from Transform2D (hot path).
/// Column-major 4×4: scale * rotation_2d * translation.
pub fn transform_system_2d(world: &mut World) {
    for (transform, matrix) in world.query_mut::<(&Transform2D, &mut ModelMatrix)>() {
        let (sin, cos) = transform.rot.sin_cos();
        let m = &mut matrix.0;
        m[0] = transform.sx * cos;
        m[1] = transform.sx * sin;
        m[2] = 0.0;
        m[3] = 0.0;
        m[4] = -transform.sy * sin;
        m[5] = transform.sy * cos;
        m[6] = 0.0;
        m[7] = 0.0;
        m[8] = 0.0;
        m[9] = 0.0;
        m[10] = 1.0;
        m[11] = 0.0;
        m[12] = transform.x;
        m[13] = transform.y;
        m[14] = 0.0;
        m[15] = 1.0;
    }
}

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

/// Count active entities. Useful for debug overlay.
pub fn count_active(world: &World) -> usize {
    world.query::<&Active>().iter().count()
}

/// Propagate parent transforms to children.
/// For each entity with a Parent != u32::MAX, multiply parent's ModelMatrix
/// by child's ModelMatrix to produce the child's world ModelMatrix.
pub fn propagate_transforms(world: &mut World, ext_to_entity: &HashMap<u32, hecs::Entity>) {
    let mut updates: Vec<(hecs::Entity, [f32; 16])> = Vec::new();

    for (entity, parent_comp, matrix, _active) in world
        .query::<(hecs::Entity, &Parent, &ModelMatrix, &Active)>()
        .iter()
    {
        if parent_comp.0 == u32::MAX {
            continue;
        }
        if let Some(&parent_entity) = ext_to_entity.get(&parent_comp.0)
            && let Ok(parent_matrix) = world.get::<&ModelMatrix>(parent_entity)
        {
            let parent_mat4 = glam::Mat4::from_cols_array(&parent_matrix.0);
            let child_mat4 = glam::Mat4::from_cols_array(&matrix.0);
            let result = parent_mat4 * child_mat4;
            updates.push((entity, result.to_cols_array()));
        }
    }

    for (entity, new_matrix) in updates {
        if let Ok(mut m) = world.get::<&mut ModelMatrix>(entity) {
            m.0 = new_matrix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::*;
    use glam::{Quat, Vec3};

    fn spawn_entity(world: &mut World, pos: Vec3, vel: Vec3) -> hecs::Entity {
        world.spawn((
            Position(pos),
            Rotation::default(),
            Scale::default(),
            Velocity(vel),
            ModelMatrix::default(),
            Active,
        ))
    }

    #[test]
    fn velocity_moves_position() {
        let mut world = World::new();
        let e = spawn_entity(&mut world, Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0));

        velocity_system(&mut world, 0.5); // 0.5 seconds

        let pos = world.get::<&Position>(e).unwrap();
        assert_eq!(pos.0, Vec3::new(5.0, 0.0, 0.0));
    }

    #[test]
    fn transform_computes_matrix() {
        let mut world = World::new();
        let e = world.spawn((
            Position(Vec3::new(1.0, 2.0, 3.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix::default(),
        ));

        transform_system(&mut world);

        let matrix = world.get::<&ModelMatrix>(e).unwrap();
        // Translation should appear in columns 12, 13, 14 of a column-major 4x4.
        assert_eq!(matrix.0[12], 1.0);
        assert_eq!(matrix.0[13], 2.0);
        assert_eq!(matrix.0[14], 3.0);
    }

    #[test]
    fn transform_applies_scale() {
        let mut world = World::new();
        let e = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::new(2.0, 3.0, 4.0)),
            ModelMatrix::default(),
        ));

        transform_system(&mut world);

        let m = world.get::<&ModelMatrix>(e).unwrap();
        assert_eq!(m.0[0], 2.0);  // scale X
        assert_eq!(m.0[5], 3.0);  // scale Y
        assert_eq!(m.0[10], 4.0); // scale Z
    }

    #[test]
    fn count_active_entities() {
        let mut world = World::new();
        spawn_entity(&mut world, Vec3::ZERO, Vec3::ZERO);
        spawn_entity(&mut world, Vec3::ONE, Vec3::ZERO);
        // Spawn one without Active
        world.spawn((Position::default(),));

        assert_eq!(count_active(&world), 2);
    }

    #[test]
    fn propagate_transforms_applies_parent_matrix() {
        let mut world = World::new();

        let parent = world.spawn((
            Position(Vec3::new(10.0, 0.0, 0.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix::default(),
            Parent::default(),
            Children::default(),
            Active,
        ));

        let child = world.spawn((
            Position(Vec3::new(5.0, 0.0, 0.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix::default(),
            Parent(0),
            Children::default(),
            Active,
        ));

        transform_system(&mut world);

        let mut ext_to_entity = std::collections::HashMap::new();
        ext_to_entity.insert(0u32, parent);
        ext_to_entity.insert(1u32, child);

        propagate_transforms(&mut world, &ext_to_entity);

        let child_matrix = world.get::<&ModelMatrix>(child).unwrap();
        assert!((child_matrix.0[12] - 15.0).abs() < 0.001);
    }

    #[test]
    fn propagate_transforms_includes_overflow_children() {
        let mut world = World::new();

        // Parent at position (10, 0, 0)
        let parent = world.spawn((
            Position(Vec3::new(10.0, 0.0, 0.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix::default(),
            Parent::default(),
            Children::default(),
            Active,
        ));

        // Child at position (5, 0, 0) with Parent(0)
        // This child is in OverflowChildren (simulating overflow)
        let child = world.spawn((
            Position(Vec3::new(5.0, 0.0, 0.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix::default(),
            Parent(0),
            Children::default(),
            Active,
        ));

        // Manually add OverflowChildren to parent (simulating overflow scenario)
        let _ = world.insert_one(parent, OverflowChildren { items: vec![1] });

        transform_system(&mut world);

        let mut ext_to_entity = std::collections::HashMap::new();
        ext_to_entity.insert(0u32, parent);
        ext_to_entity.insert(1u32, child);

        propagate_transforms(&mut world, &ext_to_entity);

        let child_matrix = world.get::<&ModelMatrix>(child).unwrap();
        // 10 + 5 = 15
        assert!((child_matrix.0[12] - 15.0).abs() < 0.001);
    }

    #[test]
    fn propagate_transforms_skips_unparented() {
        let mut world = World::new();
        let entity = world.spawn((
            Position(Vec3::new(5.0, 0.0, 0.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix::default(),
            Parent::default(),
            Children::default(),
            Active,
        ));

        transform_system(&mut world);

        let ext_to_entity = std::collections::HashMap::new();
        propagate_transforms(&mut world, &ext_to_entity);

        let matrix = world.get::<&ModelMatrix>(entity).unwrap();
        assert!((matrix.0[12] - 5.0).abs() < 0.001);
    }

    // ── 2D system tests ──────────────────────────────────────────────

    #[test]
    fn velocity_system_2d_updates_transform2d() {
        let mut world = World::new();
        let e = world.spawn((
            Transform2D { x: 0.0, y: 0.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            Velocity(Vec3::new(10.0, 20.0, 5.0)), // z=5 should be ignored
        ));
        velocity_system_2d(&mut world, 0.5);
        let t = world.get::<&Transform2D>(e).unwrap();
        assert!((t.x - 5.0).abs() < 1e-5);
        assert!((t.y - 10.0).abs() < 1e-5);
    }

    #[test]
    fn transform_system_2d_builds_identity_model_matrix() {
        let mut world = World::new();
        let e = world.spawn((
            Transform2D { x: 0.0, y: 0.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            ModelMatrix([0.0; 16]),
        ));
        transform_system_2d(&mut world);
        let m = world.get::<&ModelMatrix>(e).unwrap();
        // Identity-like: m[0]=1, m[5]=1, m[10]=1, m[15]=1
        assert!((m.0[0] - 1.0).abs() < 1e-5);
        assert!((m.0[5] - 1.0).abs() < 1e-5);
        assert!((m.0[10] - 1.0).abs() < 1e-5);
        assert!((m.0[15] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn transform_system_2d_with_translation() {
        let mut world = World::new();
        let e = world.spawn((
            Transform2D { x: 100.0, y: 200.0, rot: 0.0, sx: 2.0, sy: 3.0 },
            ModelMatrix([0.0; 16]),
        ));
        transform_system_2d(&mut world);
        let m = world.get::<&ModelMatrix>(e).unwrap();
        assert!((m.0[0] - 2.0).abs() < 1e-5);  // sx * cos(0)
        assert!((m.0[5] - 3.0).abs() < 1e-5);  // sy * cos(0)
        assert!((m.0[12] - 100.0).abs() < 1e-5);
        assert!((m.0[13] - 200.0).abs() < 1e-5);
    }

    #[test]
    fn transform_system_2d_with_rotation() {
        let mut world = World::new();
        let angle = std::f32::consts::FRAC_PI_2; // 90 degrees
        let e = world.spawn((
            Transform2D { x: 0.0, y: 0.0, rot: angle, sx: 1.0, sy: 1.0 },
            ModelMatrix([0.0; 16]),
        ));
        transform_system_2d(&mut world);
        let m = world.get::<&ModelMatrix>(e).unwrap();
        // cos(pi/2) ~ 0, sin(pi/2) ~ 1
        assert!(m.0[0].abs() < 1e-5);       // sx * cos = 0
        assert!((m.0[1] - 1.0).abs() < 1e-5); // sx * sin = 1
        assert!((m.0[4] + 1.0).abs() < 1e-5); // -sy * sin = -1
        assert!(m.0[5].abs() < 1e-5);       // sy * cos = 0
    }

    #[test]
    fn velocity_system_2d_does_not_affect_3d_entities() {
        let mut world = World::new();
        let e = world.spawn((
            Position(Vec3::new(0.0, 0.0, 0.0)),
            Velocity(Vec3::new(10.0, 20.0, 30.0)),
        ));
        velocity_system_2d(&mut world, 1.0);
        let pos = world.get::<&Position>(e).unwrap();
        assert!((pos.0.x - 0.0).abs() < 1e-5); // unchanged
    }

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
}

//! ECS systems that operate on component queries.

use std::collections::HashMap;

use glam::Mat4;
use hecs::World;

use crate::components::{Active, ModelMatrix, Parent, Position, Rotation, Scale, Velocity};

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
}

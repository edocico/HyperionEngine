//! ECS systems that operate on component queries.

use std::collections::HashMap;

use glam::Mat4;
use hecs::World;

use crate::components::{
    Active, BoundingRadius, BoundsOverride, ModelMatrix, Parent, Position, PrimitiveParams,
    RenderPrimitive, Rotation, Scale, Transform2D, Velocity, PRIM_TYPE_LIGHT2D,
};

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

/// Whether an entity's own pose is already in world space whatever its parent.
///
/// True for a physics body: `physics_sync_post` writes Rapier's WORLD pose into
/// its Transform2D. Composing the parent on top of that drew the body away from
/// its collider, which is what raycasts, events and the debug overlay use.
#[cfg(feature = "physics-2d")]
fn pose_is_world(world: &World, entity: hecs::Entity) -> bool {
    world.get::<&PhysicsControlled>(entity).is_ok()
}

#[cfg(not(feature = "physics-2d"))]
fn pose_is_world(_world: &World, _entity: hecs::Entity) -> bool {
    false
}

/// Propagate parent transforms down the scene graph, at any depth.
///
/// `transform_system` / `transform_system_2d` leave each entity's **local**
/// matrix in `ModelMatrix`; this turns those into **world** matrices.
///
/// Before the 2026-07 audit (P1-18) this was a single flat pass that multiplied
/// every child by its parent's `ModelMatrix` as it happened to be at that
/// moment — i.e. by the parent's *local* matrix. A grandchild therefore got
/// `P_local × C_local` and the grandparent was dropped entirely: a weapon held
/// by an arm rendered at the arm's local offset from the world origin.
///
/// The rewrite snapshots the local matrices first, then applies them strictly
/// in increasing depth order, so `world[e] = world[parent] × local[e]` always
/// reads a parent that is already in world space. It is also idempotent: the
/// locals it reads are the snapshot, never the values it just wrote.
///
/// Chains longer than [`MAX_HIERARCHY_DEPTH`](crate::command_processor::MAX_HIERARCHY_DEPTH)
/// are treated as broken and left in local space; `SetParent` rejects cycles,
/// so this only triggers on genuinely pathological data (e.g. a restored
/// snapshot written by an older build).
pub fn propagate_transforms(world: &mut World, ext_to_entity: &HashMap<u32, hecs::Entity>) {
    use crate::command_processor::MAX_HIERARCHY_DEPTH;

    // Pass 1 — snapshot every parented entity's local matrix and its parent.
    // A physics body is left out: its pose is already a world pose (see
    // `pose_is_world`), so it propagates like a root. Its own children still
    // compose on top of it.
    let mut locals: HashMap<hecs::Entity, ([f32; 16], u32)> = HashMap::new();
    for (entity, parent_comp, matrix, _active) in world
        .query::<(hecs::Entity, &Parent, &ModelMatrix, &Active)>()
        .iter()
    {
        if parent_comp.0 != u32::MAX && !pose_is_world(world, entity) {
            locals.insert(entity, (matrix.0, parent_comp.0));
        }
    }
    if locals.is_empty() {
        return;
    }

    // Pass 2 — depth of every parented entity (root children = depth 1).
    // Entities whose chain exceeds the cap, or whose parent is missing, are
    // dropped rather than propagated with a wrong ancestor.
    let mut ordered: Vec<(hecs::Entity, usize)> = Vec::with_capacity(locals.len());
    for (&entity, &(_, parent_ext)) in &locals {
        let mut depth = 1usize;
        let mut cursor = parent_ext;
        let mut ok = true;
        loop {
            let Some(&parent_entity) = ext_to_entity.get(&cursor) else {
                ok = false;
                break;
            };
            match locals.get(&parent_entity) {
                // Parent is itself parented — keep climbing.
                Some(&(_, grandparent_ext)) => {
                    depth += 1;
                    if depth > MAX_HIERARCHY_DEPTH {
                        ok = false;
                        break;
                    }
                    cursor = grandparent_ext;
                }
                // Parent is a root: chain complete.
                None => break,
            }
        }
        if ok {
            ordered.push((entity, depth));
        }
    }
    ordered.sort_unstable_by_key(|&(entity, depth)| (depth, entity.id()));

    // Pass 3 — apply shallowest first, so each parent is already in world space.
    for (entity, _) in ordered {
        let Some(&(local, parent_ext)) = locals.get(&entity) else {
            continue;
        };
        let Some(&parent_entity) = ext_to_entity.get(&parent_ext) else {
            continue;
        };
        let Ok(parent_matrix) = world.get::<&ModelMatrix>(parent_entity) else {
            continue;
        };
        let world_mat = Mat4::from_cols_array(&parent_matrix.0) * Mat4::from_cols_array(&local);
        drop(parent_matrix);
        if let Ok(mut m) = world.get::<&mut ModelMatrix>(entity) {
            m.0 = world_mat.to_cols_array();
        }
    }
}

/// Recompute every entity's bounding-sphere radius from its **world** matrix.
///
/// Runs after `transform_system` / `transform_system_2d` and
/// `propagate_transforms`, so the matrix already includes inherited parent
/// scale — deriving from the `Scale` component instead would leave a scaled
/// child wrong.
///
/// Before the 2026-07 audit (P1-17) `BoundingRadius` was written exactly once,
/// at spawn, as the constant 0.5 and never updated. It feeds GPU frustum
/// culling (`cull.wgsl`) and CPU ray picking (`hit-tester.ts`), so a sprite
/// scaled to 2000x1000 was culled the instant its centre left the view and
/// `hitTestRay` missed it everywhere except within 0.5 units of its centre.
/// 0.5 was also too small even for an unscaled unit quad, whose circumradius
/// is 0.7071.
///
/// Entities carrying `BoundsOverride` (set via `SetBoundingRadius`) are skipped.
pub fn update_bounding_radii(world: &mut World) {
    for (matrix, radius, _active) in world
        .query_mut::<hecs::Without<(&ModelMatrix, &mut BoundingRadius, &Active), &BoundsOverride>>()
    {
        radius.0 = world_matrix_radius(&matrix.0);
    }

    // A light's culling radius is its range, and range has exactly one source
    // of truth: `primParams[3]`, the same slot the accumulation shader reads.
    // Mirroring it into `BoundingRadius` from the TypeScript producer instead
    // would hold until someone set range through `raw-api.ts` and forgot the
    // second write, at which point the light culls against a stale radius and
    // pops at the frustum edge.
    //
    // This query runs SECOND on purpose, and the order is a correctness
    // invariant, not style: `SpawnEntity` gives *every* entity a `ModelMatrix`
    // (command_processor.rs:632 and :649, both archetypes), so the pass above
    // matches lights too and would otherwise leave them with a radius derived
    // from the light quad's scale.
    //
    // `BoundsOverride` still wins — `SetBoundingRadius` is the documented way
    // to pin a radius, and a light is no exception.
    for (prim, params, radius, _active) in world.query_mut::<hecs::Without<
        (
            &RenderPrimitive,
            &PrimitiveParams,
            &mut BoundingRadius,
            &Active,
        ),
        &BoundsOverride,
    >>() {
        if prim.0 != PRIM_TYPE_LIGHT2D {
            continue;
        }
        // A light's transform scale does NOT affect its culling radius: a
        // light's extent is its range. Negative and non-finite ranges collapse
        // to 0 rather than reaching the sphere-frustum test.
        let range = params.0[3];
        radius.0 = if range.is_finite() && range > 0.0 {
            range
        } else {
            0.0
        };
    }
}

/// Circumradius of the unit box [-0.5, 0.5]^3 transformed by `m`'s linear part.
///
/// Exact rather than conservative: the maximum is taken over the four
/// independent corner sign combinations (the other four are their negatives),
/// so nothing is culled that should be drawn and nothing is drawn that a
/// tighter bound would have culled.
fn world_matrix_radius(m: &[f32; 16]) -> f32 {
    let c0 = glam::Vec3::new(m[0], m[1], m[2]) * 0.5;
    let c1 = glam::Vec3::new(m[4], m[5], m[6]) * 0.5;
    let c2 = glam::Vec3::new(m[8], m[9], m[10]) * 0.5;
    let mut best = 0.0f32;
    for &(sy, sz) in &[(1.0f32, 1.0f32), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
        best = best.max((c0 + c1 * sy + c2 * sz).length_squared());
    }
    let r = best.sqrt();
    if r.is_finite() { r } else { 0.0 }
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

    // --- Phase 17: a light's culling radius is its range ---

    /// Mirror the archetype `SpawnEntity` actually produces — in particular the
    /// `ModelMatrix`, which is what makes the ordering inside
    /// `update_bounding_radii` load-bearing.
    fn spawn_light(world: &mut World, range: f32, scale: f32) -> hecs::Entity {
        let mut params = [0.0f32; 8];
        params[3] = range;
        world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::splat(scale)),
            ModelMatrix(
                Mat4::from_scale_rotation_translation(
                    Vec3::splat(scale),
                    Quat::IDENTITY,
                    Vec3::ZERO,
                )
                .to_cols_array(),
            ),
            BoundingRadius(0.5),
            RenderPrimitive(PRIM_TYPE_LIGHT2D),
            PrimitiveParams(params),
            Active,
        ))
    }

    #[test]
    fn light_radius_follows_prim_params_slot_3() {
        let mut world = World::new();
        let e = spawn_light(&mut world, 300.0, 1.0);
        update_bounding_radii(&mut world);
        assert_eq!(world.get::<&BoundingRadius>(e).unwrap().0, 300.0);
    }

    #[test]
    fn light_radius_ignores_transform_scale() {
        // A 40x-scaled light quad would give a matrix-derived radius near 34.6.
        // The light must still cull against its range. This is the assertion
        // that fails if the two queries are ever swapped.
        let mut world = World::new();
        let e = spawn_light(&mut world, 300.0, 40.0);
        update_bounding_radii(&mut world);
        assert_eq!(world.get::<&BoundingRadius>(e).unwrap().0, 300.0);
    }

    #[test]
    fn non_light_entities_keep_matrix_derived_radius() {
        let mut world = World::new();
        let mut params = [0.0f32; 8];
        params[3] = 999.0; // slot 3 means something else entirely for a quad
        let e = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::splat(2.0)),
            ModelMatrix(
                Mat4::from_scale_rotation_translation(
                    Vec3::splat(2.0),
                    Quat::IDENTITY,
                    Vec3::ZERO,
                )
                .to_cols_array(),
            ),
            BoundingRadius(0.5),
            RenderPrimitive(0),
            PrimitiveParams(params),
            Active,
        ));
        update_bounding_radii(&mut world);
        let r = world.get::<&BoundingRadius>(e).unwrap().0;
        assert!((r - 3.0_f32.sqrt()).abs() < 1e-5, "got {r}");
    }

    #[test]
    fn light_radius_rejects_negative_and_non_finite_range() {
        for bad in [-1.0f32, f32::NAN, f32::INFINITY] {
            let mut world = World::new();
            let e = spawn_light(&mut world, bad, 1.0);
            update_bounding_radii(&mut world);
            let r = world.get::<&BoundingRadius>(e).unwrap().0;
            assert_eq!(r, 0.0, "range {bad} must collapse to 0, got {r}");
            assert!(r.is_finite());
        }
    }

    #[test]
    fn bounds_override_pins_a_light_radius_too() {
        let mut world = World::new();
        let e = spawn_light(&mut world, 300.0, 1.0);
        world.insert_one(e, BoundsOverride).unwrap();
        world.insert_one(e, BoundingRadius(12.0)).unwrap();
        update_bounding_radii(&mut world);
        assert_eq!(
            world.get::<&BoundingRadius>(e).unwrap().0,
            12.0,
            "SetBoundingRadius must still win on a light"
        );
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

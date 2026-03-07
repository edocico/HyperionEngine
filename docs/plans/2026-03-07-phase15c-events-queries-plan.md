# Phase 15c — Events + Scene Queries: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire Rapier2D collision events from WASM to TypeScript callbacks, add sensor sugar, and implement scene queries (raycast, AABB overlap, circle overlap).

**Architecture:** Rust event structs become `#[repr(C)]` for zero-copy flat buffer export. TypeScript reads via DataView with two-phase dispatch (drain all data before firing callbacks). Scene queries use Rapier's ephemeral `QueryPipeline<'a>` via `broad_phase.as_query_pipeline()`. All behind `#[cfg(feature = "physics-2d")]`.

**Tech Stack:** Rust (rapier2d 0.32, parry2d 0.26, hecs, wasm-bindgen), TypeScript (vitest), WASM.

**Design doc:** `docs/plans/2026-03-07-phase15c-events-queries-design.md`

---

### Task 1: `#[repr(C)]` Collision Event Struct + Tests

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs:118-123` (HyperionCollisionEvent)
- Modify: `crates/hyperion-core/src/physics.rs:257-269` (translate_collision)

**Step 1: Write failing tests**

Add these tests at the end of the `mod tests` block in `physics.rs` (before the closing `}`):

```rust
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
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core --features physics-2d collision_event_repr_c_size collision_event_has_is_sensor`
Expected: FAIL — `HyperionCollisionEvent` has no field `event_type`, `is_sensor`, `_pad`

**Step 3: Update the struct and translate_collision**

Replace `HyperionCollisionEvent` (lines 118-123) with:

```rust
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
```

Replace `translate_collision` (lines 257-269) with:

```rust
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
```

**Step 4: Fix existing test that uses `started: true`**

The test `physics_world_collision_event_translation` (line 598) asserts `evt.started`. Update:

```rust
        // Change:  assert!(evt.started);
        // To:
        assert_eq!(evt.event_type, 0); // 0 = started
```

**Step 5: Run tests to verify they pass**

Run: `cargo test -p hyperion-core --features physics-2d`
Expected: ALL PASS (including the 2 new tests + updated existing test)

**Step 6: Run clippy**

Run: `cargo clippy -p hyperion-core --features physics-2d`
Expected: No warnings

**Step 7: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15c): repr(C) HyperionCollisionEvent with event_type + is_sensor"
```

---

### Task 2: Contact Force Event with Direction + Tests

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs:125-131` (HyperionContactForceEvent)
- Modify: `crates/hyperion-core/src/physics.rs:272-283` (translate_contact_force)

**Step 1: Write failing test**

Add in `mod tests`:

```rust
    #[test]
    fn contact_force_event_repr_c_size() {
        assert_eq!(std::mem::size_of::<HyperionContactForceEvent>(), 20);
    }
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d contact_force_event_repr_c_size`
Expected: FAIL — size is 12 (3 × u32/f32), not 20

**Step 3: Update the struct and translate_contact_force**

Replace `HyperionContactForceEvent` (lines 125-131) with:

```rust
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
```

Replace `translate_contact_force` (lines 272-283) with:

```rust
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
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core --features physics-2d`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15c): repr(C) HyperionContactForceEvent with force direction"
```

---

### Task 3: Sensor Collision Event Test (Integration)

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs` (tests section)

This task validates that sensor colliders produce events with `is_sensor = 1`. The struct change from Task 1 already calls `event.sensor()`, but we need an integration test proving it works end-to-end with Rapier.

**Step 1: Write the test**

Add in `mod tests`:

```rust
    #[test]
    fn sensor_event_flagged_correctly() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0); // no gravity

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
```

**Step 2: Run test**

Run: `cargo test -p hyperion-core --features physics-2d sensor_event_flagged`
Expected: PASS (the implementation was done in Task 1)

**Step 3: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "test(#15c): sensor collision event integration test"
```

---

### Task 4: Raycast on PhysicsWorld + Tests

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs` (add static buffer + method + tests)

**Step 1: Write failing tests**

Add in `mod tests`:

```rust
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
        // Register reverse mapping
        let idx = col_handle.0.into_raw_parts().0 as usize;
        pw.collider_to_entity.resize(idx + 1, None);
        pw.collider_to_entity[idx] = Some(42);

        // Step once so BVH is built
        pw.step();

        // Ray from origin → +X, should hit at toi ~ 90 (100 - 10 radius)
        let entity_id = pw.raycast(0.0, 0.0, 1.0, 0.0, 200.0);
        assert_eq!(entity_id, 42);

        // Check result buffer
        let result = unsafe { *std::ptr::addr_of!(super::world::RAYCAST_RESULT) };
        assert!((result[0] - 90.0).abs() < 1.0, "toi should be ~90, got {}", result[0]);
    }

    #[test]
    fn raycast_misses_empty_world() {
        let mut pw = PhysicsWorld::new();
        pw.step(); // build BVH

        let entity_id = pw.raycast(0.0, 0.0, 1.0, 0.0, 100.0);
        assert_eq!(entity_id, -1);
    }
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core --features physics-2d raycast`
Expected: FAIL — no method `raycast` on `PhysicsWorld`

**Step 3: Add static buffer and raycast method**

Add at the top of the `mod world` block (after `use rapier2d::prelude::*;`, around line 115):

```rust
    use std::ptr::addr_of_mut;
    use parry2d::query::Ray;

    // SAFETY: wasm32 is single-threaded; static buffers accessed only from main thread.
    pub(crate) static mut RAYCAST_RESULT: [f32; 3] = [0.0; 3]; // [toi, normal_x, normal_y]
```

Add the `raycast` method inside `impl PhysicsWorld` (after `body_count`):

```rust
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
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core --features physics-2d raycast`
Expected: PASS

**Step 5: Run clippy**

Run: `cargo clippy -p hyperion-core --features physics-2d`
Expected: No warnings

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15c): PhysicsWorld::raycast with cast_ray_and_get_normal"
```

---

### Task 5: AABB Overlap Query + Tests

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs` (add static buffer + method + tests)

**Step 1: Write failing tests**

Add in `mod tests`:

```rust
    #[test]
    fn overlap_aabb_finds_entities() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0);

        // Two fixed bodies inside the query region
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

        pw.step(); // build BVH

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

        // One body with TWO colliders
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
        // Entity 99 should appear exactly once despite 2 colliders
        let results = unsafe { &*std::ptr::addr_of!(super::world::OVERLAP_RESULTS) };
        let occurrences = results.iter().filter(|&&id| id == 99).count();
        assert_eq!(occurrences, 1, "entity should be deduplicated, found {} times", occurrences);
        assert_eq!(count as usize, results.len());
    }
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core --features physics-2d overlap_aabb`
Expected: FAIL — no method `overlap_aabb`

**Step 3: Add static buffer and overlap_aabb method**

Add next to `RAYCAST_RESULT` in `mod world`:

```rust
    pub(crate) static mut OVERLAP_RESULTS: Vec<u32> = Vec::new();
```

Add method in `impl PhysicsWorld` (after `raycast`):

```rust
        /// Find all entities whose colliders overlap the given AABB.
        /// Returns the count; entity IDs written to OVERLAP_RESULTS (deduplicated).
        pub fn overlap_aabb(&self, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> u32 {
            use parry2d::bounding_volume::Aabb;

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
            for (col_handle, _) in qp.colliders_in_aabb(&aabb) {
                if let Some(ext_id) = self.collider_handle_to_entity(col_handle) {
                    results.push(ext_id);
                }
            }
            results.sort_unstable();
            results.dedup();
            results.len() as u32
        }
```

> **Note to implementer:** The design doc says `intersect_aabb_conservative`. At runtime, verify which method name Rapier 0.32's `QueryPipeline` uses. Candidates: `colliders_in_aabb`, `intersect_aabb_conservative`, or `intersections_with_aabb`. If the method name differs, adapt the call. The iterator yields `(ColliderHandle, &Collider)`.

**Step 4: Run tests**

Run: `cargo test -p hyperion-core --features physics-2d overlap_aabb`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15c): PhysicsWorld::overlap_aabb with dedup"
```

---

### Task 6: Circle Overlap Query + Tests

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs` (add method + tests)

**Step 1: Write failing tests**

Add in `mod tests`:

```rust
    #[test]
    fn overlap_circle_finds_entities() {
        use rapier2d::prelude::*;
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, 0.0);

        // Body at (50, 0) with radius 5
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

        // Query circle at (50, 0) with radius 20 — should find the body
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

        // Body at (1000, 1000) — far away
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

        // Query circle at origin with small radius — should NOT find the body
        let count = pw.overlap_circle(0.0, 0.0, 10.0);
        assert_eq!(count, 0, "expected 0 entities, got {}", count);
    }
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core --features physics-2d overlap_circle`
Expected: FAIL — no method `overlap_circle`

**Step 3: Add overlap_circle method**

Add in `impl PhysicsWorld` (after `overlap_aabb`):

```rust
        /// Find all entities whose colliders overlap a circle at (cx, cy) with given radius.
        /// Returns the count; entity IDs written to OVERLAP_RESULTS (deduplicated, shared with overlap_aabb).
        pub fn overlap_circle(&self, cx: f32, cy: f32, radius: f32) -> u32 {
            use parry2d::shape::Ball;
            use rapier2d::math::Isometry;

            let qp = self.broad_phase.as_query_pipeline(
                self.narrow_phase.query_dispatcher(),
                &self.rigid_body_set,
                &self.collider_set,
                QueryFilter::default(),
            );
            let shape = Ball::new(radius);
            let pose = Isometry::translation(cx, cy);
            // SAFETY: wasm32 is single-threaded
            let results = unsafe { &mut *addr_of_mut!(OVERLAP_RESULTS) };
            results.clear();
            qp.intersections_with_shape(&pose, &shape, QueryFilter::default(), |col_handle| {
                if let Some(ext_id) = self.collider_handle_to_entity(col_handle) {
                    results.push(ext_id);
                }
                true // continue iterating
            });
            results.sort_unstable();
            results.dedup();
            results.len() as u32
        }
```

> **Note to implementer:** The design doc says `intersect_shape` with `Pose::translation()`. In Rapier 0.32, verify the exact method name and signature. Candidates: `intersections_with_shape(pose, shape, filter, callback)` (callback-based) or `intersect_shape(pose, &shape) -> impl Iterator`. The `Pose` type alias may be `Isometry<f32>` via rapier2d re-export. Use whichever compiles. If callback-based, `|handle| { ... true }` returns `true` to continue.

**Step 4: Run tests**

Run: `cargo test -p hyperion-core --features physics-2d overlap_circle`
Expected: PASS

**Step 5: Run full Rust test suite**

Run: `cargo test -p hyperion-core --features physics-2d`
Expected: ALL PASS

**Step 6: Run clippy**

Run: `cargo clippy -p hyperion-core --features physics-2d`
Expected: No warnings

**Step 7: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15c): PhysicsWorld::overlap_circle with intersect_shape"
```

---

### Task 7: WASM Exports (9 new)

**Files:**
- Modify: `crates/hyperion-core/src/lib.rs:466-492` (physics exports section)

**Step 1: Add the 9 WASM exports**

Add after `engine_physics_body_count` (line 492) and before the dev-tools section:

```rust
/// Pointer to the collision events buffer.
/// Buffer layout: N × 12 bytes (HyperionCollisionEvent, #[repr(C)]).
/// Valid from engine_update() return until next engine_update() call.
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_collision_events_ptr() -> *const u8 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| {
                e.physics.frame_collision_events.as_ptr() as *const u8
            })
    }
}

/// Number of collision events in the current frame.
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_collision_events_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.physics.frame_collision_events.len() as u32)
    }
}

/// Pointer to the contact force events buffer.
/// Buffer layout: N × 20 bytes (HyperionContactForceEvent, #[repr(C)]).
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_contact_force_events_ptr() -> *const u8 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| {
                e.physics.frame_contact_force_events.as_ptr() as *const u8
            })
    }
}

/// Number of contact force events in the current frame.
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_contact_force_events_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.physics.frame_contact_force_events.len() as u32)
    }
}

/// Cast a ray and return the external entity ID of the closest hit, or -1.
/// After a hit, read toi+normal from engine_physics_raycast_result_ptr().
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_raycast(ox: f32, oy: f32, dx: f32, dy: f32, max_toi: f32) -> i32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(-1, |e| e.physics.raycast(ox, oy, dx, dy, max_toi))
    }
}

/// Pointer to the raycast result: 3 × f32 [toi, normal_x, normal_y].
/// Only valid after a successful engine_physics_raycast() call.
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_raycast_result_ptr() -> *const f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe { addr_of_mut!(physics::world::RAYCAST_RESULT) as *const f32 }
}

/// Find all entities whose colliders overlap the given AABB.
/// Returns the count. Read entity IDs from engine_physics_overlap_results_ptr().
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_overlap_aabb(min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        match &*addr_of_mut!(ENGINE) {
            Some(e) => e.physics.overlap_aabb(min_x, min_y, max_x, max_y),
            None => 0,
        }
    }
}

/// Find all entities whose colliders overlap a circle at (cx, cy) with radius.
/// Returns the count. Read entity IDs from engine_physics_overlap_results_ptr().
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_overlap_circle(cx: f32, cy: f32, radius: f32) -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        match &*addr_of_mut!(ENGINE) {
            Some(e) => e.physics.overlap_circle(cx, cy, radius),
            None => 0,
        }
    }
}

/// Pointer to the overlap results buffer (u32 entity IDs).
/// Shared between overlap_aabb and overlap_circle — calling one invalidates the other.
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_physics_overlap_results_ptr() -> *const u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        let results = &*addr_of_mut!(physics::world::OVERLAP_RESULTS);
        results.as_ptr()
    }
}
```

> **Note to implementer:** The static buffer references use `physics::world::RAYCAST_RESULT` and `physics::world::OVERLAP_RESULTS`. If the module structure makes these inaccessible from `lib.rs`, either (a) make them `pub` in `mod world`, or (b) add accessor methods on `PhysicsWorld` that return the pointers. The `pub(crate)` visibility used in Task 4/5 should work since `lib.rs` is in the same crate.

> **Note:** `overlap_aabb` and `overlap_circle` call methods that take `&self` on `PhysicsWorld`, but `ENGINE` gives us `&Engine` (immutable). This is fine because the methods only mutate the `static mut OVERLAP_RESULTS`, not `self`. If the compiler disagrees, change the methods to take `&mut self` and use `match &mut *addr_of_mut!(ENGINE)` in the export.

**Step 2: Run clippy**

Run: `cargo clippy -p hyperion-core --features physics-2d`
Expected: No warnings (may need `#[allow(clippy::not_unsafe_ptr_arg_deref)]` or signature adjustments)

**Step 3: Build WASM to verify exports compile**

Run: `cd ts && npm run build:wasm:physics`
Expected: Build succeeds. Check `ts/wasm-physics/hyperion_core.d.ts` contains all 9 new exports.

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/lib.rs
git commit -m "feat(#15c): 9 WASM exports for collision events + scene queries"
```

---

### Task 8: TypeScript PhysicsAPI + Drain Functions + Tests

**Files:**
- Create: `ts/src/physics-api.ts`
- Create: `ts/src/physics-api.test.ts`

**Step 1: Write the test file first**

Create `ts/src/physics-api.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  PhysicsAPI,
  drainCollisionEvents,
  drainContactForceEvents,
} from './physics-api';

describe('drainCollisionEvents', () => {
  it('returns empty for count 0', () => {
    const buf = new ArrayBuffer(0);
    expect(drainCollisionEvents(buf, 0, 0)).toEqual([]);
  });

  it('parses 12-byte events correctly', () => {
    const buf = new ArrayBuffer(24); // 2 events
    const dv = new DataView(buf);
    // Event 0: entityA=10, entityB=20, event_type=0 (started), is_sensor=0
    dv.setUint32(0, 10, true);
    dv.setUint32(4, 20, true);
    dv.setUint8(8, 0);
    dv.setUint8(9, 0);
    // Event 1: entityA=30, entityB=40, event_type=1 (stopped), is_sensor=1
    dv.setUint32(12, 30, true);
    dv.setUint32(16, 40, true);
    dv.setUint8(20, 1);
    dv.setUint8(21, 1);

    const events = drainCollisionEvents(buf, 0, 2);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ entityA: 10, entityB: 20, started: true, isSensor: false });
    expect(events[1]).toEqual({ entityA: 30, entityB: 40, started: false, isSensor: true });
  });
});

describe('drainContactForceEvents', () => {
  it('parses 20-byte events correctly', () => {
    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    dv.setUint32(0, 5, true);
    dv.setUint32(4, 6, true);
    dv.setFloat32(8, 123.5, true);
    dv.setFloat32(12, 0.707, true);
    dv.setFloat32(16, -0.707, true);

    const events = drainContactForceEvents(buf, 0, 1);
    expect(events).toHaveLength(1);
    expect(events[0].entityA).toBe(5);
    expect(events[0].entityB).toBe(6);
    expect(events[0].totalForceMagnitude).toBeCloseTo(123.5);
    expect(events[0].directionX).toBeCloseTo(0.707);
    expect(events[0].directionY).toBeCloseTo(-0.707);
  });
});

describe('PhysicsAPI', () => {
  it('raycast returns null when no WASM', () => {
    const api = new PhysicsAPI();
    expect(api.raycast(0, 0, 1, 0, 100)).toBeNull();
  });

  it('queryAABB returns empty when no WASM', () => {
    const api = new PhysicsAPI();
    expect(api.queryAABB(0, 0, 10, 10)).toEqual([]);
  });

  it('queryCircle returns empty when no WASM', () => {
    const api = new PhysicsAPI();
    expect(api.queryCircle(0, 0, 10)).toEqual([]);
  });

  it('onCollisionStart fires callback on dispatch', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onCollisionStart(cb);

    // Simulate dispatch with mock WASM
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 1, true);  // entityA
    dv.setUint32(4, 2, true);  // entityB
    dv.setUint8(8, 0);         // event_type=started
    dv.setUint8(9, 0);         // not sensor

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(1, 2, false);
  });

  it('onCollisionEnd fires callback on dispatch', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onCollisionEnd(cb);

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 3, true);
    dv.setUint32(4, 4, true);
    dv.setUint8(8, 1); // stopped
    dv.setUint8(9, 0);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(3, 4, false);
  });

  it('onContactForce fires callback with direction', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onContactForce(cb);

    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    dv.setUint32(0, 7, true);
    dv.setUint32(4, 8, true);
    dv.setFloat32(8, 50.0, true);
    dv.setFloat32(12, 1.0, true);
    dv.setFloat32(16, 0.0, true);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 0,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 1,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(7, 8, 50.0, 1.0, 0.0);
  });

  it('unsubscribe removes callback', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    const unsub = api.onCollisionStart(cb);
    unsub();

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, 2, true);
    dv.setUint8(8, 0);
    dv.setUint8(9, 0);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).not.toHaveBeenCalled();
  });

  it('onSensorEnter filters by entity ID', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onSensorEnter(1, cb);

    // Sensor event: entityA=1, entityB=5, started, is_sensor=1
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, 5, true);
    dv.setUint8(8, 0); // started
    dv.setUint8(9, 1); // sensor

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(5); // other entity
  });

  it('onSensorEnter bidirectional check', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onSensorEnter(5, cb);  // listening on entity 5

    // Event has entity 5 as entityB
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 1, true);  // entityA
    dv.setUint32(4, 5, true);  // entityB = our sensor
    dv.setUint8(8, 0);
    dv.setUint8(9, 1);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(cb).toHaveBeenCalledWith(1); // other entity
  });

  it('destroy clears all callbacks', () => {
    const api = new PhysicsAPI();
    const cb = vi.fn();
    api.onCollisionStart(cb);
    api.onCollisionEnd(cb);
    api.onContactForce(cb as any);
    api.onSensorEnter(1, cb);
    api.onSensorExit(1, cb);

    api.destroy();

    // After destroy, dispatch should be a no-op
    (api as any)._wasm = null; // already null from destroy
    api._dispatch();
    expect(cb).not.toHaveBeenCalled();
  });

  it('dispatch survives WASM call in callback', () => {
    // Validates two-phase: data copied before callbacks fire
    const api = new PhysicsAPI();

    let dispatchedEntityA = -1;
    api.onCollisionStart((a, _b, _sensor) => {
      dispatchedEntityA = a;
      // Simulate: callback triggers a WASM call that could cause memory.grow
      // In two-phase, data is already copied, so this is safe.
      // We just verify the callback received correct data.
    });

    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, 42, true);
    dv.setUint32(4, 43, true);
    dv.setUint8(8, 0);
    dv.setUint8(9, 0);

    (api as any)._wasm = {
      memory: { buffer: buf },
      engine_collision_events_count: () => 1,
      engine_collision_events_ptr: () => 0,
      engine_contact_force_events_count: () => 0,
      engine_contact_force_events_ptr: () => 0,
    };

    api._dispatch();
    expect(dispatchedEntityA).toBe(42);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/physics-api.test.ts`
Expected: FAIL — module `./physics-api` not found

**Step 3: Create `ts/src/physics-api.ts`**

```typescript
// ── Types ──────────────────────────────────────────────────────

export interface CollisionEvent {
  entityA: number;
  entityB: number;
  started: boolean;
  isSensor: boolean;
}

export interface ContactForceEvent {
  entityA: number;
  entityB: number;
  totalForceMagnitude: number;
  directionX: number;
  directionY: number;
}

export interface RaycastHit {
  entityId: number;
  toi: number;
  normalX: number;
  normalY: number;
}

type CollisionCallback = (entityA: number, entityB: number, isSensor: boolean) => void;
type ContactForceCallback = (entityA: number, entityB: number, force: number, dirX: number, dirY: number) => void;
type SensorCallback = (otherEntityId: number) => void;

// ── WASM interface ─────────────────────────────────────────────

interface PhysicsWasmExports {
  memory: WebAssembly.Memory;
  engine_collision_events_ptr(): number;
  engine_collision_events_count(): number;
  engine_contact_force_events_ptr(): number;
  engine_contact_force_events_count(): number;
  engine_physics_raycast(ox: number, oy: number, dx: number, dy: number, max_toi: number): number;
  engine_physics_raycast_result_ptr(): number;
  engine_physics_overlap_aabb(min_x: number, min_y: number, max_x: number, max_y: number): number;
  engine_physics_overlap_circle(cx: number, cy: number, radius: number): number;
  engine_physics_overlap_results_ptr(): number;
}

// ── Drain functions (Mode B/A seam) ────────────────────────────

const COLLISION_EVENT_SIZE = 12;
const CONTACT_FORCE_EVENT_SIZE = 20;

export function drainCollisionEvents(
  memory: ArrayBuffer, ptr: number, count: number,
): CollisionEvent[] {
  if (count === 0) return [];
  const dv = new DataView(memory);
  const events: CollisionEvent[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = ptr + i * COLLISION_EVENT_SIZE;
    events[i] = {
      entityA: dv.getUint32(off, true),
      entityB: dv.getUint32(off + 4, true),
      started: dv.getUint8(off + 8) === 0,
      isSensor: dv.getUint8(off + 9) !== 0,
    };
  }
  return events;
}

export function drainContactForceEvents(
  memory: ArrayBuffer, ptr: number, count: number,
): ContactForceEvent[] {
  if (count === 0) return [];
  const dv = new DataView(memory);
  const events: ContactForceEvent[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = ptr + i * CONTACT_FORCE_EVENT_SIZE;
    events[i] = {
      entityA: dv.getUint32(off, true),
      entityB: dv.getUint32(off + 4, true),
      totalForceMagnitude: dv.getFloat32(off + 8, true),
      directionX: dv.getFloat32(off + 12, true),
      directionY: dv.getFloat32(off + 16, true),
    };
  }
  return events;
}

// ── PhysicsAPI ─────────────────────────────────────────────────

export class PhysicsAPI {
  private _wasm: PhysicsWasmExports | null = null;
  private _startCbs: CollisionCallback[] = [];
  private _endCbs: CollisionCallback[] = [];
  private _forceCbs: ContactForceCallback[] = [];
  private _sensorEnter = new Map<number, SensorCallback[]>();
  private _sensorExit = new Map<number, SensorCallback[]>();

  /** @internal Called by Hyperion when physics WASM build is loaded. */
  _init(wasm: PhysicsWasmExports): void {
    this._wasm = wasm;
  }

  onCollisionStart(cb: CollisionCallback): () => void {
    this._startCbs.push(cb);
    return () => { this._startCbs = this._startCbs.filter(c => c !== cb); };
  }

  onCollisionEnd(cb: CollisionCallback): () => void {
    this._endCbs.push(cb);
    return () => { this._endCbs = this._endCbs.filter(c => c !== cb); };
  }

  onContactForce(cb: ContactForceCallback): () => void {
    this._forceCbs.push(cb);
    return () => { this._forceCbs = this._forceCbs.filter(c => c !== cb); };
  }

  onSensorEnter(sensorEntityId: number, cb: SensorCallback): () => void {
    const arr = this._sensorEnter.get(sensorEntityId) ?? [];
    arr.push(cb);
    this._sensorEnter.set(sensorEntityId, arr);
    return () => {
      const a = this._sensorEnter.get(sensorEntityId);
      if (a) {
        const filtered = a.filter(c => c !== cb);
        if (filtered.length === 0) this._sensorEnter.delete(sensorEntityId);
        else this._sensorEnter.set(sensorEntityId, filtered);
      }
    };
  }

  onSensorExit(sensorEntityId: number, cb: SensorCallback): () => void {
    const arr = this._sensorExit.get(sensorEntityId) ?? [];
    arr.push(cb);
    this._sensorExit.set(sensorEntityId, arr);
    return () => {
      const a = this._sensorExit.get(sensorEntityId);
      if (a) {
        const filtered = a.filter(c => c !== cb);
        if (filtered.length === 0) this._sensorExit.delete(sensorEntityId);
        else this._sensorExit.set(sensorEntityId, filtered);
      }
    };
  }

  /** @internal Called after engine_update in tick loop. Two-phase dispatch. */
  _dispatch(): void {
    if (!this._wasm) return;

    // Phase 1: Copy ALL data out of WASM memory (before any callbacks)
    const mem = this._wasm.memory.buffer;
    const colCount = this._wasm.engine_collision_events_count();
    const colEvents = colCount > 0
      ? drainCollisionEvents(mem, this._wasm.engine_collision_events_ptr(), colCount)
      : null;
    const forceCount = this._wasm.engine_contact_force_events_count();
    const forceEvents = forceCount > 0
      ? drainContactForceEvents(mem, this._wasm.engine_contact_force_events_ptr(), forceCount)
      : null;

    // Phase 2: Dispatch from copied data (WASM memory no longer referenced)
    if (colEvents) {
      const startCbs = [...this._startCbs];
      const endCbs = [...this._endCbs];
      for (const e of colEvents) {
        const cbs = e.started ? startCbs : endCbs;
        for (const cb of cbs) cb(e.entityA, e.entityB, e.isSensor);

        if (e.isSensor) {
          const map = e.started ? this._sensorEnter : this._sensorExit;
          const cbsA = map.get(e.entityA);
          if (cbsA) for (const cb of cbsA) cb(e.entityB);
          const cbsB = map.get(e.entityB);
          if (cbsB) for (const cb of cbsB) cb(e.entityA);
        }
      }
    }

    if (forceEvents) {
      const forceCbs = [...this._forceCbs];
      for (const e of forceEvents) {
        for (const cb of forceCbs) cb(e.entityA, e.entityB, e.totalForceMagnitude, e.directionX, e.directionY);
      }
    }
  }

  raycast(ox: number, oy: number, dx: number, dy: number, maxDist: number): RaycastHit | null {
    if (!this._wasm) return null;
    const entityId = this._wasm.engine_physics_raycast(ox, oy, dx, dy, maxDist);
    if (entityId < 0) return null;
    const ptr = this._wasm.engine_physics_raycast_result_ptr();
    const dv = new DataView(this._wasm.memory.buffer);
    return {
      entityId,
      toi: dv.getFloat32(ptr, true),
      normalX: dv.getFloat32(ptr + 4, true),
      normalY: dv.getFloat32(ptr + 8, true),
    };
  }

  queryAABB(minX: number, minY: number, maxX: number, maxY: number): number[] {
    if (!this._wasm) return [];
    const count = this._wasm.engine_physics_overlap_aabb(minX, minY, maxX, maxY);
    if (count === 0) return [];
    const ptr = this._wasm.engine_physics_overlap_results_ptr();
    return Array.from(new Uint32Array(this._wasm.memory.buffer, ptr, count));
  }

  queryCircle(cx: number, cy: number, radius: number): number[] {
    if (!this._wasm) return [];
    const count = this._wasm.engine_physics_overlap_circle(cx, cy, radius);
    if (count === 0) return [];
    const ptr = this._wasm.engine_physics_overlap_results_ptr();
    return Array.from(new Uint32Array(this._wasm.memory.buffer, ptr, count));
  }

  destroy(): void {
    this._wasm = null;
    this._startCbs.length = 0;
    this._endCbs.length = 0;
    this._forceCbs.length = 0;
    this._sensorEnter.clear();
    this._sensorExit.clear();
  }
}
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/physics-api.test.ts`
Expected: ALL PASS (~13 tests)

**Step 5: Commit**

```bash
git add ts/src/physics-api.ts ts/src/physics-api.test.ts
git commit -m "feat(#15c): PhysicsAPI + drain functions + 13 tests"
```

---

### Task 9: Wire PhysicsAPI into Hyperion Facade

**Files:**
- Modify: `ts/src/hyperion.ts` (add property, tick wiring, destroy wiring)
- Modify: `ts/src/hyperion.test.ts` (add test)

**Step 1: Write the test**

Add in `ts/src/hyperion.test.ts` (inside the main describe block):

```typescript
  it('has physics property', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.physics).toBeDefined();
    expect(engine.physics.raycast(0, 0, 1, 0, 100)).toBeNull(); // safe no-op
  });
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — property `physics` does not exist on `Hyperion`

**Step 3: Wire PhysicsAPI into Hyperion**

In `ts/src/hyperion.ts`:

1. Add import at top:
```typescript
import { PhysicsAPI } from './physics-api';
```

2. Add field in class (after `eventBus` declaration, around line 66):
```typescript
  private readonly physicsApi: PhysicsAPI;
```

3. Initialize in constructor (after `this.eventBus = new EventBus();`, around line 93):
```typescript
    this.physicsApi = new PhysicsAPI();
```

4. Add public getter (after the `audio` getter, around line 223):
```typescript
  /** Physics API for collision events, sensor callbacks, and scene queries. */
  get physics(): PhysicsAPI {
    return this.physicsApi;
  }
```

5. Add `_dispatch()` call in `tick()` method — after `this.bridge.tick(dt)` (line 613) and before the `if (state)` SystemViews block (line 619):
```typescript
    this.physicsApi._dispatch();
```

6. Add `destroy()` call in `destroy()` method — before `this.bridge.destroy()` (line 458):
```typescript
    this.physicsApi.destroy();
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: ALL PASS

**Step 5: Run full TS test suite**

Run: `cd ts && npm test`
Expected: ALL PASS

**Step 6: Type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No errors

**Step 7: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(#15c): wire PhysicsAPI into Hyperion facade (tick + destroy)"
```

---

### Task 10: Barrel Exports + CLAUDE.md Update

**Files:**
- Modify: `ts/src/index.ts`
- Modify: `CLAUDE.md`

**Step 1: Add barrel exports**

In `ts/src/index.ts`, add after the audio exports (line 24):

```typescript
// Physics API (Phase 15c)
export { PhysicsAPI } from './physics-api';
export type { CollisionEvent, ContactForceEvent, RaycastHit } from './physics-api';
export { drainCollisionEvents, drainContactForceEvents } from './physics-api';
```

**Step 2: Run type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No errors

**Step 3: Update CLAUDE.md**

Add to the module table in "TypeScript: ts/src/" section:

```
| `physics-api.ts` | `PhysicsAPI` — collision/force event callbacks, sensor sugar (`onSensorEnter/Exit`), scene queries (`raycast/queryAABB/queryCircle`). `drainCollisionEvents/drainContactForceEvents` Mode B/A seam. Two-phase dispatch for WASM memory safety |
```

Add to the test commands section:

```
cd ts && npx vitest run src/physics-api.test.ts             # PhysicsAPI + drain functions (13 tests)
```

Update lib.rs module table to include new exports:

```
| `lib.rs` | ... Physics (physics-2d): `engine_physics_configure`, `engine_physics_body_count`, `engine_collision_events_ptr/count`, `engine_contact_force_events_ptr/count`, `engine_physics_raycast`, `engine_physics_raycast_result_ptr`, `engine_physics_overlap_aabb`, `engine_physics_overlap_circle`, `engine_physics_overlap_results_ptr`. ... |
```

Update Implementation Status table:

```
| 15c | Physics: Events + Scene Queries | `#[repr(C)]` event structs (`is_sensor`, force direction), 9 WASM exports, `PhysicsAPI` (collision/force callbacks, sensor sugar, raycast, queryAABB, queryCircle), two-phase dispatch |
```

Add new Gotchas:
- **Two-phase event dispatch** — `PhysicsAPI._dispatch()` copies all event data out of WASM memory before firing any callbacks. User callbacks may trigger WASM calls causing `memory.grow` which detaches `ArrayBuffer`. The copied data is safe.
- **OVERLAP_RESULTS shared between queryAABB and queryCircle** — Calling one invalidates the other. TS reads immediately after each query.
- **QueryPipeline is ephemeral** — Created on-the-fly via `broad_phase.as_query_pipeline()` per query. NOT stored on PhysicsWorld.

Update test counts in the "Quick Reference" section to reflect new tests.

**Step 4: Run full validation**

Run: `cargo test -p hyperion-core --features physics-2d && cargo clippy -p hyperion-core --features physics-2d && cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/index.ts CLAUDE.md
git commit -m "docs: update CLAUDE.md with Phase 15c completion"
```

---

## Summary

| Task | Description | New Tests |
|------|-------------|-----------|
| 1 | `#[repr(C)]` collision event + `is_sensor` | 2 Rust |
| 2 | Contact force event + direction | 1 Rust |
| 3 | Sensor integration test | 1 Rust |
| 4 | `raycast()` on PhysicsWorld | 2 Rust |
| 5 | `overlap_aabb()` on PhysicsWorld | 2 Rust |
| 6 | `overlap_circle()` on PhysicsWorld | 2 Rust |
| 7 | 9 WASM exports in lib.rs | 0 (compile check) |
| 8 | PhysicsAPI + drain functions | ~13 TS |
| 9 | Wire into Hyperion facade | 1 TS |
| 10 | Barrel exports + CLAUDE.md | 0 (type check) |

**Total: ~10 Rust tests + ~14 TS tests, 10 commits.**

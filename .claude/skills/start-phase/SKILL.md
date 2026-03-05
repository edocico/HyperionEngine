---
name: start-phase
description: Begin a new engine development phase from the masterplan. Use when starting work on a new phase.
disable-model-invocation: true
---

Start implementing a new phase from the Hyperion masterplan. The user should specify which phase to begin (e.g., "Phase 13", "Phase 10c").

## Steps

1. **Read the masterplan**: Open `hyperion-masterplan.md` and locate the requested phase section. Extract goals, deliverables, and dependencies.

2. **Check prerequisites**: Verify that prerequisite phases are complete by checking the Implementation Status table in CLAUDE.md.

3. **Read existing code**: Identify and read all files referenced by the phase plan. Understand current architecture before making changes.

4. **Use brainstorming skill**: Invoke the brainstorming skill to design the implementation approach. Consider trade-offs, alternative approaches, and gotchas.

5. **Create phase plan document**: Write `docs/plans/phase-{N}.md` with:
   - Goals (from masterplan)
   - Files to create/modify (with rationale)
   - Test strategy (unit + integration)
   - Gotchas and risks to watch for
   - Dependency graph between deliverables

6. **Create TODO items**: Break deliverables into actionable tasks using TodoWrite. Each task should be independently testable.

7. **Implement**: Use subagent-driven-development skill if tasks are parallelizable (independent files/modules). Otherwise, implement sequentially.

8. **Validate**: Run the full validation pipeline before considering the phase complete:
   ```bash
   cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit
   ```

9. **Update documentation** (mandatory, do NOT skip):
   - CLAUDE.md: Architecture tables, Implementation Status, test counts, Gotchas
   - MEMORY.md: Update current state, test counts, completed phases
   - Any new exports added to `ts/src/index.ts`

## Reminders

- Consult Context7 MCP for spec validation (WebGPU, KTX2, etc.) before finalizing design decisions
- Run protocol-sync-checker agent if any Rust/TS bridge files were modified
- Run wgsl-validator agent if any shader files were created or modified
- Update test count comments in CLAUDE.md after adding new tests

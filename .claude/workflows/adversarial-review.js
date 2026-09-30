export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial review of a git range: one finder per lens, one skeptical verifier per finding',
  whenToUse: 'Before merging a branch, after a phase or a risky fix. args: {range: "base..head", spec?, plan?, context?, accepted?: string[], lenses?: string[] | {key, prompt}[]}',
  phases: [
    { title: 'Find', detail: 'one finder per lens over the range' },
    { title: 'Verify', detail: 'one skeptic per finding, defaulting to refuted' },
  ],
}

// Written 2026-09-26 after the same review was hand-built three times in one
// session; every run found real defects the tests had missed (a design doc
// truncated by a scripted edit, rotations lost on physics bodies, a queue that
// drained in first-call order).

const input = typeof args === 'string' ? { range: args } : (args ?? {})
if (!input.range) throw new Error('adversarial-review needs args.range, e.g. {range: "master..HEAD"}')

const DEFAULT_LENSES = {
  webgpu: `LENS: WebGPU validity — the class no headless test can see. For every pipeline, bind group, layout, texture, view and uniform the range creates or changes, check against the CLAUDE.md gotchas: minBindingSize and uniform structs with implicit padding (TS writers pack back to back); queue.writeBuffer rewritten between passes of one submit (only the last write lands; use 256-byte slices); a placeholder bound to an unused binding that is also the pass's render target; a view dimension ('2d' vs '2d-array') against the layout's viewDimension; render attachments must be single-layer 2d views; the 8 storage buffers per stage budget (unread bindings count); drawIndexedIndirect offsets + 20 within the buffer and firstInstance needing indirect-first-instance; fs_occluder or any entry statically using a group its layout lacks; SCENE_HDR_FORMAT/JFA_FORMAT paired between pipeline and texture; textureSample outside fragment stages. Read the WGSL and the TS writer side by side.`,
  protocol: `LENS: the command stream and its consumers. Rust <-> TS CommandType tables and payload sizes; PrioritizedCommandQueue coalescing (last-write-wins per entity+type, drain order = order of LAST calls, partial updates merged, ENGINE_LEVEL_COMMANDS exempt from purge); two command types writing the same state; process_commands ordering; dirty marking so the GPU row follows; snapshot/state_hash/replay (a behaviour change replays old tapes differently); Mode A/B/C bridges (anything the render worker must also receive).`,
  physics: `LENS: physics integration (skip, returning no findings, if the range touches nothing under physics.rs, physics_commands.rs, command_processor.rs or the physics TS API). Pending components consumed in physics_sync_pre passes (a command in the creation batch finds no PhysicsControlled yet); repositions queued in pending_teleports (merged per body until the tick); physics_sync_post overwriting ECS state (sleeping bodies are skipped); 2D (Transform2D) vs 3D (Position/Rotation) entities — engine.spawn() makes 3D ones; kinematic next-position targets; determinism per target.`,
  docs: `LENS: documentation against the code. Every statement the range adds or changes in CLAUDE.md, docs/, JSDoc and code comments: numbers (run the commands: npm --prefix ts test, cargo test -p hyperion-core --lib with each feature set, integration totals), symbol names (grep each backticked identifier), behaviour claims, file/test references. Also stale mentions elsewhere of anything the range renamed, deleted or changed the meaning of. Check the range for docs that lost far more lines than they gained (git diff --numstat): a scripted edit can drop a whole section silently.`,
}

const lenses = (input.lenses ?? Object.keys(DEFAULT_LENSES)).map((l) =>
  typeof l === 'string' ? { key: l, prompt: DEFAULT_LENSES[l] } : l,
).filter((l) => l && l.prompt)
if (lenses.length === 0) throw new Error(`no usable lens; defaults are: ${Object.keys(DEFAULT_LENSES).join(', ')}`)

const CONTEXT = [
  `READ-ONLY review of the git range ${input.range} in the current repository (git log --oneline ${input.range}; git diff ${input.range.replace('..', ' ')} -- <path>).`,
  'Do NOT edit, create or commit files in the repository. Running tests is fine; scratch files only under the session scratchpad directory named in your system prompt (or `$(mktemp -d)`).',
  input.spec ? `Spec (binding authority): ${input.spec}.` : '',
  input.plan ? `Plan: ${input.plan} (read its Review Focus section if it has one).` : '',
  input.context ? `Context: ${input.context}` : '',
  input.accepted?.length ? `Decisions already accepted by the user — do NOT report these as defects:\n- ${input.accepted.join('\n- ')}` : '',
  'WebGPU cannot run headless here: unit tests use mock devices, so hunt for what they cannot see.',
  'Report only defects with a concrete failure scenario (inputs/state -> wrong output, validation error, crash, nondeterminism, or a doc statement false against the code). No style nits. Severity by effect on a person using the engine: critical / important / minor.',
].filter(Boolean).join('\n')

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: {
  title: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' },
  severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
  description: { type: 'string' }, failure_scenario: { type: 'string' }, test_idea: { type: 'string' },
}, required: ['title', 'file', 'line', 'severity', 'description', 'failure_scenario'] } } }, required: ['findings'] }

const VERDICT = { type: 'object', properties: {
  real: { type: 'boolean' }, severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
  reasoning: { type: 'string' }, evidence: { type: 'string' }, test_idea: { type: 'string' },
}, required: ['real', 'severity', 'reasoning', 'evidence'] }

const results = await pipeline(
  lenses,
  (l) => agent(`${CONTEXT}\n\n${l.prompt}\n\nReturn every defect you can substantiate by reading the code (cite file:line). Empty list if none.`,
    { label: `find:${l.key}`, phase: 'Find', schema: FINDINGS }),
  (r, l) => parallel((r?.findings ?? []).map((f, i) => () =>
    agent(`${CONTEXT}\n\nYou are a skeptical verifier. A reviewer (lens ${l.key}) claims:\n\n${JSON.stringify(f, null, 2)}\n\nTry hard to REFUTE it: read the cited code, its callers, shaders and tests; run a test or a scratch computation if that settles it. It is real only if the failure scenario happens with the code as written. If uncertain, real=false. Re-grade the severity by effect on a user. Exact evidence (file:line + quoted lines) in evidence; if real, a concrete test that fails today in test_idea.`,
      { label: `verify:${l.key}:${i}`, phase: 'Verify', schema: VERDICT })
      .then((v) => ({ lens: l.key, ...f, verdict: v })))),
)

const RANK = { critical: 0, important: 1, minor: 2 }
const all = results.flat().filter(Boolean)
const confirmed = all
  .filter((f) => f.verdict && f.verdict.real)
  .map((f) => ({ lens: f.lens, title: f.title, file: f.file, line: f.line, severity: f.verdict.severity,
    failure_scenario: f.failure_scenario, reasoning: f.verdict.reasoning, evidence: f.verdict.evidence, test_idea: f.verdict.test_idea }))
  .sort((a, b) => RANK[a.severity] - RANK[b.severity])
const refuted = all.filter((f) => !f.verdict || !f.verdict.real)
  .map((f) => ({ lens: f.lens, title: f.title, why: (f.verdict?.reasoning ?? 'verifier returned nothing').slice(0, 400) }))
log(`${all.length} findings over ${lenses.length} lenses: ${confirmed.length} confirmed, ${refuted.length} refuted`)
return { range: input.range, confirmed, refuted }

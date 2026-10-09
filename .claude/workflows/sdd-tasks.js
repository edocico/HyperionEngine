export const meta = {
  name: 'sdd-tasks',
  description: 'SDD loop (implement, spec+quality review, up to 5 fix rounds) over the tasks of a plan, sequentially',
  whenToUse: 'Executing the headless tasks of an implementation plan with superpowers:subagent-driven-development, briefs at <ws>/task-<n>-brief.md. args: {repo, plan, ws, sk, startBase, branch, fixCommitPrefix, project, tasks: [{n, title, context?, reviewContext?}], constraints?, language?, trailer?, gpuRule?, anchorsRule?, model?}',
  phases: [
    { title: 'Task', detail: 'implementer -> task review -> fix rounds, one task at a time' },
  ],
}

// The subagent-driven-development loop, one task at a time, for a plan whose briefs the
// controller has already extracted (`bash <sk>/scripts/task-brief <plan> <n>` writes
// <ws>/task-<n>-brief.md). Promoted on 2026-10-09 from a plan-specific copy that ran six tasks
// of one plan: the plan-specific text became args, the args are validated, and each prompt gained
// one sentence that runs every command inside repo (the copy had that for free: its repo was the
// session's own directory); the loop, the schemas, the bookkeeping and the result are unchanged.
//
// Per task: an implementer (TDD, commits) -> a task reviewer (spec compliance, then code quality,
// on the review package of base..head) -> while spec issues or Critical/Important findings are
// open, up to 5 fix rounds: a FRESH fixer (a workflow cannot resume an agent) gets the brief, the
// reports so far and the open findings, then a re-reviewer verdicts each finding on the fix diff
// only. The loop stops at the first task whose implementer is BLOCKED/NEEDS_CONTEXT, makes no
// commit or dies, whose reviewer dies, whose fix round stops, or which still has open findings
// after round 5: the controller takes over from there. Minor findings never block; they are
// collected in `minors`. Brief steps that need a browser or the GPU are never the implementer's
// (gpuRule): run them after the commit, e.g. with the gpu-leg workflow.
//
// Usage (by name once the workflow registry has picked this file up; otherwise by scriptPath):
//
//   Workflow({ name: 'sdd-tasks', args: {
//     repo: '/Users/me/Code/HyperionEngine',
//     plan: 'docs/plans/<date>-<topic>-plan.md',
//     ws: '/Users/me/Code/HyperionEngine/.superpowers/sdd/<date>-<topic>-plan',
//     sk: '/Users/me/.claude/plugins/cache/claude-plugins-official/superpowers/<version>/skills/subagent-driven-development',
//     startBase: '<SHA of HEAD before the first task>',
//     branch: 'feat/<topic>',
//     fixCommitPrefix: 'fix(<scope>)',
//     project: 'Hyperion, a web game engine (Rust/WASM simulation + TypeScript WebGPU rendering). This plan <what it changes, in two or three sentences>.',
//     constraints: '/Users/me/Code/HyperionEngine/.superpowers/sdd/<date>-<topic>-plan/global-constraints.md',
//     tasks: [
//       { n: 2, title: '<task title>', context: 'SCOPE: the whole task (Steps 1-6), headless.', reviewContext: 'SCOPE of this review: the whole task.' },
//       { n: 3, title: '<task title>', context: 'SCOPE: Steps 1-4; Step 5 (GPU) is the controller\'s.' },
//     ],
//   } })
//
// args (repo, ws, sk and constraints absolute; plan absolute or relative to repo; repo, plan and
// sk without whitespace or shell metacharacters, because the review-package command is built
// unquoted; any other key, in args or in a task, is an error, since a typo would silently drop a
// rule):
//   repo             the checkout the agents work in: every agent is told to run its commands
//                    there (`cd <repo> && …`), because a shell starts in the session's directory,
//                    which is not repo when repo is a worktree
//   plan             the plan file (named to the agents, passed to review-package)
//   ws               the SDD workspace: task n's brief is <ws>/task-<n>-brief.md
//   sk               the superpowers subagent-driven-development skill directory
//                    (<sk>/scripts/review-package builds every review package)
//   startBase        the SHA (7-40 hex digits, either case; used in lower case, as git prints it)
//                    of HEAD before the first task; a SHA, not a ref name, because a missing commit
//                    is detected by comparing SHA prefixes
//   branch           the branch every agent stays on
//   fixCommitPrefix  the conventional prefix of the fix-round commits, without the colon, e.g. 'fix(12)'
//   project          a paragraph: what the project is and what this plan does
//   tasks            [{n, title, context?, reviewContext?}], in order, each n once: context goes to
//                    the implementer and to every fixer (scope, rulings, fill-ins), reviewContext to
//                    the task reviewer (what to check)
//   constraints?     a file of binding constraints (the plan's global rules, the owner's decisions)
//   language?        the language rule; default: code, code comments and JSDoc in English, commit
//                    subjects and bodies in Italian after an English conventional prefix (this
//                    repo's rule, which also sets the Italian fix-commit subject template)
//   trailer?         the commit trailer; default 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
//   gpuRule?         a sentence naming the brief steps the controller runs on the GPU instead; the
//                    fixed 'Never start a dev server or a browser. Commit as soon as the headless steps
//                    are GREEN.' always follows. Default: any step that needs a browser, the dev
//                    server or the GPU.
//   anchorsRule?     a sentence saying what the brief's file:line references are anchored to; the
//                    fixed rule 'locate every edit by its quoted text, report a missing anchor'
//                    always follows
//   model?           the model of every agent; default 'opus'
//
// Result: one entry per task attempted, in order; the loop stops after the first entry with
// `stopped` set or `open` non-empty.
//   stopped at the implementer: { task, stopped: 'implementer', impl }  (impl null if it died)
//   reviewer died:              { task, stopped: 'reviewer died', impl, base, head }
//   otherwise:                  { task, base, head, implStatus, implConcerns, testSummary, commits,
//                                 specCompliant, qualityApproved, cannotVerify, minors, rounds,
//                                 open, stopped, reportChars, reviewChars }
// The full reports and reviews are not in the result (only their lengths): they are the agents'
// return values in the run's journal.jsonl. Persist them into <ws> after the run (the agents
// cannot write report files themselves).

const DEFAULT_LANGUAGE = 'code, code comments and JSDoc in English; commit subjects and bodies in Italian after an English conventional prefix'
const DEFAULT_TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
const DEFAULT_GPU_RULE = 'GPU steps: any brief step that needs a browser, the dev server or the GPU (chrome-devtools, a GPU gate or session, a pixel check, screenshots) is NOT yours: the controller runs it after your commit.'
const DEFAULT_ANCHORS_RULE = 'Line numbers in the brief (file:line) are anchors at the commit the plan was written against; earlier tasks of this plan may have moved the code since.'
const DEFAULT_MODEL = 'opus'
const USAGE = "usage: Workflow({ name: 'sdd-tasks', args: { repo, plan, ws, sk, startBase, branch, fixCommitPrefix, project, tasks: [{ n, title, context?, reviewContext? }], constraints?, language?, trailer?, gpuRule?, anchorsRule?, model? } })"

function validateArgs(raw) {
  let a = raw
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch (e) { throw new Error('sdd-tasks: args is a string that is not JSON; pass the args as an object.\n' + USAGE) }
  }
  if (a === undefined || a === null) a = {}
  if (typeof a !== 'object' || Array.isArray(a)) throw new Error('sdd-tasks: args must be an object.\n' + USAGE)
  const given = (v) => v !== undefined && v !== null
  const blank = (v) => !given(v) || (typeof v === 'string' && v.trim() === '')
  const REQUIRED = ['repo', 'plan', 'ws', 'sk', 'startBase', 'branch', 'fixCommitPrefix', 'project', 'tasks']
  const OPTIONAL = ['constraints', 'language', 'trailer', 'gpuRule', 'anchorsRule', 'model']
  const TASK_KEYS = ['n', 'title', 'context', 'reviewContext']
  const missing = REQUIRED.filter((k) => blank(a[k]))
  const problems = []
  if (missing.length) problems.push('missing required args: ' + missing.join(', '))
  const unknown = Object.keys(a).filter((k) => !REQUIRED.includes(k) && !OPTIONAL.includes(k))
  if (unknown.length) problems.push('unknown args: ' + unknown.join(', ') + ' (a typo would silently drop a rule; the known ones: ' + REQUIRED.concat(OPTIONAL).join(', ') + ')')
  for (const k of REQUIRED.filter((r) => r !== 'tasks').concat(OPTIONAL)) {
    if (given(a[k]) && !missing.includes(k) && (typeof a[k] !== 'string' || a[k].trim() === '')) problems.push(k + ' must be a non-empty string')
  }
  const ok = (k) => typeof a[k] === 'string' && a[k].trim() !== ''
  for (const k of ['repo', 'ws', 'sk', 'constraints']) {
    if (ok(k) && !a[k].startsWith('/')) problems.push(k + ' must be an absolute path; got ' + a[k])
  }
  for (const k of ['repo', 'plan', 'sk']) {
    if (ok(k) && /[\s'"`$\\;&|<>(){}[\]*?!]/.test(a[k])) problems.push(k + ' must not hold whitespace or a shell metacharacter (the review-package command is built unquoted); got ' + a[k])
  }
  if (ok('startBase') && !/^[0-9a-f]{7,40}$/i.test(a.startBase)) problems.push('startBase must be a commit SHA (7 to 40 hex digits), not a ref name: the loop detects a missing commit by comparing SHA prefixes; got ' + a.startBase)
  if (ok('fixCommitPrefix') && !/^[A-Za-z]+(\([^()\s'"`$\\]+\))?!?$/.test(a.fixCommitPrefix)) problems.push("fixCommitPrefix must be a conventional-commit type with an optional scope and no colon, e.g. 'fix(12)'; got " + a.fixCommitPrefix)
  if (ok('trailer') && /["`$\\\r\n]/.test(a.trailer)) problems.push('trailer must not hold ", `, $, \\ or a line break (it is pasted into git commit -m "…")')
  if (given(a.tasks) && !missing.includes('tasks')) {
    if (!Array.isArray(a.tasks) || a.tasks.length === 0) {
      problems.push('tasks must be a non-empty array of {n, title, context?, reviewContext?}')
    } else {
      const seen = new Map()
      a.tasks.forEach((t, i) => {
        if (t === null || typeof t !== 'object' || Array.isArray(t)) { problems.push('tasks[' + i + '] must be an object {n, title, context?, reviewContext?}'); return }
        const extra = Object.keys(t).filter((k) => !TASK_KEYS.includes(k))
        if (extra.length) problems.push('tasks[' + i + '] has unknown keys: ' + extra.join(', ') + ' (the known ones: ' + TASK_KEYS.join(', ') + ')')
        const nOk = (typeof t.n === 'number' && Number.isFinite(t.n)) || (typeof t.n === 'string' && /^[A-Za-z0-9._-]+$/.test(t.n))
        if (!nOk) problems.push('tasks[' + i + '].n must be the task number of its brief <ws>/task-<n>-brief.md')
        else if (seen.has(String(t.n))) problems.push('tasks[' + i + '].n repeats tasks[' + seen.get(String(t.n)) + '].n (' + t.n + '): each task needs its own brief and its own agent labels')
        else seen.set(String(t.n), i)
        if (typeof t.title !== 'string' || t.title.trim() === '') problems.push('tasks[' + i + '].title must be a non-empty string')
        for (const k of ['context', 'reviewContext']) {
          if (given(t[k]) && typeof t[k] !== 'string') problems.push('tasks[' + i + '].' + k + ' must be a string')
        }
      })
    }
  }
  if (problems.length) throw new Error('sdd-tasks: invalid args:\n- ' + problems.join('\n- ') + '\n' + USAGE)
  // git prints SHAs in lower case and the loop compares their prefixes: normalise, on a copy.
  return { ...a, startBase: a.startBase.toLowerCase() }
}

const A = validateArgs(args)
const LANGUAGE = A.language ?? DEFAULT_LANGUAGE
const TRAILER = A.trailer ?? DEFAULT_TRAILER
const GPU_RULE = A.gpuRule ?? DEFAULT_GPU_RULE
const ANCHORS_RULE = A.anchorsRule ?? DEFAULT_ANCHORS_RULE
const MODEL = A.model ?? DEFAULT_MODEL
const asSentence = (s) => { const t = s.trim(); return /[.!?]$/.test(t) ? t : t + '.' }
// The default language rule is this repo's: fix commits get the Italian subject template.
const fixSubject = (t) => (A.language === undefined || A.language === null
  ? '<descrizione in italiano> (review del Task ' + t.n + ')'
  : '<description, in the commit language set under Language> (review of Task ' + t.n + ')')

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'] },
    base: { type: 'string', description: 'full SHA of HEAD before you changed anything' },
    head: { type: 'string', description: 'full SHA of HEAD after your last commit' },
    commits: { type: 'array', items: { type: 'string' }, description: 'short SHA + subject, oldest first' },
    testSummary: { type: 'string' },
    concerns: { type: 'string', description: 'empty string if none; for BLOCKED/NEEDS_CONTEXT the specifics' },
    report: { type: 'string', description: 'the FULL report in Markdown (what you implemented, TDD evidence RED/GREEN with commands and outputs, files changed, self-review, concerns); for a fix round, the fix report only' },
  },
  required: ['status', 'head', 'commits', 'testSummary', 'concerns', 'report'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    specCompliant: { type: 'boolean' },
    specIssues: { type: 'array', items: { type: 'string' }, description: 'missing/extra/misunderstood, each self-contained with file:line' },
    cannotVerify: { type: 'array', items: { type: 'string' } },
    critical: { type: 'array', items: { type: 'string' } },
    important: { type: 'array', items: { type: 'string' } },
    minor: { type: 'array', items: { type: 'string' } },
    qualityApproved: { type: 'boolean' },
    diffFile: { type: 'string' },
    review: { type: 'string', description: 'the FULL written review in Markdown, file:line evidence for every finding and the checks you ran' },
  },
  required: ['specCompliant', 'specIssues', 'cannotVerify', 'critical', 'important', 'minor', 'qualityApproved', 'review'],
}
const RE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { finding: { type: 'string' }, addressed: { type: 'boolean' }, evidence: { type: 'string' } },
        required: ['finding', 'addressed', 'evidence'],
      },
    },
    newCritical: { type: 'array', items: { type: 'string' } },
    newImportant: { type: 'array', items: { type: 'string' } },
    newMinor: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    review: { type: 'string', description: 'the FULL re-review in Markdown' },
  },
  required: ['verdicts', 'newCritical', 'newImportant', 'newMinor', 'outOfScope', 'review'],
}

const COMMON = [
  'Repository: ' + A.repo + ' — work ONLY on the current branch ' + A.branch + ' (never checkout another branch, never merge, never push, never rewrite history, never amend, never stash, never reset). Run every shell command inside it, as `cd ' + A.repo + ' && …`: a shell may start in another directory, even another checkout of this repo, and the relative forms below (`--prefix ts`, ts/src/…) resolve against the current one.',
  'Project: ' + asSentence(A.project) + ' The plan is ' + A.plan + ' (do NOT read the whole plan: your brief is the extract you need).',
  'Binding constraints: ' + (A.constraints ? A.constraints + ' (the plan\'s global constraints and the owner\'s decisions).' : 'none beyond the brief and the context below.'),
  'Language: ' + asSentence(LANGUAGE) + ' Commit messages exactly as the brief gives them, each ending with the trailer `' + TRAILER + '` as a separate -m paragraph.',
  'Commands from the brief are authoritative (cwd-independent forms such as `npx --prefix ts vitest run --root ts src/...`, `npm --prefix ts test`). Never use `grep -P`; quote --include globs and any URL containing ?. A PostToolUse hook runs the colocated vitest file after each edit of a ts/src file: a failure right after editing a *.test.ts is the expected RED.',
  asSentence(GPU_RULE) + ' Never start a dev server or a browser. Commit as soon as the headless steps are GREEN.',
  asSentence(ANCHORS_RULE) + ' Locate every edit by its quoted text; if a quoted anchor is missing, report it instead of guessing.',
  'Scratch files: only under the session scratchpad directory named in your system prompt (or `$(mktemp -d)`) or the repo\'s gitignored target/ directory, never committed. Do NOT write report files with the Write tool (the harness refuses subagent report files): return your full report in the structured output field `report`.',
].join('\n')

function implPrompt(t, brief) {
  return [
    'You are implementing Task ' + t.n + ' of a plan: ' + t.title,
    '',
    '## Task Description',
    'Read this first — it is your requirements, with the exact values to use verbatim: ' + brief,
    '',
    '## Context',
    COMMON,
    t.context || '',
    '',
    '## Your Job',
    '1. Record BASE = `git -C ' + A.repo + ' rev-parse HEAD` before changing anything.',
    '2. Implement exactly what the brief specifies (within the scope given above), test-first where the brief says so (show RED, then GREEN).',
    '3. While iterating run the focused tests; run the full suite (`npm --prefix ts test`) once before committing if any ts/ file changed.',
    '4. Commit with the message(s) the brief (or the context above) gives.',
    '5. Self-review your own diff (completeness against the brief, quality, YAGNI, tests that verify behaviour, pristine output) and fix what you find before reporting.',
    '',
    '## You Do Not Dispatch Subagents',
    'Do all of the work yourself. Never spawn a subagent, and never spawn a reviewer: review is scheduled by the controller after your report.',
    '',
    '## When You Are Stuck',
    'You cannot ask questions interactively. If a requirement is unclear, contradictory, or an anchor is missing, STOP and return status NEEDS_CONTEXT or BLOCKED with the specifics in `concerns`. Bad work is worse than no work.',
    '',
    '## Report',
    'Return the structured result: status, base, head (full SHAs), commits, a one-line test summary, concerns, and `report`: the FULL report (what you implemented; TDD evidence: RED command + relevant failing output + why expected, GREEN command + passing output; files changed; self-review findings; concerns).',
  ].join('\n')
}

function fixPrompt(t, brief, reportSoFar, findings, round) {
  return [
    'You are fixing review findings for Task ' + t.n + ' of a plan (' + t.title + '), fix round ' + round + ' of 5. A prior implementer did the task; you own the fix now.',
    '',
    'Read first: the task brief ' + brief + ' (the requirements).',
    '',
    '## Context',
    COMMON,
    t.context || '',
    '',
    '## What was done so far (the implementer\'s report, then any earlier fix reports)',
    reportSoFar,
    '',
    '## Findings to fix (verbatim from the review)',
    findings.map((f) => '- ' + f).join('\n'),
    '',
    '## Your Job',
    '1. Record FIX_BASE = `git -C ' + A.repo + ' rev-parse HEAD`.',
    '2. For each finding: confirm it against the code. If a finding is wrong or contradicts the brief or the binding constraints, do NOT change the code for it: explain why (with file:line evidence) in your fix report and in `concerns`.',
    '3. Fix the real ones test-first where a test can express them (RED then GREEN). Re-run the tests covering the amended code; run `npm --prefix ts test` once at the end if any ts/ file changed.',
    '4. Commit: `git commit -m "' + A.fixCommitPrefix + ': ' + fixSubject(t) + '" -m "' + TRAILER + '"` (one or more commits).',
    '5. In `report`, the fix report under a heading "## Fix round ' + round + '": per finding what you changed (or why not), the covering tests, the exact command and its output.',
    'Never spawn subagents. Return the structured result (status, base = FIX_BASE, head, commits, testSummary, concerns, report).',
  ].join('\n')
}

function reviewPrompt(t, brief, report, base, head) {
  return [
    'You are reviewing one task of a plan: first whether it matches its requirements, then whether it is well-built. This is a task-scoped gate, not a merge review (a broad whole-branch review happens later).',
    '',
    '## What Was Requested',
    'Read the task brief: ' + brief,
    'Binding constraints: ' + (A.constraints ? 'read ' + A.constraints : 'none beyond the brief'),
    t.reviewContext || '',
    '',
    '## What the Implementer Claims (unverified)',
    'Treat this report as unverified claims; a stated rationale never downgrades a finding:',
    '<<<REPORT',
    report,
    'REPORT>>>',
    '',
    '## Diff Under Review',
    'Base ' + base + ', head ' + head + '. Generate the review package by running exactly:',
    '`cd ' + A.repo + ' && bash ' + A.sk + '/scripts/review-package ' + A.plan + ' ' + base + ' ' + head + '`',
    'It prints the path of a file holding the commit list, stat and full diff with context: Read that file once; it is your view of the change. Inspect code outside the diff only for a concrete named risk (one focused check per risk; name the risk and the check). Your review is read-only: never mutate the working tree, index, HEAD or branches. Do not re-run the suite; run a focused test only for a specific doubt. Run every command inside ' + A.repo + ' (`cd ' + A.repo + ' && …`): a shell may start in another checkout.',
    'Never spawn subagents. Do not write a review file with the Write tool: return the full review in the structured output field `review`.',
    '',
    '## Part 1: Spec Compliance — missing / extra / misunderstood, against the brief (within the scope stated above) and the binding constraints. Requirements living outside the diff go to cannotVerify.',
    '## Part 2: Code Quality — correctness, edge cases, tests that verify real behaviour (judge whether each test would fail on the defect it names), structure, pristine test output.',
    '',
    'Calibration: Critical/Important = the task cannot be trusted until fixed (incorrect or fragile behaviour, a missed requirement, a test that asserts nothing, swallowed errors). Polish is Minor. If the brief mandates something the rubric calls a defect, report it as Important labelled plan-mandated.',
    'Return the structured result; each finding string must be self-contained (file:line, what is wrong, why, how to fix).',
  ].join('\n')
}

function reReviewPrompt(t, brief, reportSoFar, findings, fixBase, head, round) {
  return [
    'You are re-reviewing fix round ' + round + ' of Task ' + t.n + ' of a plan. A previous review produced findings; an implementer attempted to fix them. Verdict each finding and inspect the fix diff — nothing else.',
    '',
    'Task brief: ' + brief + '. Binding constraints: ' + (A.constraints ? A.constraints : 'none beyond the brief'),
    'Implementer report and fix reports (unverified claims):',
    '<<<REPORT',
    reportSoFar,
    'REPORT>>>',
    '',
    '## Findings under verification',
    findings.map((f) => '- ' + f).join('\n'),
    '',
    '## The fix',
    'Fix base ' + fixBase + ' (the head the previous review saw), head ' + head + '. Generate the package: `cd ' + A.repo + ' && bash ' + A.sk + '/scripts/review-package ' + A.plan + ' ' + fixBase + ' ' + head + '` and Read the printed file once. If the implementer declined a finding with evidence, judge the evidence: a finding that was wrong counts as addressed only if the evidence proves it wrong.',
    'Read-only review; never mutate the checkout; never spawn subagents; do not re-run the suite (focused test only for a specific doubt). Run every command inside ' + A.repo + ' (`cd ' + A.repo + ' && …`): a shell may start in another checkout. Return the full re-review in the structured output field `review`.',
    'Scope: the findings and the fix diff. Issues entirely outside the fix diff go to outOfScope (non-blocking).',
    'Return one verdict per finding (addressed true/false + file:line evidence; "attempted" is not addressed), new breakage in the fix diff by severity, out-of-scope observations.',
  ].join('\n')
}

let base = A.startBase
const results = []
for (const t of A.tasks) {
  const ph = 'Task'
  const brief = A.ws + '/task-' + t.n + '-brief.md'
  const impl = await agent(implPrompt(t, brief), { label: 'implement:T' + t.n, phase: ph, schema: IMPL_SCHEMA, model: MODEL })
  if (!impl || impl.status === 'BLOCKED' || impl.status === 'NEEDS_CONTEXT' || !impl.head || impl.head.slice(0, 7) === base.slice(0, 7)) {
    results.push({ task: t.n, stopped: 'implementer', impl })
    log('Task ' + t.n + ' stopped at the implementer: ' + (impl ? impl.status + ' ' + impl.concerns : 'agent died'))
    break
  }
  log('Task ' + t.n + ' implemented (' + impl.status + '): ' + impl.commits.join(' | '))
  let head = impl.head
  let reportSoFar = impl.report
  const review = await agent(reviewPrompt(t, brief, impl.report, base, head), { label: 'review:T' + t.n, phase: ph, schema: REVIEW_SCHEMA, model: MODEL })
  if (!review) { results.push({ task: t.n, stopped: 'reviewer died', impl, base, head }); break }
  let open = []
    .concat(review.specCompliant ? [] : review.specIssues.map((s) => 'SPEC: ' + s))
    .concat(review.critical.map((s) => 'CRITICAL: ' + s))
    .concat(review.important.map((s) => 'IMPORTANT: ' + s))
  const minors = review.minor.slice()
  const rounds = []
  const fixReports = []
  const reReviews = []
  let stopped = null
  let round = 0
  log('Task ' + t.n + ' review: spec ' + (review.specCompliant ? 'OK' : 'ISSUES') + ', quality ' + (review.qualityApproved ? 'approved' : 'needs fixes') + ', ' + open.length + ' open, ' + minors.length + ' minor, ' + review.cannotVerify.length + ' cannot-verify')
  while (open.length && round < 5) {
    round++
    const fixBase = head
    const fix = await agent(fixPrompt(t, brief, reportSoFar, open, round), { label: 'fix:T' + t.n + ':r' + round, phase: ph, schema: IMPL_SCHEMA, model: MODEL })
    if (!fix || fix.status === 'BLOCKED' || fix.status === 'NEEDS_CONTEXT') { stopped = 'fix round ' + round + ': ' + (fix ? fix.status + ' ' + fix.concerns : 'agent died'); break }
    fixReports.push(fix.report)
    reportSoFar = reportSoFar + '\n\n' + fix.report
    if (!fix.head || fix.head.slice(0, 7) === fixBase.slice(0, 7)) {
      rounds.push({ round, fixBase, head: fixBase, note: 'no commit: ' + fix.concerns })
      stopped = 'fix round ' + round + ' made no commit: ' + fix.concerns
      break
    }
    head = fix.head
    const rr = await agent(reReviewPrompt(t, brief, reportSoFar, open, fixBase, head, round), { label: 're-review:T' + t.n + ':r' + round, phase: ph, schema: RE_REVIEW_SCHEMA, model: MODEL })
    if (!rr) { stopped = 're-reviewer died in round ' + round; break }
    reReviews.push(rr.review)
    const addressed = rr.verdicts.filter((v) => v.addressed).length
    open = rr.verdicts.filter((v) => !v.addressed).map((v) => v.finding + ' [re-review: ' + v.evidence + ']')
      .concat(rr.newCritical.map((s) => 'CRITICAL (fix diff): ' + s))
      .concat(rr.newImportant.map((s) => 'IMPORTANT (fix diff): ' + s))
    rr.newMinor.forEach((s) => minors.push('fix-diff minor: ' + s))
    rr.outOfScope.forEach((s) => minors.push('out-of-scope: ' + s))
    rounds.push({ round, fixBase, head, addressed, open: open.length, commits: fix.commits })
    log('Task ' + t.n + ' fix round ' + round + ': ' + addressed + ' addressed, ' + open.length + ' open')
  }
  results.push({
    task: t.n, base, head, implStatus: impl.status, implConcerns: impl.concerns, testSummary: impl.testSummary,
    commits: impl.commits, specCompliant: review.specCompliant, qualityApproved: review.qualityApproved,
    cannotVerify: review.cannotVerify, minors, rounds, open, stopped,
    reportChars: impl.report.length, reviewChars: review.review.length,
  })
  if (stopped || open.length) { log('Task ' + t.n + ' needs the controller: ' + (stopped || open.length + ' open findings at the cap')); break }
  base = head
}
return results

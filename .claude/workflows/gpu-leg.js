export const meta = {
  name: 'gpu-leg',
  description: 'One GPU leg in real Chrome: an agent runs a written step list with a chrome-devtools MCP server and writes evidence files, then an independent verifier checks them against written expectations',
  whenToUse: 'A check no headless test can run (WGSL compilation and pipeline validation on the device, harness tabs, probe reads, a committed bench), with the infrastructure up (.claude/skills/gpu-check/scripts/gpu-infra.sh up). args: {repo, title, steps: "<steps.md>", expectations: "<expectations.md>", evidenceDir?, server?: "chrome-devtools-gpu" | "chrome-devtools", context?, head?, model?}',
  phases: [
    { title: 'Run', detail: 'one agent drives the browser through the numbered steps and writes the evidence files' },
    { title: 'Verify', detail: 'an independent agent checks the evidence against the expectations, without the browser' },
  ],
}

// Promoted on 2026-10-09 from three plan-specific GPU legs (a bench session on master's engine, a
// WGSL + pipeline-validation gate, a harness-tab run). All three had one shape: an agent drives the
// browser through a step list and writes JSON evidence, then an independent agent re-reads that
// evidence against written expectations, without the browser. They also shared rules learned the
// hard way, which the prompts below carry: the anti-reload initScript on every navigation, the
// exact adapter line, the console and window.__viteWsCloses at the end of every page session,
// absolute evidence paths inside the repo, no file edits while Vite runs, raw values instead of
// guessed booleans, one retry at most, never on a failure that is not infrastructural (a redo rule
// the steps fix themselves applies as written).
//
// Before the leg, prepare the infrastructure and let nothing else edit the checkout while it runs
// (Vite would reload the page under a running script):
//   sh .claude/skills/gpu-check/scripts/gpu-infra.sh up [asset-server args, e.g. --git /old-x.wgsl=<rev>:ts/src/shaders/x.wgsl]
// It restarts Vite FRESH at the current HEAD (after a commit, a checkout or an edit of any app
// module, a running Vite can serve a stale transform or a second module instance), restarts the
// asset server with those args, and on macOS starts a detached caffeinate. It serves
// $HYPERION_ROOT, else $CLAUDE_PROJECT_DIR: `repo` below must be that checkout (one with
// ts/node_modules), and the leg checks it: the process listening on :5173 must run in <repo>/ts,
// else the leg stops BLOCKED. After the leg, with the same TMPDIR as `up` (its state lives there):
//   sh .claude/skills/gpu-check/scripts/gpu-infra.sh down
//
// Usage (by name once the workflow registry has picked this file up; otherwise by scriptPath):
//
//   Workflow({ name: 'gpu-leg', args: {
//     repo: '/Users/me/Code/HyperionEngine',
//     title: 'Task 3 GPU gate',
//     steps: '/Users/me/Code/HyperionEngine/.superpowers/sdd/<plan>/task-3-gpu-steps.md',
//     expectations: '/Users/me/Code/HyperionEngine/.superpowers/sdd/<plan>/task-3-gpu-expectations.md',
//     evidenceDir: '/Users/me/Code/HyperionEngine/docs/plans/assets/<date>-<topic>',
//     head: '<the full SHA the leg must run at>',
//     context: 'Rust is unchanged since <rev>: guard-stale-wasm may fire on an mtime only.',
//   } })
//
// args:
//   repo           absolute path of the checkout Vite serves
//   title          a short name for the leg (agent labels, the default evidence directory)
//   steps          a Markdown file of NUMBERED steps: per page session the URL and the window
//                  size, then the tool calls, the scripts to evaluate (file paths), the globals to
//                  set first, the evidence files to write (names in evidenceDir), shell commands
//   expectations   a Markdown file of NUMBERED pass criteria, each judged on its own: values and
//                  tolerances, the exact adapter line, the console allowed (a known warning
//                  included), stop or branch rules fixed before the run. The verifier gates on this
//                  file and on nothing else.
//   evidenceDir?   where every evidence file goes; default <repo>/target/gpu-check/<title slug>,
//                  for a throwaway leg: target/ is gitignored (a commit would need git add -f) and
//                  cargo clean deletes it. Evidence to commit goes in an evidenceDir under
//                  docs/plans/assets/, as in the example. Keep it inside the repo: the
//                  chrome-devtools servers write only under their workspace roots and $TMPDIR (the
//                  session scratchpad was refused).
//   server?        'chrome-devtools-gpu' (default: Chrome with --enable-webgpu-developer-features
//                  on the Mac, the Vulkan flags on the Fedora box) or 'chrome-devtools' (stock Chrome)
//   context?       text for both agents: rulings, known warnings, deferred minors, what not to touch
//   head?          the commit (7-40 hex digits) the leg must run at: any other HEAD is BLOCKED
//   model?         the model of both agents; default 'opus', as in the legs this was promoted from
// steps, expectations and evidenceDir: absolute, or relative to repo. Any other key is an error: a
// typo (contex, evidencedir) would otherwise drop a binding rule without a word.
//
// Result: { title, evidenceDir, leg, verify, pass }
//   leg     the runner's { status, steps, files, consoleErrors, adapterLine, versions, anomalies,
//           report }, or null if it died (the verifier then reports what evidence exists)
//   verify  the verifier's { verdict, perExpectation, extraFindings, report }, or null if it died
//   pass    true only when the two agree: the leg is DONE, with at least one step and none FAIL,
//           AND the verifier says PASS with every one of its expectations passing. Both count
//           because they gate on different things: the verifier on the expectations file alone,
//           the leg also on its own rules (an unexpected console message, a silent mode fallback,
//           the adapter), which an expectations file need not repeat. A disagreement, and a status
//           or a verdict that contradicts its own entries, is logged and counts as not passing.
// Stale evidence: the leg first touches <repo>/target/gpu-check/.leg-start-<title slug>, and the
// verifier counts only the files newer than that marker, so a rerun cannot pass on files an
// earlier run left in the same evidenceDir.
// The leg commits nothing: read the verdict, then commit the evidence you keep yourself.

const SERVERS = ['chrome-devtools-gpu', 'chrome-devtools']
const KNOWN_ARGS = ['repo', 'title', 'steps', 'expectations', 'evidenceDir', 'server', 'context', 'head', 'model']
const USAGE = "usage: Workflow({ name: 'gpu-leg', args: { repo, title, steps: '<steps.md>', expectations: '<expectations.md>', evidenceDir?, server?: 'chrome-devtools-gpu' | 'chrome-devtools', context?, head?, model? } })"

function validateArgs(raw) {
  let a = raw
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch (e) { throw new Error('gpu-leg: args is a string that is not JSON; pass the args as an object.\n' + USAGE) }
  }
  if (a === undefined || a === null) a = {}
  if (typeof a !== 'object' || Array.isArray(a)) throw new Error('gpu-leg: args must be an object.\n' + USAGE)
  const given = (v) => v !== undefined && v !== null
  const blank = (v) => !given(v) || (typeof v === 'string' && v.trim() === '')
  const missing = ['repo', 'title', 'steps', 'expectations'].filter((k) => blank(a[k]))
  const problems = []
  if (missing.length) problems.push('missing required args: ' + missing.join(', '))
  const unknown = Object.keys(a).filter((k) => !KNOWN_ARGS.includes(k))
  if (unknown.length) problems.push('unknown args: ' + unknown.join(', ') + ' (a typo would silently drop a binding rule; the known ones: ' + KNOWN_ARGS.join(', ') + ')')
  for (const k of KNOWN_ARGS) {
    if (given(a[k]) && !missing.includes(k) && (typeof a[k] !== 'string' || a[k].trim() === '')) problems.push(k + ' must be a non-empty string')
  }
  const ok = (k) => typeof a[k] === 'string' && a[k].trim() !== ''
  if (ok('repo') && !a.repo.startsWith('/')) problems.push('repo must be an absolute path; got ' + a.repo)
  for (const k of ['steps', 'expectations', 'evidenceDir']) {
    if (ok(k) && /[\r\n]/.test(a[k])) problems.push(k + ' must be a path, not the text itself')
  }
  if (ok('server') && !SERVERS.includes(a.server)) problems.push("server must be 'chrome-devtools-gpu' or 'chrome-devtools'; got " + a.server)
  if (ok('head') && !/^[0-9a-f]{7,40}$/i.test(a.head)) problems.push('head must be a commit SHA (7 to 40 hex digits); got ' + a.head)
  if (problems.length) throw new Error('gpu-leg: invalid args:\n- ' + problems.join('\n- ') + '\n' + USAGE)
  return a
}

const A = validateArgs(args)
const REPO = A.repo.replace(/(.)\/+$/, '$1')
const abs = (p) => (p.startsWith('/') ? p : REPO + '/' + p.replace(/^(\.\/)+/, ''))
const TITLE = A.title.trim()
const SLUG = TITLE.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'leg'
const STEPS = abs(A.steps)
const EXPECT = abs(A.expectations)
const EVDIR = (A.evidenceDir ? abs(A.evidenceDir) : REPO + '/target/gpu-check/' + SLUG).replace(/(.)\/+$/, '$1')
const SERVER = A.server ?? 'chrome-devtools-gpu'
const OTHER = SERVERS.find((s) => s !== SERVER)
const HEAD = A.head ? A.head.toLowerCase() : null
const MODEL = A.model ?? 'opus'
// Touched by the leg before its first evidence file: the verifier counts only the files newer than it.
const MARKER = REPO + '/target/gpu-check/.leg-start-' + SLUG
const TOOLS = ['list_pages', 'select_page', 'new_page', 'navigate_page', 'resize_page', 'evaluate_script', 'list_console_messages', 'get_console_message', 'list_network_requests', 'take_screenshot']
  .map((t) => 'mcp__' + SERVER + '__' + t).join(',')
const SERVER_NOTE = SERVER === 'chrome-devtools-gpu'
  ? 'Chrome launched with flags: --enable-webgpu-developer-features on the Mac (unquantized GPU timestamps; the adapter line carries the device id), the Vulkan flags on the Fedora box'
  : 'stock Chrome with no flags, what a user runs (GPU timestamps quantized to 65 536 ns; on the Mac the adapter line leaves the device id out)'
const MAC_LINE = SERVER === 'chrome-devtools-gpu'
  ? '[Hyperion] WebGPU adapter: apple / metal-3 / 0x0000, subgroups 32-32'
  : '[Hyperion] WebGPU adapter: apple / metal-3, subgroups 32-32'
if (!EVDIR.startsWith(REPO + '/')) log('gpu-leg: evidenceDir ' + EVDIR + ' is outside the repo; the chrome-devtools servers write files only under their workspace roots and $TMPDIR')

const LEG_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['DONE', 'DONE_WITH_FAILURES', 'BLOCKED'] },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'string', description: 'the step number and title, as the steps file gives them' },
          status: { type: 'string', enum: ['PASS', 'FAIL', 'SKIP'] },
          evidence: { type: 'string', description: 'expected vs observed RAW values, the files written, exit codes, retries; for a SKIP the rule and the values that decided it' },
        },
        required: ['step', 'status', 'evidence'],
      },
    },
    files: { type: 'array', items: { type: 'string' }, description: 'absolute path of every evidence file written' },
    consoleErrors: { type: 'array', items: { type: 'string' }, description: 'every error and warn console message of every page session, verbatim, prefixed by the page URL, expected ones included and marked as such; [] if none' },
    adapterLine: { type: 'string', description: 'the adapter line exactly as printed; one per page, prefixed by its URL, if they differ' },
    versions: { type: 'string', description: 'browser full version, OS version and build' },
    anomalies: { type: 'array', items: { type: 'string' }, description: 'anything outside the steps: hook messages, 304s, retries, unexpected waits, HEAD changes' },
    report: { type: 'string', description: 'the FULL report in Markdown' },
  },
  required: ['status', 'steps', 'files', 'consoleErrors', 'adapterLine', 'versions', 'anomalies', 'report'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    perExpectation: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          expectation: { type: 'string', description: 'the expectation, with its number, quoted or summarised' },
          pass: { type: 'boolean' },
          evidence: { type: 'string', description: 'what proves it (file, field, recomputed value, command and output), UNPROVEN and what is missing, or "from the leg\'s claims" for what only the leg saw' },
        },
        required: ['expectation', 'pass', 'evidence'],
      },
    },
    extraFindings: { type: 'array', items: { type: 'string' }, description: 'anything else noticed; reported, never gated on' },
    report: { type: 'string', description: 'the FULL verification in Markdown' },
  },
  required: ['verdict', 'perExpectation', 'extraFindings', 'report'],
}

const HEAD_RULE = HEAD
  ? `\`git -C "${REPO}" rev-parse HEAD\` must start with ${HEAD}; if it does not, stop and return BLOCKED.`
  : `Record \`git -C "${REPO}" rev-parse HEAD\`: the leg runs at that commit.`

const COMMON = `You run one GPU leg of the Hyperion engine (a 2D web game engine: Rust/WASM simulation, TypeScript + WebGPU rendering) in a real browser: "${TITLE}". It checks what no headless test can see (WGSL compilation and pipeline validation on a real device, what the GPU draws, browser behaviour); the evidence files it writes are the record the work is judged on.

Repo: ${REPO}. ${HEAD_RULE} Read HEAD again after the last step: it must not have changed (if it did, record both SHAs in anomalies: the evidence may mix two states of the code).

Read before you start:
- The steps, ${STEPS}: numbered, and they bind you. Run them in order, exactly as written (tool calls, scripts, globals, files, shell commands); never improvise a step they do not give.
- The expectations, ${EXPECT}: the pass criteria each step is judged against. A rule fixed there or in the steps before the run (a threshold, a tolerance, a number of runs, a stop or branch condition) is applied as written: never reinterpreted, never relaxed, never re-run until it holds.
- The header comment of every script and bench the steps name, in full (what it does, its tasks and options, the globals it reads, what it returns or writes, its guards, any clear or reset rule): it binds you like the steps. Never edit one.
- The gpu-check skill, ${REPO}/.claude/skills/gpu-check/SKILL.md, by section title (their numbers may change): "Load the harness on a hardware adapter" (the Mac, the Fedora box), "Console", "Pixels" (the probe, screenshots, absolute file paths), "Mode A", and "Bench session" when a step loads a bench, from its Page step to its "Each page ends" step (steps 2-7 today): its first and last steps, \`gpu-infra.sh up\` and \`down\`, are the controller's, never yours.
${A.context ? `
## Context from the controller (binding)
${A.context.trim()}
` : ''}
## Infrastructure: prepared by the controller, never yours to change
- Before this leg the controller ran \`.claude/skills/gpu-check/scripts/gpu-infra.sh up\` (and runs \`down\` after it): the Vite dev server at http://localhost:5173, restarted FRESH at this HEAD; on macOS a detached \`caffeinate -dimsu\` (a sleeping display stops requestAnimationFrame, and with it the engine, every probe and every wait of a bench); the asset server at http://127.0.0.1:8765, for the steps that load a bench or a file from it. Never run gpu-infra.sh, never start, stop or restart a server, never kill a process.
- \`curl --noproxy '*' -s -o /dev/null -w '%{http_code}' http://localhost:5173/\` must print 200 before the first navigation; otherwise return BLOCKED. When a step needs the asset server, the same curl on http://127.0.0.1:8765/ must print an HTTP status (any code; 000 means nothing answers): otherwise BLOCKED too.
- That Vite must serve THIS checkout (gpu-infra.sh serves $HYPERION_ROOT, which can be another one). Before the first navigation, find the process listening on :5173 (\`lsof -nP -iTCP:5173 -sTCP:LISTEN -t\`; on Linux without lsof, \`ss -Hltnp 'sport = :5173'\`) and its working directory (macOS: \`lsof -a -p <pid> -d cwd -Fn\`, the line starting with n; Linux: \`readlink /proc/<pid>/cwd\`): it must be the directory that \`cd "${REPO}/ts" && pwd -P\` prints. Another directory, or no process found: return BLOCKED. Then run \`git -C "${REPO}" status --porcelain -- ts crates\`: if it lists anything, copy it into anomalies (the page runs HEAD plus those changes).
- No file edits while Vite runs: never create, edit or delete anything under ts/ (or any other file the app imports), never run a build (a ts/wasm rebuild rewrites files Vite serves), never git checkout, stash or reset. An edit reloads the page or swaps a module under a running script, and the session is lost. The only files the leg writes are the evidence files the steps name (by default in ${EVDIR}), its start marker (${MARKER}) and scratch files in ${REPO}/target/gpu-check/ (gitignored).
- Keep the Chrome window visible and uncovered for the whole leg.
- A hook may add context to a call (guard-stale-wasm compares mtimes only, so a checkout trips it; a stale-dev-server warning): copy it verbatim into anomalies. Whether the code the page runs is really stale is a fact to check (CLAUDE.md; the skill's "The WASM must be the current engine"), not to assume; never rebuild or restart anything yourself. If it really is stale, return BLOCKED.

## The browser
- Use ONLY the ${SERVER} MCP server (${SERVER_NOTE}). Load its tools with ONE ToolSearch call: "select:${TOOLS}" (add to that same call any other tool of that server a step names). Never call any tool of ${OTHER} (any call launches its Chrome), nor Playwright or claude-in-chrome.
- list_pages first: use the existing page (new_page only if there is none; close none), and pass its pageId to every call. Pass waitForStableDom: false to every evaluate_script: the harness redraws its check panel every 500 ms and its HUD every frame, so the DOM never settles.
- Every navigation: navigate_page with type "url", the step's URL, ignoreCache true, and as initScript the full text of ${REPO}/.claude/skills/gpu-check/scripts/anti-reload-init.js (in a checkout without that file, the verbatim copy in the skill's "Load the harness on a hardware adapter"). It records a close of Vite's HMR WebSocket in window.__viteWsCloses instead of letting Vite reload the page, which kills a running evaluate_script with "Execution context was destroyed". An initScript applies to ONE navigation: never navigate with type "reload", navigate again by URL. On Linux (\`uname -s\`) the low-power adapter initScript of the skill's Fedora section is needed too: pass ONE initScript holding both texts, the anti-reload one first, joined by a newline, a semicolon and a newline.
- When a step gives a window size: resize_page BEFORE anything else runs on that page, and never touch the window size again on it. Then record innerWidth, innerHeight, devicePixelRatio and the canvas backing store (document.getElementById('canvas').width and .height); a difference from values the steps give is reported before going on.
- The adapter line, after every navigation: list_console_messages with types log, info and warn; copy the line "[Hyperion] WebGPU adapter: …" exactly. It must name the hardware GPU and must not say SOFTWARE FALLBACK; when the steps or the expectations give the line, it must match character for character (on the Mac, with this server: "${MAC_LINE}"). Anything else: stop and return BLOCKED. In Mode A the render worker prints it (list_console_messages shows worker messages).
- Then set the metadata that scripts and benches copy into their evidence: evaluate_script \`() => { window.__harnessMeta = { head: '<the first 7 characters of HEAD>', adapterLine: '<that whole line, copied exactly>' }; return window.__harnessMeta; }\`.
- window.__hyperion.mode must be the mode the URL asks for (?mode=A, B or C): a silent fallback to another mode is a FAIL, never a pass.
- At the end of every page session (before the next navigation, and at the end): record window.__viteWsCloses (it must be []) and list_console_messages with types error and warn, every message verbatim. Expected: nothing, except a favicon.ico 404 if Chrome requested it (confirm with list_network_requests that the 404 is favicon.ico) and the messages the expectations or the context name as expected. Anything else is a FAIL recorded with its full text: a LeakDetector warning, a "[Hyperion] <phase> hook … threw", anything about WebGPU, validation, a pipeline or the device.

## Scripts and evidence files
- A script file a step names is ONE evaluate_script function: pass its whole text as the \`function\` argument, unchanged. Never edit a tracked script or bench: what a script needs comes from a separate evaluate_script that sets a global first (window.__benchOpts, window.__benchSpec, …), as the steps say.
- evaluate_script with filePath writes the function's return value, as JSON, to that file and REPLACES it. Give every call its own file, unless the script returns everything accumulated on the page (a bench that returns all its results on every call): then give each page session its own fresh navigation and its own file.
- Every filePath (evaluate_script, take_screenshot) is ABSOLUTE: a bare file name in the steps means ${EVDIR}/<name>, a path relative to the repo means ${REPO}/<path>, and a full path is used as given. Keep it inside the repo: the MCP server resolves a relative path against ITS own working directory, and refuses a path outside its workspace roots and $TMPDIR (the session scratchpad was refused). Create the directory first (mkdir -p). After each write, check that the file exists and is not empty, and list every file you wrote in \`files\`.
- When a step loads a file through a server (a bench from the asset server, a module or a shader from Vite), record its byte count or hash next to the file in the repo: the page must run what the repo holds (Vite can answer 304 with a stale transform even with ignoreCache).
- If an import of an app module (\`import('/src/…')\`) returns an empty or default value where the app has a real one, the page holds a SECOND module instance (Vite serves an edited module as ?t=…): stop and return BLOCKED; restarting the dev server fresh is the controller's job.
- Shell commands run from the repo root, as \`cd "${REPO}" && …\` (a shell may start in another directory, even another checkout). Record each command, its exit code and its stderr, and read stderr before interpreting a non-zero exit (an exception and a failed check can share exit 1). Quote any URL holding ? and any glob (zsh); never use grep -P.
- GPU timings: before any swapchain probe on that page (the first one reconfigures the canvas: the skill's "Pixels"), with no Chrome of the ${OTHER} server running: \`ps -ax -o pid=,command=\` before and after each timed run, telling the two servers' Chromes apart by their --user-data-dir (read each server's own command line in ps: chrome-devtools-mcp ... --userDataDir=...); if one runs, stop and return BLOCKED (freeing it is the controller's job; never call its tools to check: any call launches its browser); the window neither covered nor resized during the run; record the power source (macOS: \`pmset -g batt\`; Linux: \`sh -c 'grep -H . /sys/class/power_supply/*/online'\`, where 1 is on mains and no file at all means no battery). A number of runs, a formula or a threshold the steps fix is never extended afterwards to reach a verdict.
- A duration: say how it was measured (performance.now() inside the page, or around the tool call) and what it includes.

## Recording
- Record values, not guessed booleans: for each expectation, the raw value the page or the file holds, next to the expected one. If its type or form differs from what the expectations assume (a string where they expect true, a count where they expect a list), record the raw value and flag the difference; never coerce it into a PASS.
- Keep what you observed apart from what you infer, and label every inference.
- Do not explain a failure away, do not fix it (what to change is the controller's decision), and do not retry until it passes: record each failure exactly, with the raw values. Retry a call at most ONCE, only for an infrastructural failure (an MCP timeout, "Execution context was destroyed", a reloaded page), and only from a fresh navigation; say that you retried and why. A retry or redo rule the steps fix themselves (to redo a page session once when a check refuses its input, say) applies as written, beside this one.
- A step is SKIP only when the steps or the expectations say so (a branch not taken, a stop rule): name the rule and the values that decided it. A step you could not run is a FAIL.
- Status: DONE when every step ran (or was skipped by such a rule) and passed; DONE_WITH_FAILURES when any step FAILED, an unexpected console message included; BLOCKED when the leg cannot run as written (the wrong HEAD, the dev server down or serving another checkout, a wrong or software adapter, the server's tools missing, a second module instance, stale code, the other Chrome server busy before a timed run): stop at once and say what you saw.
- versions: the browser's full version (navigator.userAgentData.getHighEntropyValues(['fullVersionList'])) and the OS (macOS: plain \`sw_vers\`, because \`sw_vers -productVersion -buildVersion\` prints only the build there; Linux: /etc/os-release and \`uname -r\`).

## Rules
- Do not dispatch subagents. Never git add, commit, stash, checkout, reset or restore, and never edit a tracked file other than an evidence file the steps name (a baseline they re-capture): the leg commits nothing, and what to commit is the controller's decision.
- Do not write a report file with the Write tool (the harness refuses subagent report files): return everything in the structured output.`

const LEG = `${COMMON}

## Your job
First of all, before the HEAD check and anything else, create the start marker: \`mkdir -p "${REPO}/target/gpu-check" && touch "${MARKER}"\`. Every evidence file you write afterwards is newer than it, and the verifier counts only those, so a file an earlier run left in ${EVDIR} cannot pass for yours; never touch the marker again.
Then run every step of ${STEPS} in order, judging each against ${EXPECT}. Return the structured result: status; one \`steps\` entry per step (its number and title as the steps file gives them; PASS, FAIL or SKIP; in \`evidence\` the expected and the observed raw values, the files written, exit codes, retries); \`files\` (the absolute path of every evidence file); \`consoleErrors\` (every error and warn message of every page session, verbatim, prefixed by the page URL, the expected ones included and marked as such; [] if none); \`adapterLine\` (exactly as printed); \`versions\`; \`anomalies\` (anything outside the steps: hook messages, 304s, retries, unexpected waits, a HEAD change); \`report\` (the full report in Markdown).`

function opts(label, ph, schema) {
  return { label, phase: ph, schema, model: MODEL }
}

const leg = await agent(LEG, opts('gpu:' + SLUG, 'Run', LEG_SCHEMA))
log('gpu-leg "' + TITLE + '": ' + (leg ? leg.status + ', ' + leg.steps.filter((s) => s.status === 'PASS').length + '/' + leg.steps.length + ' steps PASS, ' + leg.files.length + ' files' : 'the leg agent died'))
// The leg's own verdict: DONE, at least one step, none FAIL. Its rules (the console, the mode, the
// adapter) reach the headline only through it: the verifier gates on the expectations file alone.
const legSteps = leg ? leg.steps : []
const failedSteps = legSteps.filter((s) => s.status === 'FAIL').length
const legOk = !!leg && leg.status === 'DONE' && legSteps.length > 0 && failedSteps === 0
if (leg && leg.status === 'DONE' && !legOk) {
  log('gpu-leg: the leg says DONE but ' + (legSteps.length ? failedSteps + '/' + legSteps.length + ' of its steps FAIL' : 'reports no step') + ': counted as not passing')
}

const CLAIMS = leg
  ? JSON.stringify({ status: leg.status, steps: leg.steps, files: leg.files, consoleErrors: leg.consoleErrors, adapterLine: leg.adapterLine, versions: leg.versions, anomalies: leg.anomalies })
  : 'THE LEG AGENT DIED: verify whatever evidence exists in ' + EVDIR + ' (only the files newer than ' + MARKER + ' can be this leg\'s, and the marker itself may be an earlier run\'s if the leg died before touching it) and say what is missing.'

const VERIFY = `${COMMON}

You are the INDEPENDENT VERIFIER of the GPU leg above: another agent ran it; do not trust its claims. Do NOT drive the browser and load no browser tool: verify from the evidence files, the repo and the shell only. Read-only: never create, edit or delete a file in the repo (scratch files only under the session scratchpad directory named in your system prompt, or \`$(mktemp -d)\`), and never git add, commit, stash, checkout or reset.

Evidence: ${EVDIR} (the files the leg claims are in its claims below). Expectations: ${EXPECT}, read in full. Steps: ${STEPS}.

Freshness, first: the leg was told to touch ${MARKER} before writing any evidence (never touch it yourself: every file would then look stale). \`find "${EVDIR}" -type f -newer "${MARKER}"\` lists the files written after it; for a claimed file elsewhere, \`find <file> -newer "${MARKER}"\` prints it if it is newer. A file the leg claims that is not newer than the marker was left by an earlier run: it proves nothing for this leg, every expectation resting on it is pass false, and say so. No marker: no file can be tied to this leg, and every expectation resting on a file is UNPROVEN.

One perExpectation entry per expectation of the expectations file, in its order (quoted or summarised, with its number):
- pass true only when the evidence proves it. Re-read the files yourself (node, jq, cat); re-derive every number you can from the raw data with the formula the steps or the expectations give; re-run any statistics or check command the steps name and compare its output with the leg's file. A file that records the commit it ran at (a head field, or the field the steps name for it) must agree with the HEAD the leg recorded and with \`git -C "${REPO}" rev-parse HEAD\`; a file whose script records none (tab-runner.js, map-json.js and load-bench.js of the gpu-check skill record none) rests on the HEAD the leg recorded: say so, but that alone does not make it UNPROVEN. State every tolerance you apply, and why.
- What only the leg saw (the console, the printed adapter line, window.__viteWsCloses, the network log, the window size): judge it on the leg's claims, for consistency only, and say so in the entry's evidence ("from the leg's claims; not visible from the shell"); pass false when the claims are missing or contradict each other or the files.
- Unproven is not passing: pass false, with UNPROVEN and what is missing in its evidence.
- verdict PASS only when every entry passes.
Gate ONLY on the expectations: a tolerance, heuristic or habit of your own is not a gate. Anything else you notice (a value off a model, a script or a document the evidence contradicts, a rule of the steps not followed) goes to extraFindings: report it, do not gate on it. The workflow's headline also requires the leg's own status DONE with no failed step, so the leg's own rules (the console, the mode, the adapter) count there, not here.

THE LEG'S CLAIMS:
<<<
${CLAIMS}
>>>`

const verify = await agent(VERIFY, opts('verify:' + SLUG, 'Verify', VERIFY_SCHEMA))
const entries = verify ? verify.perExpectation : []
const passed = entries.filter((e) => e.pass === true).length
const allPass = entries.length > 0 && passed === entries.length
const verifyOk = !!verify && verify.verdict === 'PASS' && allPass
if (verify && (verify.verdict === 'PASS') !== allPass) {
  log('gpu-leg: the verifier says ' + verify.verdict + ' but ' + passed + '/' + entries.length + ' of its expectations pass: counted as not passing')
}
// The two gate on different things, so a pass needs both; say which way they disagree.
const legState = !leg ? 'agent died'
  : 'is ' + leg.status + (failedSteps ? ' (' + failedSteps + '/' + legSteps.length + ' steps FAIL)' : legSteps.length ? '' : ' (no step reported)')
if (verifyOk && !legOk) {
  log('gpu-leg: the verifier passes but the leg ' + legState + ': counted as not passing (the verifier gates only on the expectations; the leg\'s own rules, the console, the mode and the adapter among them, count too)')
}
if (legOk && verify && !verifyOk) log('gpu-leg: the leg is DONE but the verifier does not pass: counted as not passing (read the verifier\'s entries)')
const pass = legOk && verifyOk
log('gpu-leg "' + TITLE + '": leg ' + (leg ? leg.status : 'died') + ', verifier ' + (verify ? verify.verdict + ', ' + passed + '/' + entries.length + ' expectations pass' : 'died') + ' -> ' + (pass ? 'PASS' : 'NOT PASSED'))
return { title: TITLE, evidenceDir: EVDIR, leg, verify, pass }

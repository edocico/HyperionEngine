// Validate every .wgsl file of a directory with naga, the WGSL front-end
// Firefox uses (Phase 5b, spec §7.3.2).
//
//   node scripts/validate-wgsl-naga.mjs <dir>
//
// The composed primitive modules exist only as TypeScript output, so a vitest
// file writes them first:
//
//   D="$(mktemp -d)"
//   DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts
//   node scripts/validate-wgsl-naga.mjs "$D"
//
// naga comes from `cargo install naga-cli --locked` (the `diagnostic`
// directive the uber module starts with needs naga 23 or later). With an
// input file and no output file, naga parses and validates it: exit status 0
// and "Validation successful" when it is valid, non-zero with the error
// otherwise.
//
// Exit status: 0 when every file validates, 1 when any does not, 2 on a
// usage problem (no directory, no .wgsl file, naga not installed).
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/validate-wgsl-naga.mjs <dir>');
  process.exit(2);
}
const root = resolve(dir);
const files = readdirSync(root).filter((f) => f.endsWith('.wgsl')).sort();
if (files.length === 0) {
  console.error(`no .wgsl file in ${root}`);
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const run = spawnSync('naga', [join(root, file)], { encoding: 'utf8' });
  if (run.error) {
    console.error(`cannot run naga (${run.error.message}): cargo install naga-cli --locked`);
    process.exit(2);
  }
  const ok = run.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}`);
  if (!ok) {
    failed++;
    const output = `${run.stdout}${run.stderr}`.trim();
    console.log(output.split('\n').map((line) => `     ${line}`).join('\n'));
  }
}
console.log(`${files.length - failed}/${files.length} valid (naga)`);
process.exit(failed === 0 ? 0 : 1);

/**
 * Text analysis of WGSL, for the headless tests (Phase 5b).
 *
 * Neither vitest nor the composer can compile WGSL, so the composed primitive
 * modules (render/primitive-shaders.ts) are checked on their text: which names
 * a module declares, which bindings an entry point can reach, which locals
 * could silently shadow a module-scope name. This is a scanner, not a parser.
 * It knows comments (block comments nest in WGSL), brace depth, `fn`
 * signatures and attributes, and that is all the checks need. Test-only:
 * nothing in the engine imports it.
 *
 * Every function is total: text it cannot make sense of yields an empty
 * result (or null), never an exception.
 */

export type TopLevelKind = 'fn' | 'struct' | 'var' | 'const' | 'override' | 'alias';

export interface TopLevelDecl {
  kind: TopLevelKind;
  name: string;
}

export interface BindingDecl {
  group: number;
  binding: number;
  name: string;
}

export interface LocalName {
  fn: string;
  name: string;
  kind: 'let' | 'var' | 'const' | 'param';
}

const IDENT = /^[A-Za-z_]\w*$/;

/** Every character of `text` but newlines turned into a space: offsets and line numbers survive. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * The source with every comment blanked: `//` to the end of the line, and
 * `/* ... *\/` with nesting (WGSL block comments nest). Newlines are kept and
 * every other comment character becomes a space, so the result has the same
 * length and the same line numbers as the input. An unterminated block comment
 * runs to the end of the text.
 */
export function stripComments(src: string): string {
  const parts: string[] = [];
  let plain = 0;
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const newline = src.indexOf('\n', i);
      const end = newline < 0 ? src.length : newline;
      parts.push(src.slice(plain, i), blank(src.slice(i, end)));
      i = end;
      plain = end;
    } else if (src.startsWith('/*', i)) {
      const start = i;
      let depth = 0;
      while (i < src.length) {
        if (src.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (src.startsWith('*/', i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
      parts.push(src.slice(plain, start), blank(src.slice(start, i)));
      plain = i;
    } else {
      i++;
    }
  }
  parts.push(src.slice(plain));
  return parts.join('');
}

/**
 * Module scope only: every character inside braces blanked (the braces and
 * the newlines are kept). Function bodies and struct members disappear, so a
 * `var` or `let` that is left is a module-scope one. Expects comment-free text.
 */
function moduleScope(code: string): string {
  const out = code.split('');
  let depth = 0;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth > 0 && ch !== '\n') {
      out[i] = ' ';
    }
  }
  return out.join('');
}

/** The index of the bracket closing the one at `open`, or -1. */
function matching(code: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === opener) depth++;
    else if (code[i] === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split at the commas that are not inside `()` or `<>`. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '<') depth++;
    if (ch === ')' || ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Attributes (`@location(0)`, `@builtin(position)`, `@fragment`) blanked. */
function withoutAttributes(code: string): string {
  return code.replace(/@\w+\s*(?:\([^)]*\))?/g, (m) => blank(m));
}

interface FnSpan {
  paramsOpen: number;
  paramsClose: number;
  bodyOpen: number;
  bodyClose: number;
}

/** Where the module-scope `fn name` sits in comment-free `code`, or null. */
function findFn(code: string, name: string): FnSpan | null {
  if (!IDENT.test(name)) return null;
  const m = new RegExp(`\\bfn\\s+${name}\\s*\\(`).exec(moduleScope(code));
  if (!m) return null;
  const paramsOpen = m.index + m[0].length - 1;
  const paramsClose = matching(code, paramsOpen, '(', ')');
  if (paramsClose < 0) return null;
  // The return type cannot hold a brace: the next one opens the body.
  const bodyOpen = code.indexOf('{', paramsClose);
  if (bodyOpen < 0) return null;
  const bodyClose = matching(code, bodyOpen, '{', '}');
  if (bodyClose < 0) return null;
  return { paramsOpen, paramsClose, bodyOpen, bodyClose };
}

/**
 * The module-scope declarations, in source order: functions, structs,
 * module-scope `var`s (the bindings among them), `const`, `override` and
 * `alias`. `const_assert` is not a declaration and is skipped.
 */
export function topLevelDecls(src: string): TopLevelDecl[] {
  const scope = moduleScope(stripComments(src));
  const decl = /\b(fn|struct|var|const|override|alias)\b(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)/g;
  return [...scope.matchAll(decl)].map((m) => ({ kind: m[1] as TopLevelKind, name: m[2] }));
}

/**
 * The text between the braces of the module-scope `fn name`, comments blanked,
 * or null when the module has no such function.
 */
export function functionBody(src: string, name: string): string | null {
  const code = stripComments(src);
  const span = findFn(code, name);
  return span ? code.slice(span.bodyOpen + 1, span.bodyClose) : null;
}

/** The parameter names of the module-scope `fn name`, in order; [] when there is no such function. */
export function functionParams(src: string, name: string): string[] {
  const code = stripComments(src);
  const span = findFn(code, name);
  if (!span) return [];
  return splitTopLevel(code.slice(span.paramsOpen + 1, span.paramsClose))
    .map((param) => /^(?:@\w+\s*(?:\([^)]*\))?\s*)*([A-Za-z_]\w*)\s*:/.exec(param.trim())?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * Function → the module-scope names its signature and body mention: the
 * functions it calls, the bindings and other globals it reads, the structs it
 * names. Member names (after a `.`) and attribute arguments are not
 * references. A local that shadowed a module-scope name would count as a
 * reference to it: conservative, and `localNames` exists to rule it out.
 *
 * Only functions get an entry. A module-scope `const` or `override` can
 * reference other constants in its initializer but never a `var`, so bindings
 * are reached through functions only.
 */
export function callGraph(src: string): Map<string, Set<string>> {
  const code = stripComments(src);
  const decls = topLevelDecls(code);
  const names = new Set(decls.map((d) => d.name));
  const graph = new Map<string, Set<string>>();
  for (const d of decls) {
    if (d.kind !== 'fn') continue;
    const span = findFn(code, d.name);
    if (!span) continue;
    const text = withoutAttributes(code.slice(span.paramsOpen, span.bodyClose + 1));
    const refs = new Set<string>();
    for (const m of text.matchAll(/(?<![\w.])[A-Za-z_]\w*/g)) {
      if (names.has(m[0])) refs.add(m[0]);
    }
    graph.set(d.name, refs);
  }
  return graph;
}

/**
 * Every module-scope name reachable from `entry` through the call graph:
 * the functions it calls transitively and every global those functions (and
 * the entry) mention. The entry itself is not included.
 */
export function reachableFrom(src: string, entry: string): Set<string> {
  const graph = callGraph(src);
  const seen = new Set<string>();
  const stack = [...(graph.get(entry) ?? [])];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const next of graph.get(name) ?? []) stack.push(next);
  }
  return seen;
}

/**
 * The resource bindings: module-scope `var`s with both `@group(N)` and
 * `@binding(M)` (decimal literals, in either order), in source order.
 */
export function bindingDecls(src: string): BindingDecl[] {
  const scope = moduleScope(stripComments(src));
  const out: BindingDecl[] = [];
  const decl = /((?:@\w+\s*(?:\([^)]*\))?\s*)+)var\b(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)/g;
  for (const m of scope.matchAll(decl)) {
    const group = /@group\s*\(\s*(\d+)\s*\)/.exec(m[1]);
    const binding = /@binding\s*\(\s*(\d+)\s*\)/.exec(m[1]);
    if (group && binding) out.push({ group: Number(group[1]), binding: Number(binding[1]), name: m[2] });
  }
  return out;
}

/**
 * Every name a function declares for itself: its parameters, and each `let`,
 * `var` (also `var<function>` and a `for` loop's) and `const` in its body.
 */
export function localNames(src: string): LocalName[] {
  const code = stripComments(src);
  const out: LocalName[] = [];
  for (const d of topLevelDecls(code)) {
    if (d.kind !== 'fn') continue;
    for (const name of functionParams(code, d.name)) out.push({ fn: d.name, name, kind: 'param' });
    const body = functionBody(code, d.name) ?? '';
    for (const m of body.matchAll(/\b(let|var|const)\b(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)/g)) {
      out.push({ fn: d.name, name: m[2], kind: m[1] as 'let' | 'var' | 'const' });
    }
  }
  return out;
}

/**
 * The directives at the head of the module (`enable`, `requires`,
 * `diagnostic`), whitespace collapsed, e.g. `diagnostic(off, derivative_uniformity);`.
 * WGSL allows them only before the first declaration, so scanning stops at the
 * first statement that is not one.
 */
export function directives(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const directive = /\s*((?:enable|requires|diagnostic)\b[^;]*;)/y;
  let m: RegExpExecArray | null;
  while ((m = directive.exec(code)) !== null) out.push(m[1].replace(/\s+/g, ' ').trim());
  return out;
}

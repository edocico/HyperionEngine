/**
 * Composition of the primitive shaders (Phase 5b, design §3).
 *
 * The WGSL of the six primitive types lives in pieces under
 * `shaders/primitives/`: a prelude (bindings, shared structs, helpers) and one
 * library per type, whose names all carry its prefix. This module turns the
 * pieces into
 * - one module per type: prelude + that library + generated entry points
 *   `vs_main`, `fs_main`, `fs_occluder` (ForwardPass's per-type pipelines, and
 *   OccluderSeedStage through `fs_occluder`);
 * - the uber module: the `derivative_uniformity` directive, the prelude, all six
 *   libraries, and a `vs_main`/`fs_main` that switch on the primitive type (one
 *   pipeline draws every transparent type in sorted order).
 *
 * Pure text and TOTAL: concatenation only, it never throws, whatever the
 * pieces hold, so a hot-reloaded piece can always be recomposed; a broken
 * piece is caught by the GPU validation of the probe. The pieces themselves
 * (the `?raw` imports, whose hot-reload must be accepted in the module that
 * imports them) are held by renderer.ts.
 */

export type PrimitiveLibraryName = 'quad' | 'line' | 'msdf-text' | 'bezier' | 'gradient' | 'box-shadow';

export interface PrimitiveLibrary {
  /** RenderPrimitiveType of the entities it draws. */
  readonly type: number;
  /** The piece: `shaders/primitives/<name>.wgsl`, and its hot-reload slot. */
  readonly name: PrimitiveLibraryName;
  /** Starts every module-scope name of the library (upper-cased for constants). */
  readonly prefix: string;
  /** Whether its `<prefix>fs` applies the light buffer (the source of LIT_PRIMITIVE_TYPES). */
  readonly lit: boolean;
}

/** The primitive libraries, types 0-5 in order. Type 6 (Light2D) has none: ForwardPass never draws it. */
export const PRIMITIVE_LIBRARIES: readonly PrimitiveLibrary[] = [
  { type: 0, name: 'quad', prefix: 'quad_', lit: true },
  { type: 1, name: 'line', prefix: 'line_', lit: false },
  { type: 2, name: 'msdf-text', prefix: 'msdf_', lit: false },
  { type: 3, name: 'bezier', prefix: 'bezier_', lit: false },
  { type: 4, name: 'gradient', prefix: 'gradient_', lit: true },
  { type: 5, name: 'box-shadow', prefix: 'boxshadow_', lit: false },
];

/** The current text of every piece: the prelude, and each library by primitive type. */
export interface PrimitivePieces {
  prelude: string;
  libraries: Record<number, string>;
}

/**
 * First line of the uber module, and of no other. `fwidth`/`dpdx` inside
 * line_shade, msdf_shade and bezier_shade are called from the type switch,
 * which WGSL's uniformity analysis cannot prove uniform. The switch IS uniform
 * across a 2x2 quad (the type is per instance and a quad's fragments belong to
 * one triangle). A diagnostic's severity is decided where the builtin is
 * called, so an attribute on fs_main or on the switch does not reach inside the
 * libraries (verified on Chrome 154); only this directive does. The per-type
 * modules compile the same library code under the strict analysis.
 */
export const UBER_DIRECTIVE = 'diagnostic(off, derivative_uniformity);';

/**
 * RenderPrimitiveType.Light2D, the first type without a library. The uber
 * vs_main clamps the type to it, as cull.wgsl clamps to NUM_PRIM_TYPES - 1,
 * and draws nothing for it.
 */
const LIGHT2D_TYPE = 6;

/** The line put before each piece of a composed module, so a compiler error's line can be traced to its piece. */
export function pieceMarker(name: string): string {
  return `// --- piece: ${name} ---`;
}

/** `text` under its marker, ending in a newline. */
function section(name: string, text: string): string {
  return `${pieceMarker(name)}\n${text}${text.endsWith('\n') ? '' : '\n'}`;
}

/** The generated entry points of a per-type module. */
function typeEntryPoints(library: PrimitiveLibrary): string {
  const p = library.prefix;
  return `@vertex
fn vs_main(@location(0) position: vec3f, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    if (OCCLUDER_PASS && !castsInto(renderMeta[entityIdx * 2u + 1u], camera.occluderLayers)) { return culledVertex(); }
    var out = ${p}vs(position, entityIdx);
    out.primType = ${library.type}u;
    return out;
}
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f { return ${p}fs(in); }
@fragment
fn fs_occluder(in: VertexOutput) -> @location(0) vec4f { return ${p}occluder(in); }
`;
}

/** The generated entry points of the uber module. No fs_occluder: the uber never seeds occluders. */
function uberEntryPoints(): string {
  const vsCases = PRIMITIVE_LIBRARIES
    .map((l) => `        case ${l.type}u: { out = ${l.prefix}vs(position, entityIdx); }`)
    .join('\n');
  // WGSL requires exactly one default, and every path must return a colour:
  // the last case takes it. Unreachable anyway: the vertex stage culls type 6.
  const last = PRIMITIVE_LIBRARIES.length - 1;
  const fsCases = PRIMITIVE_LIBRARIES
    .map((l, i) => `        case ${l.type}u${i === last ? ', default' : ''}: { return ${l.prefix}fs(in); }`)
    .join('\n');
  return `@vertex
fn vs_main(@location(0) position: vec3f, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    let primType = min(renderMeta[entityIdx * 2u + 1u] & 0xFFu, ${LIGHT2D_TYPE}u);
    var out: VertexOutput;
    switch primType {
${vsCases}
        default: { return culledVertex(); }
    }
    out.primType = primType;
    return out;
}
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    switch in.primType {
${fsCases}
    }
}
`;
}

/**
 * The module of one primitive type: prelude + its library + generated
 * `vs_main` (with the occluder early-out), `fs_main`, `fs_occluder`. An
 * unknown type (no library) yields ''. A missing library text is taken as ''.
 */
export function composeTypeModule(pieces: PrimitivePieces, type: number): string {
  const library = PRIMITIVE_LIBRARIES.find((l) => l.type === type);
  if (!library) return '';
  return section('prelude', pieces.prelude)
    + section(library.name, pieces.libraries[type] ?? '')
    + section('generated', typeEntryPoints(library));
}

/** The module of every primitive type, keyed by type: what `ForwardPass.SHADER_SOURCES` holds. */
export function composeTypeModules(pieces: PrimitivePieces): Record<number, string> {
  const modules: Record<number, string> = {};
  for (const library of PRIMITIVE_LIBRARIES) modules[library.type] = composeTypeModule(pieces, library.type);
  return modules;
}

/** The uber module: the directive on the first line, the prelude, the six libraries, the switching entry points. */
export function composeUberModule(pieces: PrimitivePieces): string {
  return `${UBER_DIRECTIVE}\n`
    + section('prelude', pieces.prelude)
    + PRIMITIVE_LIBRARIES.map((l) => section(l.name, pieces.libraries[l.type] ?? '')).join('')
    + section('generated', uberEntryPoints());
}

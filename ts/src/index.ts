export { Hyperion } from './hyperion';
export type { HyperionConfig, ResolvedConfig, HyperionStats, MemoryStats, CompactOptions, TextureHandle } from './types';
export type { HyperionPlugin } from './plugin';
export type { HookPhase, HookFn } from './game-loop';
export type { SystemViews } from './system-views';
export { EntityHandle } from './entity-handle';
export { RawAPI } from './raw-api';
export { CameraAPI } from './camera-api';
export { SelectionManager } from './selection';
export type { OutlineOptions } from './renderer';
export { RenderPrimitiveType } from './entity-handle';
export { InputManager } from './input-manager';
export type { KeyCallback, ClickCallback, PointerMoveCallback, ScrollCallback, Unsubscribe } from './input-manager';
export { hitTestRay } from './hit-tester';
export type { Ray } from './hit-tester';
export { ImmediateState } from './immediate-state';
export type { FontAtlas, GlyphMetrics } from './text/font-atlas';
export { loadFontAtlas } from './text/font-atlas';
export { layoutText } from './text/text-layout';
export type { LayoutGlyph } from './text/text-layout';
export { AudioManager } from './audio-manager';
export type { AudioManagerOptions } from './audio-manager';
export type { SoundHandle, PlaybackId, PlaybackOptions, SpatialConfig } from './audio-types';
export { DEFAULT_PLAYBACK_OPTIONS, DEFAULT_SPATIAL_CONFIG } from './audio-types';

// Plugin system v2
export type { PluginCleanup } from './plugin';
export { PluginContext } from './plugin-context';
export type { PluginSystemsAPI, PluginRenderingAPI, PluginGpuAPI, PluginStorageAPI, PluginEventAPI } from './plugin-context';
export { EventBus } from './event-bus';

// Profiler
export { ProfilerOverlay } from './profiler';
export type { ProfilerConfig } from './profiler';

// Rendering passes
export type { BloomConfig } from './render/passes/bloom-pass';

// GPU Particle System
export type { ParticleEmitterConfig, ParticleHandle } from './particle-types';
export { DEFAULT_PARTICLE_CONFIG } from './particle-types';

// KTX2 / Compressed Textures
export { parseKTX2, isKTX2, VK_FORMAT } from './ktx2-parser';
export type { KTX2Container } from './ktx2-parser';
export { BasisTranscoder } from './basis-transcoder';
export type { TranscodeTarget, TranscodeResult } from './basis-transcoder';
export { detectCompressedFormat } from './capabilities';

// Example plugins
export { fpsCounterPlugin } from './plugins/fps-counter';

import { Hyperion } from './hyperion';
import { boundsVisualizerPlugin } from './debug/bounds-visualizer';
import type { SoundHandle } from './audio-types';
import type { EntityHandle } from './entity-handle';
import type { ParticleHandle } from './particle-types';
import type { SystemViews } from './system-views';

// Primitive type constants (matches RenderPrimitiveType)
const PRIM_QUAD = 0, PRIM_LINE = 1, PRIM_BEZIER = 3, PRIM_GRADIENT = 4, PRIM_BOX_SHADOW = 5;

// Primitive colors for Canvas2D fallback
const PRIM_COLORS: Record<number, string> = {
  [PRIM_QUAD]:       '#4488ff',
  [PRIM_LINE]:       '#88ff44',
  [PRIM_BEZIER]:     '#ff8844',
  [PRIM_GRADIENT]:   '#ff44ff',
  [PRIM_BOX_SHADOW]: '#44ffff',
};

async function main() {
  const overlay = document.getElementById('overlay')!;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  overlay.textContent = 'Hyperion Engine — initializing...';

  const engine = await Hyperion.create({ canvas });

  console.log('Compression format:', engine.compressionFormat ?? 'none');

  // Resize handler
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * dpr);
    const height = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      engine.resize(width, height);
    }
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // --- Plugins & visual features (require renderer) ---
  try { engine.use(boundsVisualizerPlugin()); } catch { /* no renderer */ }
  try { engine.enableBloom({ threshold: 0.6, intensity: 1.2 }); } catch { /* no renderer */ }

  // =============================================
  // Section 1: QUADS (grid) — center
  // =============================================
  engine.batch(() => {
    for (let i = 0; i < 25; i++) {
      const col = i % 5;
      const row = Math.floor(i / 5);
      engine.spawn()
        .position((col - 2) * 2.5, (row - 2) * 2.5, 0)
        .scale(0.8, 0.8, 1);
    }
  });

  // Label: spawn a small quad as section marker
  const labelOffsetY = -8;

  // =============================================
  // Section 2: GRADIENTS — left side
  // =============================================
  const gradientX = -18;

  // Linear gradient (type 0): horizontal blue→cyan
  engine.spawn()
    .position(gradientX, 3, 0)
    .scale(3, 3, 1)
    .gradient(0, 0, [0, 0, 0.2, 1, 0, 1, 0.8, 1]);

  // Radial gradient (type 1): orange→magenta
  engine.spawn()
    .position(gradientX, -1, 0)
    .scale(3, 3, 1)
    .gradient(1, 0, [1, 0.6, 0, 1, 0.8, 0, 1, 1]);

  // Conic gradient (type 2): rotating green→yellow
  engine.spawn()
    .position(gradientX, -5, 0)
    .scale(3, 3, 1)
    .gradient(2, 0.785, [0.2, 1, 0.3, 1, 1, 0.9, 0.1, 1]);

  // =============================================
  // Section 3: BOX SHADOWS — left-center
  // =============================================
  const shadowX = -10;

  // Sharp shadow
  engine.spawn()
    .position(shadowX, 3, 0)
    .scale(4, 3, 1)
    .boxShadow(0.7, 0.7, 0.1, 0.05, 0.2, 0.5, 1.0, 0.9);

  // Soft blurred shadow
  engine.spawn()
    .position(shadowX, -1, 0)
    .scale(4, 3, 1)
    .boxShadow(0.6, 0.6, 0.2, 0.3, 1.0, 0.3, 0.5, 0.8);

  // Rounded pill shadow
  engine.spawn()
    .position(shadowX, -5, 0)
    .scale(5, 2, 1)
    .boxShadow(0.8, 0.3, 0.3, 0.15, 0.9, 0.8, 0.2, 0.9);

  // =============================================
  // Section 4: LINES — right-center
  // =============================================
  for (let i = 0; i < 8; i++) {
    const x = 10 + i * 1.5;
    engine.spawn()
      .position(x, 0, 0)
      .scale(1, 1, 1)
      .line(0, -120, 0, 120, 1.5 + i * 0.3);
  }

  // Horizontal lines crossing
  for (let i = 0; i < 5; i++) {
    const y = -4 + i * 2;
    engine.spawn()
      .position(14, y, 0)
      .scale(1, 1, 1)
      .line(-60, 0, 60, 0, 1);
  }

  // =============================================
  // Section 5: BEZIER CURVES — far right
  // =============================================
  const bezierX = 24;

  // Arch curve
  engine.spawn()
    .position(bezierX, 3, 0)
    .scale(5, 3, 1)
    .bezier(0.0, 0.8, 0.5, 0.0, 1.0, 0.8, 0.03);

  // S-curve (two beziers)
  engine.spawn()
    .position(bezierX, -1, 0)
    .scale(5, 3, 1)
    .bezier(0.0, 0.0, 0.5, 1.0, 1.0, 0.0, 0.025);

  // Wave
  engine.spawn()
    .position(bezierX, -5, 0)
    .scale(6, 2, 1)
    .bezier(0.0, 0.5, 0.3, 0.0, 0.6, 1.0, 0.02);

  // =============================================
  // Section 6: PREFAB (multi-entity template)
  // =============================================
  engine.prefabs.register('robot', {
    root: {
      position: [0, 0, 0],
      scale: [2, 2, 1],  // body
    },
    children: {
      head: {
        position: [0, 1.8, 0],
        scale: [1.2, 1.2, 1],
      },
      leftEye: {
        position: [-0.3, 2.0, 0],
        scale: [0.25, 0.25, 1],
      },
      rightEye: {
        position: [0.3, 2.0, 0],
        scale: [0.25, 0.25, 1],
      },
      leftArm: {
        position: [-1.5, 0, 0],
        scale: [0.5, 1.5, 1],
      },
      rightArm: {
        position: [1.5, 0, 0],
        scale: [0.5, 1.5, 1],
      },
    },
  });

  // Spawn 3 robots in a row
  for (let i = 0; i < 3; i++) {
    engine.prefabs.spawn('robot', { x: -25 + i * 5, y: labelOffsetY + 14 });
  }

  // =============================================
  // Section 7: Entities outside frustum (culling test)
  // =============================================
  engine.batch(() => {
    for (let i = 0; i < 50; i++) {
      const x = i < 25 ? -60 - i * 2 : 60 + (i - 25) * 2;
      engine.spawn().position(x, 0, 0);
    }
  });

  // --- Audio: load a click sound (file is optional; demo works silently if absent) ---
  let sfxHandle: SoundHandle | null = null;
  engine.audio.load('sfx/click.ogg').then(h => { sfxHandle = h; }).catch(() => {});

  // --- Particle state ---
  let particleHandle: ParticleHandle | null = null;
  let sparkleEntity: EntityHandle | null = null;

  // --- Input: click to select/deselect entities + play spatial sound + spawn particles ---
  engine.input.onClick((button, x, y) => {
    if (button !== 0) return;
    const entityId = engine.picking.hitTest(x, y);
    if (entityId !== null) {
      engine.selection?.toggle(entityId);
      if (sfxHandle !== null) {
        const worldX = (x / canvas.width - 0.5) * 20;
        const id = engine.audio.play(sfxHandle, { volume: 0.8 });
        if (id !== null) {
          engine.audio.setSoundPosition(id, worldX, 0);
        }
      }
    }

    // Spawn sparkle particles at click position (destroy previous first)
    if (particleHandle !== null) {
      engine.destroyParticleEmitter(particleHandle);
    }
    sparkleEntity?.destroy();
    sparkleEntity = engine.spawn().position(
      (x / canvas.width - 0.5) * 20 * (canvas.width / canvas.height),
      (0.5 - y / canvas.height) * 20,
      0
    );
    particleHandle = engine.createParticleEmitter({
      maxParticles: 200,
      emissionRate: 80,
      lifetime: [0.3, 1.0],
      velocityMin: [-3, -5],
      velocityMax: [3, -0.5],
      colorStart: [1, 0.8, 0.2, 1],
      colorEnd: [1, 0.2, 0, 0],
      sizeStart: 0.15,
      sizeEnd: 0,
      gravity: [0, 5],
    }, sparkleEntity.id);
  });

  // --- Input: WASD camera movement ---
  let camX = 0, camY = 0;
  engine.addHook('preTick', (dt) => {
    const speed = 15;
    let dx = 0, dy = 0;
    if (engine.input.isKeyDown('KeyW') || engine.input.isKeyDown('ArrowUp'))    dy += speed * dt;
    if (engine.input.isKeyDown('KeyS') || engine.input.isKeyDown('ArrowDown'))  dy -= speed * dt;
    if (engine.input.isKeyDown('KeyA') || engine.input.isKeyDown('ArrowLeft'))  dx -= speed * dt;
    if (engine.input.isKeyDown('KeyD') || engine.input.isKeyDown('ArrowRight')) dx += speed * dt;
    if (dx !== 0 || dy !== 0) {
      camX += dx;
      camY += dy;
      engine.cam.position(camX, camY, 0);
    }
  });

  // --- Input: scroll to zoom ---
  engine.input.onScroll((_dx, dy) => {
    const zoom = engine.cam.zoomLevel;
    engine.cam.zoom(zoom * (1 - dy * 0.001));
  });

  // =============================================
  // Canvas2D fallback when WebGPU is unavailable
  // =============================================
  const ctx2d = canvas.getContext('2d');
  const useCanvas2D = ctx2d !== null; // null means WebGPU already claimed the canvas
  if (useCanvas2D) {
    console.log('[Hyperion] No WebGPU renderer — using Canvas2D fallback');
  }

  function drawCanvas2D(views: SystemViews) {
    if (!ctx2d) return;
    const w = canvas.width;
    const h = canvas.height;
    const zoom = engine.cam.zoomLevel;
    const viewH = 20 / zoom;
    const scale = h / viewH;
    const cx = engine.cam.x;
    const cy = engine.cam.y;

    ctx2d.clearRect(0, 0, w, h);

    // Background
    ctx2d.fillStyle = '#1a1a2e';
    ctx2d.fillRect(0, 0, w, h);

    // Grid lines
    ctx2d.strokeStyle = '#ffffff10';
    ctx2d.lineWidth = 1;
    const gridStep = 5;
    const viewW = viewH * (w / h);
    const minX = Math.floor((cx - viewW / 2) / gridStep) * gridStep;
    const maxX = Math.ceil((cx + viewW / 2) / gridStep) * gridStep;
    const minY = Math.floor((cy - viewH / 2) / gridStep) * gridStep;
    const maxY = Math.ceil((cy + viewH / 2) / gridStep) * gridStep;
    for (let gx = minX; gx <= maxX; gx += gridStep) {
      const sx = (gx - cx) * scale + w / 2;
      ctx2d.beginPath(); ctx2d.moveTo(sx, 0); ctx2d.lineTo(sx, h); ctx2d.stroke();
    }
    for (let gy = minY; gy <= maxY; gy += gridStep) {
      const sy = h / 2 - (gy - cy) * scale;
      ctx2d.beginPath(); ctx2d.moveTo(0, sy); ctx2d.lineTo(w, sy); ctx2d.stroke();
    }

    // Draw entities from SystemViews
    for (let i = 0; i < views.entityCount; i++) {
      // Position from transform matrix column 3
      const tx = views.transforms[i * 16 + 12];
      const ty = views.transforms[i * 16 + 13];

      // Scale from matrix columns (approximate)
      const sx = Math.hypot(views.transforms[i * 16], views.transforms[i * 16 + 1]);
      const sy = Math.hypot(views.transforms[i * 16 + 4], views.transforms[i * 16 + 5]);

      const radius = views.bounds[i * 4 + 3];
      const primType = views.renderMeta[i] & 0xFFFF;

      // World to screen
      const screenX = (tx - cx) * scale + w / 2;
      const screenY = h / 2 - (ty - cy) * scale;

      // Frustum cull (skip entities far offscreen)
      const screenR = radius * scale;
      if (screenX + screenR < -50 || screenX - screenR > w + 50 ||
          screenY + screenR < -50 || screenY - screenR > h + 50) continue;

      const color = PRIM_COLORS[primType] ?? '#ffffff';

      if (primType === PRIM_LINE) {
        // Draw as line
        const p = views.primParams;
        const startX = p[i * 8 + 0], startY = p[i * 8 + 1];
        const endX = p[i * 8 + 2], endY = p[i * 8 + 3];
        const lineW = p[i * 8 + 4] || 1;
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = Math.max(1, lineW * scale * 0.02);
        ctx2d.beginPath();
        ctx2d.moveTo(screenX + startX * scale * 0.01, screenY - startY * scale * 0.01);
        ctx2d.lineTo(screenX + endX * scale * 0.01, screenY - endY * scale * 0.01);
        ctx2d.stroke();
      } else if (primType === PRIM_BEZIER) {
        // Draw as bezier curve
        const p = views.primParams;
        const p0x = p[i * 8 + 0], p0y = p[i * 8 + 1];
        const p1x = p[i * 8 + 2], p1y = p[i * 8 + 3];
        const p2x = p[i * 8 + 4], p2y = p[i * 8 + 5];
        const halfW = sx * scale / 2;
        const halfH = sy * scale / 2;
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(screenX - halfW + p0x * sx * scale, screenY + halfH - p0y * sy * scale);
        ctx2d.quadraticCurveTo(
          screenX - halfW + p1x * sx * scale, screenY + halfH - p1y * sy * scale,
          screenX - halfW + p2x * sx * scale, screenY + halfH - p2y * sy * scale);
        ctx2d.stroke();
      } else if (primType === PRIM_GRADIENT) {
        // Draw as gradient-filled rect
        const halfW = sx * scale / 2;
        const halfH = sy * scale / 2;
        const p = views.primParams;
        const r1 = p[i * 8 + 3], g1 = p[i * 8 + 4], b1 = p[i * 8 + 5];
        const r2 = p[i * 8 + 7], g2 = p[i * 8 + 7], _b2 = p[i * 8 + 7]; // simplified
        const grad = ctx2d.createLinearGradient(
          screenX - halfW, screenY, screenX + halfW, screenY);
        grad.addColorStop(0, `rgb(${r1 * 255},${g1 * 255},${b1 * 255})`);
        grad.addColorStop(1, `rgb(${r2 * 255},${g2 * 255},${_b2 * 255})`);
        ctx2d.fillStyle = grad;
        ctx2d.fillRect(screenX - halfW, screenY - halfH, halfW * 2, halfH * 2);
      } else if (primType === PRIM_BOX_SHADOW) {
        // Draw as rounded rect with shadow
        const halfW = sx * scale / 2;
        const halfH = sy * scale / 2;
        const p = views.primParams;
        const cr = p[i * 8 + 2] * Math.min(halfW, halfH);
        const blur = p[i * 8 + 3] * scale;
        const r = p[i * 8 + 4], g = p[i * 8 + 5], b = p[i * 8 + 6], a = p[i * 8 + 7];
        ctx2d.save();
        ctx2d.shadowColor = `rgba(${r * 255},${g * 255},${b * 255},${a})`;
        ctx2d.shadowBlur = blur;
        ctx2d.fillStyle = `rgba(${r * 255},${g * 255},${b * 255},${a * 0.5})`;
        ctx2d.beginPath();
        ctx2d.roundRect(screenX - halfW * 0.7, screenY - halfH * 0.7,
                        halfW * 1.4, halfH * 1.4, cr);
        ctx2d.fill();
        ctx2d.restore();
      } else {
        // Default: draw as filled rect (Quad)
        const halfW = sx * scale / 2;
        const halfH = sy * scale / 2;
        ctx2d.fillStyle = color;
        ctx2d.globalAlpha = 0.8;
        ctx2d.fillRect(screenX - halfW, screenY - halfH, halfW * 2, halfH * 2);
        ctx2d.globalAlpha = 1;
        ctx2d.strokeStyle = '#ffffff44';
        ctx2d.lineWidth = 1;
        ctx2d.strokeRect(screenX - halfW, screenY - halfH, halfW * 2, halfH * 2);
      }
    }

    // Legend
    ctx2d.font = '12px monospace';
    const legendY = h - 100;
    let ly = legendY;
    for (const [type, col] of Object.entries(PRIM_COLORS)) {
      const name = ['Quad', 'Line', '', 'Bezier', 'Gradient', 'BoxShadow'][Number(type)] || '?';
      if (!name) continue;
      ctx2d.fillStyle = col;
      ctx2d.fillRect(w - 150, ly - 8, 12, 12);
      ctx2d.fillStyle = '#ccc';
      ctx2d.fillText(name, w - 132, ly + 2);
      ly += 18;
    }
  }

  // Update overlay + Canvas2D each frame
  engine.addHook('frameEnd', (_dt, views) => {
    const s = engine.stats;
    const rendererLabel = useCanvas2D ? 'Canvas2D fallback' : 'WebGPU';
    overlay.textContent =
      `Hyperion Engine — Feature Showcase
Mode: ${s.mode} | FPS: ${s.fps} | Entities: ${s.entityCount}
Renderer: ${rendererLabel}

WASD/Arrows: move | Scroll: zoom | Click: select+particles
${useCanvas2D ? '' : 'F2: toggle bounds visualizer\n'}
Primitives: Quad, Line, Gradient, BoxShadow, Bezier
Features: ${useCanvas2D ? 'ECS/WASM' : 'Bloom, GPU Particles,'} Prefabs, Frustum Culling`;

    if (useCanvas2D) {
      if (views && views.entityCount > 0) {
        drawCanvas2D(views);
      } else {
        // Static test: prove Canvas2D works
        const w = canvas.width, h = canvas.height;
        ctx2d!.fillStyle = '#1a1a2e';
        ctx2d!.fillRect(0, 0, w, h);
        ctx2d!.fillStyle = '#ff6644';
        ctx2d!.font = '24px monospace';
        ctx2d!.fillText(`Waiting for ECS data... (entities: ${s.entityCount})`, 40, h / 2);
        ctx2d!.fillText(`views: ${views ? 'yes, count=' + views.entityCount : 'null'}`, 40, h / 2 + 30);
      }
    }
  });

  engine.start();
}

main();

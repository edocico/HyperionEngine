import { Hyperion } from './hyperion';
import { ReportBuilder } from './demo/report';
import { createTestReporter } from './demo/types';
import type { DemoSection, TestReporter, SectionStatus } from './demo/types';

// ---------------------------------------------------------------------------
// Tab definitions — order matches display order
// ---------------------------------------------------------------------------
interface TabDef {
  key: string;
  label: string;
}

const TABS: TabDef[] = [
  { key: 'primitives',    label: 'Primitives' },
  { key: 'scene-graph',   label: 'Scene Graph' },
  { key: 'input',         label: 'Input' },
  { key: 'audio',         label: 'Audio' },
  { key: 'particles',     label: 'Particles' },
  { key: 'rendering-fx',  label: 'Rendering FX' },
  { key: 'debug-tools',   label: 'Debug Tools' },
  { key: 'lifecycle',     label: 'Lifecycle' },
];

// ---------------------------------------------------------------------------
// Dynamic section imports — lazy loaded on tab switch
// ---------------------------------------------------------------------------
const SECTION_LOADERS: Record<string, () => Promise<{ default: DemoSection }>> = {
  primitives:     () => import('./demo/primitives'),
  'scene-graph':  () => import('./demo/scene-graph'),
  input:          () => import('./demo/input'),
  audio:          () => import('./demo/audio'),
  particles:      () => import('./demo/particles'),
  'rendering-fx': () => import('./demo/rendering-fx'),
  'debug-tools':  () => import('./demo/debug-tools'),
  lifecycle:      () => import('./demo/lifecycle'),
};

// ---------------------------------------------------------------------------
// Status → icon/class mapping
// ---------------------------------------------------------------------------
const STATUS_ICON: Record<string, string> = {
  pass: '\u2713',    // checkmark
  fail: '\u2715',    // x mark
  skip: '\u2298',    // circled dash
  pending: '\u23F3', // hourglass
};

function badgeClassForStatus(status: SectionStatus): string {
  return status; // CSS classes match: pass, fail, partial, not-run
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const overlay = document.getElementById('overlay')!;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const tabBar = document.getElementById('tab-bar')!;
  const checkList = document.getElementById('check-list')!;
  const checkSummary = document.getElementById('check-summary')!;

  overlay.textContent = 'Hyperion Engine — initializing...';

  // --- Hyperion init ---
  const engine = await Hyperion.create({ canvas });

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * dpr);
    const height = Math.floor(canvas.clientHeight * dpr);
    engine.resize(width, height);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // --- State ---
  const sectionCache = new Map<string, DemoSection>();
  const reporterCache = new Map<string, TestReporter>();
  const tabElements = new Map<string, HTMLElement>();
  const badgeElements = new Map<string, HTMLElement>();
  let currentKey: string | null = null;

  // --- Build tab bar (createElement + textContent only, NO innerHTML) ---
  for (const tab of TABS) {
    const el = document.createElement('div');
    el.className = 'tab';

    const badge = document.createElement('span');
    badge.className = 'tab-badge not-run';
    el.appendChild(badge);

    const label = document.createElement('span');
    label.textContent = tab.label;
    el.appendChild(label);

    el.addEventListener('click', () => {
      switchSection(tab.key);
    });

    tabBar.appendChild(el);
    tabElements.set(tab.key, el);
    badgeElements.set(tab.key, badge);
  }

  // Export button (right-aligned via CSS margin-left: auto)
  const exportBtn = document.createElement('button');
  exportBtn.id = 'export-btn';
  exportBtn.textContent = 'Export Report';
  exportBtn.addEventListener('click', () => {
    const builder = new ReportBuilder(engine.stats.mode, navigator.userAgent);
    for (const [key, reporter] of reporterCache) {
      builder.addSection(key, {
        status: reporter.sectionStatus(),
        checks: reporter.results(),
      });
    }
    builder.download();
  });
  tabBar.appendChild(exportBtn);

  // --- Section switching ---
  async function switchSection(key: string) {
    // Teardown current section
    if (currentKey !== null) {
      const cached = sectionCache.get(currentKey);
      if (cached) {
        try { cached.teardown(engine); } catch (e) {
          console.warn(`[teardown:${currentKey}]`, e);
        }
      }
    }

    // Update active tab class
    for (const [k, el] of tabElements) {
      if (k === key) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }

    currentKey = key;

    // Get or create reporter for this section
    let reporter = reporterCache.get(key);
    if (!reporter) {
      reporter = createTestReporter();
      reporterCache.set(key, reporter);
    }

    // Load section (lazy, cached after first load)
    let section = sectionCache.get(key);
    if (!section) {
      try {
        const mod = await SECTION_LOADERS[key]();
        section = mod.default;
        sectionCache.set(key, section);
      } catch (err) {
        // Section module doesn't exist yet — show error in check panel
        reporter.check('module-load', false,
          `Failed to load section: ${err instanceof Error ? err.message : String(err)}`);
        renderCheckPanel(reporter);
        updateTabBadge(key, reporter.sectionStatus());
        return;
      }
    }

    // Run section setup
    try {
      await section.setup(engine, reporter);
    } catch (err) {
      reporter.check('setup', false,
        `Setup error: ${err instanceof Error ? err.message : String(err)}`);
    }

    renderCheckPanel(reporter);
    updateTabBadge(key, reporter.sectionStatus());
  }

  // --- Check panel rendering (NO innerHTML — createElement + textContent only) ---
  function renderCheckPanel(reporter: TestReporter) {
    // Clear container safely
    while (checkList.firstChild) checkList.removeChild(checkList.firstChild);
    while (checkSummary.firstChild) checkSummary.removeChild(checkSummary.firstChild);

    const results = reporter.results();

    for (const result of results) {
      const item = document.createElement('div');
      item.className = 'check-item';

      const icon = document.createElement('span');
      icon.className = `check-icon ${result.status}`;
      icon.textContent = STATUS_ICON[result.status] ?? '?';
      item.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'check-name';
      name.textContent = result.name;
      item.appendChild(name);

      checkList.appendChild(item);

      if (result.detail) {
        const detail = document.createElement('div');
        detail.className = 'check-detail';
        detail.textContent = result.detail;
        checkList.appendChild(detail);
      }
    }

    // Summary line
    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const skipped = results.filter(r => r.status === 'skip').length;
    const total = results.length;

    const summaryText = document.createElement('span');
    summaryText.textContent = `${passed}/${total} passed`;
    if (skipped > 0) summaryText.textContent += ` \u00B7 ${skipped} skipped`;
    if (failed > 0) summaryText.textContent += ` \u00B7 ${failed} failed`;
    checkSummary.appendChild(summaryText);
  }

  // --- Tab badge update ---
  function updateTabBadge(key: string, status: SectionStatus) {
    const badge = badgeElements.get(key);
    if (!badge) return;
    badge.className = `tab-badge ${badgeClassForStatus(status)}`;
  }

  // --- Periodic refresh for async checks (500ms) ---
  setInterval(() => {
    if (currentKey === null) return;
    const reporter = reporterCache.get(currentKey);
    if (!reporter) return;
    renderCheckPanel(reporter);
    updateTabBadge(currentKey, reporter.sectionStatus());
  }, 500);

  // --- HUD overlay (frameEnd hook) ---
  engine.addHook('frameEnd', () => {
    const s = engine.stats;
    overlay.textContent =
      `Hyperion Engine \u2014 Verification Harness\nMode: ${s.mode} | FPS: ${s.fps} | Entities: ${s.entityCount}`;
  });

  // --- Start engine and auto-select first tab ---
  engine.start();
  switchSection('primitives');
}

main();

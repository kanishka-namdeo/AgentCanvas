// scenarios.ts — data-driven scenario registry + action executor for the
// landing video capture harness.
//
// CHOREOGRAPHY CONTRACT (documented in README.md + recorded in the manifest):
// canvas mutations are replayed through the app's OWN store surface —
//   page.evaluate(() => window.__canvasStore.getState().sendPatch(patch))
// NOT through a raw Socket.IO "ghost collaborator". Rationale (verified
// against src/lib/canvas/store.ts init()): the client socket connects to
// io('/?XTransformPort=3003') — SAME ORIGIN — and the ?XTransformPort
// routing only exists behind the z.ai Caddy gateway (Caddyfile). On a
// direct-port dev server (127.0.0.1:3100) the /socket.io handshake 404s, so
// the browser socket NEVER connects; a Node-side socket.io-client emitting
// to :3003 would journal patches server-side without the browser UI ever
// seeing them. The store path always applies optimistically in-UI with the
// app's own mutation identity / undo semantics — exactly like a user edit.
//
// Coordinate convention for actions: canvas coordinates in actions are
// RELATIVE TO THE VISIBLE CANVAS CENTER (computed live from the store's
// viewport pan/zoom), so scenarios never depend on sidebar widths or the
// default 120/80 pan. `canvasPatches` builders receive the ABSOLUTE canvas
// center instead (they need real geometry).
//
// Scenarios are LLM-FREE by contract (root AGENTS.md endpoint policy): the
// typed prompt lands in the chat composer but is NEVER sent — no
// /api/agent calls, no endpoint touches.

import type { Page } from 'playwright-core';

// ── Types ────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

/// One choreographed canvas mutation. `patch` is a CanvasPatch payload
/// (src/lib/canvas/types.ts) — op + payload + REQUIRED summary.
export interface PatchStep {
  patch: Record<string, unknown>;
  /// Absolute offset (ms) from the start of the canvasPatches action.
  /// When omitted, the patch is scheduled at index * intervalMs.
  atMs?: number;
  label?: string;
}

/// Environment handed to a canvasPatches `build` factory at run time.
export interface PatchEnv {
  /// Center of the visible canvas area, in ABSOLUTE canvas coordinates
  /// (accounts for the live viewport pan/zoom read from the store).
  canvasCenter: Point;
  zoom: number;
  viewport: { width: number; height: number };
}

export type Action =
  | { type: 'navigate'; url?: string; waitFor?: string; settleMs?: number; timeoutMs?: number }
  | { type: 'click'; selector?: string; text?: string; canvas?: Point; timeoutMs?: number }
  | { type: 'move'; canvas?: Point; steps?: number; durationMs?: number }
  | { type: 'drag'; from: Point; to: Point; steps?: number; holdMs?: number }
  /// Drag an element (by selector) so its center lands at a canvas-center-
  /// RELATIVE target. Used to reposition toolbar-dropped shapes (the toolbar
  /// drops at WINDOW center, which sits under the right panel in the
  /// three-column layout).
  | { type: 'dragTo'; selector: string; to: Point; steps?: number }
  | {
      type: 'stroke';
      from: Point;
      to: Point;
      color?: string;
      strokeWidth?: number;
      amplitude?: number;
      strokeMs?: number;
      updateEveryMs?: number;
      id?: string;
    }
  | { type: 'type'; text: string; selector?: string; cadenceMs?: number; clickFirst?: boolean }
  | { type: 'key'; chord: string }
  | { type: 'wait'; ms: number }
  | { type: 'waitForSelector'; selector: string; timeoutMs?: number }
  | { type: 'scroll'; dx?: number; dy?: number; selector?: string }
  | { type: 'canvasPatches'; patches?: PatchStep[]; build?: (env: PatchEnv) => PatchStep[]; intervalMs?: number }
  /// Drag a guide line out of a ruler (rulers must be visible — enable via
  /// the app menu first). axis 'horizontal' = from the TOP ruler (a y-line).
  /// `to` is a canvas-center-RELATIVE drop point.
  | { type: 'guideDrag'; axis: 'horizontal' | 'vertical'; to: Point; steps?: number }
  /// HTML5 drag-and-drop between two selectors (LayersPanel rows are HTML5
  /// draggable — dropping a row onto another REPARENTS the node). Uses
  /// locator.dragTo, which drives Chromium's native drag interception.
  | { type: 'dnd'; fromSelector: string; toSelector: string }
  /// Layers-panel reparent via the panel's OWN HTML5 DnD contract: dispatch
  /// dragstart/dragover/drop DragEvents between two rows (matched by row
  /// text) and VERIFY the store reparented the node. Used because Chromium +
  /// locator.dragTo does not trigger the React synthetic DnD handlers here.
  /// The drop target must be a container (frame/group).
  | { type: 'layersReparent'; fromRowText: string; toRowText: string }
  /// Escape hatch for store-side toggles. `script` runs in the page.
  | { type: 'eval'; script: string; label?: string };

export interface Scenario {
  id: string;
  title: string;
  description: string;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  /// Landing contract = light-mode app captures (default 'light').
  theme?: 'light' | 'dark' | 'system';
  /// Extra localStorage seeds applied BEFORE app scripts load (via
  /// context.addInitScript), e.g. the active design-system pack.
  seedLocalStorage?: Record<string, string>;
  /// Show the synthetic cursor overlay (eased mouse motion follower).
  cursor?: boolean;
  /// Selectors that MUST exist at the end of the run — a miss FAILs the take.
  requireSelectors?: string[];
  actions: Action[];
}

export interface RunContext {
  page: Page;
  baseUrl: string;
  documentId: string;
  cursor: boolean;
  log: (line: string) => void;
  /** Buffered console errors (already filtered) — recorded in the manifest. */
  consoleErrors: string[];
  /** Private: last synthesized pointer screen position (for fluid moves). */
  lastPointer?: Point;
}

// ── Page-side helpers ────────────────────────────────────────────────────
//
// NOTE: page.evaluate treats STRING arguments as expressions — an
// arrow-function string evaluates to a function value and serializes to
// undefined. Every evaluate below passes a REAL function (or the scenario
// eval action requires an IIFE call `(() => {...})()` in its script string).

/// The dev-only store debug global (src/lib/canvas/store.ts mounts it when
/// NODE_ENV !== 'production').
declare global {
  interface Window {
    __canvasStore?: {
      getState: () => {
        sendPatch: (patch: unknown) => boolean;
        selectedIds: string[];
        agentBusy: boolean;
        rulersVisible: boolean;
        setViewFlag: (flag: 'rulersVisible', value: boolean) => void;
        document: {
          viewport: { zoom: number; panX: number; panY: number };
          children: Array<Record<string, unknown>>;
        };
      };
    };
  }
}

async function sendPatch(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    const store = window.__canvasStore;
    if (!store) throw new Error('window.__canvasStore missing (dev-only global; is this a production build?)');
    const ok = store.getState().sendPatch(p);
    if (ok === false) throw new Error('sendPatch returned false — mutation blocked (agent busy?)');
    return true;
  }, patch);
}

interface ViewEnv {
  left: number;
  top: number;
  width: number;
  height: number;
  zoom: number;
  panX: number;
  panY: number;
}

async function readViewEnv(page: Page): Promise<ViewEnv> {
  return await page.evaluate((): ViewEnv => {
    const world = document.querySelector('[data-ac-world]');
    const store = window.__canvasStore;
    if (!world) throw new Error('[data-ac-world] not mounted');
    if (!store) throw new Error('window.__canvasStore missing');
    const s = store.getState();
    const wrapper = world.parentElement || world;
    const r = wrapper.getBoundingClientRect();
    return {
      left: r.left, top: r.top, width: r.width, height: r.height,
      zoom: s.document.viewport.zoom,
      panX: s.document.viewport.panX,
      panY: s.document.viewport.panY,
    };
  });
}

/// ABSOLUTE canvas coords → screen (client) coords, via the live transform.
/// worldRect.left === wrapperRect.left + panX (translate before scale, origin 0 0).
async function canvasAbsToScreen(page: Page, p: Point): Promise<Point> {
  const world = await page.evaluate(() => {
    const w = document.querySelector('[data-ac-world]');
    if (!w) throw new Error('[data-ac-world] not mounted');
    const r = w.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  const zoom = (await readViewEnv(page)).zoom;
  return { x: world.left + p.x * zoom, y: world.top + p.y * zoom };
}

/// Center-RELATIVE canvas coords → screen coords.
async function canvasToScreen(page: Page, rel: Point): Promise<Point> {
  const env = await readViewEnv(page);
  const centerAbs = {
    x: (env.width / 2 - env.panX) / env.zoom,
    y: (env.height / 2 - env.panY) / env.zoom,
  };
  return {
    x: env.left + env.panX + (centerAbs.x + rel.x) * env.zoom,
    y: env.top + env.panY + (centerAbs.y + rel.y) * env.zoom,
  };
}

/// Visible-canvas center in ABSOLUTE canvas coords.
async function canvasCenterAbs(page: Page): Promise<Point> {
  const env = await readViewEnv(page);
  return {
    x: (env.width / 2 - env.panX) / env.zoom,
    y: (env.height / 2 - env.panY) / env.zoom,
  };
}

/// Synthetic cursor overlay — a DOM dot that follows real mousemove events
/// (Playwright's mouse.* dispatches trusted input events, so the overlay
/// tracks the choreographed pointer). Installed once per page.
async function installCursorOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById('vc-cursor')) return true;
    const el = document.createElement('div');
    el.id = 'vc-cursor';
    el.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'width:16px', 'height:16px',
      'border-radius:50%', 'background:rgba(14,165,233,0.9)',
      'border:2px solid #ffffff', 'box-shadow:0 1px 6px rgba(15,23,42,0.35)',
      'pointer-events:none', 'top:-40px', 'left:-40px',
    ].join(';');
    document.body.appendChild(el);
    window.addEventListener('mousemove', (e) => {
      el.style.left = (e.clientX - 8) + 'px';
      el.style.top = (e.clientY - 8) + 'px';
    }, true);
    return true;
  }).catch(() => {});
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/// App-ready gate. `[data-ac-world]` is a zero-size div on an EMPTY canvas,
/// so Playwright's default `visible` state never passes — wait for it
/// ATTACHED, plus the visible toolbar and the dev-only store global.
export async function waitForAppReady(page: Page, timeoutMs = 90_000): Promise<void> {
  await page.waitForSelector('[data-ac-world]', { state: 'attached', timeout: timeoutMs });
  await page.waitForSelector('[aria-label="Canvas toolbar"]', { state: 'visible', timeout: timeoutMs });
  await page.waitForFunction(() => !!(window as unknown as { __canvasStore?: unknown }).__canvasStore, undefined, { timeout: timeoutMs });
}

/// Human-like eased multi-step pointer motion (easeInOutCubic across
/// `steps` micro-moves spread over `durationMs`).
async function easedMove(
  page: Page,
  from: Point,
  to: Point,
  opts: { steps?: number; durationMs?: number } = {},
): Promise<void> {
  const steps = Math.max(4, opts.steps ?? 22);
  const durationMs = opts.durationMs ?? 420;
  const dt = Math.max(8, Math.round(durationMs / steps));
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutCubic(i / steps);
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (i < steps) await sleep(dt);
  }
}

// ── Action executor ──────────────────────────────────────────────────────

async function runAction(action: Action, ctx: RunContext): Promise<void> {
  const { page, log } = ctx;

  switch (action.type) {
    case 'navigate': {
      const url = action.url ?? `${ctx.baseUrl}/app?doc=${ctx.documentId}`;
      const timeoutMs = action.timeoutMs ?? 90_000; // dev-server first-compile headroom
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await waitForAppReady(page, timeoutMs);
      if (ctx.cursor) await installCursorOverlay(page);
      const settle = action.settleMs ?? 2_500;
      await sleep(settle);
      log(`navigate ${url} (settled ${settle}ms)`);
      return;
    }

    case 'click': {
      if (action.canvas) {
        const screen = await canvasToScreen(page, action.canvas);
        await page.mouse.click(screen.x, screen.y);
        ctx.lastPointer = screen;
        log(`click canvas-center-rel (${Math.round(action.canvas.x)}, ${Math.round(action.canvas.y)})`);
        await sleep(300);
        return;
      }
      const loc = action.text
        ? page.getByText(action.text, { exact: false }).first()
        : page.locator(action.selector!).first();
      await loc.click({ timeout: action.timeoutMs ?? 12_000 });
      const box = await loc.boundingBox().catch(() => null);
      if (box) ctx.lastPointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      log(`click ${action.text ? `text "${action.text}"` : action.selector}`);
      await sleep(300);
      return;
    }

    case 'move': {
      if (!action.canvas) throw new Error('move requires a canvas point');
      const target = await canvasToScreen(page, action.canvas);
      await easedMove(page, ctx.lastPointer ?? target, target, {
        steps: action.steps,
        durationMs: action.durationMs,
      });
      ctx.lastPointer = target;
      log(`move → screen (${Math.round(target.x)}, ${Math.round(target.y)})`);
      return;
    }

    case 'drag': {
      const from = await canvasToScreen(page, action.from);
      const to = await canvasToScreen(page, action.to);
      await page.mouse.move(from.x, from.y);
      await sleep(120);
      await page.mouse.down();
      await sleep(action.holdMs ?? 150);
      await easedMove(page, from, to, {
        steps: action.steps ?? 28,
        durationMs: Math.max(400, (action.steps ?? 28) * 20),
      });
      await sleep(200);
      await page.mouse.up();
      log(`drag (${Math.round(action.from.x)}, ${Math.round(action.from.y)}) → (${Math.round(action.to.x)}, ${Math.round(action.to.y)})`);
      await sleep(400);
      return;
    }

    case 'dragTo': {
      const loc = page.locator(action.selector).first();
      const box = await loc.boundingBox({ timeout: 10_000 });
      if (!box) throw new Error(`dragTo: no bounding box for ${action.selector}`);
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const to = await canvasToScreen(page, action.to);
      await page.mouse.move(from.x, from.y);
      await sleep(120);
      await page.mouse.down();
      await sleep(150);
      await easedMove(page, from, to, { steps: action.steps ?? 28, durationMs: Math.max(400, (action.steps ?? 28) * 20) });
      await sleep(200);
      await page.mouse.up();
      log(`dragTo ${action.selector} → canvas-center-rel (${Math.round(action.to.x)}, ${Math.round(action.to.y)})`);
      await sleep(400);
      return;
    }

    case 'dnd': {
      const from = page.locator(action.fromSelector).first();
      const to = page.locator(action.toSelector).first();
      await from.dragTo(to, { timeout: 15_000 });
      log(`dnd ${action.fromSelector} → ${action.toSelector}`);
      await sleep(600);
      return;
    }

    case 'layersReparent': {
      // Drive the LayersPanel's own HTML5 DnD contract with synthetic
      // DragEvents (dragstart on the source row sets text/plain = shape id;
      // drop on the target row emits op:'reparent'), then verify in the
      // store that the node actually moved under the new parent.
      const dispatched = await page.evaluate(({ fromText, toText }) => {
        const rows = [...document.querySelectorAll('[role="treeitem"]')];
        const src = rows.find((r) => (r.textContent ?? '').includes(fromText));
        const dst = rows.find((r) => (r.textContent ?? '').includes(toText));
        if (!src) throw new Error(`layersReparent: no row matching "${fromText}"`);
        if (!dst) throw new Error(`layersReparent: no row matching "${toText}"`);
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return true;
      }, { fromText: action.fromRowText, toText: action.toRowText });
      if (!dispatched) throw new Error('layersReparent dispatch failed');

      // Verify the store reparented (poll up to ~2.5s). Iterative DFS —
      // NO named inner functions: tsx/esbuild decorates named functions with
      // a module-scope __name() helper that does not exist in the page.
      const deadline = Date.now() + 2_500;
      let verdict: { ok: boolean; reason?: string } | null = null;
      while (Date.now() < deadline) {
        verdict = await page.evaluate(([fromName, toName]) => {
          const store = window.__canvasStore;
          if (!store) throw new Error('window.__canvasStore missing');
          const doc = store.getState().document;
          type N = { id?: string; name?: string; children?: N[] };
          // Iterative DFS — NO named inner functions: tsx/esbuild decorates
          // named functions with a module-scope __name() helper that does
          // not exist inside the page context.
          const stack: N[] = [...((doc.children as unknown as N[]) ?? [])];
          let from: N | null = null;
          let to: N | null = null;
          while (stack.length && !(from && to)) {
            const n = stack.shift() as N;
            if (n.name === fromName) from = n;
            if (n.name === toName) to = n;
            if (Array.isArray(n.children)) stack.push(...n.children);
          }
          if (!from || !to) return { ok: false, reason: 'node not found' };
          // The .pen tree has no parentId — reparenting is structural:
          // the target's children must now contain the source node's id.
          const nested = Array.isArray(to.children) && to.children.some((c) => c.id === from.id);
          return { ok: Boolean(nested) };
        }, [action.fromRowText, action.toRowText]);
        if (verdict?.ok) break;
        await sleep(250);
      }
      if (!verdict?.ok) {
        throw new Error(`layersReparent verify failed: ${JSON.stringify(verdict)}`);
      }
      log(`layersReparent "${action.fromRowText}" → "${action.toRowText}" (store verified)`);
      await sleep(600);
      return;
    }

    case 'guideDrag': {
      // Ensure rulers are visible (the scenario already clicked the app-menu
      // item on camera; this store-level guard makes the step deterministic
      // if the Radix menu click raced the toggle). Then locate the ruler SVG
      // (first = top ruler, last = left ruler) and drag a guide into the
      // canvas. The ruler uses pointer capture, which works with Playwright's
      // trusted input events.
      await page.evaluate(() => {
        const store = window.__canvasStore;
        if (!store) throw new Error('window.__canvasStore missing');
        const s = store.getState();
        if (!s.rulersVisible) s.setViewFlag('rulersVisible', true);
        return true;
      });
      await sleep(350);
      const r = await page.evaluate((axis) => {
        const svgs = document.querySelectorAll('[data-ac-rulers] svg');
        if (!svgs.length) throw new Error('no ruler SVG found — are rulers visible?');
        const svg = axis === 'horizontal' ? svgs[0] : svgs[svgs.length - 1];
        const box = svg.getBoundingClientRect();
        return {
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
          w: box.width, h: box.height,
        };
      }, action.axis);
      if (!r) throw new Error('ruler locate evaluate returned undefined');
      const target = await canvasToScreen(page, action.to);
      const start = { x: r.x, y: r.y };
      await page.mouse.move(start.x, start.y);
      await sleep(120);
      await page.mouse.down();
      await sleep(160);
      await easedMove(page, start, target, { steps: action.steps ?? 24, durationMs: 850 });
      await sleep(200);
      await page.mouse.up();
      log(`guideDrag ${action.axis} → (${Math.round(action.to.x)}, ${Math.round(action.to.y)})`);
      await sleep(400);
      return;
    }

    case 'stroke': {
      // Freehand-looking stroke. The UI has no freehand tool (P routes to
      // chat), so the stroke is choreographed: a path shape is added via
      // sendPatch, then the pointer sweeps an eased sine curve while update
      // patches stream the growing `points` array (~updateEveryMs) — the DOM
      // renderer's path island repaints live. `from`/`to` are canvas-center
      // RELATIVE; the polyline itself is stored in ABSOLUTE canvas coords.
      const id = action.id ?? `stroke-${Date.now()}`;
      const color = action.color ?? '#0ea5e9';
      const strokeWidth = action.strokeWidth ?? 3.5;
      const amplitude = action.amplitude ?? 26;
      const strokeMs = action.strokeMs ?? 2_000;
      const updateEveryMs = action.updateEveryMs ?? 260;
      const env = await readViewEnv(page);
      const centerAbs = {
        x: (env.width / 2 - env.panX) / env.zoom,
        y: (env.height / 2 - env.panY) / env.zoom,
      };
      const steps = Math.max(10, Math.round(strokeMs / 33));

      const pts: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const eased = easeInOutCubic(t);
        pts.push({
          x: Math.round(centerAbs.x + action.from.x + (action.to.x - action.from.x) * eased),
          y: Math.round(
            centerAbs.y +
              action.from.y +
              (action.to.y - action.from.y) * t +
              Math.sin(t * Math.PI * 2.2) * amplitude * Math.sin(t * Math.PI),
          ),
        });
      }

      await sendPatch(page, {
        op: 'add',
        shapeId: id,
        shape: {
          id,
          type: 'path',
          name: 'Freehand stroke',
          x: 0,
          y: 0,
          width: Math.abs(action.to.x - action.from.x),
          height: amplitude * 2,
          fill: 'transparent',
          stroke: color,
          strokeWidth,
          points: [pts[0]],
        },
        summary: 'Drew a freehand stroke',
      });

      const fromScreen = await canvasToScreen(page, action.from);
      const toScreen = await canvasToScreen(page, action.to);
      await page.mouse.move(fromScreen.x, fromScreen.y);
      await page.mouse.down();
      const t0 = Date.now();
      let lastUpdateAt = -Infinity;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const eased = easeInOutCubic(t);
        await page.mouse.move(
          fromScreen.x + (toScreen.x - fromScreen.x) * eased,
          fromScreen.y + (toScreen.y - fromScreen.y) * t,
        );
        // Stream the stroke so far at the update cadence — points are
        // ABSOLUTE canvas coords. Each streamed update lands on its own
        // rAF frame, so Ctrl+Z later walks the stroke back step-by-step.
        const now = Date.now() - t0;
        if (now - lastUpdateAt >= updateEveryMs) {
          lastUpdateAt = now;
          await sendPatch(page, {
            op: 'update',
            shapeId: id,
            shape: { points: pts.slice(0, i + 1) },
            summary: '',
          });
        }
        const due = t0 + Math.round(t * strokeMs);
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
      }
      // Closing update with the full polyline.
      await sendPatch(page, {
        op: 'update',
        shapeId: id,
        shape: { points: pts },
        summary: 'Finished freehand stroke',
      });
      await page.mouse.up();
      log(`stroke "${id}" (${steps} pts, ${strokeMs}ms)`);
      await sleep(400);
      return;
    }

    case 'type': {
      const loc = action.selector
        ? page.locator(action.selector).first()
        : page.locator('textarea[placeholder^="Ask the agent"]').first();
      if (action.clickFirst !== false) await loc.click({ timeout: 12_000 });
      const cadence = action.cadenceMs ?? 42;
      const chars = [...action.text];
      for (let i = 0; i < chars.length; i++) {
        await page.keyboard.type(chars[i], { delay: 0 });
        let d = cadence + Math.random() * cadence * 0.6;
        if (chars[i] === ' ') d += cadence * 0.8;
        await sleep(d);
      }
      log(`typed ${action.text.length} chars`);
      await sleep(400);
      return;
    }

    case 'key': {
      await page.keyboard.press(action.chord);
      log(`key ${action.chord}`);
      await sleep(450);
      return;
    }

    case 'wait': {
      await sleep(action.ms);
      log(`wait ${action.ms}ms`);
      return;
    }

    case 'waitForSelector': {
      await page.waitForSelector(action.selector, { timeout: action.timeoutMs ?? 15_000 });
      log(`waitForSelector ${action.selector}`);
      return;
    }

    case 'scroll': {
      if (action.selector) {
        await page.locator(action.selector).first().hover({ timeout: 10_000 });
      }
      await page.mouse.wheel(action.dx ?? 0, action.dy ?? 0);
      log(`scroll (${action.dx ?? 0}, ${action.dy ?? 0})`);
      await sleep(400);
      return;
    }

    case 'canvasPatches': {
      const env: PatchEnv = {
        canvasCenter: await canvasCenterAbs(page),
        zoom: (await readViewEnv(page)).zoom,
        viewport: page.viewportSize() ?? { width: 1600, height: 1000 },
      };
      const steps = action.build ? action.build(env) : action.patches ?? [];
      const intervalMs = action.intervalMs ?? 1_000;
      const t0 = Date.now();
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const due = t0 + (step.atMs ?? i * intervalMs);
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
        await sendPatch(page, step.patch);
        log(`patch[${i}]${step.label ? ` (${step.label})` : ''} op=${String(step.patch.op)} at ${Date.now() - t0}ms`);
      }
      log(`canvasPatches done (${steps.length} patches)`);
      return;
    }

    case 'eval': {
      await page.evaluate(action.script);
      log(`eval ${action.label ?? action.script.slice(0, 48)}`);
      await sleep(350);
      return;
    }

    default: {
      throw new Error(`Unknown action type: ${(action as { type: string }).type}`);
    }
  }
}

// ── Scenario runner ──────────────────────────────────────────────────────

export interface RunOutcome {
  ok: boolean;
  failure?: string;
  actionsExecuted: number;
  requireChecked: string[];
}

export async function runScenario(scenario: Scenario, ctx: RunContext): Promise<RunOutcome> {
  let executed = 0;
  try {
    for (const action of scenario.actions) {
      await runAction(action, ctx);
      executed += 1;
    }
    for (const sel of scenario.requireSelectors ?? []) {
      // 'attached' not 'visible': [data-ac-world] is a zero-size wrapper on
      // an empty canvas and never passes the default visibility check.
      await ctx.page.waitForSelector(sel, { state: 'attached', timeout: 8_000 });
    }
    const requireChecked = scenario.requireSelectors ?? [];
    const alive = await ctx.page.evaluate(
      `(() => { const s = window.__canvasStore?.getState?.(); return s ? { shapes: s.document.shapes.length, busy: s.agentBusy } : null; })()`,
    );
    ctx.log(`store sanity: ${JSON.stringify(alive)}`);
    return { ok: true, actionsExecuted: executed, requireChecked };
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(err);
    return { ok: false, failure: `action ${executed + 1}: ${message}`, actionsExecuted: executed, requireChecked: [] };
  }
}

// ── Patch builders (choreography payloads) ───────────────────────────────

type Node = Record<string, unknown>;

const text = (s: string, x: number, y: number, w: number, opts: Node = {}): Node => ({
  type: 'text',
  name: typeof opts.name === 'string' ? opts.name : s.slice(0, 24),
  x, y,
  width: w,
  height: ((opts.fontSize as number) ?? 16) + 8,
  text: s,
  fill: (opts.fill as string) ?? '#0f172a',
  textColor: (opts.fill as string) ?? '#0f172a',
  fontSize: (opts.fontSize as number) ?? 14,
  fontWeight: (opts.fontWeight as number) ?? 400,
  ...((opts.extra as Node) ?? {}),
});

/// build-reveal: a realistic analytics dashboard that assembles block-by-block.
function dashboardBlocks(env: PatchEnv): PatchStep[] {
  const { canvasCenter: c } = env;
  const rootX = Math.round(c.x - 480);
  const rootY = Math.round(c.y - 320);

  const kpiCard = (x: number, label: string, value: string, delta: string, deltaColor: string): Node => ({
    type: 'frame',
    name: `KPI ${label}`,
    x, y: 128,
    width: 232,
    height: 112,
    fill: '#f8fafc',
    radius: 12,
    children: [
      text(label.toUpperCase(), 16, 14, 200, { fontSize: 11, fill: '#64748b', extra: { textTransform: 'uppercase', letterSpacing: 0.6 } }),
      text(value, 16, 36, 200, { fontSize: 27, fontWeight: 700, fill: '#0f172a' }),
      text(delta, 16, 82, 200, { fontSize: 11, fontWeight: 600, fill: deltaColor }),
    ],
  });

  const bars: Node[] = [];
  const heights = [42, 64, 52, 88, 72, 110, 96, 128, 84, 142, 118, 158, 134, 176];
  heights.forEach((h, i) => {
    bars.push({
      type: 'rectangle',
      name: `bar-${i + 1}`,
      x: 28 + i * 47,
      y: 212 - h,
      width: 28,
      height: h,
      fill: i === heights.length - 1 ? '#0369a1' : '#0ea5e9',
      radius: 4,
    });
  });

  const row = (y: number, name: string, plan: string, mrr: string, muted: boolean): Node => ({
    type: 'frame',
    name: `row ${name}`,
    x: 16, y,
    width: 680,
    height: 28,
    fill: 'transparent',
    children: [
      text(name, 4, 5, 220, { fontSize: 12, fontWeight: 600, fill: '#0f172a' }),
      text(plan, 240, 6, 260, { fontSize: 11, fill: '#64748b' }),
      text(mrr, 520, 5, 150, { fontSize: 12, fontWeight: 600, fill: muted ? '#64748b' : '#0f172a', extra: { textAlign: 'right' } }),
    ],
  });

  const blocks: Array<{ id: string; label: string; node: Node }> = [
    {
      id: 'dash-root',
      label: 'app frame',
      node: {
        type: 'frame',
        name: 'Pulse Dashboard',
        x: rootX, y: rootY,
        width: 960, height: 640,
        fill: '#ffffff',
        radius: 16,
        shadow: { color: 'rgba(15,23,42,0.16)', offsetX: 0, offsetY: 18, blur: 44, spread: -8 },
      },
    },
    {
      id: 'dash-sidebar',
      label: 'sidebar',
      node: {
        type: 'frame',
        name: 'Sidebar',
        x: 0, y: 0,
        width: 200, height: 640,
        fill: '#0f172a',
        children: [
          text('◆ Pulse', 24, 26, 150, { fontSize: 19, fontWeight: 700, fill: '#f8fafc' }),
          text('Overview', 24, 92, 150, { fontSize: 13, fontWeight: 600, fill: '#38bdf8' }),
          text('Reports', 24, 132, 150, { fontSize: 13, fill: '#94a3b8' }),
          text('Customers', 24, 172, 150, { fontSize: 13, fill: '#94a3b8' }),
          text('Billing', 24, 212, 150, { fontSize: 13, fill: '#94a3b8' }),
          text('Settings', 24, 252, 150, { fontSize: 13, fill: '#94a3b8' }),
        ],
      },
    },
    {
      id: 'dash-header',
      label: 'header',
      node: {
        type: 'frame',
        name: 'Header',
        x: 200, y: 0,
        width: 760, height: 88,
        fill: '#ffffff',
        children: [
          text('Overview', 28, 18, 300, { fontSize: 22, fontWeight: 700, fill: '#0f172a' }),
          text('Last 30 days · All channels', 28, 54, 320, { fontSize: 12, fill: '#64748b' }),
          { type: 'ellipse', name: 'avatar', x: 696, y: 26, width: 36, height: 36, fill: '#38bdf8' },
        ],
      },
    },
    { id: 'dash-kpi-1', label: 'KPI · revenue', node: kpiCard(224, 'Revenue', '$128,420', '▲ 12.4% vs last month', '#16a34a') },
    { id: 'dash-kpi-2', label: 'KPI · active users', node: kpiCard(472, 'Active users', '9,481', '▲ 4.1% vs last month', '#16a34a') },
    { id: 'dash-kpi-3', label: 'KPI · churn', node: kpiCard(720, 'Churn', '1.9%', '▼ 0.3 pts', '#dc2626') },
    {
      id: 'dash-chart',
      label: 'chart',
      node: {
        type: 'frame',
        name: 'Revenue chart',
        x: 224, y: 264,
        width: 712, height: 236,
        fill: '#f8fafc',
        radius: 12,
        children: [
          text('Revenue', 20, 16, 200, { fontSize: 13, fontWeight: 600, fill: '#0f172a' }),
          ...bars,
        ],
      },
    },
    {
      id: 'dash-table',
      label: 'activity table',
      node: {
        type: 'frame',
        name: 'Recent activity',
        x: 224, y: 516,
        width: 712, height: 108,
        fill: '#ffffff',
        radius: 12,
        stroke: '#e2e8f0',
        strokeWidth: 1,
        children: [
          row(10, 'Customer', 'Plan', 'MRR', false),
          row(38, 'Northwind Labs', 'Enterprise', '$4,900', false),
          row(66, 'Acme Co', 'Pro', '$1,180', false),
        ],
      },
    },
  ];

  return blocks.map((b, i) => ({
    patch: { op: 'add_subtree', shapeId: b.id, shape: b.node, summary: `Built dashboard block: ${b.label}` },
    atMs: i * 2_700,
    label: b.label,
  }));
}

/// design-pack: a hero card styled with pack CSS variables
/// (var(--color-*)) plus a token-swatch row, so swapping the active pack
/// visibly restyles it. NOTE: pack fills/borders are LIVE CSS vars (they
/// restyle instantly on swap), but `radius` is numerically coerced at patch
/// ingest — so radii are static numbers here. The strongest cross-pack
/// deltas: --color-border-strong (shadcn #d4d4d8 → geist #0a0a0a) and the
/// accent hues (#3b82f6 → #0070f3 → #228be6).
function packHeroBlocks(env: PatchEnv): PatchStep[] {
  const { canvasCenter: c } = env;
  const x = Math.round(c.x - 280);
  const y = Math.round(c.y - 190);

  const swatch = (name: string, i: number, fillVar: string, label: string): Node => ({
    type: 'frame',
    name,
    x: i * 124, y: 0,
    width: 112, height: 76,
    fill: fillVar,
    radius: 6,
    stroke: 'var(--color-border-default)',
    strokeWidth: 1,
    children: [text(label, 8, 50, 100, { fontSize: 10, fontWeight: 600, fill: 'var(--color-text-on-accent)', extra: { textTransform: 'uppercase', letterSpacing: 0.8 } })],
  });

  const blocks: Array<{ id: string; label: string; node: Node }> = [
    {
      id: 'pack-hero',
      label: 'card shell',
      node: {
        type: 'frame',
        name: 'Pack hero',
        x, y,
        width: 560, height: 404,
        fill: 'var(--color-bg)',
        radius: 14,
        stroke: 'var(--color-border-default)',
        strokeWidth: 1,
        shadow: { color: 'rgba(15,23,42,0.14)', offsetX: 0, offsetY: 14, blur: 36, spread: -8 },
      },
    },
    {
      id: 'pack-hero-head',
      label: 'headline',
      node: {
        type: 'frame',
        name: 'Headline',
        x: 36, y: 36,
        width: 488, height: 130,
        fill: 'transparent',
        children: [
          text('Ship designs at agent speed', 0, 0, 488, { fontSize: 30, fontWeight: 700, fill: 'var(--color-text-primary)' }),
          text('Every pack swap re-themes the whole canvas — tokens in, tokens out.', 0, 46, 470, { fontSize: 14, fill: 'var(--color-text-secondary)' }),
          text('DESIGN SYSTEMS', 0, 84, 300, { fontSize: 11, fontWeight: 600, fill: 'var(--color-text-muted)', extra: { letterSpacing: 1.2 } }),
        ],
      },
    },
    {
      id: 'pack-hero-cta',
      label: 'CTA row',
      node: {
        type: 'frame',
        name: 'Actions',
        x: 36, y: 200,
        width: 488, height: 60,
        fill: 'transparent',
        children: [
          {
            type: 'frame',
            name: 'Primary button',
            x: 0, y: 0,
            width: 172, height: 44,
            fill: 'var(--color-accent)',
            radius: 8,
            children: [text('Use this pack', 0, 12, 172, { fontSize: 14, fontWeight: 600, fill: 'var(--color-accent-fg)', extra: { textAlign: 'center' } })],
          },
          {
            type: 'frame',
            name: 'Secondary button',
            x: 188, y: 0,
            width: 140, height: 44,
            fill: 'var(--color-bg-muted)',
            stroke: 'var(--color-border-default)',
            strokeWidth: 1,
            radius: 8,
            children: [text('Preview', 0, 12, 140, { fontSize: 14, fontWeight: 600, fill: 'var(--color-text-secondary)', extra: { textAlign: 'center' } })],
          },
        ],
      },
    },
    {
      id: 'pack-hero-swatches',
      label: 'token swatches',
      node: {
        type: 'frame',
        name: 'Token swatches',
        x: 36, y: 276,
        width: 488, height: 76,
        fill: 'transparent',
        children: [
          swatch('Accent', 0, 'var(--color-accent)', 'Accent'),
          swatch('Muted', 1, 'var(--color-bg-muted)', 'Muted'),
          swatch('Border', 2, 'var(--color-border-strong)', 'Border'),
          swatch('Surface', 3, 'var(--color-surface)', 'Surface'),
        ],
      },
    },
    {
      id: 'pack-hero-stats',
      label: 'stat strip',
      node: {
        type: 'frame',
        name: 'Stats',
        x: 36, y: 364,
        width: 488, height: 32,
        fill: 'transparent',
        children: [
          text('28 providers', 0, 8, 140, { fontSize: 13, fontWeight: 700, fill: 'var(--color-text-primary)' }),
          text('60+ typed tools', 170, 8, 160, { fontSize: 13, fontWeight: 700, fill: 'var(--color-text-primary)' }),
          text('5 packs', 360, 8, 100, { fontSize: 13, fontWeight: 700, fill: 'var(--color-text-primary)' }),
        ],
      },
    },
  ];

  return blocks.map((b, i) => ({
    patch: { op: 'add_subtree', shapeId: b.id, shape: b.node, summary: `Built pack hero: ${b.label}` },
    atMs: i * 1_400,
    label: b.label,
  }));
}

/// tooling-tour: quick content drops the tour then manipulates.
function tourShapes(env: PatchEnv): PatchStep[] {
  const c = env.canvasCenter;
  const baseX = Math.round(c.x - 320);
  const baseY = Math.round(c.y - 200);
  const shapes: Array<{ id: string; label: string; shape: Node }> = [
    { id: 'tour-a', label: 'panel A', shape: { type: 'rectangle', name: 'Panel A', x: baseX, y: baseY, width: 240, height: 160, fill: '#e2e8f0', radius: 10 } },
    { id: 'tour-b', label: 'panel B', shape: { type: 'rectangle', name: 'Panel B', x: baseX + 280, y: baseY + 60, width: 200, height: 140, fill: '#bae6fd', radius: 10 } },
    { id: 'tour-c', label: 'note card', shape: { type: 'rectangle', name: 'Note', x: baseX + 90, y: baseY + 220, width: 300, height: 90, fill: '#fef3c7', radius: 10 } },
    { id: 'tour-title', label: 'title', shape: { type: 'text', name: 'Title', x: baseX, y: baseY - 52, width: 420, height: 36, text: 'Q3 planning board', fill: '#0f172a', textColor: '#0f172a', fontSize: 24, fontWeight: 700 } },
    { id: 'tour-tag', label: 'tag', shape: { type: 'ellipse', name: 'Tag', x: baseX + 520, y: baseY + 200, width: 72, height: 72, fill: '#a7f3d0' } },
    // A container (frame) — the only valid HTML5 drop target for the
    // LayersPanel's reparent drag.
    { id: 'tour-board', label: 'board frame', shape: { type: 'frame', name: 'Board', x: baseX + 560, y: baseY - 40, width: 230, height: 170, fill: '#f8fafc', stroke: '#94a3b8', strokeWidth: 1.5, radius: 12 } },
  ];
  return shapes.map((s, i) => ({
    patch: { op: 'add', shapeId: s.id, shape: s.shape, summary: `Added ${s.label}` },
    atMs: i * 420,
    label: s.label,
  }));
}

// ── Registry ─────────────────────────────────────────────────────────────

export const SCENARIOS: Scenario[] = [
  // ── 1. smoke-canvas — pure UI, proves the pipeline end-to-end ──────────
  {
    id: 'smoke-canvas',
    title: 'Toolbar smoke: rectangle + freehand stroke + undo/redo + selection',
    description:
      'Empty canvas → add a rectangle from the floating toolbar → choreographed freehand stroke (path shape streamed over the store surface while the pointer sweeps) → Ctrl+Z / Ctrl+Shift+Z walk the stroke back and replay it → click the rectangle so selection handles render.',
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    theme: 'light',
    cursor: true,
    requireSelectors: ['[data-ac-world]', '[data-node-type="rectangle"]', '[data-node-type="path"]', '[data-chrome-handle]'],
    actions: [
      { type: 'navigate', settleMs: 2_600 },
      { type: 'click', selector: '[aria-label="Add rectangle"]' },
      { type: 'wait', ms: 600 },
      // The toolbar drops at WINDOW center — drag the rectangle into
      // composition (slightly above canvas center).
      { type: 'dragTo', selector: '[data-node-type="rectangle"]', to: { x: 40, y: -60 }, steps: 26 },
      { type: 'wait', ms: 500 },
      { type: 'click', selector: '[aria-label="Select tool"]' },
      { type: 'move', canvas: { x: -220, y: -20 }, durationMs: 650 },
      {
        type: 'stroke',
        from: { x: -300, y: 30 },
        to: { x: -40, y: 130 },
        color: '#0ea5e9',
        strokeWidth: 3.5,
        amplitude: 30,
        strokeMs: 2_000,
        updateEveryMs: 500,
        id: 'smoke-stroke',
      },
      { type: 'wait', ms: 600 },
      // Undo walks the streamed stroke back in visible chunks; redo replays
      // them (one undo entry per streamed chunk + the closing update).
      { type: 'key', chord: 'Control+z' },
      { type: 'key', chord: 'Control+z' },
      { type: 'key', chord: 'Control+z' },
      { type: 'key', chord: 'Control+z' },
      { type: 'wait', ms: 1_000 },
      { type: 'key', chord: 'Control+Shift+z' },
      { type: 'key', chord: 'Control+Shift+z' },
      { type: 'key', chord: 'Control+Shift+z' },
      { type: 'key', chord: 'Control+Shift+z' },
      { type: 'wait', ms: 1_000 },
      // Select the rectangle → selection handles.
      { type: 'click', selector: '[data-node-type="rectangle"]' },
      { type: 'wait', ms: 1_000 },
    ],
  },

  // ── 2. build-reveal — THE money shot ───────────────────────────────────
  {
    id: 'build-reveal',
    title: 'Dashboard assembles block-by-block while a prompt is typed',
    description:
      'Fresh document → prompt typed into the agent composer (NEVER sent — LLM-free) → dashboard blocks (frame, sidebar, header, 3 KPI cards, revenue chart, activity table) stream in as choreographed add_subtree patches through the app store → zoom-to-fit.',
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    theme: 'light',
    cursor: true,
    requireSelectors: ['[data-ac-world]', '[data-node-id="dash-root"]', '[data-node-id="dash-chart"]', '[data-node-id="dash-table"]'],
    actions: [
      { type: 'navigate', settleMs: 2_600 },
      {
        type: 'type',
        text: 'Build a modern analytics dashboard with a dark sidebar, three KPI cards, a revenue chart, and a recent-activity table.',
        cadenceMs: 32,
      },
      { type: 'wait', ms: 400 },
      { type: 'canvasPatches', build: dashboardBlocks },
      { type: 'move', canvas: { x: -420, y: -280 }, durationMs: 700 },
      // Blur the composer so the zoom chord lands (window key handlers bail
      // on editable targets while the textarea holds focus).
      { type: 'eval', script: `(() => { const el = document.activeElement; if (el && el !== document.body && typeof el.blur === 'function') el.blur(); return true; })()`, label: 'blur composer' },
      { type: 'key', chord: 'Shift+1' }, // zoom to fit
      { type: 'wait', ms: 1_400 },
    ],
  },

  // ── 3. tooling-tour — command palette, layers, properties, guides ─────
  {
    id: 'tooling-tour',
    title: 'Command palette, layers panel, properties edits, ruler guide',
    description:
      'Shapes drop fast → ⌘K palette opens, searches and runs "Insert ellipse" → Layers tab selects a row and drag-reorders it → Properties tab resizes and recolors the rectangle → rulers enabled via the app menu, a red guide drags out from the top ruler → a panel drags across the guide.',
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    theme: 'light',
    cursor: true,
    requireSelectors: ['[data-ac-world]', '[data-node-type="rectangle"]', '[data-node-type="ellipse"]'],
    actions: [
      { type: 'navigate', settleMs: 2_600 },
      { type: 'canvasPatches', build: tourShapes, intervalMs: 420 },
      { type: 'wait', ms: 700 },
      // Command palette: open → search → run "Insert ellipse" → close.
      { type: 'key', chord: 'Control+k' },
      { type: 'waitForSelector', selector: '[cmdk-input]' },
      { type: 'type', text: 'ellipse', selector: '[cmdk-input]', cadenceMs: 55, clickFirst: false },
      { type: 'wait', ms: 800 },
      { type: 'key', chord: 'Enter' },
      { type: 'wait', ms: 900 },
      { type: 'key', chord: 'Escape' },
      // Blur whatever the palette returned focus to, so the Alt-tab chords
      // below land (app keydown bails on editable/composite targets).
      { type: 'eval', script: `(() => { const el = document.activeElement; if (el && el !== document.body && typeof el.blur === 'function') el.blur(); return true; })()`, label: 'blur after palette' },
      // Layers tab (Alt+1): select a row, then reparent the Tag row into the
      // Board frame row via the panel's own HTML5 DnD contract (verified).
      { type: 'key', chord: 'Alt+1' },
      { type: 'wait', ms: 600 },
      { type: 'click', selector: '[role="treeitem"]' },
      { type: 'wait', ms: 700 },
      { type: 'layersReparent', fromRowText: 'Tag', toRowText: 'Board' },
      { type: 'wait', ms: 500 },
      // The dnd leaves focus on the treeitem row (a composite widget) —
      // blur it so the Alt-chords below land.
      { type: 'eval', script: `(() => { const el = document.activeElement; if (el && el !== document.body && typeof el.blur === 'function') el.blur(); return true; })()`, label: 'blur after dnd' },
      // Properties tab (Alt+2): resize + recolor the selected rectangle.
      { type: 'key', chord: 'Alt+2' },
      { type: 'click', selector: '[data-node-type="rectangle"]' },
      { type: 'wait', ms: 600 },
      {
        type: 'eval',
        script: `(() => {
          const el = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Width');
          const input = el ? document.getElementById(el.getAttribute('for') ?? '') : null;
          if (!input) throw new Error('Width input not found');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '320');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
        label: 'set width 320',
      },
      { type: 'wait', ms: 700 },
      { type: 'click', selector: 'input[placeholder="#hex"], input[placeholder^="Auto"]' },
      // Select any existing value first — typing at the caret would append
      // and produce an invalid concatenated color.
      { type: 'key', chord: 'Control+a' },
      { type: 'type', text: '#f97316', selector: 'input[placeholder="#hex"], input[placeholder^="Auto"]', cadenceMs: 42, clickFirst: false },
      { type: 'key', chord: 'Escape' },
      // Rulers via the app menu, then drag a red guide out of the top ruler.
      { type: 'click', selector: '[aria-label="Open application menu"]' },
      { type: 'click', text: 'Rulers' },
      { type: 'wait', ms: 600 },
      { type: 'guideDrag', axis: 'horizontal', to: { x: 0, y: -120 }, steps: 26 },
      // Move a panel across the guide (real UI drag).
      { type: 'move', canvas: { x: -320, y: -150 }, durationMs: 650 },
      { type: 'drag', from: { x: -320, y: -150 }, to: { x: -40, y: -40 }, steps: 30 },
      { type: 'wait', ms: 900 },
    ],
  },

  // ── 4. design-pack — pack swap visibly restyles the canvas ─────────────
  {
    id: 'design-pack',
    title: 'Design-system pack swap restyles a token-bound hero card',
    description:
      'shadcn pack seeded before load → a hero card built from var(--color-*) tokens assembles → the Design Systems picker swaps to Vercel Geist (corners square off, palette goes monochrome) → swaps to Mantine (warm accents) → zoom-to-fit.',
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    theme: 'light',
    cursor: true,
    seedLocalStorage: { 'design-systems:active-pack': 'shadcn-default' },
    requireSelectors: ['[data-ac-world]', '[data-node-id="pack-hero"]'],
    actions: [
      { type: 'navigate', settleMs: 3_200 },
      { type: 'canvasPatches', build: packHeroBlocks },
      { type: 'wait', ms: 900 },
      // Open the Design Systems picker through the real UI.
      { type: 'click', selector: '[role="tab"][title="Design Systems"]' },
      { type: 'wait', ms: 500 },
      { type: 'click', text: 'Open Picker' },
      { type: 'waitForSelector', selector: '[role="dialog"]' },
      { type: 'wait', ms: 1_000 },
      { type: 'click', selector: '[role="dialog"] aside button:has-text("Vercel Geist")' },
      { type: 'wait', ms: 900 },
      { type: 'click', selector: '[role="dialog"] button:has-text("Use this pack")' },
      { type: 'wait', ms: 2_000 },
      // Second swap — Mantine (warm accent, visible radius change).
      { type: 'click', selector: '[role="tab"][title="Design Systems"]' },
      { type: 'wait', ms: 500 },
      { type: 'click', text: 'Open Picker' },
      { type: 'waitForSelector', selector: '[role="dialog"]' },
      { type: 'wait', ms: 1_000 },
      { type: 'click', selector: '[role="dialog"] aside button:has-text("Mantine")' },
      { type: 'wait', ms: 900 },
      { type: 'click', selector: '[role="dialog"] button:has-text("Use this pack")' },
      { type: 'wait', ms: 2_000 },
      { type: 'move', canvas: { x: 0, y: -280 }, durationMs: 650 },
      { type: 'key', chord: 'Shift+1' },
      { type: 'wait', ms: 1_300 },
    ],
  },
];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function listScenarios(): void {
  console.log('Available scenarios:\n');
  for (const s of SCENARIOS) {
    console.log(`  ${s.id}`);
    console.log(`    ${s.title}`);
    console.log(`    viewport ${s.viewport?.width ?? 1600}x${s.viewport?.height ?? 1000} @${s.deviceScaleFactor ?? 2}x · theme ${s.theme ?? 'light'} · ${s.actions.length} actions\n`);
  }
}

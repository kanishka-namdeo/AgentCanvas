'use client';

// ScrollCanvas — the "canvas-draws-itself" scrollytelling spine (research
// report §B "Scroll-scrubbed canvas drawing" + §C "concrete interaction
// design"). A 300vh scroll track pins a sticky SVG plane for one viewport of
// travel; the page's scroll progress drives the drawing — strokes draw via
// `stroke-dashoffset`, fills fade in via `fill-opacity`, chart bars grow via
// `scaleY`, text labels fade up, all in lockstep with the wheel.
//
// Why SVG (not a video frame sequence): the research report's primary
// technique calls for "animated SVG `<path>` with `stroke-dashoffset` driven
// by scroll progress via the native Scroll-Driven Animations API with a
// Framer Motion useScroll/useTransform fallback." SVG is sharper, smaller,
// scrubbable (you can scroll backward and the drawing reverses), and needs
// zero pre-rendered asset. The drawing is built from `--ac-*` design tokens so
// it inherits the same palette as the rest of the landing.
//
// Layout (viewBox 1600 × 900, 16:9):
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │  HEADER BAR  (Dashboard label)                                    │  ← step 2
//   ├──────────┬───────────────────────────────────────────────────────┤
//   │          │  STATS                                                │  ← step 3 label
//   │          │  ┌──────┐ ┌──────┐ ┌──────┐                            │  ← steps 4-6
//   │ SIDEBAR  │  │ KPI  │ │ KPI  │ │ KPI  │                            │
//   │          │  └──────┘ └──────┘ └──────┘                            │
//   │          │  ACTIVITY                                             │  ← step 9 label
//   │          │  ┌────────────────────────────────────────────────┐    │  ← step 7
//   │          │  │  ▮ ▮▮ ▮▮▮ ▮ ▮▮ ▮▮▮▮ ▮ ▮▮                       │    │  ← step 8 (bars)
//   │          │  └────────────────────────────────────────────────┘    │
//   └──────────┴───────────────────────────────────────────────────────┘
//
// Mouse parallax: the SVG plane tilts ±3° on Y (cursor X) and ±2° on X
// (cursor Y) toward the cursor, smoothed by useSpring (stiffness 120, damping
// 18 — Framer Motion defaults recommended in the research report §C.1).
// Parallax is OFF under `prefers-reduced-motion` (research report §C.3).
//
// Accessibility (research report §C.4):
// - The `<section>` is `aria-labelledby` an off-screen h2 ("Watch the canvas
//   draw itself") so screen-reader users get a clear landmark.
// - The SVG carries `role="img"` + a stable `aria-label` ("An AgentCanvas
//   dashboard being drawn by an AI agent — header, sidebar, three stat cards,
//   and a chart of activity bars").
// - A separate visually-hidden status div with `aria-live="polite"` updates
//   with the current drawing step ("Drawing the sidebar…", "Filling in
//   colors…", "Complete dashboard design.") so the cause→effect link is
//   announced as the user scrolls.
//
// Under `prefers-reduced-motion` the whole scrub is replaced by the FINAL
// static drawing (research report §C.3: "discrete states" — for a single
// drawing state, that is one image: the completed dashboard). No scroll
// listeners, no parallax, no motion values; the 300vh track collapses to a
// single 100vh section so reduced-motion users don't scroll through empty
// space.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  motion,
  useMotionValueEvent,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
  useReducedMotion,
  type MotionValue,
} from 'motion/react';
import { BlurFade } from '@/components/ui/blur-fade';
import {
  useScrollCanvasKeyboard,
  scrollToNextSection,
} from '@/components/landing/ScrollCanvasInteractions';

/* ─────────────────────────────────────────────────────────────────────────
   Geometry (viewBox 1600 × 900). Coordinates are chosen so the layout
   breathes: 60px outer padding, 40px inner gaps, and stat-card / chart
   widths that divide evenly.
   ──────────────────────────────────────────────────────────────────────── */

const VB_W = 1600;
const VB_H = 900;
const PAD = 60;

const HEADER = { x: PAD, y: PAD, w: VB_W - 2 * PAD, h: 80, rx: 12 } as const;
const SIDEBAR = { x: PAD, y: PAD + 80 + 20, w: 220, h: VB_H - 2 * PAD - 100, rx: 12 } as const;

const MAIN_X = PAD + 220 + 24;
const MAIN_W = VB_W - MAIN_X - PAD;

const STAT_Y = HEADER.y + HEADER.h + 56;
const STAT_W = (MAIN_W - 2 * 24) / 3;
const STAT_H = 150;

const STAT_CARDS = [
  { x: MAIN_X, y: STAT_Y, w: STAT_W, h: STAT_H, fill: 'var(--ac-info-soft)', accent: 'var(--ac-info)' },
  { x: MAIN_X + STAT_W + 24, y: STAT_Y, w: STAT_W, h: STAT_H, fill: 'var(--ac-success-soft)', accent: 'var(--ac-success)' },
  { x: MAIN_X + 2 * (STAT_W + 24), y: STAT_Y, w: STAT_W, h: STAT_H, fill: 'var(--ac-warning-soft)', accent: 'var(--ac-warning)' },
] as const;

const CHART_Y = STAT_Y + STAT_H + 64;
const CHART = { x: MAIN_X, y: CHART_Y, w: MAIN_W, h: VB_H - CHART_Y - PAD, rx: 12 } as const;

// Chart bars: 10 bars, varied heights, fill the chart area's inner box.
const BAR_GAP = 24;
const BAR_INSET = 32;
const BAR_W = (CHART.w - 2 * BAR_INSET - 9 * BAR_GAP) / 10;
const BAR_BASELINE = CHART.y + CHART.h - BAR_INSET;
const BAR_MAX_H = CHART.h - 2 * BAR_INSET;
const BAR_HEIGHTS = [0.42, 0.62, 0.5, 0.78, 0.66, 0.88, 0.72, 0.55, 0.92, 0.68] as const;

// Stable label positions.
const LABEL_HEADER = { x: HEADER.x + 20, y: HEADER.y + HEADER.h / 2 + 8 } as const;
const LABEL_STATS = { x: MAIN_X, y: STAT_Y - 16 } as const;
const LABEL_ACTIVITY = { x: MAIN_X, y: CHART_Y - 16 } as const;

const PROMPT_TEXT = 'Build a dashboard with 3 stat cards';

const STROKE_TOKEN = 'var(--ac-canvas-default-stroke)';
const STROKE_SOFT = 'var(--ac-border-strong)';
const FILL_CANVAS = 'var(--ac-canvas-default-fill)';
const FILL_HEADER = 'var(--ac-accent-soft)';
const FILL_SIDEBAR = 'var(--ac-neutral-soft)';
const FILL_CHART = 'var(--ac-surface-2)';
const TEXT_TOKEN = 'var(--ac-canvas-default-text)';
const ACCENT_TOKEN = 'var(--ac-accent)';
const ACCENT_FG_TOKEN = 'var(--ac-accent-foreground)';
const ACCENT_BORDER_TOKEN = 'var(--ac-accent-border)';

/* ─────────────────────────────────────────────────────────────────────────
   Scroll-progress step ranges. Each step is a [start, end] slice of the
   0→1 scroll progress through the 300vh track. The drawing is sequenced so
   the canvas reads left-to-right, top-to-bottom — the way an agent would
   actually draw it.
   ──────────────────────────────────────────────────────────────────────── */

const STEPS = {
  prompt: [0.0, 0.08],
  headerStroke: [0.08, 0.18],
  sidebarStroke: [0.18, 0.28],
  stat1Stroke: [0.28, 0.36],
  stat2Stroke: [0.36, 0.44],
  stat3Stroke: [0.44, 0.52],
  chartStroke: [0.52, 0.62],
  fills: [0.62, 0.74],
  bars: [0.74, 0.86],
  labels: [0.86, 0.95],
  polish: [0.95, 1.0],
} as const;

// Per-step human descriptions for the aria-live status region. Indices
// correspond to progress thresholds in STATUS_THRESHOLDS.
const STATUS_THRESHOLDS = [
  0.0, 0.04, 0.08, 0.18, 0.28, 0.36, 0.44, 0.52, 0.62, 0.74, 0.86, 0.95,
] as const;
const STATUS_TEXTS = [
  'Empty canvas — waiting for a prompt.',
  'Prompt received: Build a dashboard with 3 stat cards.',
  'Drawing the header rectangle.',
  'Drawing the sidebar.',
  'Drawing the first stat card.',
  'Drawing the second stat card.',
  'Drawing the third stat card.',
  'Drawing the chart area.',
  'Filling in colors.',
  'Drawing the chart bars.',
  'Adding labels: Dashboard, Stats, Activity.',
  'Complete dashboard design.',
] as const;
const STATUS_COMPLETE = STATUS_TEXTS[STATUS_TEXTS.length - 1];

/* ─────────────────────────────────────────────────────────────────────────
   Drawing primitives. Each is a small client component so its `useTransform`
   hooks sit at the top level (hooks rules) and each shape owns its own
   perimeter / fill timings derived from `progress`.
   ──────────────────────────────────────────────────────────────────────── */

interface RectGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  rx?: number;
}

interface ShapeProps extends RectGeom {
  /** Page-scroll progress 0→1 through the track. */
  progress: MotionValue<number>;
  /** Range over which the stroke draws (stroke-dashoffset perimeter → 0). */
  strokeRange: readonly [number, number];
  /** Range over which the fill fades in (fill-opacity 0 → 1). */
  fillRange: readonly [number, number];
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

/** A single rect that strokes itself on `strokeRange` then fills itself on
 * `fillRange`. The stroke draws via `stroke-dasharray` = perimeter + a
 * `stroke-dashoffset` MotionValue animating from perimeter → 0 (CSS
 * "draw-on" technique). The fill is on the SAME rect via `fill-opacity` so
 * SVG paint order keeps the stroke on top of the fill once it appears. */
function DashboardShape({
  progress,
  strokeRange,
  fillRange,
  x,
  y,
  w,
  h,
  rx = 0,
  fill,
  stroke = STROKE_TOKEN,
  strokeWidth = 2.5,
}: ShapeProps) {
  const perimeter = 2 * (w + h);
  const dashOffset = useTransform(progress, [...strokeRange], [perimeter, 0]);
  const fillOpacity = useTransform(progress, [...fillRange], [0, 1]);
  return (
    <motion.rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={rx}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      strokeDasharray={perimeter}
      style={{
        strokeDashoffset: dashOffset,
        fillOpacity,
      }}
    />
  );
}

interface ChartBarProps {
  progress: MotionValue<number>;
  range: readonly [number, number];
  index: number;
}

/** A single chart bar. Grows from the baseline upward via `scaleY` 0→1, with
 * `transform-box: fill-box` + `transform-origin: 50% 100%` so the bar's
 * bottom stays anchored to the chart baseline (no jump on first paint). */
function ChartBar({ progress, range, index }: ChartBarProps) {
  const x = CHART.x + BAR_INSET + index * (BAR_W + BAR_GAP);
  const h = BAR_MAX_H * BAR_HEIGHTS[index];
  const y = BAR_BASELINE - h;
  const scaleY = useTransform(progress, [...range], [0, 1]);
  // Bars use the brand accent for the first half, then a chart token so the
  // tallest bars pop without leaving the palette.
  const fill = index % 2 === 0 ? ACCENT_TOKEN : 'var(--chart-2)';
  return (
    <motion.rect
      x={x}
      y={y}
      width={BAR_W}
      height={h}
      rx={6}
      fill={fill}
      style={{
        scaleY,
        transformBox: 'fill-box' as CSSProperties['transformBox'],
        transformOrigin: '50% 100%',
      }}
    />
  );
}

interface LabelProps {
  progress: MotionValue<number>;
  range: readonly [number, number];
  x: number;
  y: number;
  children: ReactNode;
  fontSize?: number;
  fontWeight?: number;
  fill?: string;
  fontFamily?: 'sans' | 'mono';
}

/** A text label that fades + slides up into place over `range`. */
function TextLabel({
  progress,
  range,
  x,
  y,
  children,
  fontSize = 26,
  fontWeight = 600,
  fill = TEXT_TOKEN,
  fontFamily = 'sans',
}: LabelProps) {
  const opacity = useTransform(progress, [...range], [0, 1]);
  const yOff = useTransform(progress, [...range], [12, 0]);
  const family = fontFamily === 'mono' ? 'var(--font-geist-mono), monospace' : 'var(--font-inter), ui-sans-serif, system-ui, sans-serif';
  return (
    <motion.g style={{ opacity, y: yOff }}>
      <text
        x={x}
        y={y}
        fill={fill}
        fontSize={fontSize}
        fontWeight={fontWeight}
        fontFamily={family}
        dominantBaseline="alphabetic"
      >
        {children}
      </text>
    </motion.g>
  );
}

/** A faint stat-card KPI detail line (label + value) — appears with the
 * stat card's fill so the cards read as data, not just boxes. */
function StatCardDetail({
  progress,
  range,
  cardIndex,
  label,
  value,
  accent,
}: {
  progress: MotionValue<number>;
  range: readonly [number, number];
  cardIndex: number;
  label: string;
  value: string;
  accent: string;
}) {
  const card = STAT_CARDS[cardIndex];
  const opacity = useTransform(progress, [...range], [0, 1]);
  const yOff = useTransform(progress, [...range], [8, 0]);
  return (
    <motion.g style={{ opacity, y: yOff }}>
      <rect
        x={card.x + 18}
        y={card.y + 18}
        width={36}
        height={36}
        rx={8}
        fill={accent}
        opacity={0.85}
      />
      <text
        x={card.x + 18}
        y={card.y + 86}
        fill="var(--ac-text-tertiary)"
        fontSize={15}
        fontFamily="var(--font-geist-mono), monospace"
      >
        {label}
      </text>
      <text
        x={card.x + 18}
        y={card.y + 122}
        fill={TEXT_TOKEN}
        fontSize={32}
        fontWeight={700}
        fontFamily="var(--font-inter), ui-sans-serif, system-ui, sans-serif"
      >
        {value}
      </text>
    </motion.g>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   The SVG drawing itself — built up from the primitives above. Used by both
   the animated path (driven by `progress`) and the reduced-motion path
   (driven by a constant `1` MotionValue so every shape renders at its
   completed state).
   ──────────────────────────────────────────────────────────────────────── */

function DashboardDrawing({ progress }: { progress: MotionValue<number> }) {
  const fills = STEPS.fills;

  // Chart bars: stagger the start across the bars step so they grow in a
  // wave from left to right.
  const barStart = STEPS.bars[0];
  const barSpan = STEPS.bars[1] - STEPS.bars[0];
  const barStagger = barSpan * 0.06; // each bar trails the previous by 6% of the step
  const barDuration = barSpan * 0.5;

  return (
    <g>
      {/* Header bar — stroke first, fill during the fills step. */}
      <DashboardShape
        progress={progress}
        strokeRange={STEPS.headerStroke}
        fillRange={fills}
        x={HEADER.x}
        y={HEADER.y}
        w={HEADER.w}
        h={HEADER.h}
        rx={HEADER.rx}
        fill={FILL_HEADER}
      />
      {/* Sidebar */}
      <DashboardShape
        progress={progress}
        strokeRange={STEPS.sidebarStroke}
        fillRange={fills}
        x={SIDEBAR.x}
        y={SIDEBAR.y}
        w={SIDEBAR.w}
        h={SIDEBAR.h}
        rx={SIDEBAR.rx}
        fill={FILL_SIDEBAR}
      />
      {/* Three stat cards (sequential strokes, shared fill step) */}
      <DashboardShape
        progress={progress}
        strokeRange={STEPS.stat1Stroke}
        fillRange={fills}
        x={STAT_CARDS[0].x}
        y={STAT_CARDS[0].y}
        w={STAT_CARDS[0].w}
        h={STAT_CARDS[0].h}
        rx={12}
        fill={STAT_CARDS[0].fill}
      />
      <DashboardShape
        progress={progress}
        strokeRange={STEPS.stat2Stroke}
        fillRange={fills}
        x={STAT_CARDS[1].x}
        y={STAT_CARDS[1].y}
        w={STAT_CARDS[1].w}
        h={STAT_CARDS[1].h}
        rx={12}
        fill={STAT_CARDS[1].fill}
      />
      <DashboardShape
        progress={progress}
        strokeRange={STEPS.stat3Stroke}
        fillRange={fills}
        x={STAT_CARDS[2].x}
        y={STAT_CARDS[2].y}
        w={STAT_CARDS[2].w}
        h={STAT_CARDS[2].h}
        rx={12}
        fill={STAT_CARDS[2].fill}
      />
      {/* Chart area */}
      <DashboardShape
        progress={progress}
        strokeRange={STEPS.chartStroke}
        fillRange={fills}
        x={CHART.x}
        y={CHART.y}
        w={CHART.w}
        h={CHART.h}
        rx={CHART.rx}
        fill={FILL_CHART}
      />

      {/* Chart bars — staggered wave inside the chart area */}
      {BAR_HEIGHTS.map((_, i) => {
        const start = barStart + i * barStagger;
        const range: readonly [number, number] = [start, start + barDuration];
        return <ChartBar key={i} progress={progress} range={range} index={i} />;
      })}

      {/* Sidebar nav placeholder lines (drawn with the sidebar stroke) */}
      <SidebarNavLines progress={progress} range={STEPS.sidebarStroke} />

      {/* KPI details inside stat cards — fade in during the fills step */}
      <StatCardDetail
        progress={progress}
        range={fills}
        cardIndex={0}
        label="Active sessions"
        value="1,284"
        accent={STAT_CARDS[0].accent}
      />
      <StatCardDetail
        progress={progress}
        range={fills}
        cardIndex={1}
        label="Approvals / hr"
        value="92%"
        accent={STAT_CARDS[1].accent}
      />
      <StatCardDetail
        progress={progress}
        range={fills}
        cardIndex={2}
        label="Avg. turn"
        value="3.2s"
        accent={STAT_CARDS[2].accent}
      />

      {/* Labels: Dashboard (header), Stats (above cards), Activity (above chart) */}
      <TextLabel
        progress={progress}
        range={STEPS.labels}
        x={LABEL_HEADER.x}
        y={LABEL_HEADER.y}
        fontSize={28}
        fontWeight={700}
        fill={TEXT_TOKEN}
      >
        Dashboard
      </TextLabel>
      <TextLabel
        progress={progress}
        range={STEPS.labels}
        x={LABEL_STATS.x}
        y={LABEL_STATS.y}
        fontSize={18}
        fontWeight={600}
        fill="var(--ac-text-secondary)"
        fontFamily="mono"
      >
        STATS
      </TextLabel>
      <TextLabel
        progress={progress}
        range={STEPS.labels}
        x={LABEL_ACTIVITY.x}
        y={LABEL_ACTIVITY.y}
        fontSize={18}
        fontWeight={600}
        fill="var(--ac-text-secondary)"
        fontFamily="mono"
      >
        ACTIVITY
      </TextLabel>
    </g>
  );
}

/** Sidebar nav placeholder lines — small dashes that draw with the sidebar's
 * stroke range so the sidebar reads as a navigation column, not an empty box.
 * Each line uses a tiny stroke-dasharray so its own draw is short and reads
 * as "the agent fills in the nav" rather than a separate step. */
function SidebarNavLines({
  progress,
  range,
}: {
  progress: MotionValue<number>;
  range: readonly [number, number];
}) {
  const items = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => ({
        y: SIDEBAR.y + 36 + i * 56,
        w: i === 0 ? 168 : 140 - i * 8,
      })),
    [],
  );
  return (
    <g aria-hidden="true">
      {items.map((line, i) => (
        <SidebarNavLine
          key={i}
          progress={progress}
          range={range}
          x={SIDEBAR.x + 26}
          y={line.y}
          w={line.w}
          delay={i * 0.012}
        />
      ))}
    </g>
  );
}

function SidebarNavLine({
  progress,
  range,
  x,
  y,
  w,
  delay,
}: {
  progress: MotionValue<number>;
  range: readonly [number, number];
  x: number;
  y: number;
  w: number;
  delay: number;
}) {
  const offset = useTransform(
    progress,
    [range[0] + delay, range[1] + delay > range[1] ? range[1] : range[0] + delay + (range[1] - range[0]) * 0.4],
    [w, 0],
  );
  return (
    <motion.line
      x1={x}
      y1={y}
      x2={x + w}
      y2={y}
      stroke={STROKE_SOFT}
      strokeWidth={10}
      strokeLinecap="round"
      strokeDasharray={w}
      style={{ strokeDashoffset: offset }}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   The prompt chip — an HTML overlay above the SVG plane. Rendered inside
   the sticky container so it pins with the canvas. Fades + slides in during
   the prompt step (0 → 0.08), then stays put.
   ──────────────────────────────────────────────────────────────────────── */

function PromptChip({
  progress,
  reduced,
  promptText,
}: {
  progress: MotionValue<number>;
  reduced: boolean;
  promptText: string;
}) {
  const opacity = useTransform(progress, [...STEPS.prompt], [0, 1]);
  const y = useTransform(progress, [...STEPS.prompt], [-16, 0]);
  // Hover-expand: the chip is `pointer-events-auto` so :hover fires; the
  // prompt-text span is truncated by default (max-width on the chip clamps
  // it) and expands on hover via a CSS transition on `max-width`. Purely
  // CSS — no JS state. The `group` class lets us target the text span's
  // `whitespace-normal` reset from the parent's `:hover` state.
  return (
    <motion.div
      data-testid="scroll-canvas-prompt"
      style={reduced ? undefined : { opacity, y }}
      className="ac-prompt-chip group pointer-events-auto relative mb-6 inline-flex max-w-[220px] items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 backdrop-blur-sm transition-[max-width] duration-300 ease-out hover:max-w-[640px]"
    >
      <span
        aria-hidden="true"
        className="ac-brand-gradient ac-cta-gradient rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white [font-family:var(--font-geist-mono),monospace]"
      >
        prompt
      </span>
      <span
        className="truncate text-sm text-white/90 [font-family:var(--font-geist-mono),monospace] group-hover:whitespace-normal"
        title={promptText}
      >
        {promptText}
      </span>
    </motion.div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Main component
   ──────────────────────────────────────────────────────────────────────── */

const SECTION_HEADING_ID = 'scroll-canvas-heading';
const SVG_ARIA_LABEL =
  'An AgentCanvas dashboard being drawn by an AI agent — a header bar, a sidebar with navigation lines, three stat cards showing KPIs, and a chart of activity bars. The drawing completes as you scroll.';

// The h2 is the section's accessible name (via aria-labelledby). It also
// doubles as the keyboard-shortcuts description (landing-interactions task:
// "Section has aria-label or aria-labelledby describing keyboard shortcuts").
// Kept brief so it reads cleanly for AT users; the visible UI hints below
// carry the same info for sighted keyboard users.
const SECTION_HEADING_TEXT =
  'Watch the canvas draw itself. Keyboard shortcuts: Space plays or pauses autoplay, Enter or right arrow advances one step, left arrow reverses, up or down arrows cycle example prompts, Escape resets the canvas to its start.';

/**
 * The sticky canvas-draws-itself spine. Pins an SVG plane for one viewport
 * of travel while a 300vh track underneath drives the drawing progress. Under
 * `prefers-reduced-motion`, the track collapses to a single viewport and the
 * final completed drawing is rendered statically.
 */
export function ScrollCanvas() {
  const shouldReduceMotion = useReducedMotion();
  const reduced = Boolean(shouldReduceMotion);

  // Keyboard + mouse interaction layer (landing-interactions task). Owns the
  // section ref (so the section is keyboard-focusable), the autoplay RAF loop,
  // the current draw step (drives the bottom-left indicator), and the example
  // prompt cycle (drives the chip text above the SVG plane).
  const keyboard = useScrollCanvasKeyboard();
  const currentPrompt = keyboard.examplePrompts[keyboard.currentExampleIndex];

  const trackRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);

  // Scroll progress through the 300vh track (0 when the track's top hits the
  // viewport top, 1 when its bottom hits the viewport bottom). `useScroll`
  // reads from the document scroll source by default — Lenis's inertial
  // scroll updates window.scrollY (it does NOT replace the native scroll
  // position), so Framer Motion's useScroll sees the same values Lenis does
  // and there is no conflict. (SmoothScroll.tsx documents this contract.)
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ['start start', 'end end'],
  });

  // Reduced-motion: drive the drawing with a constant 1 so the completed
  // state renders without depending on scroll listeners. `useMotionValue`
  // returns a stable MotionValue (motion's own useRef-backed factory) so the
  // identity persists across renders — no manual ref-guarding needed.
  const fullProgress = useMotionValue(1);
  const progress = reduced ? fullProgress : scrollYProgress;

  // aria-live status — announce the current drawing step to screen readers.
  // Initial state is the completed drawing under reduced motion (no scrub will
  // ever fire the `change` event to update it), otherwise the empty-canvas
  // prompt. `useMotionValueEvent` updates the state as the scroll progresses.
  const [statusText, setStatusText] = useState<string>(
    reduced ? STATUS_COMPLETE : STATUS_TEXTS[0],
  );
  useMotionValueEvent(progress, 'change', (p) => {
    if (reduced) {
      if (statusText !== STATUS_COMPLETE) setStatusText(STATUS_COMPLETE);
      return;
    }
    let idx = 0;
    for (let i = 0; i < STATUS_THRESHOLDS.length; i += 1) {
      if (p >= STATUS_THRESHOLDS[i]) idx = i;
    }
    const next = STATUS_TEXTS[idx];
    if (next !== statusText) setStatusText(next);
  });

  // Mouse parallax — cursor X drives rotateY (±3°), cursor Y drives rotateX
  // (±2°), both spring-smoothed. OFF under reduced motion.
  const mouseX = useRef(0);
  const mouseY = useRef(0);
  const rotateYMV = useMotionValue(0);
  const rotateXMV = useMotionValue(0);
  const rotateY = useSpring(rotateYMV, { stiffness: 120, damping: 18 });
  const rotateX = useSpring(rotateXMV, { stiffness: 120, damping: 18 });

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (reduced) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      mouseX.current = x;
      mouseY.current = y;
      rotateYMV.set(x * 6); // ±3° at the extremes
      rotateXMV.set(-y * 4); // ±2° at the extremes
    },
    [reduced, rotateYMV, rotateXMV],
  );

  const handlePointerLeave = useCallback(() => {
    if (reduced) return;
    rotateYMV.set(0);
    rotateXMV.set(0);
  }, [reduced, rotateYMV, rotateXMV]);

  // When the section is about to leave the viewport, drop any active parallax
  // so a returning visit doesn't inherit a stale tilt.
  useEffect(() => {
    if (reduced) return;
    const onScroll = () => {
      const el = planeRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const onScreen = rect.bottom > 0 && rect.top < window.innerHeight;
      if (!onScreen) {
        rotateYMV.set(0);
        rotateXMV.set(0);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [reduced, rotateYMV, rotateXMV]);

  // When the user clicks the "Scroll to explore ↓" hint, smoothly scroll to
  // the next section (mirrors the section's own click-to-scroll behavior —
  // both use the shared `scrollToNextSection` helper so there is one owner
  // for the next-sibling lookup). The hint is a real <button> so keyboard
  // users get it via Tab + Enter.
  const handleHintClick = useCallback(() => {
    const section = keyboard.sectionRef.current;
    if (section) scrollToNextSection(section, reduced);
  }, [keyboard.sectionRef, reduced]);

  return (
    <section
      ref={keyboard.sectionRef}
      aria-labelledby={SECTION_HEADING_ID}
      data-testid="section-scroll-canvas"
      tabIndex={0}
      // `ac-focus-ring` paints a 2px accent outline on :focus-visible so
      // keyboard users see where focus landed. `cursor-pointer` hints at the
      // click-to-scroll affordance (the hook attaches a click listener
      // internally that scrolls to the next section).
      className="ac-focus-ring relative cursor-pointer scroll-mt-20 outline-none"
    >
      {/* Off-screen heading — describes the section for screen readers; the
          visual heading is the BlurFade sub-section title below the canvas.
          The h2 also doubles as the keyboard-shortcuts description (see
          SECTION_HEADING_TEXT above). */}
      <h2 id={SECTION_HEADING_ID} className="sr-only">
        {SECTION_HEADING_TEXT}
      </h2>

      {/* Section title + caption — a small intro above the sticky plane so
          the visual hierarchy still reads at a glance. */}
      <div className="mx-auto max-w-6xl px-6 pt-24">
        <BlurFade inView>
          <p className="text-sm font-medium uppercase tracking-widest text-white/50 [font-family:var(--font-geist-mono),monospace]">
            Scrollytelling
          </p>
          <h3 className="mt-2 text-balance text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Design that draws itself.
          </h3>
          <p className="mt-3 max-w-2xl text-white/60">
            Scroll on — every stroke of this dashboard appears in lockstep with the wheel, the way
            the agent draws it. By the time you reach the end, the design is complete.
          </p>
        </BlurFade>
      </div>

      {/* The scroll track: 300vh tall so useScroll has real range. Reduced
          motion collapses this to one viewport so users don't scroll through
          empty space to reach the next section. The `scroll-canvas-track`
          testid is the hook's anchor — `useScrollCanvasKeyboard` finds this
          element via querySelector and reads its bounding rect to compute
          the current step + the autoplay scroll delta per frame. */}
      <div
        ref={trackRef}
        data-testid="scroll-canvas-track"
        className={reduced ? 'relative' : 'relative md:h-[300vh]'}
      >
        <div
          className={
            reduced
              ? 'relative flex flex-col items-center justify-center px-6 py-16'
              : 'sticky top-0 flex h-screen flex-col items-center justify-center px-6 py-16'
          }
        >
          {/* Prompt chip overlay (HTML) — fades in first, sits above the SVG plane.
              The chip text reflects the current example prompt from the keyboard
              hook (↑ / ↓ cycle through EXAMPLE_PROMPTS). */}
          <PromptChip progress={progress} reduced={reduced} promptText={currentPrompt} />

          {/* The SVG plane — wrapped in a motion.div that carries the mouse
              parallax tilt. Under reduced motion the tilt is identity. */}
          <motion.div
            ref={planeRef}
            data-testid="scroll-canvas-plane"
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            className="relative w-full max-w-5xl"
            style={
              reduced
                ? undefined
                : {
                    rotateX,
                    rotateY,
                    transformPerspective: 1200,
                  }
            }
          >
            {/* Light-chrome browser frame around the SVG (matches the rest
                of the landing's screenshots — light surface on dark page). */}
            <div className="overflow-hidden rounded-xl border border-white/10 bg-white shadow-2xl">
              <div
                aria-hidden="true"
                className="flex items-center gap-1.5 bg-[#e2e8f0] px-3 py-2"
              >
                <span className="h-2.5 w-2.5 rounded-full bg-[#f87171]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#fbbf24]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]" />
                <span className="ml-2 h-4 flex-1 rounded bg-white/70" />
              </div>
              <div className="relative w-full overflow-hidden bg-white [aspect-ratio:16/9]">
                <svg
                  viewBox={`0 0 ${VB_W} ${VB_H}`}
                  role="img"
                  aria-label={SVG_ARIA_LABEL}
                  className="block h-full w-full"
                  preserveAspectRatio="xMidYMid meet"
                >
                  {/* Subtle canvas dot-grid background — drawn into the SVG
                      so it scales with the drawing. */}
                  <defs>
                    <pattern
                      id="scroll-canvas-grid"
                      x={0}
                      y={0}
                      width={40}
                      height={40}
                      patternUnits="userSpaceOnUse"
                    >
                      <circle cx={1} cy={1} r={1} fill="var(--ac-canvas-grid)" />
                    </pattern>
                  </defs>
                  <rect x={0} y={0} width={VB_W} height={VB_H} fill="url(#scroll-canvas-grid)" />
                  <rect
                    x={0}
                    y={0}
                    width={VB_W}
                    height={VB_H}
                    fill="var(--ac-canvas-bg)"
                    opacity={0.4}
                  />

                  {/* The drawing itself. */}
                  <DashboardDrawing progress={progress} />
                </svg>
              </div>
            </div>
          </motion.div>

          {/* Interaction overlay footer — pinned to the bottom of the sticky
              plane. Three slots:
              - bottom-left: the step indicator (currentStep / totalSteps from
                the keyboard hook, so it stays in sync with keyboard-driven
                steps and the autoplay RAF loop).
              - bottom-center: the "Scroll to explore ↓" hint (a real button so
                keyboard users get it via Tab + Enter; mirrors the section's
                click-to-scroll behavior).
              - bottom-right: the autoplay indicator (only visible while the
                keyboard hook's RAF loop is running).
              `pointer-events-none` on the footer wrapper lets clicks fall
              through to the section's click-to-scroll handler — the hint
              button re-enables pointer events on itself. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex items-center justify-between px-6 md:px-10">
            <StepIndicator
              currentStep={keyboard.currentStep}
              totalSteps={keyboard.totalSteps}
            />
            <ScrollHint onClick={handleHintClick} reduced={reduced} />
            <AutoplayIndicator isPlaying={keyboard.isPlaying} />
          </div>
        </div>
      </div>

      {/* aria-live status — visually hidden, polite so screen readers
          announce state changes as the user scrolls. */}
      <div aria-live="polite" className="sr-only" data-testid="scroll-canvas-status">
        {statusText}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Interaction UI — indicators + scroll hint. These read state from the
   `useScrollCanvasKeyboard` hook (no internal motion values) so they stay
   in sync with the keyboard handlers + autoplay RAF loop.
   ──────────────────────────────────────────────────────────────────────── */

/** Bottom-left mono step indicator. Shows "Step NN / 11" — aria-hidden
 *  because the same info is already announced via the aria-live status
 *  region. */
function StepIndicator({
  currentStep,
  totalSteps,
}: {
  currentStep: number;
  totalSteps: number;
}) {
  return (
    <p
      aria-hidden="true"
      data-testid="scroll-canvas-step"
      className="text-xs text-white/40 [font-family:var(--font-geist-mono),monospace]"
    >
      Step {String(currentStep).padStart(2, '0')} /{' '}
      {String(totalSteps).padStart(2, '0')}
    </p>
  );
}

/** Bottom-right autoplay indicator. Only renders when `isPlaying` is true —
 *  the keyboard hook flips this when Space starts the RAF loop. */
function AutoplayIndicator({ isPlaying }: { isPlaying: boolean }) {
  if (!isPlaying) return null;
  return (
    <div
      data-testid="scroll-canvas-autoplay"
      className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-white/80 backdrop-blur-sm [font-family:var(--font-geist-mono),monospace]"
      aria-label="Autoplay playing"
    >
      <span aria-hidden="true" className="text-white/90">
        ▶
      </span>
      Playing
    </div>
  );
}

/** Bottom-center "Scroll to explore ↓" hint. A real <button> so keyboard users
 *  get it via Tab + Enter; clicking it calls the shared
 *  `scrollToNextSection` helper (the section's own click handler does the
 *  same). Hidden under reduced motion because the canvas is already at its
 *  final state — there's no scrub to invite. */
function ScrollHint({
  onClick,
  reduced,
}: {
  onClick: () => void;
  reduced: boolean;
}) {
  if (reduced) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="scroll-canvas-hint"
      className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60 transition-colors hover:border-white/20 hover:text-white/90 [font-family:var(--font-geist-mono),monospace]"
    >
      <span aria-hidden="true">Scroll to explore</span>
      <span aria-hidden="true">↓</span>
    </button>
  );
}

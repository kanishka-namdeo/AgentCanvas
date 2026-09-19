// record.ts — browser launch + video/frames pipeline for the landing video
// capture harness.
//
// Modeled on scripts/screenshot-landing.ts (scripts/AGENTS.md Playwright
// rules): playwright-core ships WITHOUT browsers, so we try the default
// registry first, then system Chrome, then system Edge.
//
// Video mode: Playwright context recordVideo (webm) → ffmpeg transcode to
// H.264 MP4 (yuv420p, CRF 18, 30fps, +faststart, even dimensions, 1-frame
// fade-in/out) + poster PNG (late frame). ffmpeg/ffprobe must be on PATH —
// verified at startup by capture.ts (verifyFfmpeg()).
//
// Frames mode: fixed-timestep PNG screenshots (default 10fps) into frames/
// for QA scrubbing. `scale: 'css'` keeps frame dimensions == viewport.
//
// Outputs live under download/ (scripts/AGENTS.md rule).

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface LaunchResult {
  browser: Browser;
  channel: string | null;
}

/// Launch headless Chromium: default registry → system Chrome → system Edge.
export async function launchBrowser(): Promise<LaunchResult> {
  try {
    return { browser: await chromium.launch({ headless: true }), channel: null };
  } catch {
    try {
      return { browser: await chromium.launch({ headless: true, channel: 'chrome' }), channel: 'chrome' };
    } catch {
      return { browser: await chromium.launch({ headless: true, channel: 'msedge' }), channel: 'msedge' };
    }
  }
}

/// Assert ffmpeg + ffprobe exist. Called once at startup so the user gets a
/// clear error instead of a mid-take spawn ENOENT.
export function verifyFfmpeg(): void {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const probe = spawnSync(bin, ['-version'], { encoding: 'utf8', shell: false });
    if (probe.error || probe.status !== 0) {
      throw new Error(
        `${bin} is not available on PATH (spawn ${probe.error ? probe.error.message : `exit ${probe.status}`}). ` +
          `The video pipeline requires system ffmpeg (8.x verified). Install ffmpeg or add it to PATH and re-run.`,
      );
    }
  }
}

/// ffprobe duration (seconds) of a media file. Rejects with stderr text.
export function probeDurationSeconds(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const dur = parseFloat(out.trim());
      if (code === 0 && Number.isFinite(dur) && dur > 0) resolve(dur);
      else reject(new Error(`ffprobe failed on ${file} (exit ${code}): ${err.trim() || out.trim()}`));
    });
  });
}

function runFfmpeg(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${label} failed (exit ${code}): ${err.trim().split('\n').slice(-6).join('\n')}`));
    });
  });
}

export interface TranscodeResult {
  mp4Path: string;
  posterPath: string | null;
  durationS: number;
  dimensions: { width: number; height: number };
  bytes: number;
}

/// Transcode a Playwright webm into a landing-grade H.264 MP4 + poster PNG.
///  - libx264 / yuv420p / CRF 18 / 30fps / +faststart
///  - even dimensions (yuv420p requirement) via truncating scale
///  - fade-in + fade-out (0.4s each) — the "1-frame fade" polish pass
///  - poster = frame at ~90% of the duration (late = fully-assembled state)
export async function transcodeToMp4(
  webmPath: string,
  outDir: string,
  opts: { mp4Name?: string; posterName?: string; fadeDur?: number } = {},
): Promise<TranscodeResult> {
  const mp4Path = path.join(outDir, opts.mp4Name ?? 'video.mp4');
  const posterPath = path.join(outDir, opts.posterName ?? 'poster.png');
  const duration = await probeDurationSeconds(webmPath);
  const fade = opts.fadeDur ?? 0.4;
  const fadeOutStart = Math.max(0, duration - fade);

  // Even-dimension scale + fades in one filter graph. scale keeps dims for
  // already-even inputs (1600x1000), only clamping odd leftovers.
  const vf = [
    `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    `fade=t=in:st=0:d=${fade}`,
    `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fade}`,
  ].join(',');

  await runFfmpeg(
    [
      '-y',
      '-i', webmPath,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-r', '30',
      '-pix_fmt', 'yuv420p',
      '-vf', vf,
      '-movflags', '+faststart',
      '-an',
      mp4Path,
    ],
    'transcode',
  );

  // Poster from the transcoded MP4 (same colors as the deliverable).
  let poster: string | null = null;
  try {
    const at = Math.max(0, duration * 0.9).toFixed(3);
    await runFfmpeg(
      ['-y', '-ss', at, '-i', mp4Path, '-frames:v', '1', posterPath],
      'poster',
    );
    poster = posterPath;
  } catch {
    // Poster is best-effort; the MP4 is the deliverable.
  }

  // Dimensions after the even-clamp scale.
  const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      mp4Path,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const m = out.trim().match(/^(\d+)x(\d+)$/);
      if (code === 0 && m) resolve({ width: parseInt(m[1], 10), height: parseInt(m[2], 10) });
      else reject(new Error(`ffprobe dims failed on ${mp4Path}`));
    });
  });

  return {
    mp4Path,
    posterPath: poster,
    durationS: duration,
    dimensions: dims,
    bytes: fs.existsSync(mp4Path) ? fs.statSync(mp4Path).size : 0,
  };
}

export interface FrameLoopHandle {
  stop: () => Promise<number>;
}

/// Fixed-timestep screenshot loop for frames mode. Captures PNGs into
/// `framesDir` every `intervalMs` until stopped; always captures one final
/// frame. Returns the frame count.
export function startFrameLoop(
  page: Page,
  framesDir: string,
  fps: number,
  onFrameError: (err: unknown) => void,
): FrameLoopHandle {
  fs.mkdirSync(framesDir, { recursive: true });
  const intervalMs = Math.max(40, Math.round(1000 / fps));
  let index = 0;
  let running = true;
  let chain: Promise<void> = Promise.resolve();

  const capture = async () => {
    if (!running) return;
    index += 1;
    const name = `frame-${String(index).padStart(5, '0')}.png`;
    try {
      // scale:'css' → frame dims == viewport (deviceScaleFactor ignored),
      // keeping the scrub corpus small.
      await page.screenshot({ path: path.join(framesDir, name), scale: 'css' as never });
    } catch (err) {
      onFrameError(err);
    }
  };

  const tick = () => {
    if (!running) return;
    chain = chain.then(capture).catch(() => {});
  };
  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    stop: async () => {
      running = false;
      clearInterval(timer);
      await chain.catch(() => {});
      await capture();
      return index;
    },
  };
}

export type { BrowserContext, Page };

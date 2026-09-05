// render-worker.mjs — isolated resvg rasterizer worker.
//
// WHY THIS EXISTS (2026-09-05): @resvg/resvg-js is a NATIVE Rust module, and
// a panic inside it (observed live: resvg geom.rs:27 `Option::unwrap()` on
// None → "fatal runtime error: failed to initiate panic") ABORTS the entire
// Node process — the dev server died mid-turn while the VLM design critic
// rendered a server-side screenshot. A JS try/catch cannot intercept a
// native abort. Running the rasterization in a CHILD process contains the
// blast radius: a panic kills only this worker, the parent reads the
// non-zero exit code, throws a normal Error, and the caller degrades
// gracefully (VLM critic falls back, pen_get_screenshot returns an
// actionable error) — the server keeps serving.
//
// Protocol: stdin receives one JSON line { svg, width, height } —
// stdout replies one JSON line { ok: true, png: <base64> } or
// { ok: false, error: <message> }.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const RENDER_TIMEOUT_MS = 30_000;

async function main() {
  const chunks = [];
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { svg, width, height } = JSON.parse(chunks.join(''));

  const { Resvg } = require('@resvg/resvg-js');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * 2 },
    background: '#ffffff',
    font: {
      fontFiles: [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/chinese/NotoSansSC-Regular.ttf',
      ],
      loadSystemFonts: true,
      defaultFontFamily: 'DejaVu Sans',
    },
  });
  const rendered = resvg.render();
  const png = rendered.asPng();
  if (!png || png.length === 0) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'resvg produced an empty PNG' }));
    return;
  }
  process.stdout.write(JSON.stringify({ ok: true, png: png.toString('base64') }));
}

main().catch((err) => {
  try {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err).slice(0, 300) }));
  } catch {
    // stdout itself failed — exit non-zero so the parent treats it as a crash.
    process.exit(1);
  }
});

// Watchdog: a wedged native render (infinite loop inside Rust) must not hold
// the worker forever — the parent also enforces its own timeout, this is the
// worker-side backstop.
setTimeout(() => {
  try {
    process.stdout.write(JSON.stringify({ ok: false, error: 'resvg render timed out' }));
  } catch { /* parent handles the exit code */ }
  process.exit(2);
}, RENDER_TIMEOUT_MS).unref();

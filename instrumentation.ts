// Next.js instrumentation hook — runs once when the Next.js server starts.
// We use it to start the canvas-sync WebSocket service in the same Node.js
// process, so the WebSocket server shares the dev server's lifecycle and
// doesn't need a separate (fragile) background process.
//
// See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation

export async function register() {
  // Only run on the server side (not in the edge runtime).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startCanvasSyncService } = await import('./src/lib/canvas/server');
    startCanvasSyncService();
  }
}

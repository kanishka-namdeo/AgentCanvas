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

    // Boot-time interrupted-run recovery (OpenHands restart-crash pattern):
    // a server restart mid-agent-run used to strand SessionRun rows at
    // 'in_progress' and SessionMessage rows at 'streaming' forever (their
    // only writers are client fire-and-forget POSTs). The recovery sweep
    // marks stale rows with an honest terminal status and records synthetic
    // "interrupted" observations for tool calls whose results were lost, so
    // a future resume has clean context. Best-effort + non-blocking: a DB
    // failure here must never block the server from booting.
    import('./src/lib/agent/boot-recovery')
      .then(({ runBootRecovery }) => runBootRecovery())
      .catch((err) => {
        console.warn(
          '[instrumentation] boot recovery skipped:',
          err instanceof Error ? err.message : String(err),
        );
      });
  }
}

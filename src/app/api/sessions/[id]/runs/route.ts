// POST /api/sessions/[id]/runs — create a run (or update when runId is passed)
//
// The POST body supports the following fields (all optional except where
// noted):
//   - prompt (string)             — the user prompt that triggered this run
//   - status (string)             — 'queued'|'in_progress'|'completed'|'failed'|'cancelled'
//   - runId (string)              — client-supplied run id (upsert)
//   - documentId (string)         — auto-heal: pre-fix localStorage sessions
//   - errorMessage (string?)
//   - toolCallCount (number)
//   - toolCalls (any[])           — JSON-serialized server-side
//   - inputTokens (number)        — per-run input token count
//   - outputTokens (number)      — per-run output token count
//   - costUsd (number)            — per-run estimated cost in USD
//
// Security / correctness (Task 4c bug-fixes — Fix 2 + Fix 3):
//   - The path `id` parameter and the client-supplied `runId` are validated
//     against `^[a-zA-Z0-9_-]{1,64}$` to prevent path-injection. Mirrors
//     the documents route + sessions route guards.
//   - `costUsd` / `inputTokens` / `outputTokens` are guarded by
//     `Number.isFinite()` — JSON.stringify converts NaN/Infinity to `null`,
//     but a client can still POST `costUsd: NaN` or `costUsd: -1` via raw
//     fetch. Reject non-finite with 400; clamp negatives to 0 (defensive
//     — a buggy client could send a refund sentinel that breaks totals).

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSession } from '../../ensure-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/// Regex for client-supplied identifiers — matches the documents route's
/// guard. Allows letters, digits, `_`, `-`; length 1..64.
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/// Validate that `id` matches ID_PATTERN; returns a 400-ready NextResponse
/// when invalid, or `null` when valid.
function validateId(id: string): NextResponse | null {
  if (!ID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: 'id must match ^[a-zA-Z0-9_-]{1,64}$' },
      { status: 400 },
    );
  }
  return null;
}

/**
 * Sanitize a numeric cost/token field. Returns `null` when the value is
 * absent (no update), `false` when invalid (caller should reject with 400),
 * or a clamped non-negative number ready to write to Prisma.
 *
 * - `undefined` (absent)            → null (skip the update)
 * - NaN, ±Infinity, non-number     → false (reject)
 * - negative                       → 0 (clamped — defensive)
 * - non-negative finite number     → value
 */
function sanitizeNumeric(v: unknown): number | false | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (v < 0) return 0;
  return v;
}

/// Round + clamp a token count: must be a non-negative integer. Rejects
/// NaN/Infinity/non-number; clamps negatives to 0; truncates fractional
/// values to integers (defensive — the SDK never sends fractional tokens).
function sanitizeTokenCount(v: unknown): number | false | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (v < 0) return 0;
  return Math.trunc(v);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const idErr = validateId(id);
  if (idErr) return idErr;

  const body = await req.json().catch(() => ({}));
  const { prompt, status, runId, documentId } = body;

  // Fix 2: validate the client-supplied runId (if any) against the same
  // regex the sessions route uses for `id`.
  if (runId !== undefined && runId !== null) {
    const runIdErr = validateId(runId);
    if (runIdErr) return runIdErr;
  }

  // Fix 3: validate numeric cost / token fields BEFORE they reach Prisma.
  // JSON.stringify converts NaN/Infinity to `null`, but a raw-fetch client
  // can still send those values; the previous code spread them through,
  // surfacing as Prisma 500s (NaN) or negative-token run rows.
  const inputTokens = sanitizeTokenCount(body.inputTokens);
  if (inputTokens === false) {
    return NextResponse.json(
      { error: 'inputTokens must be a non-negative finite number' },
      { status: 400 },
    );
  }
  const outputTokens = sanitizeTokenCount(body.outputTokens);
  if (outputTokens === false) {
    return NextResponse.json(
      { error: 'outputTokens must be a non-negative finite number' },
      { status: 400 },
    );
  }
  const costUsd = sanitizeNumeric(body.costUsd);
  if (costUsd === false) {
    return NextResponse.json(
      { error: 'costUsd must be a non-negative finite number' },
      { status: 400 },
    );
  }
  // toolCallCount is informational — same guard.
  const toolCallCount = sanitizeTokenCount(body.toolCallCount);
  if (toolCallCount === false) {
    return NextResponse.json(
      { error: 'toolCallCount must be a non-negative finite number' },
      { status: 400 },
    );
  }

  try {
    // If runId is provided, update the existing run — or create it if the
    // server never saw the create call (upsert semantics; previously this
    // threw P2025 "record not found" as an unhandled 500).
    if (runId) {
      const run = await db.sessionRun.upsert({
        where: { id: runId },
        update: {
          ...(status !== undefined ? { status } : {}),
          ...(body.errorMessage !== undefined ? { errorMessage: body.errorMessage } : {}),
          ...(toolCallCount !== null ? { toolCallCount } : {}),
          ...(body.toolCalls !== undefined ? { toolCalls: JSON.stringify(body.toolCalls) } : {}),
          ...(inputTokens !== null ? { inputTokens } : {}),
          ...(outputTokens !== null ? { outputTokens } : {}),
          ...(costUsd !== null ? { costUsd } : {}),
        },
        create: {
          id: runId,
          sessionId: id,
          prompt: prompt || '',
          status: status || 'in_progress',
          ...(body.errorMessage !== undefined ? { errorMessage: body.errorMessage } : {}),
          ...(toolCallCount !== null ? { toolCallCount } : {}),
          ...(body.toolCalls !== undefined ? { toolCalls: JSON.stringify(body.toolCalls) } : {}),
          ...(inputTokens !== null ? { inputTokens } : {}),
          ...(outputTokens !== null ? { outputTokens } : {}),
          ...(costUsd !== null ? { costUsd } : {}),
        },
      });
      return NextResponse.json({ run });
    }

    // Auto-heal: pre-fix localStorage sessions have no server row. If the
    // client tells us which document this belongs to, create the shell.
    const ensured = await ensureSession(id, documentId, body.title);
    if (!ensured) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const run = await db.sessionRun.create({
      data: {
        sessionId: id,
        prompt: prompt || '',
        status: status || 'in_progress',
        ...(inputTokens !== null ? { inputTokens } : {}),
        ...(outputTokens !== null ? { outputTokens } : {}),
        ...(costUsd !== null ? { costUsd } : {}),
      },
    });

    // Increment the session's run count (updateMany: no-op if the shell row
    // was just created concurrently rather than the increment racing).
    await db.session.update({
      where: { id },
      data: { runCount: { increment: 1 }, lastOpenedAt: new Date().toISOString() },
    });

    return NextResponse.json({ run });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to sync run: ${message}` }, { status: 500 });
  }
}

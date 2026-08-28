// GET /api/sessions?documentId=xxx — list sessions (most recent first, capped)
// POST /api/sessions             — create a new session (idempotent by id)
//
// Server-side session persistence (Phase 3). The client's localStorage remains
// as a fast cache; this API is the source of truth.
//
// POST accepts an optional client-supplied `id` (the client's localStorage
// session id). When provided, the server row is created with THAT id so child
// writes (runs/messages/snapshots) reference a session that exists — this is
// the fix for the ForeignKeyConstraintViolation spam (see ensure-session.ts).
//
// Security (Task 4c bug-fixes — Fix 2): the client-supplied `id`,
// `documentId`, and `parentSessionId` are validated against
// `^[a-zA-Z0-9_-]{1,64}$` before being written to the DB. Without this,
// a malicious/buggy client could POST an id containing path-unsafe
// characters that would later render in URLs (e.g. `/api/sessions/; drop;/…`
// would not execute, but the id would pollute logs and child route 404s).
// Mirrors the existing guard in `src/app/api/documents/route.ts::POST`.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cap the list response. Without this, a corrupted/legacy DB with thousands of
// empty session shells floods the client merge on every load.
const MAX_SESSIONS_RETURNED = 50;

/// Regex for client-supplied identifiers — matches the documents route's
/// guard. Allows letters, digits, `_`, `-`; length 1..64. Anything else
/// (whitespace, path-unsafe chars, SQL-ish punctuation) is rejected with 400.
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/// Validate that `v` (if provided) is a string matching ID_PATTERN.
/// Returns `null` when valid, or a 400-ready error string.
function validateIdField(name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !ID_PATTERN.test(v)) {
    return `${name} must match ^[a-zA-Z0-9_-]{1,64}$`;
  }
  return null;
}

export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get('documentId');
  const status = req.nextUrl.searchParams.get('status') ?? 'active';

  try {
    const sessions = await db.session.findMany({
      where: {
        ...(documentId ? { documentId } : {}),
        status,
      },
      orderBy: { lastOpenedAt: 'desc' },
      take: MAX_SESSIONS_RETURNED,
      include: {
        _count: { select: { messages: true, runs: true } },
      },
    });

    return NextResponse.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to list sessions: ${message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { documentId, title, parentSessionId, id, tags } = body;

  if (!documentId) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
  }

  // Fix 2: validate client-supplied identifiers (id / documentId /
  // parentSessionId) against the same regex the documents route uses.
  // Rejects path-unsafe chars and oversized values BEFORE they reach Prisma.
  const idErr = validateIdField('id', id);
  if (idErr) return NextResponse.json({ error: idErr }, { status: 400 });
  const docErr = validateIdField('documentId', documentId);
  if (docErr) return NextResponse.json({ error: docErr }, { status: 400 });
  const parentErr = validateIdField('parentSessionId', parentSessionId);
  if (parentErr) return NextResponse.json({ error: parentErr }, { status: 400 });

  // Validate `tags` if provided: must be an array of strings.
  let tagsJson: string | undefined;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string')) {
      return NextResponse.json(
        { error: 'tags must be an array of strings' },
        { status: 400 },
      );
    }
    tagsJson = JSON.stringify(tags);
  }

  try {
    // Idempotency: if the client-supplied id already exists, return the
    // existing row instead of failing on the unique primary-key constraint.
    // (The client fire-and-forgets creates, so duplicate requests happen.)
    if (id) {
      const existing = await db.session.findUnique({ where: { id } });
      if (existing) {
        return NextResponse.json({ session: existing });
      }
    }

    const session = await db.session.create({
      data: {
        // Client-supplied id (client localStorage id) — keeps client and
        // server rows aligned so child writes never FK-fail. Falls back to
        // the Prisma cuid default when absent.
        ...(id ? { id } : {}),
        documentId,
        title: title || 'Untitled',
        parentSessionId: parentSessionId || null,
        lastOpenedAt: new Date().toISOString(),
        ...(tagsJson !== undefined ? { tags: tagsJson } : {}),
      },
    });

    return NextResponse.json({ session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to create session: ${message}` }, { status: 500 });
  }
}

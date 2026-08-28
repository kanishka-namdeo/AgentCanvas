// GET  /api/documents                — list documents (most recent first)
// POST /api/documents                 — create a new document
//
// Multi-document support (P3-1). The Document model has existed since the
// first schema, but until now the page hard-coded `documentId = 'demo'` so
// no UI ever created new documents. This route is the source of truth for
// the document switcher in SessionHeader.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DOCUMENTS_RETURNED = 50;

export async function GET(req: NextRequest) {
  const includeDeleted = req.nextUrl.searchParams.get('includeDeleted') === 'true';
  try {
    // List documents ordered by updatedAt desc. The list excludes the
    // `viewport` / `background` columns — the canvas store already has the
    // live values; the switcher only needs id + name + timestamps.
    const documents = await db.document.findMany({
      orderBy: { updatedAt: 'desc' },
      take: MAX_DOCUMENTS_RETURNED,
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        // Denormalized counts so the switcher can show "demo · 5 chats · 23 shapes".
        _count: {
          select: { shapes: true, actions: true },
        },
      },
    });
    return NextResponse.json({ documents });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to list documents: ${message}` }, { status: 500 });
  }
  // `includeDeleted` is a no-op today (no soft-delete column) but reserved
  // for future use; suppress the lint so callers can pass it speculatively.
  void includeDeleted;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { id, name, background } = body;

  // Validate `id` if provided — must be a non-empty string (no whitespace-only,
  // no path-unsafe characters that would break URLs).
  if (id !== undefined) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      return NextResponse.json(
        { error: 'id must match ^[a-zA-Z0-9_-]{1,64}$' },
        { status: 400 },
      );
    }
  }

  // Validate `name` if provided — cap at 100 chars.
  if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
    return NextResponse.json(
      { error: 'name must be a string of ≤ 100 characters' },
      { status: 400 },
    );
  }

  try {
    // Idempotency: if the client-supplied id already exists, return the
    // existing row instead of failing on the unique primary-key constraint.
    if (id) {
      const existing = await db.document.findUnique({ where: { id } });
      if (existing) {
        return NextResponse.json({ document: existing });
      }
    }

    const document = await db.document.create({
      data: {
        ...(id ? { id } : {}),
        name: name || 'Untitled',
        ...(background ? { background } : {}),
      },
    });

    return NextResponse.json({ document });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to create document: ${message}` }, { status: 500 });
  }
}

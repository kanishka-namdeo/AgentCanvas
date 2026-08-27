// GET    /api/documents/[documentId]/snapshots/[id] — fetch one snapshot
//         INCLUDING the parsed document JSON (restore path for remote entries)
// PATCH  /api/documents/[documentId]/snapshots/[id] — update label/bookmark
// DELETE /api/documents/[documentId]/snapshots/[id] — delete a snapshot
//         (refused while bookmarked — the user marked it as a keeper)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string; id: string }> },
) {
  const { documentId, id } = await params;
  try {
    const row = await db.documentSnapshot.findFirst({
      where: { id, documentId },
    });
    if (!row) {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
    // Parse the document JSON for the client (remote metadata-only entries
    // fetch this on restore). A corrupt payload surfaces as a parse error the
    // client can handle, rather than a 500.
    let document: unknown = null;
    try {
      document = JSON.parse(row.document);
    } catch {
      document = null;
    }
    return NextResponse.json({ snapshot: { ...row, document } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to get snapshot: ${message}` }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string; id: string }> },
) {
  const { documentId, id } = await params;
  const body = await req.json().catch(() => ({}));
  const { label, bookmarked } = body;

  try {
    const existing = await db.documentSnapshot.findFirst({ where: { id, documentId } });
    if (!existing) {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
    const snapshot = await db.documentSnapshot.update({
      where: { id },
      data: {
        ...(typeof label === 'string' ? { label } : {}),
        ...(typeof bookmarked === 'boolean' ? { bookmarked } : {}),
      },
    });
    return NextResponse.json({ snapshot });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to update snapshot: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string; id: string }> },
) {
  const { documentId, id } = await params;
  try {
    const existing = await db.documentSnapshot.findFirst({ where: { id, documentId } });
    if (!existing) {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
    if (existing.bookmarked) {
      return NextResponse.json(
        { error: 'Snapshot is bookmarked — unbookmark it before deleting' },
        { status: 400 },
      );
    }
    await db.documentSnapshot.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to delete snapshot: ${message}` }, { status: 500 });
  }
}

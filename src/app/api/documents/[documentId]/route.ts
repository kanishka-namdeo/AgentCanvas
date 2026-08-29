// GET    /api/documents/[documentId]   — get one document (id + name + viewport + counts)
// PATCH  /api/documents/[documentId]   — rename / update viewport / update background
// DELETE /api/documents/[documentId]   — delete a document (cascade: shapes, actions,
//                                          sessions, snapshots, agent events)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId: id } = await params;
  try {
    const document = await db.document.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        viewport: true,
        background: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { shapes: true, actions: true } },
      },
    });
    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    return NextResponse.json({ document });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to fetch document: ${message}` }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId: id } = await params;
  const body = await req.json().catch(() => ({}));
  const { name, viewport, background } = body;

  // Validate `name` if provided.
  if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
    return NextResponse.json(
      { error: 'name must be a string of ≤ 100 characters' },
      { status: 400 },
    );
  }

  // Validate `viewport` if provided — must be a JSON-serializable object.
  let viewportJson: string | undefined;
  if (viewport !== undefined) {
    if (typeof viewport !== 'object' || viewport === null) {
      return NextResponse.json(
        { error: 'viewport must be an object' },
        { status: 400 },
      );
    }
    try {
      viewportJson = JSON.stringify(viewport);
    } catch {
      return NextResponse.json({ error: 'viewport not serializable' }, { status: 400 });
    }
  }

  // Validate `background` if provided — basic hex check.
  if (background !== undefined && (typeof background !== 'string' || !/^#([0-9a-fA-F]{3,8})$/.test(background))) {
    return NextResponse.json(
      { error: 'background must be a hex color' },
      { status: 400 },
    );
  }

  try {
    const document = await db.document.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(viewportJson !== undefined ? { viewport: viewportJson } : {}),
        ...(background !== undefined ? { background } : {}),
      },
    });
    return NextResponse.json({ document });
  } catch (err) {
    const isNotFound = (err as { code?: string })?.code === 'P2025';
    if (isNotFound) {
      // UI-audit round 2: the seed 'demo' document (and any doc that only
      // ever lived in the in-memory sync service) has NO database row until
      // the user explicitly creates one — which made "Rename current…"
      // 404 and left the header label stale. UPSERT instead: renaming a
      // missing doc materializes it server-side under the same id.
      try {
        const document = await db.document.create({
          data: {
            id,
            name: name ?? 'Untitled',
            ...(viewportJson !== undefined ? { viewport: viewportJson } : {}),
            ...(background !== undefined ? { background } : {}),
          },
        });
        return NextResponse.json({ document });
      } catch (createErr) {
        const message = createErr instanceof Error ? createErr.message : 'Unknown database error';
        return NextResponse.json({ error: `Failed to create document: ${message}` }, { status: 500 });
      }
    }
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to update document: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId: id } = await params;
  try {
    await db.document.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    const isNotFound = (err as { code?: string })?.code === 'P2025';
    if (isNotFound) {
      return NextResponse.json({ success: true });
    }
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to delete document: ${message}` }, { status: 500 });
  }
}

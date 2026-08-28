// GET /api/sessions/[id]/tags — list distinct tags used across all sessions
//                                in the same document as `[id]` (tag suggestion
//                                source for the sidebar's "Add tag" combobox).
//
// Tags are stored as a JSON-encoded string array on each Session row (no
// separate Tag model — see prisma/schema.prisma). The suggestion list is
// derived at query time by aggregating every session's tags column within
// the document, deduping, and returning { tag, count } tuples so the UI
// can show "(12)" counts next to each tag chip.
//
// This route is READ-ONLY. Tag mutations happen via PATCH /api/sessions/[id]
// (the entire tags array is replaced in one PATCH — a delta API would be more
// chatty for the small tag counts we expect).

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Look up the session to find its documentId. If the session doesn't
    // exist, return an empty list rather than a 404 — the UI calls this
    // route to populate the suggestion combobox for a freshly-created
    // session whose server row may not yet exist.
    const session = await db.session.findUnique({
      where: { id },
      select: { documentId: true },
    });
    if (!session) {
      return NextResponse.json({ tags: [] });
    }

    // Aggregate tag strings across every session in the document.
    const rows = await db.session.findMany({
      where: { documentId: session.documentId },
      select: { tags: true },
    });

    const counts = new Map<string, number>();
    for (const row of rows) {
      let tags: string[] = [];
      try {
        const parsed = JSON.parse(row.tags || '[]');
        if (Array.isArray(parsed)) {
          tags = parsed.filter((t: unknown) => typeof t === 'string' && t.length > 0);
        }
      } catch {
        // Bad JSON in the column — skip; never crash the suggestions list.
      }
      for (const t of tags) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }

    const tags = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

    return NextResponse.json({ tags });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to fetch tag suggestions: ${message}` }, { status: 500 });
  }
}

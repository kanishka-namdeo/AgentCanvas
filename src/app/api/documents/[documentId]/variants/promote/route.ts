// POST /api/documents/[documentId]/variants/promote — promote a parked variant
// to the active design (designer-workflow-parity spec §4.3).
//
// Body: `{ sectionId: string }` — the parked section node id (from the
// alternatives card's `promoteAlternative(sectionId)` action).
//
// Semantics:
//   1. Validate body (400 on bad input).
//   2. Check for an active run (409 — the run slot is NOT claimed).
//   3. Hydrate the document from the journal fold.
//   4. Attempt the pure swap (404 when the section isn't parked).
//   5. Journal a `variant_promote` synthetic event with the payload.
//   6. Return `{ ok: true, document }` — the client's subsequent
//      `document:restore` emission journals the durable `document_restore` row.
//
// The route does NOT broadcast — the client's `document:restore` emission
// triggers the existing restore handler which validates + adopts + broadcasts
// + journals a `document_restore` row.

import { NextRequest, NextResponse } from 'next/server';
import { hydrateDocumentFromJournal } from '@/lib/canvas/journal-fold';
import { getActiveRun } from '@/lib/canvas/run-registry';
import { appendSyntheticJournalEvent } from '@/lib/agent/event-journal';
import { swapVariantWithMain } from '@/lib/canvas/variant-promote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;

  // 1. Body validation.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }
  const sectionId = (body as { sectionId?: unknown }).sectionId;
  if (typeof sectionId !== 'string' || sectionId.length === 0) {
    return NextResponse.json(
      { error: 'sectionId must be a non-empty string' },
      { status: 400 },
    );
  }

  // 2. Active-run check (read-only — never claim the slot).
  if (getActiveRun(documentId) !== null) {
    return NextResponse.json({ error: 'a design run is active' }, { status: 409 });
  }

  // 3. Hydrate from journal fold.
  let fold;
  try {
    fold = await hydrateDocumentFromJournal(documentId);
  } catch {
    return NextResponse.json({ error: 'failed to hydrate document' }, { status: 500 });
  }

  // 4. Pure swap.
  const result = swapVariantWithMain(fold.document, sectionId);
  if (!result) {
    return NextResponse.json({ error: 'section not parked' }, { status: 404 });
  }

  // 5. Journal the variant_promote row.
  appendSyntheticJournalEvent(documentId, 'variant_promote', undefined, result.payload);

  // 6. Return the swapped document.
  return NextResponse.json({ ok: true, document: result.document });
}

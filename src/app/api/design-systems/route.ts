// GET /api/design-systems
//
// Returns the list of available design-system packs (metadata only —
// no tokens, no sample components). Used by the picker UI to render
// pack cards before the user picks one.

import { NextResponse } from 'next/server';
import { listPacks } from '@/lib/design-systems/loader';

export const dynamic = 'force-static';

export async function GET() {
  try {
    const packs = await listPacks();
    return NextResponse.json({ packs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'registry_load_failed', message: msg }, { status: 500 });
  }
}

// GET /api/design-systems/[name]
//
// Returns the full detail for a single pack — including raw
// tokens.css content, dependencies, import map, and sample
// component snippets. Used by the picker's "preview" view and by
// the agent when committing to a pack.

import { NextResponse } from 'next/server';
import { getPackDetail } from '@/lib/design-systems/loader';

export const dynamic = 'force-static';

export async function generateStaticParams() {
  // Pre-render the known packs at build time.
  return [
    { name: 'shadcn-default' },
    { name: 'vercel-geist' },
    { name: 'mantine-default' },
    { name: 'radix-themes' },
    { name: 'tailwind-catalyst' },
  ];
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const pack = await getPackDetail(name);
    return NextResponse.json({ pack });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'pack_not_found', message: msg, name },
      { status: 404 },
    );
  }
}

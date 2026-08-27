// GET /api/design-systems/[name]/tokens
//
// Returns the raw tokens.css content as `text/css`. Used by the
// agent (and by the picker's live-preview iframe) when only the CSS
// is needed — cheaper than fetching the full PackDetail.

import { getPackTokens } from '@/lib/design-systems/loader';

export const dynamic = 'force-static';

export async function generateStaticParams() {
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
    const tokensCss = await getPackTokens(name);
    return new Response(tokensCss, {
      status: 200,
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'public, max-age=300, immutable',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: 'pack_not_found', message: msg, name }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

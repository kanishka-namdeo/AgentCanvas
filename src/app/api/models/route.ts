// POST /api/models — list models the user can switch to for the configured
// LLM provider. Powers the AgentPanel model-badge switcher and the Settings
// → LLM provider "load live models" button.
//
// Request body (all optional — defaults mirror the app settings):
//   { provider?: string, apiKey?: string, apiBaseUrl?: string }
//
// Response:
//   {
//     provider: { provider, label, source: 'endpoint'|'catalog'|'error',
//                 ready, readyReason?, models: [...], error? },
//     zaiSandbox: { available, models: [...], note? } | null
//   }
//
// Read-only by design (no secrets are persisted server-side; the API key is
// used in-memory for the /models probe only, same as the agent runner).

import { NextRequest, NextResponse } from 'next/server';
import { listModelsForSettings } from '@/lib/agent/model-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty/invalid body — fall through to defaults.
  }

  const provider = typeof body.provider === 'string' ? body.provider : undefined;
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
  const apiBaseUrl = typeof body.apiBaseUrl === 'string' ? body.apiBaseUrl : undefined;

  try {
    const listing = await listModelsForSettings({ llmProvider: provider, apiKey, apiBaseUrl });
    return NextResponse.json(listing);
  } catch (err) {
    return NextResponse.json(
      {
        provider: {
          provider: provider ?? 'custom',
          label: provider ?? 'Custom',
          source: 'error',
          ready: false,
          models: [],
          error: err instanceof Error ? err.message : 'Failed to list models',
        },
        zaiSandbox: null,
      },
      { status: 200 }, // 200 + error payload — the UI renders the error state
    );
  }
}

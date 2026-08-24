// GET /api/plugins
//
// Returns the list of all available plugins with their enabled/disabled
// state. The frontend's Settings → Plugins panel uses this to render the
// toggle list.

import { getAllPlugins, getEnabledPlugins } from '@/lib/agent/plugins';
import type { AgentRunSettings } from '@/lib/settings/types';
import { DEFAULT_SETTINGS } from '@/lib/settings/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const all = getAllPlugins();
  // We don't have access to the user's actual settings here (they're in
  // the browser's localStorage). Return the manifest + defaultEnabled flag;
  // the frontend merges with the user's stored toggles.
  return new Response(
    JSON.stringify({
      plugins: all.map((p) => ({
        pluginId: p.pluginId,
        pluginName: p.pluginName,
        description: p.description,
        category: p.category,
        defaultEnabled: p.defaultEnabled,
        toolCount: p.tools.length,
        toolNames: p.tools.map((t) => t.name),
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// Use the imports to avoid TS unused warnings — these are used by callers
// that compose settings before passing to the runner.
void (DEFAULT_SETTINGS as AgentRunSettings);
void getEnabledPlugins;

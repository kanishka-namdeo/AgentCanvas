// GET /api/mcp/[id]
// POST /api/mcp/[id]   { action: 'connect' | 'disconnect' }
//
// Status + control endpoint for a specific MCP server. The frontend's
// Settings → MCP Servers panel calls this to connect/disconnect and check
// status.

import { NextRequest } from 'next/server';
import { getConnectedServers, registerServer, unregisterServer } from '@/lib/agent/plugins/mcp-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const servers = getConnectedServers();
  const server = servers.find((s) => s.id === id);
  if (!server) {
    return new Response(JSON.stringify({ error: 'server not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(server), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action: string = body.action ?? '';

  if (action === 'connect') {
    // For now, register a placeholder server — actual MCP client connection
    // would use @modelcontextprotocol/sdk here.
    registerServer({
      id,
      name: body.name ?? id,
      transport: body.transport ?? 'stdio',
      status: 'connected',
      tools: body.tools ?? [],
      resources: body.resources ?? [],
    });
    return new Response(JSON.stringify({ ok: true, status: 'connected' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (action === 'disconnect') {
    unregisterServer(id);
    return new Response(JSON.stringify({ ok: true, status: 'disconnected' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'unknown action' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

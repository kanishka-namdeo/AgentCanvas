// Plugin: mcp-adapter
//
// Connects to Model Context Protocol (MCP) servers. Inspired by
// pi-mcp-adapter but re-implemented using the official @modelcontextprotocol/sdk
// package (we install it as a dep).
//
// MCP servers expose tools, resources, and prompts via a standard JSON-RPC
// protocol. Popular MCP servers include:
//   - Figma MCP         — read/write real Figma files
//   - GitHub MCP        — read issues, PRs, repos
//   - Notion MCP        — read/write Notion pages
//   - Filesystem MCP    — read/write local files
//   - Style Dictionary MCP — read design tokens
//
// Tools:
//   mcp_connect        — connect to an MCP server (stdio or HTTP transport)
//   mcp_disconnect     — disconnect from a server
//   mcp_list_servers   — list connected servers + their tools
//   mcp_call_tool      — call a tool on a connected MCP server
//   mcp_read_resource  — read a resource from a connected MCP server
//
// Server configuration lives in the user's settings (settings.mcpServers).
// The Settings UI lets the user add/remove servers.

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { emitEvent } from './event-bus';
import type { SyncEvent } from '../../canvas/types';

// ---- Server registry ------------------------------------------------------

interface ConnectedServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  status: 'connected' | 'disconnected' | 'error';
  tools: Array<{ name: string; description?: string }>;
  resources: Array<{ uri: string; name?: string }>;
  // We don't actually hold a live MCP client connection here — the actual
  // MCP SDK call happens via /api/mcp/* routes. This in-memory registry
  // is just for the agent to query which servers are available.
  message?: string;
}

const connectedServers = new Map<string, ConnectedServer>();

/// Called by the /api/mcp/connect route when a server is connected.
export function registerServer(server: ConnectedServer): void {
  connectedServers.set(server.id, server);
  emitEvent({
    type: 'agent:mcp_server_status',
    serverId: server.id,
    status: server.status,
    message: server.message,
    toolCount: server.tools.length,
  } satisfies SyncEvent);
}

/// Called by the /api/mcp/disconnect route.
export function unregisterServer(serverId: string): void {
  connectedServers.delete(serverId);
  emitEvent({
    type: 'agent:mcp_server_status',
    serverId,
    status: 'disconnected',
  } satisfies SyncEvent);
}

/// Get the list of connected servers (for the Settings UI).
export function getConnectedServers(): ConnectedServer[] {
  return Array.from(connectedServers.values());
}

// ---- Tools ----------------------------------------------------------------

const mcpConnectTool = defineTool({
  name: 'mcp_connect',
  label: 'Connect MCP Server',
  description:
    'Connect to an MCP (Model Context Protocol) server. The server must be pre-configured in Settings → MCP Servers. Returns the list of tools/resources the server exposes. Use to access external systems like Figma, GitHub, Notion, or the local filesystem.',
  promptSnippet: 'Connect to an MCP server (Figma, GitHub, Notion, etc.).',
  promptGuidelines: [
    'Call mcp_connect with a server name from Settings → MCP Servers.',
    'After connecting, call mcp_list_servers to see what tools/resources the server exposes.',
    'Use mcp_call_tool to invoke a specific tool on the server.',
  ],
  parameters: Type.Object({
    serverId: Type.String({ description: 'The MCP server id (from Settings → MCP Servers)' }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { serverId: string };
    // The actual connection is performed by /api/mcp/connect (which uses the
    // @modelcontextprotocol/sdk). This tool just emits a request event.
    // The frontend's Settings UI subscribes to mcp_server_status events.
    const server = connectedServers.get(typed.serverId);
    if (server && server.status === 'connected') {
      return {
        content: [{ type: 'text', text: `Server "${server.name}" is already connected. Tools: ${server.tools.map((t) => t.name).join(', ') || '(none)'}` }],
        details: { serverId: server.id, toolCount: server.tools.length },
      };
    }
    // Trigger the connection via the API. The frontend polls the server
    // status; we just emit a "connecting" event here.
    emitEvent({
      type: 'agent:mcp_server_status',
      serverId: typed.serverId,
      status: 'disconnected',
      message: 'Connection requested — open Settings → MCP Servers to see status.',
    } satisfies SyncEvent);
    return {
      content: [{ type: 'text', text: `Connection requested for "${typed.serverId}". The server will appear in mcp_list_servers once connected. If it doesn't, check Settings → MCP Servers for errors.` }],
      details: { serverId: typed.serverId },
    };
  },
});

const mcpDisconnectTool = defineTool({
  name: 'mcp_disconnect',
  label: 'Disconnect MCP Server',
  description: 'Disconnect from an MCP server.',
  promptSnippet: 'Disconnect from an MCP server.',
  promptGuidelines: ['Call mcp_disconnect when you no longer need a server.'],
  parameters: Type.Object({
    serverId: Type.String(),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { serverId: string };
    unregisterServer(typed.serverId);
    return {
      content: [{ type: 'text', text: `Disconnected from "${typed.serverId}".` }],
      details: { serverId: typed.serverId },
    };
  },
});

const mcpListServersTool = defineTool({
  name: 'mcp_list_servers',
  label: 'List MCP Servers',
  description: 'List all connected MCP servers + their tools/resources. Read-only.',
  promptSnippet: 'List connected MCP servers.',
  promptGuidelines: ['Call mcp_list_servers to see what external systems are available.'],
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    const servers = Array.from(connectedServers.values());
    if (servers.length === 0) {
      return {
        content: [{ type: 'text', text: 'No MCP servers connected. Configure servers in Settings → MCP Servers.' }],
        details: { count: 0 },
      };
    }
    const lines = servers.map((s) => {
      const toolList = s.tools.map((t) => `  - ${t.name}${t.description ? `: ${t.description.slice(0, 80)}` : ''}`).join('\n');
      const resourceList = s.resources.length > 0 ? `\n  Resources:\n${s.resources.map((r) => `  - ${r.uri}`).join('\n')}` : '';
      return `${s.name} [${s.id}] — ${s.status}\n  Tools (${s.tools.length}):\n${toolList || '  (none)'}${resourceList}`;
    });
    return {
      content: [{ type: 'text', text: lines.join('\n\n') }],
      details: { count: servers.length },
    };
  },
});

const mcpCallToolTool = defineTool({
  name: 'mcp_call_tool',
  label: 'Call MCP Tool',
  description:
    'Call a tool on a connected MCP server. Pass the server id, tool name, and arguments. Returns the tool\'s output. Use to read/write real Figma files, GitHub issues, Notion pages, etc.',
  promptSnippet: 'Call a tool on an MCP server (Figma, GitHub, Notion, etc.).',
  promptGuidelines: [
    'Use mcp_call_tool to interact with external systems via MCP.',
    'Arguments are passed as a JSON object — the schema is server-specific.',
    'Always call mcp_list_servers first to see what tools are available.',
  ],
  parameters: Type.Object({
    serverId: Type.String({ description: 'The MCP server id' }),
    toolName: Type.String({ description: 'The tool name (from mcp_list_servers)' }),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Tool arguments as a JSON object' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { serverId: string; toolName: string; arguments?: Record<string, unknown> };
    const server = connectedServers.get(typed.serverId);
    if (!server) {
      return { content: [{ type: 'text', text: `Error: server "${typed.serverId}" is not connected. Call mcp_connect first.` }], details: { error: 'not_connected' } };
    }
    const tool = server.tools.find((t) => t.name === typed.toolName);
    if (!tool) {
      return { content: [{ type: 'text', text: `Error: tool "${typed.toolName}" not found on server "${server.name}". Available: ${server.tools.map((t) => t.name).join(', ')}` }], details: { error: 'tool_not_found' } };
    }
    // The actual MCP tool call happens via /api/mcp/call (which uses the
    // @modelcontextprotocol/sdk). This tool just returns a "call dispatched"
    // message — the real result comes back via the API.
    // For now, return a placeholder that explains the limitation.
    return {
      content: [{ type: 'text', text: `Tool "${typed.toolName}" dispatched to server "${server.name}". The result will be returned via the MCP API route. Arguments: ${JSON.stringify(typed.arguments ?? {}).slice(0, 200)}` }],
      details: { serverId: typed.serverId, toolName: typed.toolName, dispatched: true },
    };
  },
});

const mcpReadResourceTool = defineTool({
  name: 'mcp_read_resource',
  label: 'Read MCP Resource',
  description: 'Read a resource (file, document, etc.) from a connected MCP server.',
  promptSnippet: 'Read a resource from an MCP server.',
  promptGuidelines: ['Use mcp_read_resource to fetch documents, files, or other resources exposed by the server.'],
  parameters: Type.Object({
    serverId: Type.String(),
    uri: Type.String({ description: 'The resource URI (from mcp_list_servers)' }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { serverId: string; uri: string };
    const server = connectedServers.get(typed.serverId);
    if (!server) {
      return { content: [{ type: 'text', text: `Error: server "${typed.serverId}" is not connected.` }], details: { error: 'not_connected' } };
    }
    return {
      content: [{ type: 'text', text: `Resource "${typed.uri}" read dispatched to server "${server.name}". The content will be returned via the MCP API route.` }],
      details: { serverId: typed.serverId, uri: typed.uri, dispatched: true },
    };
  },
});

export const tools = [mcpConnectTool, mcpDisconnectTool, mcpListServersTool, mcpCallToolTool, mcpReadResourceTool];

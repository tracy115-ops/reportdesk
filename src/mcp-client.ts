import { invoke } from '@tauri-apps/api/core';
import { nativeDesktop } from './desktop';

export type McpServer = { id: string; name: string } & (
  { kind: 'http'; url: string } | { kind: 'stdio'; command: string; args: string[] }
);

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface McpToolResult { content?: unknown[]; structuredContent?: unknown; isError?: boolean }

export function listMcpServers(): Promise<McpServer[]> {
  return nativeDesktop ? invoke('mcp_servers') : Promise.resolve([]);
}

export function saveMcpServer(server: McpServer): Promise<McpServer> { return invoke('mcp_save', { server }); }
export function removeMcpServer(id: string): Promise<void> { return invoke('mcp_remove', { id }); }
export function listMcpTools(id: string): Promise<McpTool[]> { return invoke('mcp_tools', { id }); }
export function mcpCall(id: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
  return invoke('mcp_call', { id, tool, args });
}

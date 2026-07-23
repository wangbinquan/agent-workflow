// RFC-111 PR-C — pure transforms from the platform's DB-shape MCP / dependsOn
// closure into Claude Code's `--mcp-config` / `--agents` inline-JSON wire shapes.
// (opencode injects these via OPENCODE_CONFIG_CONTENT; claude takes flags.)
//
// Leaf module: imports only shared types → no module-init cycle.

import type { Agent, Mcp } from '@agent-workflow/shared'

/**
 * Translate the platform's MCP rows into Claude Code's `--mcp-config` shape:
 *   { mcpServers: { <name>: { command, args, env } | { type, url, headers } } }
 * Disabled entries + closure duplicates are dropped. Local `command` is an
 * `[cmd, ...args]` array in our schema → split into claude's `command` + `args`.
 * Returns null when nothing enabled remains (caller omits the flag).
 */
export function toClaudeMcpConfig(
  mcps: readonly Mcp[],
): { mcpServers: Record<string, Record<string, unknown>> } | null {
  const servers: Record<string, Record<string, unknown>> = {}
  for (const m of mcps) {
    if (m.enabled === false) continue
    // `constructor` is a valid resource name. Own-property checks prevent the
    // Object prototype from masquerading as an already-injected registry key.
    if (Object.hasOwn(servers, m.name)) continue // closure dedupe
    if (m.type === 'local') {
      const command = Array.isArray(m.config.command) ? m.config.command : []
      const entry: Record<string, unknown> = { command: command[0] ?? '', args: command.slice(1) }
      if (m.config.env !== undefined) entry.env = m.config.env
      servers[m.name] = entry
    } else {
      const entry: Record<string, unknown> = { type: 'http', url: m.config.url }
      if (m.config.headers !== undefined) entry.headers = m.config.headers
      servers[m.name] = entry
    }
  }
  return Object.keys(servers).length > 0 ? { mcpServers: servers } : null
}

/**
 * Translate the dependsOn closure (RFC-022, BFS order, root excluded) into
 * Claude Code's `--agents` inline-JSON shape: `{ <name>: { description, prompt } }`
 * so the primary claude agent can invoke them as subagents (the claude analog of
 * opencode's inline `agent.<dep>` entries). Returns null when the closure is
 * empty. Per-node overrides never apply to dependents (parity with opencode).
 */
export function toClaudeAgents(
  dependents: readonly Agent[],
): Record<string, { description: string; prompt: string }> | null {
  const agents: Record<string, { description: string; prompt: string }> = {}
  for (const dep of dependents) {
    if (Object.hasOwn(agents, dep.name)) continue
    agents[dep.name] = { description: dep.description, prompt: dep.bodyMd }
  }
  return Object.keys(agents).length > 0 ? agents : null
}

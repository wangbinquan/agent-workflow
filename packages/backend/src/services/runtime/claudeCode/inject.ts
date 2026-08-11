// RFC-111 PR-C — pure transforms from the platform's DB-shape MCP / dependsOn
// closure into Claude Code's `--mcp-config` / `--agents` inline-JSON wire shapes.
// (opencode injects these via OPENCODE_CONFIG_CONTENT; claude takes flags.)
//
// Leaf module: imports only shared types → no module-init cycle.

import type { Agent, Mcp } from '@agent-workflow/shared'
import {
  renderClaudeMcpInjection,
  renderClaudeSubagentEntries,
  type ClaudeAgentEntry,
  type ClaudeAgentsOpts,
} from '@/services/execution/agentInjection'
import { claudeBusinessGate } from './permissionMap'

/**
 * Translate the platform's MCP rows into Claude Code's `--mcp-config` shape:
 *   { mcpServers: { <name>: { command, args, env } | { type, url, headers } } }
 * Disabled entries + same-id closure duplicates are dropped. Local `command` is
 * an `[cmd, ...args]` array in our schema → split into claude's `command` +
 * `args`. Returns null when nothing enabled remains (caller omits the flag).
 *
 * RFC-280 T1: partition + entry rendering live in the unified injection layer
 * (`services/execution/agentInjection.ts`), shared with the opencode paths.
 * Different-id-same-name now throws there (design-gate P1-1) instead of
 * silently keeping the first entry.
 */
export function toClaudeMcpConfig(
  mcps: readonly Mcp[],
): { mcpServers: Record<string, Record<string, unknown>> } | null {
  const { entries } = renderClaudeMcpInjection(mcps)
  return entries === null ? null : { mcpServers: entries }
}

// RFC-280 T2 — the subagent entry renderer moved to the unified injection
// layer (services/execution/agentInjection.ts, `renderClaudeSubagentEntries`).
// This adapter binds the production permission gate (claudeBusinessGate stays
// the single definition) and keeps the historical signature for import sites.

export type {
  ClaudeAgentEntry,
  ClaudeAgentsOpts as ClaudeAgentsRenderOpts,
} from '@/services/execution/agentInjection'

export function toClaudeAgents(
  dependents: readonly Agent[],
  opts?: Omit<ClaudeAgentsOpts, 'gateOf'>,
): { agents: Record<string, ClaudeAgentEntry>; warnings: readonly string[] } | null {
  return renderClaudeSubagentEntries(dependents, { ...(opts ?? {}), gateOf: claudeBusinessGate })
}

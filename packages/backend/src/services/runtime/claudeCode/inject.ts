// RFC-111 PR-C — pure transforms from the platform's DB-shape MCP / dependsOn
// closure into Claude Code's `--mcp-config` / `--agents` inline-JSON wire shapes.
// (opencode injects these via OPENCODE_CONFIG_CONTENT; claude takes flags.)
//
// Leaf module: imports only shared types → no module-init cycle.

import type { Agent } from '@agent-workflow/shared'
import {
  renderClaudeSubagentEntries,
  type ClaudeAgentEntry,
  type ClaudeAgentsOpts,
} from '@/services/execution/agentInjection'
import { claudeBusinessGate } from './permissionMap'

// (RFC-282 B4 — `toClaudeMcpConfig` deleted: it was a src-dead wrapper around
// renderClaudeMcpInjection; the drivers call the unified render directly.)

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

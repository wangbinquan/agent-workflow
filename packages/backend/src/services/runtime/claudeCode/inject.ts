// RFC-111 PR-C — pure transforms from the platform's DB-shape MCP / dependsOn
// closure into Claude Code's `--mcp-config` / `--agents` inline-JSON wire shapes.
// (opencode injects these via OPENCODE_CONFIG_CONTENT; claude takes flags.)
//
// Leaf module: imports only shared types → no module-init cycle.

import type { Agent, Mcp } from '@agent-workflow/shared'
import { claudeBusinessGate } from './permissionMap'

/**
 * Translate the platform's MCP rows into Claude Code's `--mcp-config` shape:
 *   { mcpServers: { <name>: { command, args, env } | { type, url, headers } } }
 * Disabled entries + closure duplicates are dropped. Local `command` is an
 * `[cmd, ...args]` array in our schema → split into claude's `command` + `args`.
 * Returns null when nothing enabled remains (caller omits the flag).
 *
 * RFC-242 T5 — `localWrapperByName` carries the no-network wrappers a CONTROLLED
 * business node materialized (`netlessMcp.ts`). A named local entry is rewritten
 * to fork that wrapper instead of the raw command, and its `env` is deliberately
 * NOT emitted: the real command and its environment live in the 0400 manifest,
 * so MCP secrets stop travelling through this inline JSON (i.e. through argv,
 * readable by every process listing on the host). Absent from the map ⇒ the
 * historical raw shape, which is what an unconstrained node keeps.
 */
export function toClaudeMcpConfig(
  mcps: readonly Mcp[],
  localWrapperByName?: ReadonlyMap<string, string>,
): { mcpServers: Record<string, Record<string, unknown>> } | null {
  const servers: Record<string, Record<string, unknown>> = {}
  for (const m of mcps) {
    if (m.enabled === false) continue
    // `constructor` is a valid resource name. Own-property checks prevent the
    // Object prototype from masquerading as an already-injected registry key.
    if (Object.hasOwn(servers, m.name)) continue // closure dedupe
    if (m.type === 'local') {
      const wrapperPath = localWrapperByName?.get(m.name)
      if (wrapperPath !== undefined) {
        servers[m.name] = { command: wrapperPath, args: [] }
        continue
      }
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

/** One `--agents` entry. `model`/`tools` are omitted rather than nulled — an
 *  absent key means "claude's own default", which is not the same as a value. */
export interface ClaudeAgentEntry {
  description: string
  prompt: string
  model?: string
  tools?: string[]
}

export interface ClaudeAgentsOpts {
  /**
   * 2026-08-09 — RFC-113 profile per agent NAME, i.e. exactly
   * `BusinessNodeSpawnContext.resolvedParamsByAgent`, whose contract already
   * says "live-resolved for each dependent". opencode has consumed the
   * per-dependent model since RFC-251 (`hermetic.ts` passes `dep.model` /
   * variant / temperature / steps); claude dropped it on the floor, so every
   * dependent silently ran on whatever the parent conversation used.
   */
  profileByName?: ReadonlyMap<string, { model: string | null }>
  /**
   * The parent's LOADED built-in set (`--tools`), or null when the parent is
   * unconstrained (`bypassPermissions` has no load set to intersect with).
   *
   * MEASURED on claude 2.1.226: a subagent's tool pool is the parent's loaded
   * set — the built-in `general-purpose` agent declares `tools:["*"]` yet
   * reported exactly `Agent, Read` under a `--tools Read,Task` parent. So the
   * parent set is a hard ceiling, and a dependent's own `permission` was simply
   * not participating: a dependent declared read-only under a writing parent
   * inherited the write tools. We intersect instead — strictly narrowing,
   * never widening.
   */
  parentTools?: readonly string[] | null
}

/** `Task` is deliberately never handed to a closure member: v1 does no nested
 *  delegation, matching opencode's `buildPermission(dep, false)`. */
const NESTED_DELEGATION_TOOL = 'Task'

/**
 * Translate the dependsOn closure (RFC-022, BFS order, root excluded) into
 * Claude Code's `--agents` inline-JSON shape so the primary claude agent can
 * invoke them as subagents (the claude analog of opencode's inline
 * `agent.<dep>` entries). Returns null when the closure is empty.
 *
 * Per-NODE overrides still never apply to dependents (parity with opencode) —
 * what travels here is each dependent's OWN resolved profile and permission.
 *
 * `warnings` carries capability losses the caller must surface: claude caps a
 * subagent at the parent's loaded set, so a dependent asking for a tool the
 * parent does not load cannot get it. That is a structural limit of the
 * runtime, and swallowing it silently is the exact failure mode this whole
 * batch of fixes exists to end.
 */
export function toClaudeAgents(
  dependents: readonly Agent[],
  opts?: ClaudeAgentsOpts,
): { agents: Record<string, ClaudeAgentEntry>; warnings: readonly string[] } | null {
  const agents: Record<string, ClaudeAgentEntry> = {}
  const warnings: string[] = []
  const parentTools = opts?.parentTools
  for (const dep of dependents) {
    if (Object.hasOwn(agents, dep.name)) continue
    const entry: ClaudeAgentEntry = { description: dep.description, prompt: dep.bodyMd }
    const model = opts?.profileByName?.get(dep.name)?.model
    if (typeof model === 'string' && model.length > 0) entry.model = model
    // Only a parent WITH a load set can express a member load set; an
    // unconstrained parent keeps the byte-exact historical entry shape.
    if (parentTools != null) {
      const ceiling = parentTools.filter((tool) => tool !== NESTED_DELEGATION_TOOL)
      const gate = claudeBusinessGate(dep.permission)
      if (gate === null) {
        // No declaration of its own: inherit the parent's set, minus nesting.
        entry.tools = [...ceiling]
      } else {
        const wanted = gate.tools.filter((tool) => tool !== NESTED_DELEGATION_TOOL)
        entry.tools = wanted.filter((tool) => ceiling.includes(tool))
        const unreachable = wanted.filter((tool) => !ceiling.includes(tool))
        if (unreachable.length > 0) {
          warnings.push(
            `dependent '${dep.name}' declares ${unreachable.join(', ')}, which the parent agent ` +
              'does not load; claude caps a subagent at the parent tool set, so it runs without them',
          )
        }
      }
    }
    agents[dep.name] = entry
  }
  return Object.keys(agents).length > 0 ? { agents, warnings } : null
}

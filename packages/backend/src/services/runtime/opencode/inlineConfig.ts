// RFC-143 PR-4 — the OPENCODE_CONFIG_CONTENT inline-config assembly, moved
// VERBATIM out of runner.ts so the opencode driver's `buildBusinessSpawn` can
// import it without a module-init cycle (driver ← runner would loop through
// runtime/index). Behavior is byte-identical — the runner-* inline-config tests
// (runner-build-inline-config-multi / runner-mcp-inject / runner-permission-
// inject / runner-plugin-inject / mcp-end-to-end) lock the move; runner.ts
// re-exports this surface so existing import sites keep resolving.
//
// Leaf module: imports shared types + the RuntimeProfile TYPE only (type-only,
// erased at runtime) → no runtime edge back into runner/runtimeRegistry.

import type { Agent, Mcp, Plugin } from '@agent-workflow/shared'
import type { RuntimeProfile } from '@/services/runtimeRegistry'
import { buildPluginSpecArray } from './pluginSpec'

/** RFC-113: a profile that omits all params (the binary uses its own defaults). */
export const EMPTY_RUNTIME_PROFILE: RuntimeProfile = {
  model: null,
  variant: null,
  temperature: null,
  steps: null,
  maxSteps: null,
  isSandbox: false,
}

/**
 * RFC-022: build the inline-agent JSON for one agent. Pulled out so the
 * primary agent and every closure dependent share one definition formula;
 * the only difference is that dependents pass `overrides = {}` so per-node
 * model/variant/temperature tweaks only apply to the selected primary.
 */
export function buildInlineAgentEntry(
  agent: Agent,
  // RFC-113: model/variant/temperature/steps/maxSteps now come from the agent's
  // RUNTIME (resolved at dispatch), NOT from the agent or a node
  // override. The caller passes the resolved profile for THIS agent.
  params: RuntimeProfile = EMPTY_RUNTIME_PROFILE,
): Record<string, unknown> {
  const inlineAgent: Record<string, unknown> = {
    prompt: agent.bodyMd,
    description: agent.description,
    // RFC-276: the author's explicit permission map is the only platform
    // permission overlay. OpenCode's own `--auto` semantics handle all
    // unspecified operations; the platform no longer adds a global allow/deny.
    permission: agent.permission,
    // Platform-only fields live under `options` so opencode passes them through
    // without trying to parse. The runner doesn't read these back; they exist
    // for observability when an operator dumps `opencode debug agent`.
    options: { outputs: agent.outputs },
  }
  // RFC-113: emit only the params the runtime actually set (NULL = omit, so the
  // binary uses its own default — a distinct, preserved profile).
  if (params.model !== null) inlineAgent.model = params.model
  if (params.variant !== null) inlineAgent.variant = params.variant
  if (params.temperature !== null) inlineAgent.temperature = params.temperature
  if (params.steps !== null) inlineAgent.steps = params.steps
  if (params.maxSteps !== null) inlineAgent.maxSteps = params.maxSteps // Codex P2-3
  return inlineAgent
}

export function buildInlineConfig(
  agent: Agent,
  // RFC-113: resolved runtime profile per agent name (root + each dependent).
  // Missing → EMPTY_RUNTIME_PROFILE (omit all params).
  paramsByAgent: ReadonlyMap<string, RuntimeProfile>,
  dependents: readonly Agent[],
  mcps: readonly Mcp[] = [],
  plugins: readonly Plugin[] = [],
): {
  agent: Record<string, Record<string, unknown>>
  mcp?: Record<string, Record<string, unknown>>
  /**
   * RFC-031: opencode `config.plugin` is an array of `Spec` values. Each
   * element is either a bare `file://<path>` string or a `[file://..., options]`
   * tuple when the plugin record carries non-empty options. We NEVER inject
   * the raw user-supplied spec — opencode would re-resolve it through npm,
   * defeating the eager-install + cache contract.
   */
  plugin?: Array<string | [string, Record<string, unknown>]>
} {
  const map: Record<string, Record<string, unknown>> = {
    [agent.name]: buildInlineAgentEntry(agent, paramsByAgent.get(agent.name)),
  }
  for (const dep of dependents) {
    if (dep.name === agent.name) continue // root would shadow itself; defensive
    // Resource names are external registry keys. `constructor` is a valid
    // platform name, so prototype lookup on `{}` would mistake it for an
    // existing entry and silently drop the managed dependent.
    if (Object.hasOwn(map, dep.name)) continue // closure already deduped, but guard anyway
    map[dep.name] = buildInlineAgentEntry(dep, paramsByAgent.get(dep.name))
  }
  const out: {
    agent: Record<string, Record<string, unknown>>
    mcp?: Record<string, Record<string, unknown>>
    plugin?: Array<string | [string, Record<string, unknown>]>
  } = { agent: map }
  // RFC-028: emit the mcp record only when at least one ENABLED entry exists.
  // Disabled entries are skipped entirely to keep the env-var compact AND to
  // avoid masking a same-name inherited entry from repo .opencode/config.json
  // — leaving inherited config alone is the v1 stance (docs/OPENCODE_CONFIG.md §6).
  const mcpMap: Record<string, Record<string, unknown>> = {}
  for (const m of mcps) {
    if (m.enabled === false) continue
    if (Object.hasOwn(mcpMap, m.name)) continue // closure dedupe; prototype names are valid keys
    mcpMap[m.name] = buildInlineMcpEntry(m)
  }
  if (Object.keys(mcpMap).length > 0) out.mcp = mcpMap
  // RFC-031: emit the plugin array only when at least one ENABLED entry
  // resolves. RFC-251 moved the encoding rules to `pluginSpec.ts` so all
  // OpenCode assembly paths share one implementation.
  const pluginArr = buildPluginSpecArray(plugins)
  if (pluginArr.length > 0) out.plugin = pluginArr
  return out
}

/**
 * Translate one DB-shape Mcp into the opencode-wire shape consumed by
 * `OPENCODE_CONFIG_CONTENT.mcp.<name>`:
 *   - Local : `command` array kept verbatim; `env` → `environment`;
 *             `timeoutMs` → `timeout`. **No `cwd` field** (opencode lacks it
 *             — stdio child cwd is taken from the opencode process directory
 *             = our worktree). See docs/OPENCODE_CONFIG.md §3.3.
 *   - Remote: `url` / `headers` / `oauth` kept verbatim; `timeoutMs` → `timeout`.
 *
 * Undefined fields are stripped so the resulting JSON does not include `null`
 * values that opencode's Effect Schema would reject.
 */
export function buildInlineMcpEntry(m: Mcp): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: m.type, enabled: m.enabled }
  if (m.type === 'local') {
    entry.command = m.config.command
    if (m.config.env !== undefined) entry.environment = m.config.env
    if (m.config.timeoutMs !== undefined) entry.timeout = m.config.timeoutMs
  } else {
    entry.url = m.config.url
    if (m.config.headers !== undefined) entry.headers = m.config.headers
    if (m.config.oauth !== undefined) entry.oauth = m.config.oauth
    if (m.config.timeoutMs !== undefined) entry.timeout = m.config.timeoutMs
  }
  return entry
}

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
import { toFileUrl } from '@/util/platform'

/** RFC-113: a profile that omits all params (the binary uses its own defaults). */
export const EMPTY_RUNTIME_PROFILE: RuntimeProfile = {
  model: null,
  variant: null,
  temperature: null,
  steps: null,
  maxSteps: null,
}

/**
 * RFC-073: global permission injected at the TOP LEVEL of OPENCODE_CONFIG_CONTENT
 * (not under any agent). opencode folds a top-level `permission` into
 * `config.permission` (config/config.ts), which `agent/agent.ts:124` reads as
 * `user` and merges into EVERY agent's ruleset (`:290` `merge(defaults, user)`).
 * Because `session/prompt.ts`'s `ctx.ask` and `session/llm.ts:resolveTools`
 * recompute the ruleset per-session from the CURRENT session's agent.permission,
 * this reaches the root AND every nested subagent — without relying on
 * opencode's subagent permission forwarding (subagent-permissions.ts only
 * forwards external_directory/deny, never allow).
 *
 *   "*": "allow"       — evaluate() (permission/evaluate.ts) returns allow for
 *                        every permission on every session, so `ask()` never
 *                        publishes `permission.asked`. Kills the subagent
 *                        deadlock: `opencode run`'s loop only replies to the
 *                        ROOT session's permission (cli/cmd/run.ts:708 skips
 *                        child sessions) and we have no reverse channel in CLI
 *                        mode, so a child's `permission.asked` would otherwise
 *                        block forever.
 *   "question": "deny" — Permission.disabled (permission/index.ts:293-302,
 *                        called from llm.ts:resolveTools) drops the `question`
 *                        tool from the model's tool list on every session, so
 *                        the agent can't invoke it → no `question.asked`
 *                        deadlock (run.ts has no question.asked handler at all).
 *                        Orthogonal to our own clarify flow, which travels via
 *                        the `<workflow-clarify>` envelope (shared/clarify.ts),
 *                        not opencode's question tool.
 *
 * ORDER IS LOAD-BEARING: `Permission.disabled` resolves a tool via `findLast`.
 * For `question` BOTH `{*,allow}` and `{question,deny}` match; the LAST wins.
 * `question` MUST stay AFTER `*` or it is not disabled. Locked by
 * runner-permission-inject.test.ts (serialization-order assertion).
 */
export const AW_GLOBAL_PERMISSION: Record<string, string> = {
  '*': 'allow',
  question: 'deny',
}

/**
 * RFC-073: strip any `question` key from an agent's own permission overrides
 * before injecting it under `agent.<name>.permission`. opencode merges the
 * per-agent permission LAST (agent.ts:306), so a `question: "allow"` there
 * would override the global `question: "deny"` from AW_GLOBAL_PERMISSION and
 * revive the deadlock-prone question tool. No product surface sets this today;
 * the guard is defensive + future-proof. Other keys pass through verbatim.
 */
function sanitizeInjectedAgentPermission(
  permission: Record<string, unknown>,
): Record<string, unknown> {
  if (!('question' in permission)) return permission
  const { question: _dropped, ...rest } = permission
  return rest
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
  // RUNTIME (resolved + frozen at dispatch), NOT from the agent or a node
  // override. The caller passes the resolved profile for THIS agent.
  params: RuntimeProfile = EMPTY_RUNTIME_PROFILE,
): Record<string, unknown> {
  const inlineAgent: Record<string, unknown> = {
    prompt: agent.bodyMd,
    description: agent.description,
    // RFC-073: drop any `question:"allow"` so it can't override the global
    // `question:"deny"` (AW_GLOBAL_PERMISSION) and revive the question tool.
    permission: sanitizeInjectedAgentPermission(agent.permission),
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
  /** RFC-073: global permission injected at the top level — see AW_GLOBAL_PERMISSION. */
  permission?: Record<string, string>
} {
  const map: Record<string, Record<string, unknown>> = {
    [agent.name]: buildInlineAgentEntry(agent, paramsByAgent.get(agent.name)),
  }
  for (const dep of dependents) {
    if (dep.name === agent.name) continue // root would shadow itself; defensive
    if (map[dep.name] !== undefined) continue // closure already deduped, but guard anyway
    map[dep.name] = buildInlineAgentEntry(dep, paramsByAgent.get(dep.name))
  }
  const out: {
    agent: Record<string, Record<string, unknown>>
    mcp?: Record<string, Record<string, unknown>>
    plugin?: Array<string | [string, Record<string, unknown>]>
    permission?: Record<string, string>
  } = { agent: map }
  // RFC-073: inject global permission at the TOP LEVEL of the inline config
  // (= OPENCODE_CONFIG_CONTENT) so opencode folds it into `config.permission`
  // → every agent + every nested subagent. Roots out the subagent
  // permission.asked / question.asked deadlock at the source. See
  // AW_GLOBAL_PERMISSION for the full mechanism + the load-bearing key order.
  out.permission = AW_GLOBAL_PERMISSION
  // RFC-028: emit the mcp record only when at least one ENABLED entry exists.
  // Disabled entries are skipped entirely to keep the env-var compact AND to
  // avoid masking a same-name inherited entry from repo .opencode/config.json
  // — leaving inherited config alone is the v1 stance (OPENCODE_CONFIG.md §6).
  const mcpMap: Record<string, Record<string, unknown>> = {}
  for (const m of mcps) {
    if (m.enabled === false) continue
    if (mcpMap[m.name] !== undefined) continue // closure dedupe
    mcpMap[m.name] = buildInlineMcpEntry(m)
  }
  if (Object.keys(mcpMap).length > 0) out.mcp = mcpMap
  // RFC-031: emit the plugin array only when at least one ENABLED entry
  // resolves. Dedupe by plugin.name (closure may visit the same plugin via
  // multiple agents). Each element is `file://<cachedPath>` so opencode's
  // `resolvePathPluginTarget` handles it without npm.
  const pluginArr: Array<string | [string, Record<string, unknown>]> = []
  const pluginSeen = new Set<string>()
  for (const p of plugins) {
    if (p.enabled === false) continue
    if (pluginSeen.has(p.name)) continue
    pluginSeen.add(p.name)
    const pathSpec = p.cachedPath.startsWith('file://') ? p.cachedPath : toFileUrl(p.cachedPath)
    const opts = p.options && Object.keys(p.options).length > 0 ? p.options : undefined
    pluginArr.push(opts === undefined ? pathSpec : [pathSpec, opts])
  }
  if (pluginArr.length > 0) out.plugin = pluginArr
  return out
}

/**
 * Translate one DB-shape Mcp into the opencode-wire shape consumed by
 * `OPENCODE_CONFIG_CONTENT.mcp.<name>`:
 *   - Local : `command` array kept verbatim; `env` → `environment`;
 *             `timeoutMs` → `timeout`. **No `cwd` field** (opencode lacks it
 *             — stdio child cwd is taken from the opencode process directory
 *             = our worktree). See OPENCODE_CONFIG.md §3.3.
 *   - Remote: `url` / `headers` / `oauth` kept verbatim; `timeoutMs` → `timeout`.
 *
 * Undefined fields are stripped so the resulting JSON does not include `null`
 * values that opencode's Effect Schema would reject.
 */
function buildInlineMcpEntry(m: Mcp): Record<string, unknown> {
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

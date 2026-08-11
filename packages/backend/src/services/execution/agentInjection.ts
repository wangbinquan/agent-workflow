// RFC-280 T1 — A 层注入装配：MCP 与 agent 定义的唯一「DB 形状 → 注入意图 / wire 形状」
// 实现。收敛自（对拍等价后原实现删除、原导出点 re-export 兼容）：
//   - runtime/opencode/inlineConfig.ts  buildInlineMcpEntry / buildInlineAgentEntry
//   - runtime/claudeCode/inject.ts      toClaudeMcpConfig 的 entry 构造
// DeclaredManifest 是启动验证层（RFC-280 T3）的输入；T1 先产 MCP 面字段，
// T2 扩 skills/subagents/plugins/tools/droppedParams/unsupported/unobservable。
//
// 身份语义（RFC-280 设计门 P1-1，与 scheduler 的 exact-identity 围栏同一裁决）：
//   - 同一 canonical id 的重复引用（闭包 union）→ 去重，first-seen 顺序保留；
//   - 不同 id 共享同一 runtime name 且都 enabled → 抛错。生产路径已被
//     `prepareNodeRunInjection`（scheduler.ts）在 spawn 前挡下；这里是防御断言，
//     绝不允许「先见者赢」把 A owner 的服务静默替换成 B owner 的同名服务；
//   - disabled 行不参与冲突判定，进入 declared.skippedDisabledMcps（落差③：
//     不再静默丢弃，T3 起在节点告警面可见）。
//
// Leaf module：只 type-import shared 与 RuntimeProfile —— 不得引入对
// driver / runner / scheduler 的运行时依赖（会成环）。

import type { Agent, Mcp } from '@agent-workflow/shared'
import type { RuntimeProfile } from '@/services/runtimeRegistry'

export class AgentInjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AgentInjectionError'
  }
}

/** RFC-113: a profile that omits all params (the binary uses its own defaults). */
export const EMPTY_RUNTIME_PROFILE: RuntimeProfile = {
  model: null,
  variant: null,
  temperature: null,
  steps: null,
  maxSteps: null,
  isSandbox: false,
}

/** T1 字段集；后续任务按 design.md §2.1 扩展。 */
export interface DeclaredManifestV1 {
  /** 实际注入的 enabled MCP 名单，first-seen 顺序（= wire 键序）。 */
  mcpServers: string[]
  /** 被引用但 disabled 的 MCP 名单（忠实记录，含重复引用）。 */
  skippedDisabledMcps: string[]
}

export interface McpInjectionPartition {
  /** enabled ∩ 同 id 去重后的注入集，first-seen 顺序。 */
  injected: Mcp[]
  declared: DeclaredManifestV1
}

/**
 * 分拣一个 MCP 引用集合为「注入集 + 声明清单」。
 *
 * 与被收敛的两处旧循环（inlineConfig.ts / inject.ts 各自的
 * `enabled === false → continue; Object.hasOwn(map, name) → continue`）对合法
 * 输入字节等价；唯一的行为差异是防御分支——不同 id 同 enabled name 从
 * 「静默 first-wins」变为抛错（P1-1，见文件头）。
 */
export function partitionMcpsForInjection(mcps: readonly Mcp[]): McpInjectionPartition {
  const injected: Mcp[] = []
  const skippedDisabledMcps: string[] = []
  // Map keys avoid the Object-prototype trap: `constructor` is a valid MCP name.
  const seenByName = new Map<string, Mcp>()
  for (const m of mcps) {
    if (m.enabled === false) {
      skippedDisabledMcps.push(m.name)
      continue
    }
    const seen = seenByName.get(m.name)
    if (seen !== undefined) {
      if (seen.id === m.id) continue // closure union 的同 id 重复引用
      throw new AgentInjectionError(
        'agent-injection-duplicate-mcp-name',
        `two different MCP resources share the runtime name '${m.name}' ` +
          `(ids: ${String(seen.id)}, ${String(m.id)}); injecting either would ` +
          `silently substitute the other — refusing to spawn`,
      )
    }
    seenByName.set(m.name, m)
    injected.push(m)
  }
  return {
    injected,
    declared: {
      mcpServers: injected.map((m) => m.name),
      skippedDisabledMcps,
    },
  }
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
 * URL userinfo（内嵌凭据）不做拒绝——RFC-280 用户裁决「配凭据是个人选择」。
 */
export function renderOpencodeMcpEntry(m: Mcp): Record<string, unknown> {
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

/**
 * Translate one DB-shape Mcp into Claude Code's `--mcp-config` server entry:
 *   { command, args, env } for local （`[cmd, ...args]` 数组拆分）；
 *   { type:'http', url, headers } for remote.
 */
export function renderClaudeMcpServerEntry(m: Mcp): Record<string, unknown> {
  if (m.type === 'local') {
    const command = Array.isArray(m.config.command) ? m.config.command : []
    const entry: Record<string, unknown> = { command: command[0] ?? '', args: command.slice(1) }
    if (m.config.env !== undefined) entry.env = m.config.env
    return entry
  }
  const entry: Record<string, unknown> = { type: 'http', url: m.config.url }
  if (m.config.headers !== undefined) entry.headers = m.config.headers
  return entry
}

export interface McpInjectionRender {
  /** wire 键值表；无 enabled 条目时为 null（claude 调用方以此省略 --mcp-config）。 */
  entries: Record<string, Record<string, unknown>> | null
  declared: DeclaredManifestV1
}

function renderMcpInjection(
  mcps: readonly Mcp[],
  renderEntry: (m: Mcp) => Record<string, unknown>,
): McpInjectionRender {
  const { injected, declared } = partitionMcpsForInjection(mcps)
  if (injected.length === 0) return { entries: null, declared }
  const entries: Record<string, Record<string, unknown>> = {}
  for (const m of injected) {
    entries[m.name] = renderEntry(m)
  }
  return { entries, declared }
}

/** opencode `OPENCODE_CONFIG_CONTENT.mcp` 的完整渲染（分拣 + 逐条 wire 形状）。 */
export function renderOpencodeMcpInjection(mcps: readonly Mcp[]): McpInjectionRender {
  return renderMcpInjection(mcps, renderOpencodeMcpEntry)
}

/** claude `--mcp-config.mcpServers` 的完整渲染（分拣 + 逐条 wire 形状）。 */
export function renderClaudeMcpInjection(mcps: readonly Mcp[]): McpInjectionRender {
  return renderMcpInjection(mcps, renderClaudeMcpServerEntry)
}

/**
 * RFC-022: build the inline-agent JSON for one agent. Pulled out so the
 * primary agent and every closure dependent share one definition formula;
 * the only difference is that dependents pass `overrides = {}` so per-node
 * model/variant/temperature tweaks only apply to the selected primary.
 */
export function renderOpencodeAgentEntry(
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

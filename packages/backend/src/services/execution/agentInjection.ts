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

import type { Agent, DeclaredInjectionManifest, Mcp, Plugin } from '@agent-workflow/shared'
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

/**
 * design.md §2.1 的声明清单。T1 落 MCP 面；T2 扩其余资源面；T3 起持久化形状由
 * shared `DeclaredInjectionManifestSchema` 锁定（前后端单一事实源），此处仅为
 * 既有 import 面保留的别名。
 */
export type DeclaredManifestV1 = DeclaredInjectionManifest

/**
 * Runtime-only plugin projection. Persistence may provide the historical
 * cached path while Resource Catalog provides an already-normalized file
 * specifier; spawn assembly consumes exactly one locator and never a row.
 */
export type RuntimePlugin = Pick<Plugin, 'id' | 'name' | 'options' | 'enabled'> &
  (
    | { readonly cachedPath: string; readonly runtimeSpecifier?: never }
    | { readonly runtimeSpecifier: string; readonly cachedPath?: never }
  )

/** 全空 manifest —— 各渲染路径在此之上按面填充。 */
export function emptyDeclaredManifest(): DeclaredManifestV1 {
  return {
    mcpServers: [],
    skippedDisabledMcps: [],
    skills: [],
    subagents: [],
    plugins: [],
    tools: null,
    droppedParams: [],
    unsupported: [],
    unobservable: [],
  }
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
      ...emptyDeclaredManifest(),
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
    // The author's explicit permission map. RFC-281 revises RFC-276's "the
    // author's map is the ONLY platform overlay": the workspace boundary adds
    // exactly one platform rule (`external_directory`), composed by
    // `composeOpencodeBoundary` in the OPENCODE assembly (inlineConfig.ts) —
    // this renderer still emits the author's map verbatim, and the boundary is
    // layered on top there. Everything else is unchanged: OpenCode's own
    // `--auto` semantics handle operations nobody declared.
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

// ---------------------------------------------------------------------------
// RFC-280 T2 — declaration helpers（纯函数；物理 staging / 文件物化留在 driver 渲染侧）
// ---------------------------------------------------------------------------

/** 平台实际 stage 的 skill 名单（managed only —— project 由 CLI 自发现）。 */
/** RFC-282 B4 — THE managed-skill predicate (was inlined 4× across drivers). */
export function managedSkillsOf<T extends { sourceKind: string }>(skills: readonly T[]): T[] {
  return skills.filter((s) => s.sourceKind === 'managed')
}

export function declareSkills(skills: readonly { name: string; sourceKind: string }[]): string[] {
  return managedSkillsOf(skills).map((s) => s.name)
}

/** dependsOn 闭包注入的 subagent 名单（root 除外、first-seen 去重）——两个 runtime 同一声明。 */
export function declareSubagents(rootName: string, dependents: readonly Agent[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dep of dependents) {
    if (dep.name === rootName) continue
    if (seen.has(dep.name)) continue
    seen.add(dep.name)
    out.push(dep.name)
  }
  return out
}

/** enabled plugin 名单——opencode 注入面；claude 调用方转 unsupported。
 * RFC-282 B4（去重键统一）：按 **id** 去重，与 `selectShippedPlugins`（实际
 * ship 集）同键。旧版按 name 去重 ⇒ 同名异 id 时注入 2 个、声明 1 个，启动
 * 验证漏判——声明必须描述 exactly the shipped set（RFC-251 同理）。 */
export function declarePlugins(plugins: readonly RuntimePlugin[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of plugins) {
    if (p.enabled === false) continue
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p.name)
  }
  return out
}

/** RFC-282 B4 — THE memory-block weave (was inlined in both drivers with the
 *  same template; two spellings of one seam is how they drift). */
export function weaveMemoryBlock(text: string, block: string): string {
  return `${text}\n\n${block}`
}

/**
 * 落差④：claude 渲染只消费 profile.model —— variant/temperature/steps/maxSteps
 * 一律静默丢弃（claudeCode/driver.ts 历史行为）。这里把「丢了什么」显式化，
 * T3 起进 spawn 日志 warn + 节点告警面。
 */
export function deriveClaudeDroppedParams(profile: RuntimeProfile): string[] {
  const dropped: string[] = []
  if (profile.variant !== null) dropped.push('variant')
  if (profile.temperature !== null) dropped.push('temperature')
  if (profile.steps !== null) dropped.push('steps')
  if (profile.maxSteps !== null) dropped.push('maxSteps')
  return dropped
}

// ---------------------------------------------------------------------------
// claude subagent（--agents）条目渲染 —— RFC-280 T2 自 claudeCode/inject.ts 移入
//（原名 toClaudeAgents；inject.ts re-export 兼容既有 import 面）。
// ---------------------------------------------------------------------------

/** One `--agents` entry. `model`/`tools` are omitted rather than nulled — an
 *  absent key means "claude's own default", which is not the same as a value. */
export interface ClaudeAgentEntry {
  description: string
  prompt: string
  model?: string
  tools?: string[]
}

export interface ClaudeAgentsOpts {
  /** RFC-282 B4 — excluded from rendering (symmetry with declareSubagents). */
  rootName?: string
  /**
   * 2026-08-09 — RFC-113 profile per agent NAME, i.e. exactly
   * `BusinessNodeSpawnContext.resolvedParamsByAgent`, whose contract already
   * says "live-resolved for each dependent". OpenCode has consumed the
   * per-dependent model since RFC-251; Claude previously dropped it, so every
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
  /**
   * RFC-280 T2 依赖注入：dependent 自身 permission → tool 载入集的映射
   * （生产恒为 claudeCode/permissionMap 的 `claudeBusinessGate` —— 保持单点；
   * 以参数传入避免 A 层对 claude 专属模块的硬依赖）。
   */
  gateOf: (permission: Agent['permission'] | undefined) => { tools: readonly string[] } | null
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
export function renderClaudeSubagentEntries(
  dependents: readonly Agent[],
  opts: ClaudeAgentsOpts,
): { agents: Record<string, ClaudeAgentEntry>; warnings: readonly string[] } | null {
  const agents: Record<string, ClaudeAgentEntry> = {}
  const warnings: string[] = []
  const parentTools = opts.parentTools
  for (const dep of dependents) {
    // RFC-282 B4 — root-exclusion symmetry with declareSubagents: the closure
    // already excludes the root, but the declaration side skipped it and this
    // renderer did not — an injected-but-undeclared entry the moment any
    // caller passes a root-bearing list.
    if (opts.rootName !== undefined && dep.name === opts.rootName) continue
    if (Object.hasOwn(agents, dep.name)) continue
    const entry: ClaudeAgentEntry = { description: dep.description, prompt: dep.bodyMd }
    const model = opts.profileByName?.get(dep.name)?.model
    if (typeof model === 'string' && model.length > 0) entry.model = model
    // Only a parent WITH a load set can express a member load set; an
    // unconstrained parent keeps the byte-exact historical entry shape.
    if (parentTools != null) {
      const ceiling = parentTools.filter((tool) => tool !== NESTED_DELEGATION_TOOL)
      const gate = opts.gateOf(dep.permission)
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

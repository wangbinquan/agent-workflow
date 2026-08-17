// RFC-271 T8 / T12b —— `BundleApply` 引擎的 provider 契约与依赖规划器。
//
// 场景差异全部收进 `BundleApplyProvider`：引擎本体既不认识 intent 也不认识配置包。
// 它只知道「一串 op、一套解析钩子、一个执行身份」。
//
// ⚠️ **`serializationKey` 与 `idempotencyKey.scope` 是两回事**（invariants I1）。
// 源码按 `sessionId` 串行（`applyChangeset.ts:201` `withSessionApplyLock`）——即**按
// 资源实例**串行，不是按命名空间。配置包若直接拿常量 `scope:'package'` 当串行键，
// 所有导入会全局串行：Alice 一个慢 npm 安装堵死 Bob 完全无关的纯 agent 包。

import type { AclResourceType, BundleResourceType } from '@agent-workflow/shared'
import type { BundleOp, BundleOpKind, ResourceBundle } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbTxSync } from '@/db/txSync'

/** journal 的四态。 */
export type BundleApplyState = 'prepared' | 'applying' | 'committed' | 'failed'

export interface BundleAppliedOp {
  opId: string
  resourceType: AclResourceType
  resourceId: string
  action: 'create' | 'update'
  name: string
}

export interface BundleReceiptRoot {
  resourceType: AclResourceType
  resourceId: string
  name: string
  action: 'create' | 'update' | 'reuse'
}

export interface BundleSkippedSecret {
  resourceType: string
  resourceName: string
  field: string
}

export interface BundleReceipt {
  journalId: string
  applied: BundleAppliedOp[]
  /** Package adapters fill this in finalizeInTx; generic bundles may omit it. */
  root?: BundleReceiptRoot
  /** Credential positions intentionally left empty by the importer. */
  skippedSecrets?: BundleSkippedSecret[]
}

/**
 * 补偿 oracle 的条目（I14 record-before-act）：**外部副作用落地之前**写进
 * journal，让崩溃后的收敛器能精确删掉它。
 *
 * ⚠️ 插件那条必须带 `generationId`：只记 `{pluginId}` 不够——粗粒度 GC 会被任一
 * 非终态 node run 完全挡住，于是目录永久残留且 journal 无法证明补偿完成。
 * 这要求调用方**预铸** generation id 再调 installer。
 */
/**
 * `StagedSkillVersion` 的结构镜像。这里**不** import 那个类型：provider 是引擎与
 * 场景之间的契约层，把技能版本模块拖进来会让两边的依赖方向反过来。字段对不上会在
 * `apply.ts` 的赋值处直接编译失败——那正是想要的检查点。
 */
export interface StagedSkillVersionLike {
  skillId: string
  skillName: string
  opId: string | null
  publishId: string
  newVersion: number
  newHash: string
  filesDir: string
  versionDir: string
  stagingDir: string
  noop: unknown
}

export type BundleArtifact =
  | { kind: 'skill-stage'; skillId: string; opId: string; skillDir: string }
  /**
   * 整个 `StagedSkillVersion` 都要落库，不只是补偿用得到的那三个字段。
   *
   * 补偿（abort）只需要 `stagingDir`，但 **committed 之后的重放需要 publish**，而
   * publish 要的是完整结构（newVersion / newHash / filesDir / versionDir …）。只记
   * 三个字段的话，一次「DB 已提交、publish 前崩溃」的 run 永远补不上那次 publish
   * ——收敛器看得见这条 committed 行，却没有足够信息把它推完。
   */
  | { kind: 'skill-version-stage'; staged: StagedSkillVersionLike }
  | { kind: 'plugin-install'; pluginId: string; generationId: string; generationDir: string }

export interface BundleApplyProvider {
  /** 幂等身份。配置包：`{scope:'package', key:importId}`，由客户端持有并重放。 */
  readonly idempotencyKey: { scope: string; key: string }
  /**
   * **串行键**——粒度由 provider 自己定（建议按目标资源集合），与幂等 namespace
   * 无关。见文件头的警告。
   */
  readonly serializationKey: string
  /** 执行身份。owner 归属与全部授权判据都从它出。 */
  readonly actor: Actor
  /** 解析 `external:<token>` → 本地资源 id（含类型校验）。`name:` 形态不走这里。 */
  resolveExternal(ref: string, expectType: AclResourceType): Promise<string>
  /** 技能文件载体：配置包从 zip 取，intent 从内联句柄取。 */
  readSkillFile(ref: string): Uint8Array
  /**
   * 工作组的 human 成员：包里带的是源实例的 **username**，本机的 `user_id` 与它
   * 没有任何关系。返回本地 user id，或 `null` = 该成员不加入。
   *
   * 缺省实现（intent 场景没有这一步）等价于「全部不加入」。配置包侧只对最终
   * new / overwrite 的工作组按 `(workgroupSlug, username)` 强制拍板并校验；reuse
   * 不写 roster，因此既不要求也不消费映射。
   */
  resolveHumanMember?(workgroupSlug: string, username: string): string | null
  /**
   * 框架 built-in 按**名字**绑到本实例自己 seed 的那一个。包里的 built-in 没有
   * create op（导入侧自动忽略），引用靠这条解析；返回 null ⇒ 环境前提缺失。
   */
  resolveBuiltin?(type: AclResourceType, name: string): Promise<string | null>

  // ── 事务钩子。三个都在**同一个** big tx 内被调用（I7 / I13）。 ──
  /** claim 事务内的场景特有校验（intent 的 draft revision/hash）。 */
  claimInTx?(tx: DbTxSync): void
  /**
   * CAS `prepared→applying` **之后**、任何 commit 内核**之前**（I6）。
   * pre-stage 窗口（npm 安装 / 技能暂存）足够长，claim 期的校验会过期；配置包在
   * 这里做 reuse 目标的内容复核（selectedExternalFence）。
   */
  revalidateInTx?(tx: DbTxSync): void
  /** 资源写之后、journal 置 committed **之前**，同事务（I7）。 */
  finalizeInTx?(tx: DbTxSync, receipt: BundleReceipt): void
}

// --- T12b 依赖规划器 ---------------------------------------------------------

const RESOURCE_OF_KIND: Record<BundleOpKind, BundleResourceType> = {
  'agent-create': 'agent',
  'agent-update': 'agent',
  'skill-create': 'skill',
  'skill-update': 'skill',
  'mcp-create': 'mcp',
  'mcp-update': 'mcp',
  'plugin-create': 'plugin',
  'plugin-update': 'plugin',
  'workflow-create': 'workflow',
  'workflow-update': 'workflow',
  'workgroup-create': 'workgroup',
  'workgroup-update': 'workgroup',
  'capability-framework-create': 'capability_template',
  'capability-framework-update': 'capability_template',
  'capability-binding-create': 'capability_template',
  'capability-binding-update': 'capability_template',
  'capability-template-create': 'capability_template',
  'capability-template-update': 'capability_template',
}

export function resourceTypeOfOp(op: BundleOp): BundleResourceType {
  return RESOURCE_OF_KIND[op.kind]
}

export function opAction(op: BundleOp): 'create' | 'update' {
  return op.kind.endsWith('-create') ? 'create' : 'update'
}

/** create op 的 bundle 内标识；update op 没有 slug。 */
export function opSlug(op: BundleOp): string | null {
  return 'slug' in op ? op.slug : null
}

/**
 * 类型序（I4，照抄 `resolveChangeset.ts:651-665`，**别自己重排**）：
 * skills → mcps → plugins → agents → wf/wg。
 * 理由是引用方向：agent 引用技能/MCP/插件，工作流与工作组引用 agent。
 */
const TYPE_RANK: Record<BundleResourceType, number> = {
  skill: 0,
  mcp: 1,
  plugin: 2,
  agent: 3,
  workflow: 4,
  workgroup: 4,
  // RFC-304: a framework references nothing, so it only has to precede the
  // bindings that name it. A binding references BOTH its framework and the
  // agents filling its slots, so it sorts after agents (3) and after the
  // framework — the same reference-direction rule as everything above, not a
  // preference.
  capability_template: 4,
}

export class BundleCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`agent dependsOn forms a cycle within the bundle: ${cycle.join(' → ')}`)
    this.name = 'BundleCycleError'
  }
}

/** `local:<slug>` → slug；其余（external / project / name）返回 null。 */
export function localSlugOf(ref: string): string | null {
  return ref.startsWith('local:') ? ref.slice('local:'.length) : null
}

/**
 * 排序 op：类型序，agent 组内再按**同 bundle 内**的 `dependsOn` 拓扑。
 *
 * ⚠️ 只统计同 bundle 内的依赖（`localSlugOf` 命中且该 slug 确实是本包的 agent
 * create/update 目标）——指向库里既有 agent 的 `external:` 依赖已经存在，不构成
 * 本次的排序约束。这与 `resolveChangeset.ts` 的
 * `.filter((id) => resolved.some((o) => o.resourceId === id))` 同义。
 *
 * 闭环给出**确定的**拒绝点：环里字典序最小的 slug 起头，让错误信息可复现。
 */
export function planBundleOps(ops: readonly BundleOp[]): BundleOp[] {
  const bySlug = new Map<string, BundleOp>()
  for (const op of ops) {
    const slug = opSlug(op)
    if (slug !== null) bySlug.set(slug, op)
  }

  // agent 组的同包依赖图
  const agentSlugs = new Set<string>()
  for (const [slug, op] of bySlug) {
    if (resourceTypeOfOp(op) === 'agent') agentSlugs.add(slug)
  }
  const deps = new Map<string, string[]>()
  for (const slug of agentSlugs) {
    const op = bySlug.get(slug)
    if (op === undefined) continue
    const payload = op.payload as { dependsOn?: unknown }
    const list = Array.isArray(payload.dependsOn) ? payload.dependsOn : []
    const inBundle: string[] = []
    for (const ref of list) {
      if (typeof ref !== 'string') continue
      const target = localSlugOf(ref)
      if (target !== null && agentSlugs.has(target)) inBundle.push(target)
    }
    deps.set(slug, inBundle.sort())
  }

  // 三色 DFS：被依赖者先出（依赖在前）。确定性靠 slug 字典序入口。
  const depthBySlug = new Map<string, number>()
  const state = new Map<string, 'gray' | 'black'>()
  const stack: string[] = []
  const visit = (slug: string): number => {
    const done = depthBySlug.get(slug)
    if (done !== undefined) return done
    if (state.get(slug) === 'gray') {
      const start = stack.indexOf(slug)
      throw new BundleCycleError([...stack.slice(start), slug])
    }
    state.set(slug, 'gray')
    stack.push(slug)
    let depth = 0
    for (const child of deps.get(slug) ?? []) depth = Math.max(depth, visit(child) + 1)
    stack.pop()
    state.set(slug, 'black')
    depthBySlug.set(slug, depth)
    return depth
  }
  for (const slug of [...agentSlugs].sort()) visit(slug)

  // 稳定排序：类型序 → agent 依赖深度 → 原始声明序。
  return [...ops]
    .map((op, index) => ({ op, index }))
    .sort((a, b) => {
      const ra = TYPE_RANK[resourceTypeOfOp(a.op)]
      const rb = TYPE_RANK[resourceTypeOfOp(b.op)]
      if (ra !== rb) return ra - rb
      const sa = opSlug(a.op)
      const sb = opSlug(b.op)
      const da = sa === null ? 0 : (depthBySlug.get(sa) ?? 0)
      const db = sb === null ? 0 : (depthBySlug.get(sb) ?? 0)
      if (da !== db) return da - db
      return a.index - b.index
    })
    .map((e) => e.op)
}

/**
 * I5 pending seams —— 预铸 id **必须早于 preflight**：各 prepare* 内核要靠这两个
 * 集合接受「同 bundle 内还没落库的目标」，否则一个引用同包新建 agent 的工作组会
 * 在 preflight 就报引用不存在。
 */
export interface BundlePendingSeams {
  /** 本次将要创建的资源 id（预铸值，不是名字）。 */
  pendingBundleIds: Set<string>
  /** 预铸 agent id → 它将要落库的名字。 */
  pendingAgentNames: Map<string, string>
}

export function pendingSeamsFor(
  ops: readonly BundleOp[],
  idOfSlug: (slug: string) => string,
): BundlePendingSeams {
  const pendingBundleIds = new Set<string>()
  const pendingAgentNames = new Map<string, string>()
  for (const op of ops) {
    const slug = opSlug(op)
    if (slug === null) continue // update 目标已在库里，不属于 pending
    const id = idOfSlug(slug)
    pendingBundleIds.add(id)
    if (resourceTypeOfOp(op) === 'agent') {
      const name = (op.payload as { name?: unknown }).name
      if (typeof name === 'string') pendingAgentNames.set(id, name)
    }
  }
  return { pendingBundleIds, pendingAgentNames }
}

/** 引擎入口的输入。 */
export interface BundleApplyInput {
  bundle: ResourceBundle
  provider: BundleApplyProvider
}

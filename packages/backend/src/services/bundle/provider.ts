// RFC-271 依赖规划与生产回执合同；RFC-395 II-pre 删除未接线的 BundleApply 合同。
import type { AclResourceType, BundleResourceType } from '@agent-workflow/shared'
import type { BundleOp, BundleOpKind } from '@agent-workflow/shared'

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
 * RFC-401 A1：包内依赖环不在这里拒绝（此前抛普通 Error，落成 `internal-error`）。环上的 agent 与依赖它们的 agent
 * 排在其余 agent 之后、保持声明序；唯一的 agent 写入参与者以本包最终 dependsOn 校验，报与普通编辑相同的
 * `agent-dependency-self` / `agent-dependency-cycle`。
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

  // 三色 DFS：被依赖者先出（依赖在前）。确定性靠 slug 字典序入口。回边（环）的深度记为无穷：环上的 agent 与依赖
  // 它们的 agent 一起排到最后，组内按声明序。
  const depthBySlug = new Map<string, number>()
  const state = new Map<string, 'gray' | 'black'>()
  const visit = (slug: string): number => {
    const done = depthBySlug.get(slug)
    if (done !== undefined) return done
    if (state.get(slug) === 'gray') return Number.POSITIVE_INFINITY
    state.set(slug, 'gray')
    let depth = 0
    for (const child of deps.get(slug) ?? []) depth = Math.max(depth, visit(child) + 1)
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

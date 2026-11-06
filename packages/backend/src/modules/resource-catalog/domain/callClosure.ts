// RFC-454 — the stored call-closure codec (`tasks.ref_closure_json`): the frozen snapshot of the resource-catalog
// definitions (workflows, workgroups) a call tree launches with. Moved verbatim from task-execution's
// `infrastructure/legacyCallClosure.ts` (which keeps the freeze walk that reads the rows): resource-catalog's workflow
// validator and task-execution's child launches both read it, and resource-catalog → task-execution is not a target
// DAG edge (the validator used to reach it through `services/execution/closure`). Pure: shared types only.

import type { z } from 'zod'
import {
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  migrateWorkflowDefinitionToLatest,
  WorkflowDefinitionSchema,
  WorkgroupSchema,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

export interface FrozenWorkflowRef {
  id: string
  version: number
  definition: WorkflowDefinition
}

/** RFC-243 PR-4 — a frozen workgroup RESOURCE row (member roster included).
 *  Stored opaquely: the frozen-launch face re-derives the runtime config via
 *  buildWorkgroupRuntimeConfig(group, renderedGoal) at call time, so the
 *  closure never bakes a goal in. Workgroups are closure LEAVES (the dw
 *  validator rejects call nodes in generated DAGs).
 *
 *  RFC-454 — `group` is typed as the launch-relevant shape the freeze writes (task-execution's
 *  `taskExecutionCallClosure` stores exactly that snapshot) instead of `unknown`, so the codec's public
 *  entries carry a closed type. Decoding only checks that it is an object; the launch still re-validates it
 *  with `parseFrozenWorkgroupGroup` (older closures carry the row metadata, which that strips). */
export interface FrozenWorkgroupRef {
  id: string
  version: number
  group: FrozenWorkgroupGroup
}

/**
 * The exact shape a frozen workgroup is stored in and re-validated against.
 *
 * RFC-345 narrowed the frozen snapshot to the launch-relevant fields
 * (`TaskExecutionWorkgroupSnapshot`), so a stored closure carries no
 * `schemaVersion` / `createdAt` / `updatedAt` row metadata. Validating the
 * payload with the full row `WorkgroupSchema` therefore rejects every
 * call-workgroup child launch — a `child-launch-failed` on three "Required"
 * issues that never reach the roster. Older closures that still carry the row
 * metadata keep parsing: zod strips the extra keys.
 */
export const FrozenWorkgroupGroupSchema = WorkgroupSchema.omit({
  schemaVersion: true,
  createdAt: true,
  updatedAt: true,
})
export type FrozenWorkgroupGroup = z.infer<typeof FrozenWorkgroupGroupSchema>

/**
 * RFC-271 T6e（决策 28）—— 冻结结果按**边**键控，不再按名字。
 *
 * v1（无 `closureVersion`）是 `Record<name, ref>`：同名两个 call 节点落到同一条，
 * 于是「用户在下拉里选的那个」被静默丢弃。v2 的 key 是 `sourceWorkflowId#nodeId`。
 *
 * ⚠️ **不能只用 nodeId**：节点 id 只在**单份 definition 内**唯一
 * （`workflow.validator.ts` 只查单份内重复），传递闭包里两个不同工作流都用
 * `call-1` 是合法的，扁平 `Record<nodeId,…>` 必有一条被覆盖。
 *
 * **存量任务零影响**：`parseCallClosure` 同时接受两种形状，消费端对 v1 回退按名字取。
 */
export interface FrozenCallClosure {
  /** 缺席 = v1（name-keyed）。 */
  closureVersion?: 2
  workflows: Record<string, FrozenWorkflowRef>
  workgroups: Record<string, FrozenWorkgroupRef>
}

/** v2 的边键。source 在两层都是现成的：根启动传 `root.id`，子层传 `frozen.id`。 */
export function callEdgeKey(sourceWorkflowId: string, nodeId: string): string {
  return `${sourceWorkflowId}#${nodeId}`
}

/** Parse a stored closure JSON. Returns null for NULL/corrupt (callers fail
 *  closed with `workflow-call-ref-missing` at the consumption site). */
export function parseCallClosure(json: string | null): FrozenCallClosure | null {
  if (json === null || json === '') return null
  try {
    const parsed = JSON.parse(json) as { workflows?: unknown }
    if (typeof parsed !== 'object' || parsed === null) return null
    const rawWorkflows = parsed.workflows
    if (typeof rawWorkflows !== 'object' || rawWorkflows === null) return null
    const version = (parsed as { closureVersion?: unknown }).closureVersion
    const out: FrozenCallClosure =
      version === 2
        ? { closureVersion: 2, workflows: {}, workgroups: {} }
        : { workflows: {}, workgroups: {} }
    for (const [name, ref] of Object.entries(rawWorkflows as Record<string, unknown>)) {
      const r = ref as { id?: unknown; version?: unknown; definition?: unknown }
      if (typeof r.id !== 'string' || typeof r.version !== 'number') return null
      const def = WorkflowDefinitionSchema.safeParse(r.definition)
      if (!def.success) return null
      out.workflows[name] = {
        id: r.id,
        version: r.version,
        definition: migrateWorkflowDefinitionToLatest(def.data),
      }
    }
    const rawWorkgroups = (parsed as { workgroups?: unknown }).workgroups
    if (rawWorkgroups !== undefined) {
      if (typeof rawWorkgroups !== 'object' || rawWorkgroups === null) return null
      for (const [name, ref] of Object.entries(rawWorkgroups as Record<string, unknown>)) {
        const r = ref as { id?: unknown; version?: unknown; group?: unknown }
        if (typeof r.id !== 'string' || typeof r.version !== 'number') return null
        if (typeof r.group !== 'object' || r.group === null) return null
        out.workgroups[name] = {
          id: r.id,
          version: r.version,
          group: r.group as FrozenWorkgroupGroup,
        }
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * 按**边**取冻结项；v1 存量闭包回退按名字取（零迁移）。
 * `source` 缺席时也走 v1 路径——调用方尚未拿到 source id 的过渡形态。
 */
export function frozenWorkflowFromClosure(
  closureJson: string | null,
  name: string,
  source?: { workflowId: string; nodeId: string },
): FrozenWorkflowRef | null {
  const closure = parseCallClosure(closureJson)
  if (closure === null) return null
  if (closure.closureVersion === 2 && source !== undefined) {
    return closure.workflows[callEdgeKey(source.workflowId, source.nodeId)] ?? null
  }
  return closure.workflows[name] ?? null
}

export function frozenWorkgroupFromClosure(
  closureJson: string | null,
  name: string,
  source?: { workflowId: string; nodeId: string },
): FrozenWorkgroupRef | null {
  const closure = parseCallClosure(closureJson)
  if (closure === null) return null
  if (closure.closureVersion === 2 && source !== undefined) {
    return closure.workgroups[callEdgeKey(source.workflowId, source.nodeId)] ?? null
  }
  return closure.workgroups[name] ?? null
}

/**
 * The closure subset a CHILD task passes down to its own grandchildren: every
 * entry except definitions unreachable from the child's definition. Keeping
 * the exact reachable set (BFS over the frozen graph, no DB) preserves the
 * recursion invariant "a task's closure covers its own call nodes".
 */
export function childClosureSubset(
  closureJson: string | null,
  childDefinition: WorkflowDefinition,
  /** RFC-271 T6e：v2 闭包按边键控，子集裁剪因此需要**子工作流自己的 id** 当 source。
   *  缺席 ⇒ 走 v1 按名字路径（存量任务）。调用点持有 `frozen.id`。 */
  childWorkflowId?: string,
): string | null {
  const closure = parseCallClosure(closureJson)
  if (closure === null) return null
  childDefinition = migrateWorkflowDefinitionToLatest(childDefinition)
  const v2 = closure.closureVersion === 2 && childWorkflowId !== undefined
  const kept: FrozenCallClosure = v2
    ? { closureVersion: 2, workflows: {}, workgroups: {} }
    : { workflows: {}, workgroups: {} }

  const keepWorkgroupsOf = (defn: WorkflowDefinition, sourceId: string | undefined): void => {
    for (const ref of collectWorkgroupCallRefs(defn)) {
      if (v2 && sourceId !== undefined) {
        const key = callEdgeKey(sourceId, ref.nodeId)
        const g = closure.workgroups[key]
        if (g !== undefined) kept.workgroups[key] = g
        continue
      }
      const g = closure.workgroups[ref.workgroupName]
      if (g !== undefined) kept.workgroups[ref.workgroupName] = g
    }
  }

  keepWorkgroupsOf(childDefinition, childWorkflowId)

  // v2 按边 BFS；v1 保持原来的按名 BFS（存量闭包里没有边键可用）。
  const queue: Array<{
    sourceId: string | undefined
    ref: { nodeId: string; workflowName: string }
  }> = collectWorkflowCallRefs(childDefinition).map((r) => ({ sourceId: childWorkflowId, ref: r }))
  const seen = new Set<string>()
  while (queue.length > 0) {
    const item = queue.shift()!
    const key =
      v2 && item.sourceId !== undefined
        ? callEdgeKey(item.sourceId, item.ref.nodeId)
        : item.ref.workflowName
    if (seen.has(key)) continue
    seen.add(key)
    const ref = closure.workflows[key]
    if (ref === undefined) continue // consumption site fails closed later
    kept.workflows[key] = ref
    keepWorkgroupsOf(ref.definition, v2 ? ref.id : undefined)
    for (const next of collectWorkflowCallRefs(ref.definition)) {
      queue.push({ sourceId: v2 ? ref.id : undefined, ref: next })
    }
  }
  return Object.keys(kept.workflows).length === 0 && Object.keys(kept.workgroups).length === 0
    ? null
    : JSON.stringify(kept)
}

/** RFC-454 — re-validate a stored frozen workgroup against its launch-relevant shape (row metadata stripped): the
 *  stored JSON was only shape-checked when the closure was decoded. The schema itself stays inside resource-catalog. */
export function parseFrozenWorkgroupGroup(group: FrozenWorkgroupGroup): FrozenWorkgroupGroup {
  return FrozenWorkgroupGroupSchema.parse(group)
}

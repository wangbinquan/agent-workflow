// RFC-243 §3.1 — the launch-time reference-closure freeze.
//
// A parent task whose definition contains call nodes freezes EVERY transitively
// referenced workflow definition (by authoritative NAME selector) into
// `tasks.ref_closure_json` at launch. Runtime never re-reads the referenced
// resource rows (D9): edits/deletes after launch cannot change a running tree,
// and grandchildren inherit the relevant subset instead of resolving live.
//
// The walk doubles as the authoritative cycle gate (validator's 4f rule is the
// advisory twin over possibly-stale resolvers): a cycle or an unresolvable
// name fails the LAUNCH closed with id-only payloads (design-gate P2-6 —
// names are display data the launcher may not be entitled to echo).
import { asc, inArray } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { workflows, workgroups as workgroupsTable } from '@/db/schema'
import { isVisibleRow, listGrantedResourceIds } from '@/services/resourceAcl'
import { getWorkgroupById } from '@/services/workgroups'
import { ValidationError } from '@/util/errors'
import {
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  decodeCallRef,
  detectCallCycles,
  migrateWorkflowDefinitionToLatest,
  WorkflowDefinitionSchema,
  type ResourceRefAst,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

/** RFC-282 D3 — the call-domain AST (RFC-271 codec) freeze walks on. */
type CallRefAstNode = Extract<ResourceRefAst, { k: 'call' }>

/** Selector wire → call-domain AST, via the ONE call codec (RFC-271 决策 29;
 *  RFC-282 D3 puts it on the production path — the walk below reads
 *  `authoritativeName` / `idHint` instead of bare wire fields). */
function workflowCallAst(ref: {
  nodeId: string
  workflowName: string
  workflowId?: string
}): CallRefAstNode {
  return decodeCallRef('workflow', {
    nodeId: ref.nodeId,
    name: ref.workflowName,
    ...(ref.workflowId === undefined ? {} : { idHint: ref.workflowId }),
  }) as CallRefAstNode
}

function workgroupCallAst(ref: {
  nodeId: string
  workgroupName: string
  workgroupId?: string
}): CallRefAstNode {
  return decodeCallRef('workgroup', {
    nodeId: ref.nodeId,
    name: ref.workgroupName,
    ...(ref.workgroupId === undefined ? {} : { idHint: ref.workgroupId }),
  }) as CallRefAstNode
}

export interface FrozenWorkflowRef {
  id: string
  version: number
  definition: WorkflowDefinition
}

/** RFC-243 PR-4 — a frozen workgroup RESOURCE row (member roster included).
 *  Stored opaquely: the frozen-launch face re-derives the runtime config via
 *  buildWorkgroupRuntimeConfig(group, renderedGoal) at call time, so the
 *  closure never bakes a goal in. Workgroups are closure LEAVES (the dw
 *  validator rejects call nodes in generated DAGs). */
export interface FrozenWorkgroupRef {
  id: string
  version: number
  group: unknown
}

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
        out.workgroups[name] = { id: r.id, version: r.version, group: r.group }
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

/**
 * Freeze the reference closure for a PARENT launch. Returns null when the
 * definition has no call nodes (byte-compat fast path). Throws:
 *   - `workflow-call-ref-missing` — a referenced name has no resource row (or
 *     its stored definition no longer parses);
 *   - `workflow-call-cycle` — the frozen call graph contains a cycle (payload
 *     lists resource-id paths only).
 */
export async function freezeCallClosure(
  db: DbClient,
  root: { id: string; definition: WorkflowDefinition },
  /**
   * 实现门 P0-1 —— the LAUNCH actor. Resolution is id-cache-first (the node's
   * `workflowId`, accepted only when that row still bears the selector name —
   * resolveNodeAgent's id-first precedent) and the name fallback is confined
   * to rows VISIBLE to this actor (oldest visible ULID wins). Without the
   * fence, a same-name row invisible to the launcher could be bound, frozen
   * into the task snapshot and EXECUTED — a cross-visibility leak the
   * save-time name gate cannot see (it only proves ≥1 visible match exists).
   */
  actor: Actor,
): Promise<string | null> {
  const canonicalRoot = {
    ...root,
    definition: migrateWorkflowDefinitionToLatest(root.definition),
  }
  const rootRefs = collectWorkflowCallRefs(canonicalRoot.definition)
  const rootWorkgroupRefs = collectWorkgroupCallRefs(canonicalRoot.definition)
  if (rootRefs.length === 0 && rootWorkgroupRefs.length === 0) return null
  const workflowGrants = await listGrantedResourceIds(db, actor, 'workflow')
  const workgroupGrants = await listGrantedResourceIds(db, actor, 'workgroup')

  // RFC-271 T6e（决策 28）：BFS 按**边**走，不按 name。
  // ⚠️ 此前是 `idHintByName`（per-name、last-write-wins）——同一张图里两个同名
  // selector 分别指向 W1/W2 时，**至少一个用户选择会丢**。边键让它们各自独立。
  // RFC-282 D3：边上的 ref 是 call 域 AST（decodeCallRef），不再是裸 wire 字段。
  type WorkflowEdge = { sourceId: string; ref: CallRefAstNode }
  const workflowEdges: WorkflowEdge[] = rootRefs.map((r) => ({
    sourceId: root.id,
    ref: workflowCallAst(r),
  }))
  const resolvedByEdge = new Map<string, FrozenWorkflowRef>()
  /** 同一行只解析一次（definition 解析开销）；键是行 id。 */
  const resolvedById = new Map<string, FrozenWorkflowRef>()
  let frontier: WorkflowEdge[] = [...workflowEdges]
  const seenEdge = new Set<string>()
  while (frontier.length > 0) {
    const pending = frontier.filter((e) => !seenEdge.has(callEdgeKey(e.sourceId, e.ref.nodeId)))
    if (pending.length === 0) break
    for (const e of pending) seenEdge.add(callEdgeKey(e.sourceId, e.ref.nodeId))
    const missing = [...new Set(pending.map((e) => e.ref.authoritativeName))]
    // `workflows.name` is NOT unique (YAML import collisions live behind a
    // dialog). Freeze-time has no dialog — resolution is id-cache-first, then
    // DETERMINISTIC among the rows the launch actor CAN SEE: oldest visible
    // ULID wins (实现门 P0-1).
    const hintIds = [
      ...new Set(pending.flatMap((e) => (e.ref.idHint !== undefined ? [e.ref.idHint] : []))),
    ]
    const hintRows =
      hintIds.length === 0
        ? []
        : await db
            .select({
              id: workflows.id,
              name: workflows.name,
              version: workflows.version,
              definition: workflows.definition,
              ownerUserId: workflows.ownerUserId,
              visibility: workflows.visibility,
            })
            .from(workflows)
            .where(inArray(workflows.id, hintIds))
    const hintById = new Map(hintRows.map((r) => [r.id, r]))
    const rows = await db
      .select({
        id: workflows.id,
        name: workflows.name,
        version: workflows.version,
        definition: workflows.definition,
        ownerUserId: workflows.ownerUserId,
        visibility: workflows.visibility,
      })
      .from(workflows)
      .where(inArray(workflows.name, missing))
      .orderBy(asc(workflows.id))
    const byName = new Map<string, (typeof rows)[number]>()
    for (const r of rows) {
      if (!isVisibleRow(actor, r, workflowGrants)) continue
      if (!byName.has(r.name)) byName.set(r.name, r)
    }
    const nextFrontier: WorkflowEdge[] = []
    for (const edge of pending) {
      const name = edge.ref.authoritativeName
      const hintId = edge.ref.idHint
      const hinted = hintId !== undefined ? hintById.get(hintId) : undefined
      const row =
        hinted !== undefined && hinted.name === name && isVisibleRow(actor, hinted, workflowGrants)
          ? hinted
          : byName.get(name)
      if (row === undefined) {
        throw new ValidationError(
          'workflow-call-ref-missing',
          `a call node references workflow '${name}' which does not exist or is not visible to the launcher`,
        )
      }
      let definition: WorkflowDefinition
      try {
        const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(row.definition))
        if (!parsed.success) throw new Error('schema')
        definition = migrateWorkflowDefinitionToLatest(parsed.data)
      } catch {
        throw new ValidationError(
          'workflow-call-ref-missing',
          `referenced workflow '${row.id}' has an unreadable definition`,
        )
      }
      const frozen: FrozenWorkflowRef = { id: row.id, version: row.version, definition }
      resolvedByEdge.set(callEdgeKey(edge.sourceId, edge.ref.nodeId), frozen)
      resolvedById.set(row.id, frozen)
      // 被解析出来的这个工作流自己的 call 边，继续入队（source 是它自己的 id）。
      for (const ref of collectWorkflowCallRefs(definition)) {
        const next = { sourceId: row.id, ref: workflowCallAst(ref) }
        workflowEdges.push(next)
        nextFrontier.push(next)
      }
    }
    frontier = nextFrontier
  }

  // Authoritative cycle gate over the exact frozen graph.
  // RFC-271 T6e：按**边**取，与冻结结果逐条同源——按名字取会让同名双 id 的其中
  // 一支被另一支替身，环检测就此瞎掉（design §1.1c''' 的可复现例）。
  const report = detectCallCycles(canonicalRoot, (ref, sourceId) => {
    const frozen = resolvedByEdge.get(callEdgeKey(sourceId, ref.nodeId))
    return frozen === undefined ? null : { id: frozen.id, definition: frozen.definition }
  })
  if (report.cycles.length > 0) {
    throw new ValidationError('workflow-call-cycle', 'workflow call graph contains a cycle', {
      // id-only payload (RFC-099 D1 echo discipline) — first cycle is enough
      // to act on; the validator's advisory twin lists them all in-editor.
      cycle: report.cycles[0],
    })
  }
  if (report.unresolved.length > 0) {
    // Freezing resolved every reachable name; a leftover here means the walk
    // and the detector disagree — fail closed rather than launch half-frozen.
    throw new ValidationError(
      'workflow-call-ref-missing',
      'workflow call closure could not be fully resolved',
    )
  }

  // Workgroup leaves: union over the root + every frozen workflow definition,
  // resolved by the SAME deterministic name rule (oldest ULID wins) and
  // hydrated with the full member roster.
  // RFC-271 T6e（决策 28）：按**边**收集，每条边带自己的 idHint。
  // ⚠️ 此前这里只收 `workgroupName` 进一个 Set，`workgroupId` 从头到尾没被读过
  // ——用户在下拉里选的那个组被静默丢弃，启动照样取最老可见行。
  const workgroupEdges: Array<{ sourceId: string; ref: CallRefAstNode }> = []
  for (const r of rootWorkgroupRefs)
    workgroupEdges.push({ sourceId: root.id, ref: workgroupCallAst(r) })
  for (const wf of resolvedById.values()) {
    for (const g of collectWorkgroupCallRefs(wf.definition)) {
      workgroupEdges.push({ sourceId: wf.id, ref: workgroupCallAst(g) })
    }
  }
  const workgroupNames = new Set(workgroupEdges.map((e) => e.ref.authoritativeName))
  const frozenWorkgroups: Record<string, FrozenWorkgroupRef> = {}
  if (workgroupNames.size > 0) {
    const rows = await db
      .select({
        id: workgroupsTable.id,
        name: workgroupsTable.name,
        version: workgroupsTable.version,
        ownerUserId: workgroupsTable.ownerUserId,
        visibility: workgroupsTable.visibility,
      })
      .from(workgroupsTable)
      .where(inArray(workgroupsTable.name, [...workgroupNames]))
      .orderBy(asc(workgroupsTable.id))
    const rowByName = new Map<string, (typeof rows)[number]>()
    for (const r of rows) {
      if (!isVisibleRow(actor, r, workgroupGrants)) continue
      if (!rowByName.has(r.name)) rowByName.set(r.name, r)
    }
    // id-hint 行（与工作流分支同构：命中且**该行仍带该选择器名字**才用）。
    const hintIds = [
      ...new Set(
        workgroupEdges.flatMap((e) => {
          const hint = e.ref.idHint
          return typeof hint === 'string' ? [hint] : []
        }),
      ),
    ]
    const hintRows =
      hintIds.length === 0
        ? []
        : await db
            .select({
              id: workgroupsTable.id,
              name: workgroupsTable.name,
              version: workgroupsTable.version,
              ownerUserId: workgroupsTable.ownerUserId,
              visibility: workgroupsTable.visibility,
            })
            .from(workgroupsTable)
            .where(inArray(workgroupsTable.id, hintIds))
    const hintById = new Map(hintRows.map((r) => [r.id, r]))

    for (const edge of workgroupEdges) {
      const name = edge.ref.authoritativeName
      const hintId = edge.ref.idHint
      const hinted = typeof hintId === 'string' ? hintById.get(hintId) : undefined
      const row =
        hinted !== undefined && hinted.name === name && isVisibleRow(actor, hinted, workgroupGrants)
          ? hinted
          : rowByName.get(name)
      if (row === undefined) {
        throw new ValidationError(
          'workflow-call-ref-missing',
          `a call node references workgroup '${name}' which does not exist or is not visible to the launcher`,
        )
      }
      const group = await getWorkgroupById(db, row.id)
      if (group === null) {
        throw new ValidationError(
          'workflow-call-ref-missing',
          `referenced workgroup '${row.id}' could not be loaded`,
        )
      }
      frozenWorkgroups[callEdgeKey(edge.sourceId, edge.ref.nodeId)] = {
        id: row.id,
        version: row.version,
        group,
      }
    }
  }

  // v2：按边键控。workflows 侧同理——每条 call 边一条冻结项。
  const closure: FrozenCallClosure = {
    closureVersion: 2,
    workflows: {},
    workgroups: frozenWorkgroups,
  }
  for (const edge of workflowEdges) {
    const ref = resolvedByEdge.get(callEdgeKey(edge.sourceId, edge.ref.nodeId))
    if (ref !== undefined) closure.workflows[callEdgeKey(edge.sourceId, edge.ref.nodeId)] = ref
  }
  return JSON.stringify(closure)
}

// RFC-349 compatibility adapter. New launches freeze through TaskExecutionResourceBinding; the SQLite walk remains
// as an exact behavior oracle for historical focused tests. RFC-454: the stored-closure codec moved to
// resource-catalog's `domain/callClosure.ts` (exported through its public entries).
// RFC-466 (RFC-294 W9-D): moved verbatim from task-execution `infrastructure/` (no production path reaches it) into the
// test helpers; its grant / visibility / workgroup reads now name resource-catalog directly instead of the retired
// `services/resourceAcl` and `services/workgroups` facades.
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

import { createWorkflowExecutionQueries } from '@/modules/resource-catalog/public/queries'
import { callEdgeKey } from '@/modules/resource-catalog/domain/callClosure'
import type {
  FrozenWorkflowRef,
  FrozenWorkgroupRef,
  FrozenCallClosure,
} from '@/modules/resource-catalog/public/types'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { asc, inArray } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { isVisibleRow } from '@/modules/resource-catalog/domain/resourceAccess'
import { listGrantedResourceIds } from '@/modules/resource-catalog/infrastructure/sqliteResourceGrantRepository'
import { getWorkgroupById } from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import { pickCallTarget } from '@agent-workflow/shared'
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

/**
 * Freeze the reference closure for a PARENT launch. Returns null when the
 * definition has no call nodes (byte-compat fast path). Throws:
 *   - `workflow-call-ref-missing` — a referenced name has no resource row (or
 *     its stored definition no longer parses);
 *   - `workflow-call-cycle` — the frozen call graph contains a cycle (payload
 *     lists resource-id paths only).
 */
export async function freezeCallClosure(
  // RFC-359 AC-6：形参放宽到中立客户端。函数体本来就是中立的——全模块零 `.get()` / `.run()` /
  // `dbTxSync`，`DbClient` 只出现在这一处标注上，是个残留的品牌。放宽向后兼容
  // （`DbClient` 是它的子类型），代价为零，换来的是 `rfc291-closure-call-edges` 的
  // freeze/dump 同解两条用例能上双引擎——此前它们只能留在单引擎块里，正是被这个标注钉住的。
  db: PersistenceDb,
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
        : await createWorkflowExecutionQueries(db)
            .documents(hintIds, true)
            .then((rows) =>
              rows.map((row) => ({
                id: row.id,
                name: row.name,
                version: row.version,
                definition: row.definition,
                ownerUserId: row.ownerUserId,
                visibility: row.visibility,
              })),
            )
    const rows = await createWorkflowExecutionQueries(db)
      .namedDocuments(missing)
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          version: row.version,
          definition: row.definition,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })),
      )
    // RFC-291 面 D — visibility is decided HERE (we own the ACL context);
    // WHICH row wins is decided by `pickCallTarget`, the single implementation
    // the intent dump also calls. Name-query rows and id-hint rows are merged
    // into one candidate set: a hinted row that was renamed simply stops
    // matching the selector name and falls through to the name rule, exactly as
    // before.
    const candidateById = new Map<string, (typeof rows)[number]>()
    for (const r of [...rows, ...hintRows]) {
      if (!isVisibleRow(actor, r, workflowGrants)) continue
      if (!candidateById.has(r.id)) candidateById.set(r.id, r)
    }
    const candidates = [...candidateById.values()]
    const nextFrontier: WorkflowEdge[] = []
    for (const edge of pending) {
      const name = edge.ref.authoritativeName
      const hintId = edge.ref.idHint
      const row = pickCallTarget(
        { authoritativeName: name, ...(hintId === undefined ? {} : { idHint: hintId }) },
        candidates,
      )
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
    const { workgroups } = tablesOf(db)
    const rows = await db
      .select({
        id: workgroups.id,
        name: workgroups.name,
        version: workgroups.version,
        ownerUserId: workgroups.ownerUserId,
        visibility: workgroups.visibility,
      })
      .from(workgroups)
      .where(inArray(workgroups.name, [...workgroupNames]))
      .orderBy(asc(workgroups.id))
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
              id: workgroups.id,
              name: workgroups.name,
              version: workgroups.version,
              ownerUserId: workgroups.ownerUserId,
              visibility: workgroups.visibility,
            })
            .from(workgroups)
            .where(inArray(workgroups.id, hintIds))
    // RFC-291 面 D — 与工作流分支同构：可见性在这里判（我们持有 ACL 上下文），
    // 「选哪一行」交给 pickCallTarget 这个单点，intent dump 调的是同一个。
    const candidateById = new Map<string, (typeof rows)[number]>()
    for (const r of [...rows, ...hintRows]) {
      if (!isVisibleRow(actor, r, workgroupGrants)) continue
      if (!candidateById.has(r.id)) candidateById.set(r.id, r)
    }
    const candidates = [...candidateById.values()]

    for (const edge of workgroupEdges) {
      const name = edge.ref.authoritativeName
      const hintId = edge.ref.idHint
      const row = pickCallTarget(
        {
          authoritativeName: name,
          ...(typeof hintId === 'string' ? { idHint: hintId } : {}),
        },
        candidates,
      )
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

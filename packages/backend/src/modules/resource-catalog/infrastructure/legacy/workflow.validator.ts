// Workflow static validator — context loaders (P-2-01).
//
// RFC-493 (RFC-294 S13): the validator itself (`validateWorkflowDef`, `validateWorkflowDefinition`, the context types,
// candidate overlays and context projection / hashes) lives in `domain/workflowValidator.ts`; this file keeps the entry
// points that read agents, skills, plugins, MCPs and the call-workflow closure to build a `ValidatorContext`.

import { workflowCatalogPredicate } from '../workflowCatalogPredicate'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { WorkflowDefinition, WorkflowValidationResult } from '@agent-workflow/shared'
import { collectWorkflowCallRefs, collectWorkgroupCallRefs } from '@agent-workflow/shared'
import { callEdgeKey, parseCallClosure } from '../../domain/callClosure'
import { workflowReferenceFromPersistenceRow } from '../workflowPersistence'
import { asc, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { listAgents } from './agent'
import { createPluginRepository } from '@/modules/resource-catalog/infrastructure/pluginRepository'
import { listSkills } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { getWorkflow } from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import { NotFoundError } from '@/util/errors'
import { validateWorkflowDefinition, withValidationOverlays } from '../../domain/workflowValidator'
import type {
  ValidatorContext,
  ValidatorWorkflowRef,
  WorkflowValidationCandidate,
} from '../../domain/workflowValidator'

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

/**
 * RFC-165 (F14/R3-3): THE production validation context — agents + skills +
 * MCPs + plugins, all live from the DB. Every launch-path / sync-path caller MUST
 * build its ctx through this helper: hand-rolled `{agents, skills}` objects
 * silently skipped the plugin checks (ctx.plugins undefined ⇒ no-op), so a
 * workflow referencing a missing/disabled plugin validated at launch and
 * died at spawn. A consistency lock test pins every caller to this helper.
 *
 * RFC-243 §5.4: pass the candidate being validated to ALSO load its
 * call-workflow reference closure (lazy, name-keyed, transitively — the
 * advisory twin of the launch freeze in task-execution's `infrastructure/legacyCallClosure.ts`).
 * Callers that omit it keep the pre-RFC-243 context: call rules that need the
 * child definition then degrade instead of false-failing (see §4f / rule 2).
 */
export async function loadWorkflowValidationContext(
  db: PersistenceDb,
  candidate?: WorkflowValidationCandidate,
): Promise<ValidatorContext> {
  const { mcps: mcpsTable } = tablesOf(db)
  const [agents, skills, mcps, plugins] = await Promise.all([
    listAgents(db),
    listSkills(db),
    db
      .select({
        id: mcpsTable.id,
        name: mcpsTable.name,
        ownerUserId: mcpsTable.ownerUserId,
        visibility: mcpsTable.visibility,
        enabled: mcpsTable.enabled,
        schemaVersion: mcpsTable.schemaVersion,
        updatedAt: mcpsTable.updatedAt,
      })
      .from(mcpsTable),
    createPluginRepository({ db }).repository.list(),
  ])
  const ctx: ValidatorContext = {
    agents,
    skills,
    mcps,
    plugins,
  }
  if (candidate !== undefined) {
    // RFC-271 T6f2：启动期给了冻结闭包就**只读它**，一次 live 查询都不发。
    const frozen =
      candidate.frozenClosureJson === undefined || candidate.frozenClosureJson === null
        ? null
        : closureFromFrozen(candidate.frozenClosureJson, {
            id: candidate.currentWorkflow?.id ?? FROZEN_ROOT_PLACEHOLDER,
            definition: candidate.definition,
          })
    if (frozen !== null) {
      ctx.callWorkflows = frozen.workflows
      ctx.callWorkgroupNames = frozen.workgroupNames
    } else {
      ctx.callWorkflows = await loadCallWorkflowClosure(db, candidate.definition)
      ctx.callWorkgroupNames = await loadCallWorkgroupNames(db, candidate.definition)
    }
    if (candidate.currentWorkflow !== undefined) ctx.currentWorkflow = candidate.currentWorkflow
  }
  // RFC-358: 候选期覆盖层最后并入——它描述的是本次变更集里即将存在的资源，
  // 必须盖在 live 快照之上（合并规则与 PostgreSQL provider 共用同一个纯函数）。
  return withValidationOverlays(ctx, candidate?.overlays)
}

/** 根 id 未知时（未落库的候选）的占位——它永远不会出现在任何边键里。 */
const FROZEN_ROOT_PLACEHOLDER = '__frozen-root__'

/**
 * RFC-271 T6f2 —— 把**已冻结**的闭包投影成 validator 认得的形状，零 DB 查询。
 *
 * BFS 沿冻结图走，每条 call 边配上它自己的冻结项：v2 按边键取，v1 按名字取
 * （存量任务）。取到的项以**该选择器的名字**登记 —— 冻结时已经过了名字守卫，
 * 所以「这条边解析到了它」本身就是事实，`pickCallWorkflowRow` 据此按 id 命中。
 */
function closureFromFrozen(
  frozenJson: string,
  root: { id: string; definition: WorkflowDefinition },
): {
  workflows: ReadonlyMap<string, ValidatorWorkflowRef>
  workgroupNames: ReadonlySet<string>
} | null {
  const closure = parseCallClosure(frozenJson)
  if (closure === null) return null
  const v2 = closure.closureVersion === 2
  const byId = new Map<string, ValidatorWorkflowRef>()
  const nameWinner = new Map<string, ValidatorWorkflowRef>()
  const workgroupNames = new Set<string>()
  const seen = new Set<string>()
  const queue: Array<{ id: string; definition: WorkflowDefinition }> = [root]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === undefined) break
    if (seen.has(cur.id)) continue
    seen.add(cur.id)
    for (const ref of collectWorkflowCallRefs(cur.definition)) {
      const frozen = v2
        ? closure.workflows[callEdgeKey(cur.id, ref.nodeId)]
        : closure.workflows[ref.workflowName]
      if (frozen === undefined) continue // 冻结里没有 ⇒ 4f 照常报 ref-missing
      const entry: ValidatorWorkflowRef = {
        id: frozen.id,
        name: ref.workflowName,
        definition: frozen.definition,
      }
      byId.set(frozen.id, entry)
      if (!nameWinner.has(ref.workflowName)) nameWinner.set(ref.workflowName, entry)
      queue.push({ id: frozen.id, definition: frozen.definition })
    }
    for (const g of collectWorkgroupCallRefs(cur.definition)) {
      const frozen = v2
        ? closure.workgroups[callEdgeKey(cur.id, g.nodeId)]
        : closure.workgroups[g.workgroupName]
      if (frozen !== undefined) workgroupNames.add(g.workgroupName)
    }
  }
  // 与 live 装载同序：先 id 键、后 name 键（name 与另一行的 id 撞车时 name 胜）。
  const out = new Map<string, ValidatorWorkflowRef>(byId)
  for (const [name, entry] of nameWinner) out.set(name, entry)
  return { workflows: out, workgroupNames }
}

/**
 * RFC-243 §5.4 — lazily load the call-workflow reference closure for ONE
 * candidate definition: BFS level-by-level over the `workflows` table by
 * authoritative NAME selector, following references of referenced definitions
 * transitively. Never loads unreferenced rows. Lenient advisory twin of the
 * launch freeze (`freezeCallClosure`, task-execution `infrastructure/legacyCallClosure.ts` — keep the
 * two walks shape-identical so the gates cannot drift): an unresolvable name
 * or an unreadable stored definition simply stays absent from the map (the
 * validator reports `call-workflow-ref-missing`), it never throws. The map is
 * keyed by BOTH name and id; on a key collision the name entry wins.
 */
async function loadCallWorkgroupNames(
  db: PersistenceDb,
  definition: WorkflowDefinition,
): Promise<ReadonlySet<string>> {
  const wanted = [...new Set(collectWorkgroupCallRefs(definition).map((r) => r.workgroupName))]
  if (wanted.length === 0) return new Set()
  const { workgroups } = tablesOf(db)
  const rows = await db
    .select({ name: workgroups.name })
    .from(workgroups)
    .where(inArray(workgroups.name, wanted))
  return new Set(rows.map((r) => r.name))
}

async function loadCallWorkflowClosure(
  db: PersistenceDb,
  definition: WorkflowDefinition,
): Promise<ReadonlyMap<string, ValidatorWorkflowRef>> {
  const { workflows } = tablesOf(db)
  const columns = {
    id: workflows.id,
    name: workflows.name,
    definition: workflows.definition,
  }

  const byId = new Map<string, ValidatorWorkflowRef>()
  const nameWinner = new Map<string, ValidatorWorkflowRef>()
  // RFC-271 T6e：BFS 的单位是**选择器**（name + 可选 idHint），不是裸名字——
  // 同名两个节点分别 hint W1/W2 时，两支都要各自展开。
  type Selector = { name: string; id?: string }
  const selKey = (s: Selector): string => `${s.id ?? ''}#${s.name}`
  const refToSelector = (r: { workflowName: string; workflowId?: string }): Selector => ({
    name: r.workflowName,
    ...(r.workflowId !== undefined ? { id: r.workflowId } : {}),
  })
  let frontier: Selector[] = collectWorkflowCallRefs(definition).map(refToSelector)
  const seen = new Set<string>()
  const queriedNames = new Set<string>()
  const queriedIds = new Set<string>()

  while (frontier.length > 0) {
    const pending = frontier.filter((s) => !seen.has(selKey(s)))
    if (pending.length === 0) break
    for (const s of pending) seen.add(selKey(s))

    const wantNames = [...new Set(pending.map((s) => s.name))].filter((n) => !queriedNames.has(n))
    const wantIds = [...new Set(pending.flatMap((s) => (s.id !== undefined ? [s.id] : [])))].filter(
      (i) => !queriedIds.has(i),
    )
    for (const n of wantNames) queriedNames.add(n)
    for (const i of wantIds) queriedIds.add(i)

    if (wantNames.length > 0) {
      const rows = await db
        .select(columns)
        .from(workflows)
        .where(workflowCatalogPredicate(workflows.id, inArray(workflows.name, wantNames)))
        .orderBy(asc(workflows.id))
      // Duplicate names resolve DETERMINISTICALLY: oldest row (lowest ULID)
      // wins, first-wins per name — the fallback rule freezeCallClosure applies
      // when a node carries no usable id hint.
      for (const row of rows) {
        const ref = workflowReferenceFromPersistenceRow(row)
        if (ref === null) continue
        if (!nameWinner.has(ref.name)) nameWinner.set(ref.name, ref)
      }
    }
    if (wantIds.length > 0) {
      const rows = await db
        .select(columns)
        .from(workflows)
        .where(workflowCatalogPredicate(workflows.id, inArray(columns.id, wantIds)))
      for (const row of rows) {
        const ref = workflowReferenceFromPersistenceRow(row)
        if (ref !== null) byId.set(ref.id, ref)
      }
    }

    const nextFrontier: Selector[] = []
    for (const sel of pending) {
      const hinted = sel.id !== undefined ? byId.get(sel.id) : undefined
      const ref =
        hinted !== undefined && hinted.name === sel.name ? hinted : nameWinner.get(sel.name)
      if (ref === undefined) continue // dangling ref → 4f `call-workflow-ref-missing`
      byId.set(ref.id, ref)
      for (const child of collectWorkflowCallRefs(ref.definition)) {
        nextFrontier.push(refToSelector(child))
      }
    }
    frontier = nextFrontier
  }

  // id keys first, then name keys — a (pathological) name equal to another
  // row's id resolves to the name entry, matching the authoritative selector.
  const out = new Map<string, ValidatorWorkflowRef>()
  for (const ref of byId.values()) out.set(ref.id, ref)
  for (const [name, ref] of nameWinner) out.set(name, ref)
  return out
}

/** @deprecated Use the canonical loader; retained for existing runtime callers. */
export const buildWorkflowValidationContext = loadWorkflowValidationContext

export async function validateWorkflowById(
  db: PersistenceDb,
  id: string,
): Promise<WorkflowValidationResult> {
  const wf = await getWorkflow(db, id)
  if (wf === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  }
  return validateWorkflowDefinition(
    wf.definition,
    await loadWorkflowValidationContext(db, {
      definition: wf.definition,
      currentWorkflow: { id: wf.id, name: wf.name },
    }),
  )
}

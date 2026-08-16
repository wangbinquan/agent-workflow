// RFC-306 — read model: the branch TRACE of one task.
//
// Lives in `application/`, NOT in `public/`: it needs a `DbClient`, and the
// RFC-294 preflight forbids infrastructure types on a module's public surface
// (`rfc294-architecture-preflight.test.ts` — "no type taint"). The only thing
// crossing a package boundary here is the `BranchTrace` VALUE OBJECT, which
// already lives in `@agent-workflow/shared` because the frontend renders it.
//
// "Which parts of the graph did this run actually take?" answered once, on the
// server, from the same domain rule the dispatcher used (domain/branchActivation).
// The frontend renders it and never re-derives it — a second implementation of
// "is this edge live" is exactly how a canvas ends up disagreeing with the node
// table sitting next to it.
//
// DISPLAY SLICE (design-gate P2#13): a node or edge has no single activation
// state once loops and fanout exist. This query reports the LATEST settled
// generation per node and stamps the `iteration` it read, plus per-shard counts
// for fanout wrappers, rather than collapsing "3 of 20 shards ran" into one
// boolean that is wrong either way.

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import {
  WorkflowDefinitionSchema,
  buildWorkflowScopeParentMap,
  resolveWorkflowSourceRef,
  type BranchTrace,
  type BranchTraceEdge,
  type BranchTraceNode,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { edgeActivationOf } from '../domain/branchActivation'
import { collectDataflowInboundEdges, nodeKindIndex } from '../domain/inboundEdges'

type RunRow = typeof nodeRuns.$inferSelect

function parseSnapshot(raw: string | null): WorkflowDefinition | null {
  if (raw === null || raw.length === 0) return null
  try {
    const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Freshest top-level SETTLED row per node (done ∪ skipped), any iteration. */
function latestSettledPerNode(rows: readonly RunRow[]): Map<string, RunRow> {
  const m = new Map<string, RunRow>()
  for (const r of rows) {
    if (r.parentNodeRunId !== null) continue
    if (r.status !== 'done' && r.status !== 'skipped') continue
    const cur = m.get(r.nodeId)
    if (
      cur === undefined ||
      r.iteration > cur.iteration ||
      (r.iteration === cur.iteration && r.id > cur.id)
    ) {
      m.set(r.nodeId, r)
    }
  }
  return m
}

export async function getTaskBranchTrace(
  db: DbClient,
  taskId: string,
): Promise<BranchTrace | null> {
  const taskRow = (
    await db
      .select({ snapshot: tasks.workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  const definition = parseSnapshot(taskRow?.snapshot ?? null)
  if (definition === null) return null

  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const latest = latestSettledPerNode(rows)

  // Port activation of every settled row we might consult. One query, not N.
  const outRows = await db
    .select({
      nodeRunId: nodeRunOutputs.nodeRunId,
      portName: nodeRunOutputs.portName,
      content: nodeRunOutputs.content,
      active: nodeRunOutputs.active,
    })
    .from(nodeRunOutputs)
    .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
    .where(eq(nodeRuns.taskId, taskId))
  const portsByRun = new Map<string, Map<string, { active: boolean; content: string }>>()
  for (const o of outRows) {
    const m = portsByRun.get(o.nodeRunId) ?? new Map()
    m.set(o.portName, { active: o.active, content: o.content })
    portsByRun.set(o.nodeRunId, m)
  }

  const skippedNodes: BranchTraceNode[] = []
  for (const [nodeId, row] of latest) {
    if (row.status !== 'skipped') continue
    // Design-gate P1#1 / user decision: a skip does NOT undo work an earlier
    // generation already merged. Say so explicitly — a bare "skipped" badge
    // otherwise implies the worktree is untouched by this node.
    const producedBefore = rows.some(
      (r) =>
        r.nodeId === nodeId &&
        r.parentNodeRunId === null &&
        r.status === 'done' &&
        (portsByRun.get(r.id)?.size ?? 0) > 0,
    )
    skippedNodes.push({
      nodeId,
      iteration: row.iteration,
      reason: row.errorMessage ?? 'branch-inactive',
      ...(producedBefore ? { hasEarlierProducedGeneration: true } : {}),
    })
  }

  const parents = buildWorkflowScopeParentMap(definition)
  const kindById = nodeKindIndex(definition)
  const inactiveEdges: BranchTraceEdge[] = []
  const decisions: BranchTrace['decisions'] = []

  for (const node of definition.nodes) {
    for (const edge of collectDataflowInboundEdges(definition.edges, node.id, kindById)) {
      const resolved = resolveWorkflowSourceRef(definition, edge.source, node.id, parents)
      const source = resolved.ok ? resolved.source : edge.source
      const run = latest.get(source.nodeId)
      if (run === undefined) continue
      const port = portsByRun.get(run.id)?.get(source.portName)
      const activation = edgeActivationOf({
        status: run.status,
        ...(port !== undefined ? { portActive: port.active } : {}),
      })
      if (activation.kind !== 'inactive') continue
      inactiveEdges.push({
        edgeId: edge.id,
        sourceNodeId: source.nodeId,
        sourcePortName: source.portName,
        targetNodeId: node.id,
        iteration: run.iteration,
        reason: activation.reason,
      })
    }
  }

  // Per-port decision reasons: the text an agent wrote next to `active="false"`.
  for (const [nodeRunId, ports] of portsByRun) {
    const run = rows.find((r) => r.id === nodeRunId)
    if (run === undefined) continue
    for (const [portName, v] of ports) {
      if (v.active) continue
      decisions.push({ nodeId: run.nodeId, nodeRunId, portName, reason: v.content })
    }
  }

  // Fanout wrappers: how many shards stayed active this generation. Reported as
  // counts rather than folded into the wrapper's own on/off state (P2#13).
  const shardActivation: BranchTrace['shardActivation'] = []
  for (const node of definition.nodes) {
    if (node.kind !== 'wrapper-fanout') continue
    const wrapperRow = latest.get(node.id)
    if (wrapperRow === undefined) continue
    const children = rows.filter(
      (r) => r.parentNodeRunId === wrapperRow.id && r.shardKey !== null && r.status === 'done',
    )
    if (children.length === 0) continue
    const active = children.filter((c) => {
      const ports = portsByRun.get(c.id)
      if (ports === undefined || ports.size === 0) return true
      return [...ports.values()].some((p) => p.active)
    }).length
    shardActivation.push({ nodeId: node.id, active, total: children.length })
  }

  return { skippedNodes, inactiveEdges, decisions, shardActivation }
}

/** Convenience for callers that already hold the task id and want it inline. */
export async function branchTraceForTask(
  db: DbClient,
  taskId: string,
): Promise<BranchTrace | undefined> {
  const trace = await getTaskBranchTrace(db, taskId)
  if (trace === null) return undefined
  // Nothing to say ⇒ omit the field entirely, so a task that used no branches
  // sends exactly the payload it sent before RFC-306.
  if (
    trace.skippedNodes.length === 0 &&
    trace.inactiveEdges.length === 0 &&
    trace.decisions.length === 0 &&
    trace.shardActivation.length === 0
  ) {
    return undefined
  }
  return trace
}

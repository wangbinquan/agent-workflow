// RFC-061 follow-up — session tree view temporarily degraded.
//
// The legacy RFC-027 getSessionTree stitched per-row node_run_events
// + opencodeSessionId-shared sibling node_runs into a tree the
// frontend's SessionTab rendered. Under the actor model the
// equivalent data lives in (attempts + attempt-subagent-* events on
// the projection events table); reconstructing the tree from those
// requires a new parseSessionTree path keyed off attempt_id + the
// projection's session_id columns.
//
// For now, getSessionTree returns an empty tree but keeps the
// 404 task / 404 node-run / 410 non-agent-kind validation contracts
// so the route layer doesn't 500. The frontend's Session tab will
// render an empty state; full rebuild is queued behind the
// /tasks/:id/timeline event-stream view (Phase 6 follow-up PR).

import { eq } from 'drizzle-orm'
import { parseSessionTree, type SessionTree } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { logicalRuns, tasks } from '@/db/schema'
import { DomainError, NotFoundError } from '@/util/errors'

const PROMPT_CAPABLE_KINDS = new Set(['agent-single'])

export async function getSessionTree(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
): Promise<{ tree: SessionTree }> {
  const taskRows = await db
    .select({ snapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (taskRows.length === 0) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  const lrRows = await db
    .select({ id: logicalRuns.id, taskId: logicalRuns.taskId, nodeId: logicalRuns.nodeId })
    .from(logicalRuns)
    .where(eq(logicalRuns.id, nodeRunId))
    .limit(1)
  const lr = lrRows[0]
  if (lr === undefined || lr.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  const { nodeKind, primaryAgentName } = resolveNodeMetaFromSnapshot(
    taskRows[0]!.snapshot,
    lr.nodeId,
  )
  if (nodeKind !== null && !PROMPT_CAPABLE_KINDS.has(nodeKind)) {
    throw new DomainError(
      'node-kind-not-supported',
      `node '${lr.nodeId}' (kind=${nodeKind}) does not produce an opencode session`,
      410,
    )
  }

  const tree = parseSessionTree({
    rootSessionId: null,
    promptText: null,
    startedAt: null,
    primaryAgentName: primaryAgentName ?? 'agent',
    events: [],
  })
  return { tree }
}

interface SnapshotNode {
  id?: unknown
  kind?: unknown
  agentName?: unknown
}

function resolveNodeMetaFromSnapshot(
  snapshotJson: string,
  nodeId: string,
): { nodeKind: string | null; primaryAgentName: string | null } {
  try {
    const snap = JSON.parse(snapshotJson) as { nodes?: SnapshotNode[] }
    const nodes = Array.isArray(snap.nodes) ? snap.nodes : []
    for (const n of nodes) {
      if (typeof n.id !== 'string' || n.id !== nodeId) continue
      return {
        nodeKind: typeof n.kind === 'string' ? n.kind : null,
        primaryAgentName: typeof n.agentName === 'string' ? n.agentName : null,
      }
    }
  } catch {
    // unreadable snapshot → degrade gracefully
  }
  return { nodeKind: null, primaryAgentName: null }
}

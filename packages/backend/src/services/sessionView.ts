// RFC-027 T4 — service helper for the GET …/node-runs/:nodeRunId/session
// endpoint. Stitches together: (a) the persisted node_run row (for
// promptText + startedAt), (b) the per-row sessionId-tagged events, and
// (c) the workflow snapshot's primary-agent-name resolution. Hands the
// final SessionTree off to the route layer (which serializes via
// SessionViewResponseSchema).
//
// We keep the pure parse step (parseSessionTree) in @agent-workflow/shared
// so the frontend can also call it if it ever needs to re-derive the
// tree client-side from raw event rows. Here we just do the IO and
// pass-through.

import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  isAgentNodeKind,
  parseSessionTree,
  type ParseSessionInputEvent,
  type SessionTree,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns, tasks } from '@/db/schema'
import { DomainError, NotFoundError } from '@/util/errors'

/**
 * Workflow node kinds for which an opencode session exists (everything
 * an agent process produces). Input / output / wrapper / review nodes
 * never spawn opencode so they have nothing to render in the Session
 * tab; the route returns 410 for those so the frontend can show a
 * "session not applicable" hint instead of an empty tree.
 */
// RFC-060 PR-E: agent-multi removed; agent-single is the only prompt-capable kind.

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

  const runRows = await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      nodeId: nodeRuns.nodeId,
      promptText: nodeRuns.promptText,
      startedAt: nodeRuns.startedAt,
      opencodeSessionId: nodeRuns.opencodeSessionId,
      retryIndex: nodeRuns.retryIndex,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const run = runRows[0]
  if (run === undefined || run.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  const { nodeKind, primaryAgentName } = resolveNodeMetaFromSnapshot(
    taskRows[0]!.snapshot,
    run.nodeId,
  )
  if (nodeKind !== null && !isAgentNodeKind(nodeKind)) {
    throw new DomainError(
      'node-kind-not-supported',
      `node '${run.nodeId}' (kind=${nodeKind}) does not produce an opencode session`,
      410,
    )
  }

  // RFC-027 §UX merge — when the requested node_run shares an opencode
  // session_id with sibling node_runs in this task (RFC-026 inline
  // clarify reruns), unify their events + treat each round's promptText
  // as a separate user message in the merged conversation flow.
  const inlineSiblings = await loadInlineSiblings(db, taskId, run)
  const targetNodeRunIds = inlineSiblings.map((s) => s.id)
  const promptText = inlineSiblings[0]!.promptText
  const startedAt = inlineSiblings[0]!.startedAt
  const extraUserPrompts: Array<{ text: string; ts: number }> = []
  for (let i = 1; i < inlineSiblings.length; i++) {
    const s = inlineSiblings[i]!
    if (s.promptText !== null && s.promptText !== '') {
      extraUserPrompts.push({ text: s.promptText, ts: s.startedAt ?? 0 })
    }
  }

  const rows = await db
    .select({
      id: nodeRunEvents.id,
      ts: nodeRunEvents.ts,
      kind: nodeRunEvents.kind,
      sessionId: nodeRunEvents.sessionId,
      parentSessionId: nodeRunEvents.parentSessionId,
      payload: nodeRunEvents.payload,
    })
    .from(nodeRunEvents)
    .where(inArray(nodeRunEvents.nodeRunId, targetNodeRunIds))
    .orderBy(asc(nodeRunEvents.ts), asc(nodeRunEvents.id))

  const events: ParseSessionInputEvent[] = rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    sessionId: r.sessionId,
    parentSessionId: r.parentSessionId,
    payload: r.payload,
  }))

  const rootSessionId = deriveRootSessionId(events)

  const tree = parseSessionTree({
    rootSessionId,
    promptText,
    startedAt,
    primaryAgentName: primaryAgentName ?? 'agent',
    events,
    ...(extraUserPrompts.length > 0 ? { extraUserPrompts } : {}),
  })
  return { tree }
}

interface InlineSiblingRow {
  id: string
  promptText: string | null
  startedAt: number | null
  retryIndex: number
}

/**
 * Returns the chronological chain of node_runs that share an opencode
 * session id with the requested run. When opencodeSessionId is null
 * (legacy / isolated mode), returns just [run] so the rest of
 * getSessionTree degrades to the pre-merge single-attempt query.
 */
async function loadInlineSiblings(
  db: DbClient,
  taskId: string,
  run: {
    id: string
    promptText: string | null
    startedAt: number | null
    opencodeSessionId: string | null
    retryIndex: number
  },
): Promise<InlineSiblingRow[]> {
  if (run.opencodeSessionId === null) {
    return [
      {
        id: run.id,
        promptText: run.promptText,
        startedAt: run.startedAt,
        retryIndex: run.retryIndex,
      },
    ]
  }
  const rows = await db
    .select({
      id: nodeRuns.id,
      promptText: nodeRuns.promptText,
      startedAt: nodeRuns.startedAt,
      retryIndex: nodeRuns.retryIndex,
    })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.opencodeSessionId, run.opencodeSessionId)))
  if (rows.length === 0) {
    return [
      {
        id: run.id,
        promptText: run.promptText,
        startedAt: run.startedAt,
        retryIndex: run.retryIndex,
      },
    ]
  }
  // RFC-074 PR-C: chronological ordering is pure ULID id-order (creation
  // order) — the first sibling is round 0 (smallest id, the original ask) and
  // later clarify rounds / retries (minted later, larger id) append in order.
  // This replaces the retired (clarifyIteration, retryIndex, startedAt) sort.
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows
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
      const kind = typeof n.kind === 'string' ? n.kind : null
      const name = typeof n.agentName === 'string' ? n.agentName : null
      return { nodeKind: kind, primaryAgentName: name }
    }
  } catch {
    // Snapshot unreadable → fall through with nulls; route still 200s with
    // a best-effort tree (no kind gating, agentName="agent" fallback).
  }
  return { nodeKind: null, primaryAgentName: null }
}

function deriveRootSessionId(events: ParseSessionInputEvent[]): string | null {
  for (const e of events) {
    if (e.parentSessionId === null && e.sessionId !== null) return e.sessionId
  }
  for (const e of events) {
    if (e.sessionId !== null) return e.sessionId
  }
  return null
}

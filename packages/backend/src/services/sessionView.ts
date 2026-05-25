// RFC-061 follow-up — session tree view rebuilt on attempt-subagent-*
// events.
//
// Original RFC-027 implementation walked `node_run_events` (deleted in
// migration 0035) to reconstruct the opencode session tree. The actor
// captures a narrower slice of opencode telemetry into the projection
// `events` table via two EventKinds:
//   - attempt-subagent-tool-use  → tool call (with tool name + session)
//   - attempt-subagent-output    → assistant text (with session id)
// We synthesise the legacy envelope shape parseSessionTree expects
// (`{type: 'text'|'tool', part: {...}}`) from these typed payloads so
// the existing renderer keeps working.
//
// Coverage delta vs the legacy capture: reasoning blocks, permission
// asks, step start/finish, and arbitrary stdout error lines are NOT
// emitted by runner-v2 as attempt-subagent-* events; the Session tab
// renders only text + tool calls. A future commit can widen the
// runner-v2 stdout aggregator to emit reasoning + step events too.

import { asc, eq, inArray } from 'drizzle-orm'
import {
  parseSessionTree,
  type ParseSessionInputEvent,
  type SessionTree,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { attempts, events as eventsTable, logicalRuns, tasks } from '@/db/schema'
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

  // Collect every attempt id under this logical_run and pull the
  // attempt-subagent-* + attempt-started events keyed off them.
  const attRows = await db
    .select({
      id: attempts.id,
      pid: attempts.pid,
      opencodeSessionId: attempts.opencodeSessionId,
      startedAt: attempts.startedAt,
    })
    .from(attempts)
    .where(eq(attempts.logicalRunId, lr.id))
    .orderBy(asc(attempts.attemptSeq))
  const attemptIds = attRows.map((a) => a.id)

  if (attemptIds.length === 0) {
    const tree = parseSessionTree({
      rootSessionId: null,
      promptText: null,
      startedAt: null,
      primaryAgentName: primaryAgentName ?? 'agent',
      events: [],
    })
    return { tree }
  }

  const rawRows = await db
    .select({
      id: eventsTable.id,
      ts: eventsTable.ts,
      kind: eventsTable.kind,
      payload: eventsTable.payload,
      attemptId: eventsTable.attemptId,
    })
    .from(eventsTable)
    .where(inArray(eventsTable.attemptId, attemptIds))
    .orderBy(asc(eventsTable.ts), asc(eventsTable.id))

  // The parser keys events by sessionId; root events fall into the
  // root bucket via deriveRootBucketKey when null. The first attempt's
  // opencodeSessionId (if any) is the canonical root id.
  const rootSessionId = attRows.find((a) => a.opencodeSessionId !== null)?.opencodeSessionId ?? null
  const firstStartedAt = attRows[0]?.startedAt ?? null

  let synthIdCursor = 0
  const events: ParseSessionInputEvent[] = []
  for (const r of rawRows) {
    synthIdCursor++
    if (r.kind === 'attempt-subagent-output') {
      const p = safeParse(r.payload) as { sessionId?: string; content?: string } | null
      if (!p || typeof p.sessionId !== 'string' || typeof p.content !== 'string') continue
      events.push({
        id: synthIdCursor,
        ts: r.ts,
        kind: 'text',
        sessionId: p.sessionId,
        parentSessionId: rootSessionId === p.sessionId ? null : rootSessionId,
        payload: JSON.stringify({
          type: 'text',
          part: { type: 'text', text: p.content, messageId: `evt_${synthIdCursor}` },
        }),
      })
    } else if (r.kind === 'attempt-subagent-tool-use') {
      const p = safeParse(r.payload) as {
        sessionId?: string
        toolName?: string
        detail?: unknown
      } | null
      if (!p || typeof p.sessionId !== 'string' || typeof p.toolName !== 'string') continue
      events.push({
        id: synthIdCursor,
        ts: r.ts,
        kind: 'tool_use',
        sessionId: p.sessionId,
        parentSessionId: rootSessionId === p.sessionId ? null : rootSessionId,
        payload: JSON.stringify({
          type: 'tool',
          part: {
            type: 'tool',
            tool: p.toolName,
            messageId: `evt_${synthIdCursor}`,
            ...(typeof p.detail === 'object' && p.detail !== null
              ? (p.detail as Record<string, unknown>)
              : {}),
          },
        }),
      })
    }
    // attempt-started / attempt-finished-* aren't surfaced as session
    // messages (the legacy parser ignored 'step_start'/'step_finish'
    // beyond the leading prompt anyway). Skip them.
  }

  const tree = parseSessionTree({
    rootSessionId,
    promptText: null,
    startedAt: firstStartedAt,
    primaryAgentName: primaryAgentName ?? 'agent',
    events,
  })
  return { tree }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
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

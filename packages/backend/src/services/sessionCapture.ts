// RFC-061 follow-up — post-run subagent capture retired.
//
// The legacy RFC-027 / RFC-048 path opened opencode's XDG SQLite after
// a child run finished, BFS'd the session tree, and persisted message+
// part rows into node_run_events. The actor doesn't populate
// node_run_events anymore — the runner-v2 stdout aggregator emits
// attempt-subagent-* events into the projection events table directly.
// The legacy capture flow was only ever invoked by the legacy runner.ts
// which RFC-061 PR-B deleted, so this module is dead under the actor
// model.
//
// We keep the pure utility exports (`resolveOpencodeDbPath` +
// `transcodeOpencodeRowsToEvents` + `TranscodedEvent` typedef) because
// distillSessionCapture.ts still uses them to read opencode SQLite for
// RFC-043 memory distill jobs. The IO-heavy `captureChildSessions` /
// `loadSiblingsCapturedSessionIds` / `markCaptureFailed` paths are
// gone — the export surface is preserved as a no-op so any historical
// caller compiles, but they never touch the DB.

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DbClient } from '../db/client'
import type { Logger } from '@/util/log'

export interface CaptureChildSessionsOptions {
  rootSessionId: string
  nodeRunId: string
  db: DbClient
  log?: Logger
  opencodeDbPath?: string
  taskId?: string
  alreadyInsertedPartIds?: Map<string, Set<string>>
}

export interface CaptureChildSessionsResult {
  capturedSessionIds: string[]
  insertedEventRows: number
  failed: boolean
  failureReason?: string
}

export function resolveOpencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OPENCODE_TEST_HOME ?? homedir()
  const xdgData = env.XDG_DATA_HOME ?? defaultXdgDataDir(home)
  return join(xdgData, 'opencode', 'opencode.db')
}

function defaultXdgDataDir(home: string): string {
  return join(home, '.local', 'share')
}

interface OpencodeMessageRow {
  id: string
  time_created: number
  data: string
}

interface OpencodePartRow {
  id: string
  message_id: string
  time_created: number
  data: string
}

export interface TranscodedEvent {
  ts: number
  kind: 'text' | 'tool_use' | 'reasoning' | 'step_start' | 'step_finish'
  payload: string
}

/**
 * Pure transformer from opencode message + part rows into the legacy
 * NDJSON event envelope shape. Still used by distillSessionCapture.ts
 * to import historical opencode session data for RFC-043 distill jobs.
 */
export function transcodeOpencodeRowsToEvents(input: {
  sessionId: string
  messages: OpencodeMessageRow[]
  parts: OpencodePartRow[]
}): TranscodedEvent[] {
  const messageById = new Map<string, OpencodeMessageRow>()
  for (const m of input.messages) messageById.set(m.id, m)

  const sorted = [...input.parts].sort(
    (a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id),
  )
  const out: TranscodedEvent[] = []
  for (const p of sorted) {
    let part: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(p.data)
      if (parsed !== null && typeof parsed === 'object') part = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (part === null) continue
    const type = typeof part.type === 'string' ? part.type : ''

    let kind: TranscodedEvent['kind'] | null = null
    let envelopeType: string = type
    if (type === 'text') kind = 'text'
    else if (type === 'tool') {
      kind = 'tool_use'
      envelopeType = 'tool_use'
    } else if (type === 'reasoning') kind = 'reasoning'
    else if (type === 'step-start') {
      kind = 'step_start'
      envelopeType = 'step_start'
    } else if (type === 'step-finish') {
      kind = 'step_finish'
      envelopeType = 'step_finish'
    }
    if (kind === null) continue

    const envelope = {
      type: envelopeType,
      sessionID: input.sessionId,
      messageID: p.message_id,
      part: { id: p.id, ...part },
      timestamp: p.time_created,
    }
    out.push({ ts: p.time_created, kind, payload: JSON.stringify(envelope) })
  }
  return out
}

export async function captureChildSessions(
  _opts: CaptureChildSessionsOptions,
): Promise<CaptureChildSessionsResult> {
  return { capturedSessionIds: [], insertedEventRows: 0, failed: false }
}

export async function loadSiblingsCapturedSessionIds(
  _db: DbClient,
  _taskId: string,
  _myNodeRunId: string,
): Promise<Set<string>> {
  return new Set()
}

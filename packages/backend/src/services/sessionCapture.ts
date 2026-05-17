// RFC-027 T3 — post-run capture of opencode subagent (child) session
// events.
//
// Why this exists: opencode 1.15.x's `run` subcommand uses an
// in-process server (Server.Default().app.fetch — see
// opencode/packages/opencode/src/cli/cmd/run.ts:806/838); it does NOT
// expose an HTTP port, so external runners can't subscribe to
// child-session events live. Instead, opencode persists every
// session / message / part to a single XDG SQLite DB
// (opencode/packages/opencode/src/storage/db.ts:33 → Global.Path.data
// /opencode.db, with xdg-basedir resolution in
// opencode/packages/core/src/global.ts). After our child process
// exits cleanly, we open that DB read-only, BFS the session.parent_id
// tree starting from the root sessionID we already captured from
// stdout, transcode message+part rows into the same NDJSON shape that
// our stdout pump writes, and INSERT them into node_run_events tagged
// with session_id / parent_session_id. The frontend SessionTab can
// then render an arbitrarily deep subagent conversation without
// caring whether an event came from stdout or post-run readback.
//
// Failure mode is always non-fatal: any IO / schema mismatch writes a
// single `subagent_capture_failed` marker row + warn log. The parent
// session's stdout-derived events are unaffected.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { nodeRunEvents } from '../db/schema'
import type { DbClient } from '../db/client'
import { createLogger, type Logger } from '@/util/log'

export interface CaptureChildSessionsOptions {
  rootSessionId: string
  nodeRunId: string
  db: DbClient
  log?: Logger
  /** Override the opencode SQLite path (tests). */
  opencodeDbPath?: string
}

export interface CaptureChildSessionsResult {
  /** Child session IDs reached via BFS (root excluded). */
  capturedSessionIds: string[]
  /** Number of event rows inserted (sum across children). */
  insertedEventRows: number
  /** True when any failure happened — see also the marker row in DB. */
  failed: boolean
  /** Human-readable failure reason (only set when failed=true). */
  failureReason?: string
}

/**
 * Resolve the path opencode 1.15.x writes its SQLite to. Mirrors
 * opencode/packages/core/src/global.ts: xdg-basedir + 'opencode'.
 *
 * Honors `OPENCODE_TEST_HOME` (opencode's own env override) so e2e
 * fixtures can isolate the DB from the user's real opencode install.
 */
export function resolveOpencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OPENCODE_TEST_HOME ?? homedir()
  const xdgData = env.XDG_DATA_HOME ?? defaultXdgDataDir(home)
  return join(xdgData, 'opencode', 'opencode.db')
}

function defaultXdgDataDir(home: string): string {
  // Matches xdg-basedir behavior on macOS / Linux. Windows is out of
  // scope for v1 per RFC-027 design.md §8.
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support')
  }
  return join(home, '.local', 'share')
}

interface OpencodeSessionRow {
  id: string
  parent_id: string | null
  agent: string | null
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
 * Pure function: turn opencode message + part rows into NDJSON event
 * payloads matching the shape our stdout pump persists, so the
 * downstream parseSessionTree consumer doesn't care about the source.
 *
 * Exported for direct unit testing — keeps schema-mapping decisions
 * out of the IO-heavy captureChildSessions function.
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

/**
 * Open opencode's SQLite read-only, BFS from rootSessionId to find
 * descendants, transcode their messages+parts, and persist into
 * node_run_events. Never throws — any IO / schema error becomes a
 * `subagent_capture_failed` marker row + warn log.
 */
export async function captureChildSessions(
  opts: CaptureChildSessionsOptions,
): Promise<CaptureChildSessionsResult> {
  const log = opts.log ?? createLogger('sessionCapture')
  const dbPath = opts.opencodeDbPath ?? resolveOpencodeDbPath()

  if (!existsSync(dbPath)) {
    log.warn('opencode-db-not-found', { dbPath, nodeRunId: opts.nodeRunId })
    await markCaptureFailed(opts.db, opts.nodeRunId, opts.rootSessionId, 'opencode-db-not-found')
    return {
      capturedSessionIds: [],
      insertedEventRows: 0,
      failed: true,
      failureReason: 'opencode-db-not-found',
    }
  }

  let opencodeDb: Database | null = null
  try {
    opencodeDb = new Database(dbPath, { readonly: true })
    // BFS children — bounded by visited set so malformed self-loops can't
    // hang the runner.
    const visited = new Set<string>()
    const queue: string[] = [opts.rootSessionId]
    const order: OpencodeSessionRow[] = []
    while (queue.length > 0) {
      const sid = queue.shift()!
      if (visited.has(sid)) continue
      visited.add(sid)
      const children = opencodeDb
        .query<
          OpencodeSessionRow,
          [string]
        >('SELECT id, parent_id, agent FROM session WHERE parent_id = ?')
        .all(sid)
      for (const c of children) {
        if (visited.has(c.id)) continue
        order.push(c)
        queue.push(c.id)
      }
    }

    let insertedRows = 0
    for (const sess of order) {
      const messages = opencodeDb
        .query<
          OpencodeMessageRow,
          [string]
        >('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
        .all(sess.id)
      const parts = opencodeDb
        .query<
          OpencodePartRow,
          [string]
        >('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id')
        .all(sess.id)
      const events = transcodeOpencodeRowsToEvents({ sessionId: sess.id, messages, parts })
      if (events.length === 0) continue
      const rows = events.map((e) => ({
        nodeRunId: opts.nodeRunId,
        ts: e.ts,
        kind: e.kind,
        payload: e.payload,
        sessionId: sess.id,
        parentSessionId: sess.parent_id,
      }))
      await opts.db.insert(nodeRunEvents).values(rows)
      insertedRows += rows.length
    }

    return {
      capturedSessionIds: order.map((s) => s.id),
      insertedEventRows: insertedRows,
      failed: false,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn('subagent-capture-error', { nodeRunId: opts.nodeRunId, err: reason })
    await markCaptureFailed(opts.db, opts.nodeRunId, opts.rootSessionId, reason)
    return {
      capturedSessionIds: [],
      insertedEventRows: 0,
      failed: true,
      failureReason: reason,
    }
  } finally {
    if (opencodeDb !== null) {
      try {
        opencodeDb.close()
      } catch {
        // ignore — readonly close failures are non-fatal
      }
    }
  }
}

async function markCaptureFailed(
  db: DbClient,
  nodeRunId: string,
  rootSessionId: string,
  reason: string,
): Promise<void> {
  try {
    await db.insert(nodeRunEvents).values({
      nodeRunId,
      ts: Date.now(),
      kind: 'subagent_capture_failed',
      payload: JSON.stringify({ sessionID: rootSessionId, reason }),
      sessionId: rootSessionId,
      parentSessionId: null,
    })
  } catch {
    // If even the marker write fails, swallow — we already logged the
    // underlying failure; the parent run path must remain unaffected.
  }
}

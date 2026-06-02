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
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { DbClient } from '../db/client'
import { nodeRunEvents, nodeRuns } from '../db/schema'
import { createLogger, type Logger } from '@/util/log'
import {
  walkOpencodeSessions,
  type OpencodeMessageRow,
  type OpencodePartRow,
} from './opencodeSessionWalk'

export interface CaptureChildSessionsOptions {
  rootSessionId: string
  nodeRunId: string
  db: DbClient
  log?: Logger
  /** Override the opencode SQLite path (tests). */
  opencodeDbPath?: string
  /**
   * RFC-027 §UX merge — when set, captureChildSessions queries
   * sibling node_runs in the same task that already captured events
   * for a given child sessionId and skips the re-write. Prevents
   * RFC-026 inline-mode reruns from double-counting subagent events
   * (the resumed opencode session keeps the prior round's child
   * session rows around).
   */
  taskId?: string
  /**
   * RFC-048 — partId-level dedupe. The live poller (see
   * services/subagentLiveCapture.ts) inserts part rows during the
   * opencode run; this map (`sessionId → set of partIds already
   * written by this nodeRun`) lets the post-run BFS skip rows the
   * live poll already persisted. Omitted callers (RFC-027 legacy
   * path, `pollMs = 0`) get byte-level identical behavior because
   * the filter step is skipped entirely.
   */
  alreadyInsertedPartIds?: Map<string, Set<string>>
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
  // Verified against opencode's actual behavior on this machine:
  // opencode uses xdg-basedir v5 (packages/core/src/global.ts:3) which
  // resolves `xdgData` to `~/.local/share` on macOS as well as Linux —
  // it does NOT remap to `~/Library/Application Support` despite the
  // Apple convention. The earlier macOS branch returning the Library
  // path was a wrong assumption that caused captureChildSessions (and
  // RFC-043 captureDistillJobSession) to silently write
  // `subagent_capture_failed` / `rfc043/distill-capture-failed` marker
  // rows with reason `opencode-db-not-found`.
  // Windows is out of scope for v1 per RFC-027 design.md §8.
  return join(home, '.local', 'share')
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

    // RFC-027 §UX merge / RFC-026 inline-mode dedup: when a sibling
    // node_run in this same task already captured rows for this
    // child sessionId (typical for resumed opencode sessions),
    // skip the re-import — otherwise every inline rerun would
    // duplicate every prior round's subagent events.
    const alreadyCaptured = opts.taskId
      ? await loadSiblingsCapturedSessionIds(opts.db, opts.taskId, opts.nodeRunId)
      : new Set<string>()

    let insertedRows = 0
    const skipped: string[] = []
    const captured: string[] = []
    // RFC-077: BFS + per-session message/part reads via the shared walk core.
    // includeRoot:false — root events are written live by the stdout pump, so
    // we capture only descendants. The walk yields in the same BFS order as
    // the previous inline implementation.
    for (const { session: sess, messages, parts } of walkOpencodeSessions(
      opencodeDb,
      opts.rootSessionId,
      { includeRoot: false },
    )) {
      if (alreadyCaptured.has(sess.id)) {
        skipped.push(sess.id)
        continue
      }
      captured.push(sess.id)
      // RFC-048: when the live poller already wrote part rows for this
      // sessionId in the current nodeRun, drop them before transcoding so
      // post-run capture only inserts the tail flushed after the last tick.
      // The filter is keyed off the opencode `part.id`, which transcode
      // preserves as the envelope's `part.id` field — `extractPartId` reads
      // it back from the (just-stringified) envelope.
      const skipPartIds = opts.alreadyInsertedPartIds?.get(sess.id)
      const filteredParts =
        skipPartIds !== undefined && skipPartIds.size > 0
          ? parts.filter((p) => !skipPartIds.has(p.id))
          : parts
      const events = transcodeOpencodeRowsToEvents({
        sessionId: sess.id,
        messages,
        parts: filteredParts,
      })
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
    if (skipped.length > 0) {
      log.info('subagent-already-captured', { nodeRunId: opts.nodeRunId, skipped })
    }

    return {
      capturedSessionIds: captured,
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

/**
 * Returns the set of opencode child sessionIds already persisted into
 * node_run_events by SOME OTHER node_run in the same task. Used to
 * dedup re-captures during RFC-026 inline-mode reruns. Exported for
 * the RFC-048 live poller which loads the sibling set once at start
 * so its per-tick BFS shares the same skip semantics as the post-run
 * BFS in captureChildSessions.
 */
export async function loadSiblingsCapturedSessionIds(
  db: DbClient,
  taskId: string,
  myNodeRunId: string,
): Promise<Set<string>> {
  const siblings = await db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), ne(nodeRuns.id, myNodeRunId)))
  const sibIds = siblings.map((r) => r.id)
  if (sibIds.length === 0) return new Set()
  const rows = await db
    .selectDistinct({ sessionId: nodeRunEvents.sessionId })
    .from(nodeRunEvents)
    .where(inArray(nodeRunEvents.nodeRunId, sibIds))
  const out = new Set<string>()
  for (const r of rows) {
    if (r.sessionId !== null && r.sessionId !== '') out.add(r.sessionId)
  }
  return out
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

// RFC-043 T3 — post-run capture of the distiller opencode subprocess
// session events.
//
// This is the distiller-side counterpart of sessionCapture.ts (RFC-027).
// We deliberately keep it a near-90% copy of captureChildSessions rather
// than abstracting over the owner — node_runs and distill_jobs differ in
// schema (no retry_index / shard_key on distill, no task-scoped sibling
// dedup) and a single abstraction would have to thread both shapes
// through hot-path code. When a third capture owner appears we can revisit.
//
// Failure mode: never throws. Any IO / schema mismatch becomes a
// `rfc043/distill-capture-failed` marker row in memory_distill_events +
// a warn log. The distiller's own success / failure path is unaffected.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { DbClient } from '../db/client'
import { memoryDistillEvents } from '../db/schema'
import { createLogger, type Logger } from '@/util/log'
import { resolveOpencodeDbPath, transcodeOpencodeRowsToEvents } from './sessionCapture'
import { walkOpencodeSessions } from './opencodeSessionWalk'

export const DISTILL_CAPTURE_FAILED_KIND = 'rfc043/distill-capture-failed'

export interface CaptureDistillJobSessionOptions {
  rootSessionId: string
  distillJobId: string
  attemptIndex: number
  db: DbClient
  log?: Logger
  /** Override the opencode SQLite path (tests). */
  opencodeDbPath?: string
}

export interface CaptureDistillJobSessionResult {
  capturedSessionIds: string[]
  insertedEventRows: number
  failed: boolean
  failureReason?: string
}

/**
 * Open opencode's SQLite read-only, BFS from rootSessionId to discover
 * descendants (subagent sessions, if any), transcode messages+parts
 * via RFC-027's transcodeOpencodeRowsToEvents helper, and persist into
 * memory_distill_events tagged with attemptIndex + sessionId +
 * parentSessionId.
 *
 * The root session itself IS captured (unlike the worker-node path
 * where stdout already wrote the root events live — distiller doesn't
 * stream events to our own pump, so SQLite is the only source).
 */
export async function captureDistillJobSession(
  opts: CaptureDistillJobSessionOptions,
): Promise<CaptureDistillJobSessionResult> {
  const log = opts.log ?? createLogger('distill-session-capture')
  const dbPath = opts.opencodeDbPath ?? resolveOpencodeDbPath()

  if (!existsSync(dbPath)) {
    log.warn('opencode-db-not-found', { dbPath, distillJobId: opts.distillJobId })
    await markCaptureFailed(opts.db, opts, 'opencode-db-not-found')
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

    let insertedRows = 0
    const captured: string[] = []
    // RFC-077: BFS + per-session message/part reads via the shared walk core.
    // includeRoot:true — the distiller never streamed root events through our
    // stdout pump, so SQLite is the only source for the root session's own
    // events; the root row is seeded first (skipped if its session row is
    // absent, matching the previous `rootRow !== null` guard).
    for (const { session: sess, messages, parts } of walkOpencodeSessions(
      opencodeDb,
      opts.rootSessionId,
      { includeRoot: true },
    )) {
      captured.push(sess.id)
      const events = transcodeOpencodeRowsToEvents({ sessionId: sess.id, messages, parts })
      if (events.length === 0) continue
      const rows = events.map((e) => ({
        distillJobId: opts.distillJobId,
        attemptIndex: opts.attemptIndex,
        ts: e.ts,
        kind: e.kind,
        payload: e.payload,
        sessionId: sess.id,
        parentSessionId: sess.parent_id,
      }))
      await opts.db.insert(memoryDistillEvents).values(rows)
      insertedRows += rows.length
    }

    return {
      capturedSessionIds: captured,
      insertedEventRows: insertedRows,
      failed: false,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn('distill-capture-error', { distillJobId: opts.distillJobId, err: reason })
    await markCaptureFailed(opts.db, opts, reason)
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
        // readonly close failures are non-fatal
      }
    }
  }
}

async function markCaptureFailed(
  db: DbClient,
  opts: Pick<CaptureDistillJobSessionOptions, 'distillJobId' | 'attemptIndex' | 'rootSessionId'>,
  reason: string,
): Promise<void> {
  try {
    await db.insert(memoryDistillEvents).values({
      distillJobId: opts.distillJobId,
      attemptIndex: opts.attemptIndex,
      ts: Date.now(),
      kind: DISTILL_CAPTURE_FAILED_KIND,
      payload: JSON.stringify({ sessionID: opts.rootSessionId, reason }),
      sessionId: opts.rootSessionId,
      parentSessionId: null,
    })
  } catch {
    // If even the marker write fails, swallow — already logged.
  }
}

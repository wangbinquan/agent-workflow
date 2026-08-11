// RFC-048 — Subagent live capture poller.
//
// Why this exists: opencode 1.15.x's `run` subcommand uses an in-process
// server (no HTTP port), so external runners can't subscribe to child-session
// events live (see services/sessionCapture.ts header for the full story).
// RFC-027 worked around this by reading opencode's XDG SQLite once after the
// parent opencode child exited — but a subagent that runs for 8 minutes was
// invisible in the SessionTab until the final flush. RFC-048 plugs the gap by
// re-running the same BFS on a fixed cadence while the parent is still alive,
// inserting only rows that haven't been written yet (partId-level dedupe).
//
// Failure mode is non-fatal by design: any open/SELECT throw is swallowed,
// the consecutive-failure counter advances, and after `consecutiveFailureLimit`
// back-to-back failures the poller disables itself for this nodeRun. The
// runner's post-run capture (services/sessionCapture.ts:captureChildSessions)
// still runs once at the end, so even with the poller fully disabled the
// final transcript matches RFC-027 byte-for-byte.
//
// The poller is intentionally decoupled from WebSocket plumbing: it calls
// `opts.onInsert` whenever a tick lands at least one row, and the caller
// (services/runner.ts) is responsible for translating that into a broadcast.
// This keeps the live capture testable without booting the ws server.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { DbClient } from '../db/client'
import { nodeRunEvents } from '../db/schema'
import { createLogger, type Logger } from '@/util/log'
import {
  loadSiblingsCapturedSessionIds,
  resolveOpencodeDbPath,
  transcodeOpencodeRowsToEvents,
} from './sessionCapture'
import { walkOpencodeSessions } from './opencodeSessionWalk'

export interface LivePollOptions {
  nodeRunId: string
  taskId: string
  /** Workflow node id (canvas-level). Forwarded to onInsert payloads. */
  nodeId: string
  /**
   * Root opencode session id resolver. Returns null until stdoutPump observes
   * the first `sessionID` event from the child process; the poller short-
   * circuits its tick while this is null (no point BFS'ing nothing).
   */
  getRootSessionId: () => string | null
  db: DbClient
  log?: Logger
  /** Override the opencode SQLite path (tests). */
  opencodeDbPath?: string
  /** Cadence between ticks. `0` disables the poller — startLive returns a no-op handle. */
  pollMs: number
  /** Auto-disable after this many back-to-back failing ticks. */
  consecutiveFailureLimit: number
  /** When aborted, the poller stops itself. The runner pipes child.exited in here. */
  signal?: AbortSignal
  /**
   * Fired once per tick that actually inserted at least one row. The runner
   * uses this to broadcast a `node.status: running` re-ping so the frontend
   * `useTaskSync` invalidates `['tasks', taskId, 'node-runs']`. Tests can
   * pass a spy here.
   */
  onInsert?: (info: { insertedRows: number; sessionIds: string[] }) => void
}

export interface LivePollerStats {
  ticks: number
  insertedRows: number
  failedTicks: number
  disabled: boolean
  /** Snapshot of internal partId dedupe state — runner.ts forwards into post-run capture. */
  insertedPartIdsBySession: Map<string, Set<string>>
}

export interface LivePollerHandle {
  stop(): void
  /**
   * Test-only: run a single tick synchronously. The production timer just
   * invokes the same function on a setInterval cadence; exposing it lets
   * unit tests seed the SQLite fixture between ticks without sleeping.
   */
  tickOnce(): Promise<number>
  stats(): LivePollerStats
}

/** RFC-143: exported so runner's `driver.startLiveCapture?.(ctx) ?? NOOP_HANDLE`
 *  falls back cleanly when a runtime (claude) doesn't implement live capture. */
export const NOOP_HANDLE: LivePollerHandle = {
  stop: () => {},
  tickOnce: async () => 0,
  stats: () => ({
    ticks: 0,
    insertedRows: 0,
    failedTicks: 0,
    disabled: true,
    insertedPartIdsBySession: new Map(),
  }),
}

/**
 * Spin up the runner-side live poller. Returns a no-op handle when
 * `pollMs === 0` so callers don't need to special-case the disabled path.
 */
export function startLiveSubagentCapture(opts: LivePollOptions): LivePollerHandle {
  if (opts.pollMs === 0) return NOOP_HANDLE

  const log = opts.log ?? createLogger('subagentLiveCapture')
  const dbPath = opts.opencodeDbPath ?? resolveOpencodeDbPath()

  // Shared mutable state — keep small so the closure stays cheap.
  const insertedPartIdsBySession = new Map<string, Set<string>>()
  let opencodeDb: Database | null = null
  let siblingsCached: Set<string> | null = null
  let disabled = false
  let stopped = false
  let consecutiveFailures = 0
  let ticks = 0
  let insertedRows = 0
  let failedTicks = 0
  let inTick = false

  const close = (): void => {
    if (opencodeDb !== null) {
      try {
        opencodeDb.close()
      } catch {
        /* readonly close: ignore */
      }
      opencodeDb = null
    }
  }

  async function tickOnce(): Promise<number> {
    if (stopped || disabled) return 0
    if (inTick) return 0 // re-entry guard — a slow SELECT must not overlap itself
    inTick = true
    try {
      const root = opts.getRootSessionId()
      if (root === null || root === '') return 0

      if (!existsSync(dbPath)) {
        throw new Error(`opencode-db-not-found: ${dbPath}`)
      }
      if (opencodeDb === null) {
        opencodeDb = new Database(dbPath, { readonly: true })
      }

      // Sibling sessionId skip: load once on first successful tick. The set
      // can only grow across ticks (other nodeRuns finishing mid-run is
      // possible but extremely rare; even then a one-shot load is a no-op
      // for correctness — at worst we double-write a part the sibling
      // wrote after us, which the per-nodeRun partId Set guards against).
      if (siblingsCached === null) {
        siblingsCached = await loadSiblingsCapturedSessionIds(opts.db, opts.taskId, opts.nodeRunId)
      }

      let tickInserted = 0
      const changedSessions: string[] = []
      // RFC-077: BFS + per-session message/part reads via the shared walk
      // core. includeRoot:false — root events are written live by the stdout
      // pump, so the poller captures only descendants (subagent sessions).
      for (const { session: sess, messages, parts } of walkOpencodeSessions(opencodeDb, root, {
        includeRoot: false,
      })) {
        if (siblingsCached.has(sess.id)) continue

        let writtenForSession = insertedPartIdsBySession.get(sess.id)
        const fresh = parts.filter(
          (p) => writtenForSession === undefined || !writtenForSession.has(p.id),
        )
        if (fresh.length === 0) continue

        const events = transcodeOpencodeRowsToEvents({
          sessionId: sess.id,
          messages,
          parts: fresh,
        })
        if (events.length === 0) {
          // Transcode dropped every fresh part (unknown type / malformed data).
          // Still mark them as seen so we don't re-process the same garbage
          // every tick.
          if (writtenForSession === undefined) {
            writtenForSession = new Set<string>()
            insertedPartIdsBySession.set(sess.id, writtenForSession)
          }
          for (const p of fresh) writtenForSession.add(p.id)
          continue
        }

        const rows = events.map((e) => ({
          nodeRunId: opts.nodeRunId,
          ts: e.ts,
          kind: e.kind,
          payload: e.payload,
          sessionId: sess.id,
          parentSessionId: sess.parent_id,
        }))
        await opts.db.insert(nodeRunEvents).values(rows)
        if (writtenForSession === undefined) {
          writtenForSession = new Set<string>()
          insertedPartIdsBySession.set(sess.id, writtenForSession)
        }
        for (const p of fresh) writtenForSession.add(p.id)
        tickInserted += rows.length
        changedSessions.push(sess.id)
      }

      ticks += 1
      consecutiveFailures = 0
      if (tickInserted > 0) {
        insertedRows += tickInserted
        try {
          opts.onInsert?.({ insertedRows: tickInserted, sessionIds: changedSessions })
        } catch (err) {
          log.warn('subagent-live-poll-onInsert-threw', {
            nodeRunId: opts.nodeRunId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return tickInserted
    } catch (err) {
      failedTicks += 1
      consecutiveFailures += 1
      // Drop the DB handle so the next tick gets a fresh open (covers
      // schema-mismatch errors thrown mid-SELECT that leave the handle
      // unusable). open() may itself throw — counted as another failure.
      close()
      if (consecutiveFailures >= opts.consecutiveFailureLimit) {
        disabled = true
        log.warn('subagent-live-poll-disabled', {
          nodeRunId: opts.nodeRunId,
          failures: consecutiveFailures,
          lastErr: err instanceof Error ? err.message : String(err),
        })
      } else {
        log.warn('subagent-live-poll-error', {
          nodeRunId: opts.nodeRunId,
          failures: consecutiveFailures,
          err: err instanceof Error ? err.message : String(err),
        })
      }
      return 0
    } finally {
      inTick = false
    }
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (intervalHandle !== null) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
    close()
  }

  function stats(): LivePollerStats {
    return {
      ticks,
      insertedRows,
      failedTicks,
      disabled,
      insertedPartIdsBySession,
    }
  }

  // Schedule periodic ticks. Pending tickOnce promises are NOT awaited by
  // the interval — re-entry is guarded above so concurrent timer fires
  // collapse into the next slot.
  let intervalHandle: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (stopped || disabled) {
      if (intervalHandle !== null) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
      return
    }
    void tickOnce().catch((err) => {
      log.warn('subagent-live-poll-tick-unhandled', {
        nodeRunId: opts.nodeRunId,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }, opts.pollMs)

  if (opts.signal !== undefined) {
    if (opts.signal.aborted) {
      stop()
    } else {
      opts.signal.addEventListener('abort', stop, { once: true })
    }
  }

  return { stop, tickOnce, stats }
}

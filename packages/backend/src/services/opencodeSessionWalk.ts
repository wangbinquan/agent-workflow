// RFC-077 — shared opencode session-tree walk core.
//
// Three capture owners read opencode 1.15.x's XDG SQLite, BFS the
// `session.parent_id` tree and read each session's message+part rows:
//   - services/sessionCapture.ts        (RFC-027 worker node post-run)
//   - services/distillSessionCapture.ts (RFC-043 distiller post-run)
//   - services/subagentLiveCapture.ts   (RFC-048 live poll while running)
// They used to hand-copy the BFS + the two per-session SELECTs + the row
// interfaces. This module is the single source of truth for that TRAVERSAL
// step only. It deliberately does NOT transcode, dedup, insert, open/close
// the handle, or write failure markers — those carry per-owner semantics
// (target table / row shape / sibling+partId dedup / handle lifecycle /
// live-poller orchestration) and stay at each call site.
//
// Caller owns the Database lifecycle: the one-shot post-run paths open a
// readonly handle and close it after the walk; the live poller reuses one
// handle across ticks. So `walkOpencodeSessions` takes an already-open
// readonly `Database` and never closes it.

import type { Database } from 'bun:sqlite'

/** opencode `session` row (subset we read). */
export interface OpencodeSessionRow {
  id: string
  parent_id: string | null
  agent: string | null
}

/** opencode `message` row (subset we read). */
export interface OpencodeMessageRow {
  id: string
  time_created: number
  data: string
}

/** opencode `part` row (subset we read). */
export interface OpencodePartRow {
  id: string
  message_id: string
  time_created: number
  data: string
}

/** One reached session plus its message+part rows, in capture order. */
export interface WalkedSession {
  session: OpencodeSessionRow
  messages: OpencodeMessageRow[]
  parts: OpencodePartRow[]
}

export interface WalkOptions {
  /**
   * Whether the root session itself is yielded.
   *  - false (worker / live paths): root is only a BFS seed — its events
   *    are already written live by our stdout pump, so we yield only its
   *    descendants.
   *  - true (distiller path): the distiller never streams through our pump,
   *    so SQLite is the only source for the root's own events; the root row
   *    is seeded into the yield order first. Matches RFC-043's behavior of
   *    skipping the seed when the root session row is absent.
   */
  includeRoot: boolean
}

/**
 * BFS the opencode session tree from `rootSessionId` over an ALREADY-OPEN
 * readonly handle, yielding each reached session together with its
 * message+part rows (each ordered by `time_created, id`, mirroring the
 * original per-owner SELECTs).
 *
 * The traversal is bounded by a `visited` set, so a malformed
 * `parent_id` self-loop / cycle in the source DB can never hang the caller.
 *
 * Raw and side-effect free: any IO error from the underlying SELECTs
 * propagates to the caller, which handles it per its own failure mode
 * (marker row for one-shot paths, failure-counter + auto-disable for the
 * live poller).
 */
export function* walkOpencodeSessions(
  db: Database,
  rootSessionId: string,
  opts: WalkOptions,
): Generator<WalkedSession> {
  const order: OpencodeSessionRow[] = []

  if (opts.includeRoot) {
    // Seed the root row itself (distiller path). When the root session row
    // is absent we simply don't seed it — same as RFC-043's `rootRow !== null`
    // guard.
    const rootRow = db
      .query<OpencodeSessionRow, [string]>('SELECT id, parent_id, agent FROM session WHERE id = ?')
      .get(rootSessionId)
    if (rootRow !== null) order.push(rootRow)
  }

  const visited = new Set<string>()
  const queue: string[] = [rootSessionId]
  while (queue.length > 0) {
    const sid = queue.shift()!
    if (visited.has(sid)) continue
    visited.add(sid)
    const children = db
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

  for (const session of order) {
    const messages = db
      .query<
        OpencodeMessageRow,
        [string]
      >('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
      .all(session.id)
    const parts = db
      .query<
        OpencodePartRow,
        [string]
      >('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id')
      .all(session.id)
    yield { session, messages, parts }
  }
}

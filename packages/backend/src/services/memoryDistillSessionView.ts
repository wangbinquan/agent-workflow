// RFC-043 T4 — assembles MemoryDistillSessionViewSchema responses for
// GET /api/memory-distill-jobs/:id/session.
//
// One attempt entry per distill retry round (grouped by attempt_index).
// Each attempt's conversation tree is rendered via the same RFC-027
// parseSessionTree helper the worker-node SessionTab consumes, so the
// admin detail page can reuse ConversationFlow with no schema work.

import { asc, eq } from 'drizzle-orm'
import {
  parseSessionTree,
  type MemoryDistillSessionAttempt,
  type MemoryDistillSessionView,
  type ParseSessionInputEvent,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { memoryDistillEvents, memoryDistillJobs } from '@/db/schema'
import { DISTILL_CAPTURE_FAILED_KIND } from '@/services/runtime'
import { NotFoundError } from '@/util/errors'

export const DISTILLER_PRIMARY_AGENT_NAME = 'aw-memory-distiller'

export async function getDistillJobSessionView(
  db: DbClient,
  jobId: string,
): Promise<MemoryDistillSessionView> {
  const jobRow = await db
    .select()
    .from(memoryDistillJobs)
    .where(eq(memoryDistillJobs.id, jobId))
    .limit(1)
  if (jobRow.length === 0) {
    throw new NotFoundError('distill-job-not-found', `distill job '${jobId}' not found`)
  }

  const rows = await db
    .select({
      id: memoryDistillEvents.id,
      attemptIndex: memoryDistillEvents.attemptIndex,
      sessionId: memoryDistillEvents.sessionId,
      parentSessionId: memoryDistillEvents.parentSessionId,
      ts: memoryDistillEvents.ts,
      kind: memoryDistillEvents.kind,
      payload: memoryDistillEvents.payload,
    })
    .from(memoryDistillEvents)
    .where(eq(memoryDistillEvents.distillJobId, jobId))
    .orderBy(
      asc(memoryDistillEvents.attemptIndex),
      asc(memoryDistillEvents.ts),
      asc(memoryDistillEvents.id),
    )

  const byAttempt = new Map<number, typeof rows>()
  for (const r of rows) {
    let bucket = byAttempt.get(r.attemptIndex)
    if (bucket === undefined) {
      bucket = []
      byAttempt.set(r.attemptIndex, bucket)
    }
    bucket.push(r)
  }

  const attempts: MemoryDistillSessionAttempt[] = []
  // Preserve numeric attempt order (0..N-1).
  const sortedAttemptIndexes = [...byAttempt.keys()].sort((a, b) => a - b)
  for (const attemptIndex of sortedAttemptIndexes) {
    const bucket = byAttempt.get(attemptIndex)!
    const captureFailed = bucket.some((r) => r.kind === DISTILL_CAPTURE_FAILED_KIND)
    // Derive the root session from the first non-failure-marker row.
    const firstReal = bucket.find((r) => r.kind !== DISTILL_CAPTURE_FAILED_KIND)
    const rootSessionId = (firstReal ?? bucket[0])?.sessionId ?? null

    const events: ParseSessionInputEvent[] = bucket
      // Skip capture-failed markers when building the tree — the flag
      // surfaces them; the conversation tree itself should not contain
      // a synthetic placeholder.
      .filter((r) => r.kind !== DISTILL_CAPTURE_FAILED_KIND)
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        kind: r.kind,
        sessionId: r.sessionId,
        parentSessionId: r.parentSessionId,
        payload: r.payload,
      }))

    let tree: ReturnType<typeof parseSessionTree> | null = null
    if (events.length > 0 && rootSessionId !== null) {
      try {
        tree = parseSessionTree({
          rootSessionId,
          promptText: null,
          startedAt: bucket[0]?.ts ?? null,
          primaryAgentName: DISTILLER_PRIMARY_AGENT_NAME,
          events,
        })
      } catch {
        // Defensive: a malformed payload should not 500 the detail page.
        tree = null
      }
    }

    attempts.push({
      attemptIndex,
      rootSessionId,
      startedAt: bucket[0]?.ts ?? null,
      finishedAt: bucket[bucket.length - 1]?.ts ?? null,
      captureFailed,
      tree,
    })
  }

  return { attempts }
}

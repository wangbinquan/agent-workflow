// RFC-041 — distill job enqueue + daemon-side 1Hz worker (PR2 scope).
//
// The scheduler is intentionally minimal:
//   - `enqueueDistillJob` is a one-shot DB insert + WS broadcast.
//   - `startMemoryDistillLoop` sets up a setInterval that, on each tick,
//     SELECTs at most 5 pending jobs whose `next_run_at <= now`, merges
//     them with any siblings sharing the same debounce_key, hands the
//     bundle to `runDistill`, and applies exponential backoff on error.
//
// We do NOT lease running jobs to a separate worker process — Single
// daemon process, single in-process worker. Tests get full control by
// driving `tick()` synchronously instead of starting the interval.

import { and, asc, eq, inArray, lte } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  MemoryDistillJob,
  MemoryDistillJobWsMessage,
  ResolvedDistillScope,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { agents, cachedRepos, memoryDistillJobs, tasks } from '@/db/schema'
import { runDistill, type DistillerSpawnFn, rowToDistillJob } from '@/services/memoryDistiller'
import { MEMORY_DISTILL_JOB_CHANNEL, memoryDistillJobBroadcaster } from '@/ws/broadcaster'
import { createLogger } from '@/util/log'

const log = createLogger('memory-distill-scheduler')

/** 5s debounce window: collapse N events on the same (task, source) into 1 distill. */
export const DISTILL_DEBOUNCE_MS = 5_000
/** Cap how many distill jobs we kick off per tick to bound LLM concurrency. */
export const DISTILL_BATCH_LIMIT = 5
/** Failed jobs flip to permanent `failed` after this many attempts. */
export const DISTILL_MAX_ATTEMPTS = 3
/** First retry waits 2s, then 4s, then 8s before the row gives up. */
export const DISTILL_BACKOFF_BASE_MS = 30_000

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueDistillJobInput {
  sourceKind: 'clarify' | 'review' | 'feedback'
  sourceEventId: string
  taskId: string | null
  /** Override the 5s default — useful for tests. */
  debounceMs?: number
}

export interface EnqueueResult {
  jobId: string
  debounceKey: string
  nextRunAt: number
}

export async function enqueueDistillJob(
  db: DbClient,
  input: EnqueueDistillJobInput,
): Promise<EnqueueResult> {
  const debounceKey = buildDebounceKey(input)
  const scopeResolved = await computeEligibleScopes(db, input.taskId)
  const jobId = ulid()
  const now = Date.now()
  const debounceMs = input.debounceMs ?? DISTILL_DEBOUNCE_MS
  await db.insert(memoryDistillJobs).values({
    id: jobId,
    debounceKey,
    sourceKind: input.sourceKind,
    sourceEventId: input.sourceEventId,
    taskId: input.taskId,
    scopeResolvedJson: JSON.stringify(scopeResolved),
    status: 'pending',
    attempts: 0,
    nextRunAt: now + debounceMs,
    createdAt: now,
  })
  publish({ type: 'distill.queued', jobId, debounceKey })
  return { jobId, debounceKey, nextRunAt: now + debounceMs }
}

export function buildDebounceKey(input: EnqueueDistillJobInput): string {
  if (input.taskId !== null) return `${input.taskId}:${input.sourceKind}`
  return `noTask:${input.sourceKind}:${input.sourceEventId}`
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

interface SnapshotAgentNode {
  agentName?: string
  agent?: string
  kind?: string
}

export function extractAgentNamesFromSnapshot(workflowSnapshot: string): string[] {
  let parsed: { nodes?: SnapshotAgentNode[] } = {}
  try {
    parsed = JSON.parse(workflowSnapshot) as typeof parsed
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const node of parsed.nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue
    const kind = typeof node.kind === 'string' ? node.kind : null
    if (kind !== 'agent-single' && kind !== 'agent-multi') continue
    // Workflow snapshots use either `agentName` (frontend canvas) or
    // `agent` (older YAML imports). Accept both.
    const name =
      typeof node.agentName === 'string' && node.agentName.length > 0
        ? node.agentName
        : typeof node.agent === 'string' && node.agent.length > 0
          ? node.agent
          : null
    if (name !== null) out.add(name)
  }
  return [...out]
}

export async function computeEligibleScopes(
  db: DbClient,
  taskId: string | null,
): Promise<ResolvedDistillScope> {
  if (taskId === null) {
    return { agentIds: [], workflowId: null, repoId: null, includeGlobal: true }
  }
  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (taskRow === undefined) {
    return { agentIds: [], workflowId: null, repoId: null, includeGlobal: true }
  }
  const agentNames = extractAgentNamesFromSnapshot(taskRow.workflowSnapshot)
  const agentIds =
    agentNames.length === 0
      ? []
      : (
          await db.select({ id: agents.id }).from(agents).where(inArray(agents.name, agentNames))
        ).map((r) => r.id)
  let repoId: string | null = null
  if (taskRow.repoUrl !== null) {
    const repoRow = (
      await db
        .select({ id: cachedRepos.id })
        .from(cachedRepos)
        .where(eq(cachedRepos.url, taskRow.repoUrl))
        .limit(1)
    )[0]
    repoId = repoRow?.id ?? null
  }
  return {
    agentIds,
    workflowId: taskRow.workflowId,
    repoId,
    includeGlobal: true,
  }
}

// ---------------------------------------------------------------------------
// Worker tick
// ---------------------------------------------------------------------------

export interface DistillTickOptions {
  db: DbClient
  /** Inject a fake spawn for tests; production uses defaultDistillerSpawn. */
  spawnFn?: DistillerSpawnFn
  /** Default model for distiller agent. Settings: memoryDistillModel. */
  model?: string | null
  /** Default = Date.now; tests pump time forward via a mock. */
  now?: () => number
}

interface DistillJobRow {
  id: string
  debounceKey: string
  sourceKind: 'clarify' | 'review' | 'feedback'
  sourceEventId: string
  taskId: string | null
  scopeResolvedJson: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'
  attempts: number
  nextRunAt: number
  lastError: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/**
 * One tick of the worker: pull up to DISTILL_BATCH_LIMIT pending jobs whose
 * next_run_at has elapsed, merge siblings sharing each debounce_key, run
 * the distiller subprocess for each merged bundle, and apply exponential
 * backoff on failure.
 *
 * Exported so tests can drive the loop synchronously without booting
 * setInterval. Production callers use `startMemoryDistillLoop`.
 */
export async function distillTick(options: DistillTickOptions): Promise<{
  picked: number
  succeeded: number
  failed: number
  candidatesCreated: number
}> {
  const now = (options.now ?? Date.now)()
  const due = (await options.db
    .select()
    .from(memoryDistillJobs)
    .where(and(eq(memoryDistillJobs.status, 'pending'), lte(memoryDistillJobs.nextRunAt, now)))
    .orderBy(asc(memoryDistillJobs.nextRunAt))
    .limit(DISTILL_BATCH_LIMIT)) as DistillJobRow[]
  if (due.length === 0) {
    return { picked: 0, succeeded: 0, failed: 0, candidatesCreated: 0 }
  }
  // De-dup by debounce_key so we don't process the same key twice in one tick.
  const seenKeys = new Set<string>()
  const heads: DistillJobRow[] = []
  for (const row of due) {
    if (seenKeys.has(row.debounceKey)) continue
    seenKeys.add(row.debounceKey)
    heads.push(row)
  }
  let succeeded = 0
  let failed = 0
  let candidatesCreated = 0
  for (const head of heads) {
    // Pull every pending sibling sharing this debounce_key in one shot.
    const siblings = (await options.db
      .select()
      .from(memoryDistillJobs)
      .where(
        and(
          eq(memoryDistillJobs.debounceKey, head.debounceKey),
          eq(memoryDistillJobs.status, 'pending'),
        ),
      )) as DistillJobRow[]
    const ids = siblings.map((s) => s.id)
    await options.db
      .update(memoryDistillJobs)
      .set({ status: 'running', startedAt: now })
      .where(inArray(memoryDistillJobs.id, ids))
    publish({ type: 'distill.started', jobId: head.id })
    try {
      const result = await runDistill({
        db: options.db,
        job: rowToDistillJob(head),
        siblings: siblings.map(rowToDistillJob),
        spawnFn: options.spawnFn,
        model: options.model,
      })
      await options.db
        .update(memoryDistillJobs)
        .set({ status: 'done', finishedAt: (options.now ?? Date.now)() })
        .where(inArray(memoryDistillJobs.id, ids))
      publish({
        type: 'distill.done',
        jobId: head.id,
        candidatesCreated: result.candidatesCreated,
      })
      succeeded += 1
      candidatesCreated += result.candidatesCreated
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('distill failed', { jobId: head.id, error: message })
      const attempts = head.attempts + 1
      if (attempts >= DISTILL_MAX_ATTEMPTS) {
        await options.db
          .update(memoryDistillJobs)
          .set({
            status: 'failed',
            attempts,
            lastError: message.slice(0, 2000),
            finishedAt: (options.now ?? Date.now)(),
          })
          .where(inArray(memoryDistillJobs.id, ids))
      } else {
        const backoff = DISTILL_BACKOFF_BASE_MS * Math.pow(2, attempts - 1)
        await options.db
          .update(memoryDistillJobs)
          .set({
            status: 'pending',
            attempts,
            lastError: message.slice(0, 2000),
            nextRunAt: (options.now ?? Date.now)() + backoff,
            startedAt: null,
          })
          .where(inArray(memoryDistillJobs.id, ids))
      }
      publish({ type: 'distill.failed', jobId: head.id, error: message.slice(0, 200) })
      failed += 1
    }
  }
  return { picked: due.length, succeeded, failed, candidatesCreated }
}

// ---------------------------------------------------------------------------
// Daemon-side loop
// ---------------------------------------------------------------------------

export interface StartLoopOptions {
  db: DbClient
  spawnFn?: DistillerSpawnFn
  /** Settings.memoryDistillerEnabled — when false, ticker is a no-op shell. */
  enabled?: boolean
  /** Default 1000ms (1Hz). Tests can shorten / lengthen. */
  intervalMs?: number
  model?: string | null
}

export interface DistillLoopHandle {
  stop: () => void
}

/**
 * Spin up the daemon-side worker. Returns a `.stop()`-able handle. On
 * stop, any rows still marked `running` (left over from a crashed tick
 * mid-await) are flipped back to `pending` so the next start picks them
 * up. Tests should call `.stop()` to keep the handle out of the JS event
 * loop after the case finishes.
 */
export function startMemoryDistillLoop(options: StartLoopOptions): DistillLoopHandle {
  if (options.enabled === false) {
    return { stop: () => {} }
  }
  // Recover any rows left as 'running' from a crashed prior tick.
  recoverRunning(options.db).catch((err) => {
    log.warn('startup recovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
  const interval = options.intervalMs ?? 1000
  const handle = setInterval(() => {
    distillTick({ db: options.db, spawnFn: options.spawnFn, model: options.model }).catch((err) => {
      log.warn('tick threw', { error: err instanceof Error ? err.message : String(err) })
    })
  }, interval)
  return {
    stop: () => {
      clearInterval(handle)
      // Best-effort restore on stop too so a developer-side daemon restart
      // doesn't strand rows in 'running'.
      recoverRunning(options.db).catch(() => {
        // ignore
      })
    },
  }
}

export async function recoverRunning(db: DbClient): Promise<{ recovered: number }> {
  const rows = (await db
    .select()
    .from(memoryDistillJobs)
    .where(eq(memoryDistillJobs.status, 'running'))) as DistillJobRow[]
  if (rows.length === 0) return { recovered: 0 }
  await db
    .update(memoryDistillJobs)
    .set({ status: 'pending', startedAt: null })
    .where(
      inArray(
        memoryDistillJobs.id,
        rows.map((r) => r.id),
      ),
    )
  log.info('recovered running jobs', { count: rows.length })
  return { recovered: rows.length }
}

// ---------------------------------------------------------------------------
// Manual-control endpoints helpers
// ---------------------------------------------------------------------------

/**
 * Force a failed job back to pending so a subsequent tick retries it.
 * Resets attempts to 0 (admin's explicit "give it another full chance").
 * Returns false if the row is not in a re-tryable state.
 */
export async function retryFailedJob(db: DbClient, jobId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(memoryDistillJobs)
    .where(eq(memoryDistillJobs.id, jobId))
    .limit(1)
  if (rows.length === 0) return false
  const row = rows[0]!
  if (row.status !== 'failed') return false
  await db
    .update(memoryDistillJobs)
    .set({
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextRunAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    })
    .where(eq(memoryDistillJobs.id, jobId))
  publish({ type: 'distill.queued', jobId: row.id, debounceKey: row.debounceKey })
  return true
}

/** Soft-cancel a pending row (still tracked, but never executes). */
export async function cancelPendingJob(db: DbClient, jobId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(memoryDistillJobs)
    .where(eq(memoryDistillJobs.id, jobId))
    .limit(1)
  if (rows.length === 0) return false
  const row = rows[0]!
  if (row.status !== 'pending') return false
  await db
    .update(memoryDistillJobs)
    .set({ status: 'canceled', finishedAt: Date.now() })
    .where(eq(memoryDistillJobs.id, jobId))
  return true
}

export async function listDistillJobs(
  db: DbClient,
  filter: { status?: string } = {},
): Promise<MemoryDistillJob[]> {
  const where =
    filter.status !== undefined
      ? eq(memoryDistillJobs.status, filter.status as 'pending')
      : undefined
  const rows = (await (where !== undefined
    ? db.select().from(memoryDistillJobs).where(where).orderBy(asc(memoryDistillJobs.createdAt))
    : db
        .select()
        .from(memoryDistillJobs)
        .orderBy(asc(memoryDistillJobs.createdAt)))) as DistillJobRow[]
  return rows.map(rowToDistillJob)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function publish(msg: MemoryDistillJobWsMessage): void {
  memoryDistillJobBroadcaster.broadcast(MEMORY_DISTILL_JOB_CHANNEL, msg)
}

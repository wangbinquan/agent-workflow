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
  Language,
  MemoryDistillJob,
  MemoryDistillJobWsMessage,
  ResolvedDistillScope,
  SourceContextBudget,
} from '@agent-workflow/shared'
import { QUARANTINED_SNAPSHOT_AGENT_ID } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { agents, cachedRepos, memoryDistillJobs, tasks } from '@/db/schema'
import { runDistill, type DistillerSpawnFn, rowToDistillJob } from '@/services/memoryDistiller'
import { resolveInternalAgentRuntime } from '@/services/runtimeRegistry'
import { MEMORY_DISTILL_JOB_CHANNEL, memoryDistillJobBroadcaster } from '@/ws/broadcaster'
import { createLogger } from '@/util/log'

const log = createLogger('memory-distill-scheduler')

/** 5s debounce window: collapse N events on the same (task, source) into 1 distill. */
export const DISTILL_DEBOUNCE_MS = 5_000

/**
 * RFC-050: ambient provider for the per-job output language. `cli/start.ts`
 * registers a function that reads `config.memoryDistillLang` from disk on
 * every call (so edits without a daemon restart still flow through). When
 * unset (tests, early boot) the provider returns null and the runtime
 * falls back to 'en-US' (RFC-041 byte-level baseline).
 *
 * Per-call `outputLang` passed to `enqueueDistillJob` always wins.
 */
let memoryDistillLangProvider: () => Language | null = () => null

export function setMemoryDistillLangProvider(fn: () => Language | null): void {
  memoryDistillLangProvider = fn
}

/** Test-only — restore the noop provider so a leaked setter from a prior
 *  case doesn't leak into the next one. Production never calls this. */
export function resetMemoryDistillLangProviderForTest(): void {
  memoryDistillLangProvider = () => null
}
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
  /**
   * RFC-050: language for this job's distiller output. Snapshotted at
   * enqueue so retries / merged siblings within this debounce key all
   * produce candidates in the same language, even if the admin flips
   * `config.memoryDistillLang` between enqueue and run. `undefined` ≡
   * null in DB ≡ runtime fallback 'en-US' (RFC-041 byte-level baseline).
   */
  outputLang?: Language | null
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
  // RFC-050: explicit per-call wins; otherwise consult the ambient provider
  // registered by cli/start.ts at daemon boot. Null is persisted as-is and
  // means "use the runtime default" (currently 'en-US' / RFC-041 baseline).
  const outputLang: Language | null =
    input.outputLang !== undefined ? input.outputLang : memoryDistillLangProvider()
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
    outputLang,
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
  agentId?: string
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
    // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
    if (kind !== 'agent-single') continue
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

/**
 * RFC-223 (PR-3a) — split a snapshot's agent-single references into the frozen
 * CANONICAL ids (each names exactly one agent — 取单行, so no name→multi-id spread
 * after PR-8 lifts uniqueness) and the leftover legacy nodes that carry only a
 * name. A node whose `agentId` is the R4-1 quarantine sentinel is dropped
 * ENTIRELY — it is NOT downgraded to a name lookup. The sentinel means "historical
 * identity unrecoverable" (a stale frozen name that may have been ABA-reassigned to
 * a different tenant's agent), so re-resolving it by the current name would pull an
 * arbitrary tenant's memories into this task's distill scope. Fail closed here
 * (skip it) rather than fall open — only genuinely id-less legacy nodes keep the
 * deterministic name fallback (impl-gate H1).
 */
export function extractAgentRefsFromSnapshot(workflowSnapshot: string): {
  ids: string[]
  namesWithoutId: string[]
} {
  let parsed: { nodes?: SnapshotAgentNode[] } = {}
  try {
    parsed = JSON.parse(workflowSnapshot) as typeof parsed
  } catch {
    return { ids: [], namesWithoutId: [] }
  }
  const ids = new Set<string>()
  const namesWithoutId = new Set<string>()
  for (const node of parsed.nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue
    if (node.kind !== 'agent-single') continue
    // R4-1 quarantined: a PRESENT id that resolves to no agent. Skip it — never
    // fall back to the name (that is the exact ABA fail-open H1 closes).
    if (node.agentId === QUARANTINED_SNAPSHOT_AGENT_ID) continue
    const id = typeof node.agentId === 'string' && node.agentId.length > 0 ? node.agentId : null
    if (id !== null) {
      ids.add(id)
      continue
    }
    const name =
      typeof node.agentName === 'string' && node.agentName.length > 0
        ? node.agentName
        : typeof node.agent === 'string' && node.agent.length > 0
          ? node.agent
          : null
    if (name !== null) namesWithoutId.add(name)
  }
  return { ids: [...ids], namesWithoutId: [...namesWithoutId] }
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
  // RFC-223 (PR-3a): take the frozen CANONICAL ids directly (each names exactly
  // ONE agent — no name→multi-id spread); resolve only the residual legacy
  // name-only nodes by name (bounded; distill scope is a heuristic, not a
  // security boundary).
  const { ids: frozenAgentIds, namesWithoutId } = extractAgentRefsFromSnapshot(
    taskRow.workflowSnapshot,
  )
  const nameResolvedIds =
    namesWithoutId.length === 0
      ? []
      : (
          await db
            .select({ id: agents.id })
            .from(agents)
            .where(inArray(agents.name, namesWithoutId))
        ).map((r) => r.id)
  const agentIds = [...new Set([...frozenAgentIds, ...nameResolvedIds])]
  // RFC-204: see memoryInject — join on the stored mirror id. The old URL join
  // compared a REDACTED tasks.repo_url against the plaintext cached_repos.url,
  // so it missed private repos entirely and, once the credential column is
  // blanked, would have matched arbitrary rows on ''.
  let repoId: string | null = null
  if (taskRow.cachedRepoId !== null) {
    const repoRow = (
      await db
        .select({ id: cachedRepos.id })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, taskRow.cachedRepoId))
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
  /** RFC-117 — runtime profile NAME (config.memoryDistillRuntime); wins over `model`. */
  runtimeName?: string | null
  /** RFC-117 — global default runtime name (config.defaultRuntime) for inheritance. */
  defaultRuntime?: string | null
  /** @deprecated RFC-117 — transition fallback (config.memoryDistillModel). */
  model?: string | null
  /**
   * RFC-044: per-source byte budget for distiller user prompt context.
   * Plumbed from `config.memoryDistillSourceContext`. Defaults to
   * DEFAULT_SOURCE_CONTEXT_BUDGET when omitted.
   */
  sourceContextBudget?: SourceContextBudget
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
  outputLang?: string | null
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
  // RFC-117: resolve the distiller runtime once per tick (per-feature profile
  // name → default → deprecated model fallback). Runtime config can't change
  // within a tick; resolving once keeps every merged bundle on the same runtime.
  const rt = await resolveInternalAgentRuntime(options.db, {
    runtimeName: options.runtimeName,
    deprecatedModel: options.model,
    defaultRuntime: options.defaultRuntime,
  })
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
        protocol: rt.protocol,
        runtimeBinary: rt.binaryPath,
        model: rt.model,
        sourceContextBudget: options.sourceContextBudget,
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
  /** RFC-117 — runtime profile NAME (config.memoryDistillRuntime); wins over `model`. */
  runtimeName?: string | null
  /** RFC-117 — global default runtime name (config.defaultRuntime) for inheritance. */
  defaultRuntime?: string | null
  /** @deprecated RFC-117 — transition fallback (config.memoryDistillModel). */
  model?: string | null
  /** RFC-044: forwarded to distillTick → runDistill on every tick. */
  sourceContextBudget?: SourceContextBudget
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
  // Reentrancy guard — mirrors the sibling tickers (gc.ts, eventsArchive.ts).
  // distillTick is async and awaits a real LLM spawn (runDistill) that can take
  // seconds, while the interval is 1Hz. Without this guard, tick N+1 fires while
  // tick N is still awaiting: both SELECT the same `pending` rows before either
  // has UPDATE'd them to `running` (there are awaits between the SELECT at the
  // top of distillTick and the per-head claim), so the same debounce_key gets
  // distilled twice — duplicate memory candidates + double token spend +
  // attempts/lastError clobbering each other. Single-process deployment (flock
  // single-instance) means this in-process guard fully closes the overlap.
  // See design/test-guard-audit-2026-07-21 gap B6-data-4 / Top-16.
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    distillTick({
      db: options.db,
      spawnFn: options.spawnFn,
      runtimeName: options.runtimeName,
      defaultRuntime: options.defaultRuntime,
      model: options.model,
      sourceContextBudget: options.sourceContextBudget,
    })
      .catch((err) => {
        log.warn('tick threw', { error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running = false
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

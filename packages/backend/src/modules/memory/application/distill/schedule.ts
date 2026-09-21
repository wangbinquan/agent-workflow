// RFC-041 — distill job enqueue + daemon-side 1Hz worker (PR2 scope)。
// RFC-352 T7（RFC-294 W4-E2）把它从 `services/memoryDistillScheduler.ts` 迁进 memory 模块的
// application 层——入队、去抖、退避、恢复、重试、取消都是 memory 自己的编排，不该住在
// 横向平铺的 services/ 层。行为零变化：批次上限、去抖键、指数退避、`DISTILL_MAX_ATTEMPTS`、
// 「单 daemon 单进程内 worker、不做租约」这些语义全部保持原样。
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

import { ulid } from 'ulid'
import type {
  DistillPolicy,
  DistillSourceKind,
  Language,
  MemoryDistillJob,
  MemoryDistillJobWsMessage,
  ResolvedDistillScope,
  SourceContextBudget,
} from '@agent-workflow/shared'
import {
  DEFAULT_DISTILL_POLICY,
  QUARANTINED_SNAPSHOT_AGENT_ID,
  WorkgroupRuntimeConfigSchema,
} from '@agent-workflow/shared'
import { distillAdmission } from '@/modules/memory/domain/distillAdmission'
import {
  runDistill,
  type RunDistillOptions,
  rowToDistillJob,
} from '@/modules/memory/application/distill/memoryDistiller'
import { MEMORY_DISTILL_JOB_CHANNEL, memoryDistillJobBroadcaster } from '@/ws/broadcaster'
import { createLogger } from '@/util/log'
import { agentRefOfNode } from '@/services/ref/runtimeRef'
import type {
  MemoryDistillReviewedArtifactReader,
  MemoryDistillRuntimeResolver,
  MemoryDistillTaskScopeRecord,
  MemoryDistillWorkStore,
} from '@/modules/memory/application/ports/distillWorkStore'
import type { MemoryDistillJobRecord } from '@/modules/memory/application/ports/distillReadStore'

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

/**
 * RFC-366: ambient provider for the distill POLICY — which task origins and
 * which sources may enqueue, plus the agent-run debounce window. Same shape and
 * same reason as the RFC-050 language provider above: `cli/start.ts` registers
 * one that re-reads `config.json` on every call, so a settings edit takes effect
 * on the next event instead of at the next daemon restart (RFC-366 D10).
 *
 * The default is deliberately the permissive-for-sources / manual-only-for-origins
 * shape rather than "everything on": tests and early boot must see the same
 * defaults a fresh install sees, or the gate's behaviour would differ between
 * the first event after boot and every later one.
 */
let memoryDistillPolicyProvider: () => DistillPolicy = () => DEFAULT_DISTILL_POLICY

export function setMemoryDistillPolicyProvider(fn: () => DistillPolicy): void {
  memoryDistillPolicyProvider = fn
}

/** Test-only — see {@link resetMemoryDistillLangProviderForTest}. */
export function resetMemoryDistillPolicyProviderForTest(): void {
  memoryDistillPolicyProvider = () => DEFAULT_DISTILL_POLICY
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
  sourceKind: DistillSourceKind
  sourceEventId: string
  taskId: string | null
  /**
   * RFC-366 (`agent-run` only): the workflow node whose run just settled.
   *
   * Passed instead of a resolved agent id on purpose — resolving a node to its
   * frozen `agents.id` needs the task's workflow snapshot, which this function
   * already reads for the scope. Making the caller do it would put a second
   * copy of that lookup in task-execution, and a second copy is a second thing
   * that can disagree about what `QUARANTINED_SNAPSHOT_AGENT_ID` means.
   */
  nodeId?: string
  /** Override the default window — useful for tests. */
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

/**
 * RFC-366: the ONE place the distill gate runs. Every source kind reaches the
 * queue through this function, so no caller can route around the policy.
 *
 * Returns `null` when the event is not admitted — callers treat that as "this
 * event produced no job", never as an error (the four pre-RFC-366 call sites
 * were all best-effort or durable-consumer shaped already).
 */
export async function enqueueDistillJob(
  store: MemoryDistillWorkStore,
  input: EnqueueDistillJobInput,
): Promise<EnqueueResult | null> {
  const policy = memoryDistillPolicyProvider()
  const taskRow = input.taskId === null ? null : await store.findTaskScope(input.taskId)
  const admission = distillAdmission({
    sourceKind: input.sourceKind,
    task:
      taskRow === null
        ? null
        : {
            launchOrigin: taskRow.launchOrigin,
            catalogVisibility: taskRow.catalogVisibility,
            spaceKind: taskRow.spaceKind,
          },
    policy,
  })
  if (!admission.admitted) {
    log.debug('distill enqueue rejected', {
      sourceKind: input.sourceKind,
      sourceEventId: input.sourceEventId,
      taskId: input.taskId,
      reason: admission.reason,
    })
    return null
  }
  // RFC-366 D11: an agent-run job's candidates must be able to bind to the agent
  // that just finished, and ONLY that agent. `runDistill` reads the HEAD job's
  // scope and discards its merged siblings', so the narrowed agent has to be
  // part of the debounce key too — see buildDebounceKey.
  const narrowAgentId =
    input.sourceKind === 'agent-run' && input.nodeId !== undefined && taskRow !== null
      ? agentIdOfSnapshotNode(taskRow.workflowSnapshot, input.nodeId)
      : null
  const debounceKey = buildDebounceKey({ ...input, narrowAgentId })
  const scopeResolved = scopeFromTaskRow(taskRow, narrowAgentId)
  const jobId = ulid()
  const now = Date.now()
  const debounceMs = input.debounceMs ?? defaultDebounceMs(input.sourceKind, policy)
  // RFC-050: explicit per-call wins; otherwise consult the ambient provider
  // registered by cli/start.ts at daemon boot. Null is persisted as-is and
  // means "use the runtime default" (currently 'en-US' / RFC-041 baseline).
  const outputLang: Language | null =
    input.outputLang !== undefined ? input.outputLang : memoryDistillLangProvider()
  await store.enqueue({
    id: jobId,
    debounceKey,
    sourceKind: input.sourceKind,
    sourceEventId: input.sourceEventId,
    taskId: input.taskId,
    scope: scopeResolved,
    nextRunAt: now + debounceMs,
    createdAt: now,
    outputLang,
  })
  publish({ type: 'distill.queued', jobId, debounceKey })
  return { jobId, debounceKey, nextRunAt: now + debounceMs }
}

/** RFC-366 D8: agent-run gets its own (longer) window; the other four keep 5s. */
function defaultDebounceMs(
  sourceKind: DistillSourceKind,
  policy: Pick<DistillPolicy, 'agentRunDebounceMs'>,
): number {
  return sourceKind === 'agent-run' ? policy.agentRunDebounceMs : DISTILL_DEBOUNCE_MS
}

/**
 * RFC-366 INVARIANT — **a debounce key must determine the job's scope.**
 *
 * `distillTick` merges every pending sibling that shares a key into one
 * distiller run, and `runDistill` then uses the HEAD job's `scopeResolved` and
 * throws the siblings' away. For the four task-keyed sources that is harmless:
 * their scope is a pure function of `taskId`, so head and siblings always agree.
 * `agent-run` narrows the scope to one agent (D11), so its key carries the agent
 * too — otherwise agent A's transcript could produce a memory filed under agent
 * B just because their runs finished within the same window.
 *
 * Nodes whose agent cannot be resolved (name-only nodes, the quarantine
 * sentinel, workgroup hosts) fall back to the node id: still one key per
 * subject, and `scopeFromTaskRow` correspondingly does not narrow.
 */
export function buildDebounceKey(
  input: Pick<EnqueueDistillJobInput, 'sourceKind' | 'sourceEventId' | 'taskId' | 'nodeId'> & {
    readonly narrowAgentId?: string | null
  },
): string {
  if (input.taskId === null) return `noTask:${input.sourceKind}:${input.sourceEventId}`
  if (input.sourceKind === 'agent-run') {
    const subject = input.narrowAgentId ?? `node:${input.nodeId ?? input.sourceEventId}`
    return `${input.taskId}:agent-run:${subject}`
  }
  return `${input.taskId}:${input.sourceKind}`
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

interface SnapshotAgentNode {
  agentId?: string
  agentName?: string
  kind?: string
}

/**
 * RFC-223 T15 — extract only frozen canonical ids. A name-only node and the
 * quarantine sentinel both contribute no scope; neither may be resolved
 * against today's mutable name registry.
 */
export function extractAgentIdsFromSnapshot(workflowSnapshot: string): string[] {
  let parsed: { nodes?: SnapshotAgentNode[] } = {}
  try {
    parsed = JSON.parse(workflowSnapshot) as typeof parsed
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const node of parsed.nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue
    if (node.kind !== 'agent-single') continue
    if (node.agentId === QUARANTINED_SNAPSHOT_AGENT_ID) continue
    // RFC-284 T22：判据改走唯一读取点（services/ref/runtimeRef.agentRefOfNode），
    // QUARANTINED 过滤仍留本地（上一行）——它是 distill 语义不是 ref 语义。
    const ref = agentRefOfNode(node)
    if (ref !== null && ref.k === 'id') ids.add(ref.id)
  }
  return [...ids]
}

/**
 * Workgroup host snapshots contain framework placeholders, not one node per
 * roster member. The frozen runtime config is therefore the canonical source
 * for every member agent participating in the task.
 */
export function extractAgentIdsFromWorkgroupConfig(workgroupConfigJson: string | null): string[] {
  if (workgroupConfigJson === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(workgroupConfigJson)
  } catch {
    return []
  }
  const parsed = WorkgroupRuntimeConfigSchema.safeParse(raw)
  if (!parsed.success) return []
  const ids = new Set<string>()
  for (const member of parsed.data.members) {
    if (member.memberType !== 'agent') continue
    if (
      typeof member.agentId === 'string' &&
      member.agentId.length > 0 &&
      member.agentId !== QUARANTINED_SNAPSHOT_AGENT_ID
    ) {
      ids.add(member.agentId)
    }
  }
  return [...ids]
}

/**
 * RFC-366 D11 — resolve ONE workflow node to its frozen agent id.
 *
 * Same criteria as {@link extractAgentIdsFromSnapshot}, just pointed at a single
 * node: `agent-single` only, canonical id only (a name-only node must not be
 * resolved against today's mutable name registry — RFC-223 T15), quarantine
 * sentinel excluded. Returns null when the node is unresolvable, which is the
 * signal not to narrow the scope at all.
 */
export function agentIdOfSnapshotNode(workflowSnapshot: string, nodeId: string): string | null {
  let parsed: { nodes?: (SnapshotAgentNode & { id?: string })[] } = {}
  try {
    parsed = JSON.parse(workflowSnapshot) as typeof parsed
  } catch {
    return null
  }
  for (const node of parsed.nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue
    if (node.id !== nodeId) continue
    if (node.kind !== 'agent-single') return null
    if (node.agentId === QUARANTINED_SNAPSHOT_AGENT_ID) return null
    const ref = agentRefOfNode(node)
    return ref !== null && ref.k === 'id' ? ref.id : null
  }
  return null
}

/**
 * RFC-366: scope resolution off an already-read task row.
 *
 * Split out of {@link computeEligibleScopes} so `enqueueDistillJob` can read the
 * task once and use it for both the admission gate and the scope — the two used
 * to be one call, and adding a second `findTaskScope` would have let the gate
 * and the scope see different rows.
 *
 * `narrowAgentId` (D11) restricts the agent scopes to the agent whose run just
 * settled. Null means "no narrowing" and reproduces the pre-RFC-366 behaviour
 * byte for byte, which is what the other four sources still get.
 */
export function scopeFromTaskRow(
  taskRow: MemoryDistillTaskScopeRecord | null,
  narrowAgentId: string | null = null,
): ResolvedDistillScope {
  if (taskRow === null) {
    return { agentIds: [], workflowId: null, repoId: null, includeGlobal: true }
  }
  const agentIds =
    narrowAgentId !== null
      ? [narrowAgentId]
      : [
          ...new Set([
            ...extractAgentIdsFromSnapshot(taskRow.workflowSnapshot),
            ...extractAgentIdsFromWorkgroupConfig(taskRow.workgroupConfigJson),
          ]),
        ]
  // RFC-204: see memoryInject — join on the stored mirror id. The old URL join
  // compared a REDACTED tasks.repo_url against the plaintext cached_repos.url,
  // so it missed private repos entirely and, once the credential column is
  // blanked, would have matched arbitrary rows on ''.
  let repoId: string | null = null
  if (taskRow.cachedRepoId !== null && taskRow.cachedRepoExists) repoId = taskRow.cachedRepoId
  return {
    agentIds,
    workflowId: taskRow.workflowId,
    repoId,
    includeGlobal: true,
  }
}

export async function computeEligibleScopes(
  store: MemoryDistillWorkStore,
  taskId: string | null,
): Promise<ResolvedDistillScope> {
  if (taskId === null) return scopeFromTaskRow(null)
  return scopeFromTaskRow(await store.findTaskScope(taskId))
}

// ---------------------------------------------------------------------------
// Worker tick
// ---------------------------------------------------------------------------

export interface DistillTickOptions {
  store: MemoryDistillWorkStore
  reviewedArtifacts: MemoryDistillReviewedArtifactReader
  runtimeResolver: MemoryDistillRuntimeResolver
  /** RFC-367 test seam; production uses `runSystemAgent`. */
  runFn?: RunDistillOptions['runFn']
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
  /**
   * Per-run distiller timeout (ms), plumbed from `config.memoryDistillTimeoutMs`.
   * Omitted → runDistill's DEFAULT_TIMEOUT_MS (1 hour).
   */
  timeoutMs?: number
  /** Default = Date.now; tests pump time forward via a mock. */
  now?: () => number
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
  const due = await options.store.listDue(now, DISTILL_BATCH_LIMIT)
  if (due.length === 0) {
    return { picked: 0, succeeded: 0, failed: 0, candidatesCreated: 0 }
  }
  // De-dup by debounce_key so we don't process the same key twice in one tick.
  const seenKeys = new Set<string>()
  const heads: MemoryDistillJobRecord[] = []
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
  const rt = await options.runtimeResolver.resolve({
    runtimeName: options.runtimeName,
    deprecatedModel: options.model,
    defaultRuntime: options.defaultRuntime,
  })
  for (const head of heads) {
    // Pull every pending sibling sharing this debounce_key in one shot.
    const siblings = await options.store.listPendingSiblings(head.debounceKey)
    const ids = siblings.map((s) => s.id)
    await options.store.markRunning(ids, now)
    publish({ type: 'distill.started', jobId: head.id })
    try {
      const result = await runDistill({
        store: options.store,
        reviewedArtifacts: options.reviewedArtifacts,
        job: rowToDistillJob(head),
        siblings: siblings.map(rowToDistillJob),
        runFn: options.runFn,
        protocol: rt.protocol,
        runtimeBinary: rt.binaryPath,
        model: rt.model,
        isSandbox: rt.isSandbox,
        sourceContextBudget: options.sourceContextBudget,
        timeoutMs: options.timeoutMs,
      })
      await options.store.markDone(ids, (options.now ?? Date.now)())
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
        await options.store.markFailed({
          ids,
          attempts,
          error: message.slice(0, 2000),
          now: (options.now ?? Date.now)(),
          retryAt: null,
        })
      } else {
        const backoff = DISTILL_BACKOFF_BASE_MS * Math.pow(2, attempts - 1)
        const failedAt = (options.now ?? Date.now)()
        await options.store.markFailed({
          ids,
          attempts,
          error: message.slice(0, 2000),
          now: failedAt,
          retryAt: failedAt + backoff,
        })
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
  store: MemoryDistillWorkStore
  reviewedArtifacts: MemoryDistillReviewedArtifactReader
  runtimeResolver: MemoryDistillRuntimeResolver
  runFn?: RunDistillOptions['runFn']
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
  /** Forwarded to distillTick → runDistill on every tick (config.memoryDistillTimeoutMs). */
  timeoutMs?: number
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
  recoverRunning(options.store).catch((err) => {
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
      store: options.store,
      reviewedArtifacts: options.reviewedArtifacts,
      runtimeResolver: options.runtimeResolver,
      runFn: options.runFn,
      runtimeName: options.runtimeName,
      defaultRuntime: options.defaultRuntime,
      model: options.model,
      sourceContextBudget: options.sourceContextBudget,
      timeoutMs: options.timeoutMs,
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
      recoverRunning(options.store).catch(() => {
        // ignore
      })
    },
  }
}

export async function recoverRunning(
  store: MemoryDistillWorkStore,
): Promise<{ recovered: number }> {
  const recovered = await store.recoverRunning()
  if (recovered > 0) log.info('recovered running jobs', { count: recovered })
  return { recovered }
}

// ---------------------------------------------------------------------------
// Manual-control endpoints helpers
// ---------------------------------------------------------------------------

/**
 * Force a failed job back to pending so a subsequent tick retries it.
 * Resets attempts to 0 (admin's explicit "give it another full chance").
 * Returns false if the row is not in a re-tryable state.
 */
export async function retryFailedJob(
  store: MemoryDistillWorkStore,
  jobId: string,
): Promise<boolean> {
  const row = await store.retryFailed(jobId, Date.now())
  if (row === null) return false
  publish({ type: 'distill.queued', jobId: row.id, debounceKey: row.debounceKey })
  return true
}

/** Soft-cancel a pending row (still tracked, but never executes). */
export async function cancelPendingJob(
  store: MemoryDistillWorkStore,
  jobId: string,
): Promise<boolean> {
  return store.cancelPending(jobId, Date.now())
}

export async function listDistillJobs(
  store: MemoryDistillWorkStore,
  filter: { status?: string } = {},
): Promise<MemoryDistillJob[]> {
  const rows = await store.listJobs(filter.status)
  return rows.map(rowToDistillJob)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function publish(msg: MemoryDistillJobWsMessage): void {
  memoryDistillJobBroadcaster.broadcast(MEMORY_DISTILL_JOB_CHANNEL, msg)
}

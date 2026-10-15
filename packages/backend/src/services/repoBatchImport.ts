// RFC-033: Batch import driver for the `/repos` page.
//
// Responsibilities:
//   - `startBatchImport`: validate + dedupe + queue rows, return synchronously
//     with a snapshot so the HTTP caller never blocks on `git clone`.
//   - `pumpQueue` / `runRow`: consume the queue concurrently (capped by a
//     global cross-batch semaphore, default 3), delegate the actual clone to
//     `resolveCachedRepo` (RFC-024).
//   - `retryBatchRow`: re-enqueue a terminated row, optionally with a new URL.
//   - `gcBatches`: drop completed batches older than the retention TTL.
//   - All row state lives in this module's `batches` map; daemon restart
//     wipes in-flight progress but never loses successfully cloned cache rows
//     (those are committed by `resolveCachedRepo` before this module sees them).
//
// Concurrency:
//   - Global semaphore caps simultaneous `runRow` calls across every batch,
//     preventing 2 batches × 3 workers = 6 clones from saturating I/O.
//   - Same-URL serialization is delegated to `resolveCachedRepo`'s own
//     per-URL mutex — duplicate URLs across batches will simply cache-hit.
//
// Redaction:
//   - The original `inputUrl` is retained in memory so retries / cache hits
//     keep working with credential-bearing URLs.
//   - Every wire-bound copy (snapshot row, WS message, log line, error
//     message) passes through `redactGitUrl` or `clipAndRedact`.

import {
  BATCH_IMPORT_MAX_URLS,
  type BatchImportRow,
  type BatchImportSnapshot,
  type BatchImportState,
  type BatchImportRowStatus,
  redactGitUrl,
  parseGitUrl,
  type RepoImportWsMessage,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { SecretBox } from '@/auth/secretBox'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/public/operations'
import { REPO_IMPORT_CHANNEL, repoImportsBroadcaster } from '@/ws/broadcaster'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { resolveCachedRepo as defaultResolveCachedRepo } from '@/services/gitRepoCache'
import { HOUR_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { startMaintenanceTicker } from './maintenanceTicker'

const log = createLogger('repo-batch-import')

const DEFAULT_CONCURRENCY = 3
const DEFAULT_RETENTION_MS = 60 * 60 * 1000

const MESSAGE_CLIP = 400

interface MutableRow {
  rowId: string
  /** Original input URL — may contain credentials. Never leaves the module. */
  inputUrl: string
  status: BatchImportRowStatus
  cold: boolean | null
  fetchOk: boolean | null
  cachedRepoId: string | null
  errorCode: string | null
  message: string | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

interface BatchRecord {
  batchId: string
  /** RFC-285 B6②：批次发起者——WS 升级门（发起者 ∨ `resource-acl:bypass`）的判定依据。 */
  ownerUserId: string
  state: BatchImportState
  createdAt: number
  completedAt: number | null
  rows: Map<string, MutableRow>
  order: string[]
  pendingQueue: string[]
  inFlight: Set<string>
  /** Awaiter callbacks signalled when any in-flight row finishes. */
  waiters: Array<() => void>
  /** True while a pumpQueue loop is running for this batch. */
  pumping: boolean
}

const batches = new Map<string, BatchRecord>()

// Module-global semaphore: caps the total `runRow` operations across batches.
let globalConcurrency = DEFAULT_CONCURRENCY
let globalInFlight = 0
const globalWaiters: Array<() => void> = []

/**
 * RFC-285 B6②：WS 升级门的判定读点。缺行返回 null——门以「与不存在同形」
 * 拒绝（batch-not-found），不泄露批次存在性。
 */
export function batchOwnerUserId(batchId: string): string | null {
  return batches.get(batchId)?.ownerUserId ?? null
}

/** Test-only: reset internal state between cases. */
export function __resetBatchImportForTests(): void {
  batches.clear()
  globalConcurrency = DEFAULT_CONCURRENCY
  globalInFlight = 0
  globalWaiters.length = 0
}

export interface RepoBatchImportDeps {
  store: RepositoryWorkspaceStore
  appHome?: string
  /** Seal imported private-repo URLs so later refreshes survive a daemon reload. */
  secretBox?: SecretBox
  /** Override clone executor (tests). Defaults to `resolveCachedRepo`. */
  resolveCachedRepo?: typeof defaultResolveCachedRepo
  /** Concurrency cap shared across batches. Default 3 (1..8). */
  concurrency?: number
  /** TTL for completed batches before GC. Default 60 min. */
  retentionMs?: number
  /** Custom emit (tests can capture broadcast). Defaults to repoImportsBroadcaster. */
  emit?: (batchId: string, msg: RepoImportWsMessage) => void
  now?: () => number
}

export interface StartBatchImportInput {
  urls: string[]
}

export interface StartBatchImportResult {
  batchId: string
  snapshot: BatchImportSnapshot
}

/**
 * Validate, dedupe, and queue a batch. Returns synchronously — the actual
 * clones happen in the background via `pumpQueue`.
 */
export function startBatchImport(
  deps: RepoBatchImportDeps,
  input: StartBatchImportInput,
  // RFC-285 B6②：ownership 随创建落地（此前批次无归属，/ws/repo-imports 完全
  // 无门——RFC-152 D4 登记的缺口）。owner 来自路由 actor，绝不来自请求体。
  owner: { userId: string },
): StartBatchImportResult {
  if (typeof deps.concurrency === 'number') {
    setGlobalConcurrency(deps.concurrency)
  }
  const now = deps.now ?? Date.now

  // Trim + drop blanks + de-duplicate while preserving order.
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const raw of input.urls) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    uniq.push(trimmed)
  }

  if (uniq.length === 0) {
    throw new DomainError('batch-empty', 'no non-empty URLs provided', 400)
  }
  if (uniq.length > BATCH_IMPORT_MAX_URLS) {
    throw new DomainError(
      'batch-too-large',
      `batch size ${uniq.length} exceeds max ${BATCH_IMPORT_MAX_URLS}`,
      400,
      { max: BATCH_IMPORT_MAX_URLS },
    )
  }

  const batchId = ulid()
  const record: BatchRecord = {
    batchId,
    ownerUserId: owner.userId,
    state: 'running',
    createdAt: now(),
    completedAt: null,
    rows: new Map(),
    order: [],
    pendingQueue: [],
    inFlight: new Set(),
    waiters: [],
    pumping: false,
  }

  for (const url of uniq) {
    const rowId = ulid()
    const queuedAt = now()
    const parsed = parseGitUrl(url)
    if (parsed === null) {
      const failed: MutableRow = {
        rowId,
        inputUrl: url,
        status: 'failed',
        cold: null,
        fetchOk: null,
        cachedRepoId: null,
        errorCode: 'repo-url-invalid',
        message: clipAndRedact('unsupported or malformed Git URL', url),
        queuedAt,
        startedAt: null,
        finishedAt: queuedAt,
      }
      record.rows.set(rowId, failed)
      record.order.push(rowId)
      // Row is born terminal — no queue, no worker. Snapshot will reflect it.
      continue
    }
    const queued: MutableRow = {
      rowId,
      inputUrl: url,
      status: 'queued',
      cold: null,
      fetchOk: null,
      cachedRepoId: null,
      errorCode: null,
      message: null,
      queuedAt,
      startedAt: null,
      finishedAt: null,
    }
    record.rows.set(rowId, queued)
    record.order.push(rowId)
    record.pendingQueue.push(rowId)
  }

  batches.set(batchId, record)

  // If every row was invalid, the batch is already done.
  if (record.pendingQueue.length === 0 && record.inFlight.size === 0) {
    record.state = 'completed'
    record.completedAt = now()
    emit(deps, batchId, {
      type: 'batch.completed',
      batchId,
      completedAt: new Date(record.completedAt).toISOString(),
    })
  } else {
    queueMicrotask(() => {
      void pumpQueue(deps, record)
    })
  }

  return { batchId, snapshot: serialize(record) }
}

/** Read-only snapshot. Returns null when the batch has been GC'd or never existed. */
export function getBatchSnapshot(batchId: string): BatchImportSnapshot | null {
  const record = batches.get(batchId)
  if (!record) return null
  return serialize(record)
}

export interface RetryBatchRowOverride {
  url?: string
}

/**
 * Re-enqueue a terminated row. If the batch was already `completed` we rewind
 * its state to `running` and restart the pump so the new row gets picked up.
 */
export function retryBatchRow(
  deps: RepoBatchImportDeps,
  batchId: string,
  rowId: string,
  override: RetryBatchRowOverride = {},
): BatchImportSnapshot {
  const record = batches.get(batchId)
  if (!record) {
    throw new NotFoundError('batch-not-found', `batch ${batchId} not found or expired`)
  }
  const row = record.rows.get(rowId)
  if (!row) {
    throw new NotFoundError('row-not-found', `row ${rowId} not found in batch ${batchId}`)
  }
  if (row.status !== 'failed' && row.status !== 'done') {
    throw new DomainError(
      'row-not-retryable',
      `row ${rowId} is in status ${row.status}; only terminated rows can be retried`,
      409,
    )
  }

  const now = deps.now ?? Date.now
  if (typeof override.url === 'string' && override.url.trim().length > 0) {
    row.inputUrl = override.url.trim()
  }

  // Reset terminal state.
  row.cold = null
  row.fetchOk = null
  row.cachedRepoId = null
  row.errorCode = null
  row.message = null
  row.startedAt = null
  row.finishedAt = null
  row.queuedAt = now()

  const parsed = parseGitUrl(row.inputUrl)
  if (parsed === null) {
    row.status = 'failed'
    row.errorCode = 'repo-url-invalid'
    row.message = clipAndRedact('unsupported or malformed Git URL', row.inputUrl)
    row.finishedAt = now()
    emit(deps, batchId, { type: 'row.update', row: rowToWire(row) })
    // If the batch was already completed, it stays completed (no change in
    // terminal-set membership).
    if (record.state === 'completed') {
      // no-op: still completed
    }
    return serialize(record)
  }

  row.status = 'queued'
  record.pendingQueue.push(rowId)
  emit(deps, batchId, { type: 'row.update', row: rowToWire(row) })

  if (record.state === 'completed') {
    record.state = 'running'
    record.completedAt = null
  }
  if (!record.pumping) {
    queueMicrotask(() => {
      void pumpQueue(deps, record)
    })
  }
  return serialize(record)
}

export interface GcResult {
  evicted: number
}

/**
 * Start an hourly ticker that GC's completed batches past their retention.
 * Mirrors the shape of `startWorktreeGc` / `startEventsArchiver`.
 */
export function startBatchImportGc(
  intervalMs: number = HOUR_MS,
  retentionMs: number = DEFAULT_RETENTION_MS,
  // RFC-322：错峰相位。原实现的 handle 没有 unref()，收编后统一 unref——本 GC 的
  // 定时器不该独自把进程吊活着，daemon 寿命由 HTTP server 与 shutdown 路径决定。
  phaseOffsetMs: number = MAINTENANCE_PHASE.batchImportGc,
): { stop: () => void } {
  return startMaintenanceTicker({
    job: 'batchImportGc',
    intervalMs,
    phaseOffsetMs,
    onTick: () => {
      try {
        gcBatches({ retentionMs })
      } catch (err) {
        log.warn('gcBatches threw', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })
}

export function gcBatches(deps: { retentionMs?: number; now?: () => number } = {}): GcResult {
  const now = (deps.now ?? Date.now)()
  const ttl = deps.retentionMs ?? DEFAULT_RETENTION_MS
  let evicted = 0
  for (const [id, record] of batches) {
    if (record.state !== 'completed') continue
    if (record.completedAt === null) continue
    if (now - record.completedAt > ttl) {
      batches.delete(id)
      evicted += 1
    }
  }
  if (evicted > 0) {
    log.info('gc evicted completed batches', { evicted, ttl })
  }
  return { evicted }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function setGlobalConcurrency(n: number): void {
  const clamped = Math.max(1, Math.min(8, Math.floor(n)))
  if (clamped === globalConcurrency) return
  globalConcurrency = clamped
  // Wake any waiters that may now fit under the new cap.
  while (globalInFlight < globalConcurrency && globalWaiters.length > 0) {
    const wake = globalWaiters.shift()!
    wake()
  }
}

async function acquireSlot(): Promise<void> {
  if (globalInFlight < globalConcurrency) {
    globalInFlight += 1
    return
  }
  await new Promise<void>((resolve) => {
    globalWaiters.push(() => {
      globalInFlight += 1
      resolve()
    })
  })
}

function releaseSlot(): void {
  globalInFlight -= 1
  if (globalInFlight < 0) globalInFlight = 0
  if (globalInFlight < globalConcurrency && globalWaiters.length > 0) {
    const wake = globalWaiters.shift()!
    wake()
  }
}

async function pumpQueue(deps: RepoBatchImportDeps, record: BatchRecord): Promise<void> {
  if (record.pumping) return
  record.pumping = true
  try {
    while (record.pendingQueue.length > 0 || record.inFlight.size > 0) {
      while (record.pendingQueue.length > 0) {
        const rowId = record.pendingQueue.shift()!
        record.inFlight.add(rowId)
        // Fire-and-forget; runRow always finalizes via finally.
        void acquireSlot()
          .then(() => runRow(deps, record, rowId))
          .catch((err) => {
            log.warn('runRow leaked exception', {
              batchId: record.batchId,
              rowId,
              error: err instanceof Error ? err.message : String(err),
            })
          })
      }
      if (record.inFlight.size === 0) break
      await new Promise<void>((resolve) => record.waiters.push(resolve))
    }
    record.state = 'completed'
    record.completedAt = (deps.now ?? Date.now)()
    emit(deps, record.batchId, {
      type: 'batch.completed',
      batchId: record.batchId,
      completedAt: new Date(record.completedAt).toISOString(),
    })
  } finally {
    record.pumping = false
  }
}

async function runRow(
  deps: RepoBatchImportDeps,
  record: BatchRecord,
  rowId: string,
): Promise<void> {
  const row = record.rows.get(rowId)
  if (!row) {
    releaseSlot()
    record.inFlight.delete(rowId)
    resolveAnyWaiter(record)
    return
  }
  const now = deps.now ?? Date.now
  row.status = 'cloning'
  row.startedAt = now()
  emit(deps, record.batchId, { type: 'row.update', row: rowToWire(row) })

  try {
    const resolver = deps.resolveCachedRepo ?? defaultResolveCachedRepo
    const result = await resolver(
      {
        store: deps.store,
        ...(deps.appHome === undefined ? {} : { appHome: deps.appHome }),
        ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
      },
      { url: row.inputUrl },
    )
    row.status = 'done'
    row.cold = result.cold
    row.fetchOk = result.cold ? null : result.fetchOk
    row.cachedRepoId = result.cached.id
    row.message = result.cold
      ? 'cloned'
      : result.fetchOk
        ? 'cache hit (fetched)'
        : 'cache hit (fetch failed; cache reused)'
  } catch (err) {
    row.status = 'failed'
    if (err instanceof DomainError || err instanceof ValidationError) {
      row.errorCode = err.code
      row.message = clipAndRedact(err.message, row.inputUrl)
    } else {
      row.errorCode = 'internal-error'
      const msg = err instanceof Error ? err.message : String(err)
      row.message = clipAndRedact(msg, row.inputUrl)
    }
  } finally {
    row.finishedAt = now()
    record.inFlight.delete(rowId)
    releaseSlot()
    emit(deps, record.batchId, { type: 'row.update', row: rowToWire(row) })
    resolveAnyWaiter(record)
  }
}

function resolveAnyWaiter(record: BatchRecord): void {
  const wake = record.waiters.shift()
  if (wake) wake()
}

function clipAndRedact(s: string, url: string): string {
  // Belt-and-suspenders: pass both the raw string and the URL through redact
  // so any embedded credential-bearing form is scrubbed before clipping.
  const redacted = redactGitUrl(s).replace(url, redactGitUrl(url))
  return redacted.length > MESSAGE_CLIP ? redacted.slice(0, MESSAGE_CLIP) : redacted
}

function rowToWire(row: MutableRow): BatchImportRow {
  return {
    rowId: row.rowId,
    inputUrl: redactGitUrl(row.inputUrl),
    inputUrlRedacted: redactGitUrl(row.inputUrl),
    status: row.status,
    cold: row.cold,
    fetchOk: row.fetchOk,
    cachedRepoId: row.cachedRepoId,
    errorCode: row.errorCode,
    message: row.message,
    queuedAt: new Date(row.queuedAt).toISOString(),
    startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
  }
}

function serialize(record: BatchRecord): BatchImportSnapshot {
  return {
    batchId: record.batchId,
    state: record.state,
    createdAt: new Date(record.createdAt).toISOString(),
    completedAt: record.completedAt === null ? null : new Date(record.completedAt).toISOString(),
    rows: record.order
      .map((id) => record.rows.get(id))
      .filter((r): r is MutableRow => r !== undefined)
      .map(rowToWire),
  }
}

function emit(deps: RepoBatchImportDeps, batchId: string, msg: RepoImportWsMessage): void {
  if (deps.emit) {
    deps.emit(batchId, msg)
    return
  }
  repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(batchId), msg)
}

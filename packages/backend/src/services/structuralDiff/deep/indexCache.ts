// RFC-258 §2.3 — daemon-level SCIP index cache for the code-intel click path.
// Gate findings baked in:
//  - F-01/F-02: key = (taskId, repoKey, worktreeSnapshotDigest, indexerId) —
//    per-repo (SCIP paths are repo-relative; a task-level key would cross
//    repos) and per-indexer (a TS index must never answer a Go query).
//  - F-15: per-key singleflight (concurrent first clicks share ONE indexer
//    run), a failure negative-cache (an unavailable indexer is not re-probed
//    per click), and a weight-bounded LRU (occurrence count, not entry count).
//
// The cache is deliberately NOT wired into structural-diff's own deep pass in
// this RFC — that path is low-frequency and behaviour-frozen; this cache
// serves the high-frequency click path only.

import { parseScip, ScipParseError, type ScipGraph } from './scip'
import {
  INDEXER_SPECS,
  probeIndexer as defaultProbe,
  type DeepIndexerOverrides,
  type IndexerId,
  type IndexerProbe,
  type IndexerSpec,
} from './indexers'
import { runIndexer as defaultRun, type IndexerRunResult } from './runner'

export interface IndexCacheDeps {
  probeIndexer?: (spec: IndexerSpec, overrides?: DeepIndexerOverrides) => Promise<IndexerProbe>
  runIndexer?: (opts: {
    spec: IndexerSpec
    bin: string
    worktreePath: string
    timeoutMs: number
  }) => Promise<IndexerRunResult>
  overrides?: DeepIndexerOverrides
  timeoutMs?: number
  /** Injectable clock for negative-cache expiry tests. */
  now?: () => number
}

export type IndexAnswer = { ok: true; graph: ScipGraph } | { ok: false; reason: string }

interface CacheEntry {
  key: string
  graph: ScipGraph
  weight: number
  lastUsed: number
  /** Probed indexer version at build time (impl-gate P1-3 / gate F-02): a
   *  daemon-lifetime indexer upgrade must not keep serving old graphs. */
  indexerVersion: string | null
}

const FAILURE_COOLDOWN_MS = 5 * 60_000
/** Global weight budget: total cached occurrences across all entries. */
const MAX_TOTAL_WEIGHT = 2_000_000
/** A single index bigger than this is not cached (nor served). */
const MAX_INDEX_BYTES = 64 * 1024 * 1024

function graphWeight(graph: ScipGraph): number {
  let n = 0
  for (const d of graph.documents) n += d.occurrences.length
  return n
}

export class ScipIndexCache {
  private entries = new Map<string, CacheEntry>()
  private inflight = new Map<string, Promise<IndexAnswer>>()
  /** probe memo: indexerId → {version, at} (avoids per-click which-spawns). */
  private probeMemo = new Map<string, { version: string | null; at: number }>()
  /** negative cache: `${taskId}\u0000${repoKey}\u0000${indexerId}` → retry-at ts */
  private failedUntil = new Map<string, number>()
  private totalWeight = 0
  private seq = 0

  constructor(private deps: IndexCacheDeps = {}) {}

  /** Get (or build) the SCIP graph for one repo worktree under one indexer. */
  async get(q: {
    taskId: string
    repoKey: string
    snapshotDigest: string
    indexerId: IndexerId
    worktreePath: string
  }): Promise<IndexAnswer> {
    const key = [q.taskId, q.repoKey, q.snapshotDigest, q.indexerId].join('\u0000')
    const hit = this.entries.get(key)
    if (hit !== undefined) {
      // Version re-check is deliberately NOT a per-hit probe (that would spawn
      // `which` on every click); the probe result is memoised below with a
      // TTL, so upgrades surface within a probe-cache window.
      const ver = await this.probedVersion(q.indexerId)
      if (ver.stale || hit.indexerVersion === ver.version) {
        hit.lastUsed = ++this.seq
        return { ok: true, graph: hit.graph }
      }
      this.entries.delete(key)
      this.totalWeight -= hit.weight
    }

    const now = this.deps.now ?? Date.now
    const negKey = [q.taskId, q.repoKey, q.indexerId].join('\u0000')
    const until = this.failedUntil.get(negKey)
    if (until !== undefined && now() < until) {
      return { ok: false, reason: 'indexer-cooldown' }
    }

    const existing = this.inflight.get(key)
    if (existing !== undefined) return existing

    const run = this.build(q, key, negKey)
    this.inflight.set(key, run)
    try {
      return await run
    } finally {
      this.inflight.delete(key)
    }
  }

  private async probedVersion(
    indexerId: IndexerId,
  ): Promise<{ version: string | null; stale: boolean }> {
    const now = this.deps.now ?? Date.now
    const memo = this.probeMemo.get(indexerId)
    if (memo !== undefined && now() - memo.at < FAILURE_COOLDOWN_MS) {
      return { version: memo.version, stale: false }
    }
    // memo expired — report stale so the caller keeps the hit this round; the
    // NEXT build (or explicit miss) refreshes the memo.
    return { version: memo?.version ?? null, stale: true }
  }

  private async build(
    q: { taskId: string; repoKey: string; indexerId: IndexerId; worktreePath: string },
    key: string,
    negKey: string,
  ): Promise<IndexAnswer> {
    const now = this.deps.now ?? Date.now
    const probe = this.deps.probeIndexer ?? defaultProbe
    const runIx = this.deps.runIndexer ?? defaultRun
    const spec = INDEXER_SPECS[q.indexerId]
    const p = await probe(spec, this.deps.overrides)
    this.probeMemo.set(q.indexerId, { version: p.available ? p.version : null, at: now() })
    if (!p.available) {
      this.failedUntil.set(negKey, now() + FAILURE_COOLDOWN_MS)
      return { ok: false, reason: 'indexer-missing' }
    }
    const result = await runIx({
      spec,
      bin: p.bin,
      worktreePath: q.worktreePath,
      timeoutMs: this.deps.timeoutMs ?? spec.timeoutMs,
    })
    if (!result.ok || result.scipBytes === undefined) {
      this.failedUntil.set(negKey, now() + FAILURE_COOLDOWN_MS)
      return { ok: false, reason: result.reason ?? 'build-failed' }
    }
    if (result.scipBytes.byteLength > MAX_INDEX_BYTES) {
      this.failedUntil.set(negKey, now() + FAILURE_COOLDOWN_MS)
      return { ok: false, reason: 'index-oversized' }
    }
    let graph: ScipGraph
    try {
      graph = parseScip(result.scipBytes)
    } catch (e) {
      this.failedUntil.set(negKey, now() + FAILURE_COOLDOWN_MS)
      return {
        ok: false,
        reason: e instanceof ScipParseError ? 'scip-parse-error' : 'build-failed',
      }
    }
    this.failedUntil.delete(negKey)
    this.insert(key, graph, p.version)
    return { ok: true, graph }
  }

  private insert(key: string, graph: ScipGraph, indexerVersion: string | null): void {
    const weight = Math.max(1, graphWeight(graph))
    this.entries.set(key, { key, graph, weight, lastUsed: ++this.seq, indexerVersion })
    this.totalWeight += weight
    while (this.totalWeight > MAX_TOTAL_WEIGHT && this.entries.size > 1) {
      let oldest: CacheEntry | null = null
      for (const e of this.entries.values()) {
        if (e.key === key) continue // never evict what we just built
        if (oldest === null || e.lastUsed < oldest.lastUsed) oldest = e
      }
      if (oldest === null) break
      this.entries.delete(oldest.key)
      this.totalWeight -= oldest.weight
    }
  }

  /** Test-only introspection. */
  stats(): { entries: number; totalWeight: number } {
    return { entries: this.entries.size, totalWeight: this.totalWeight }
  }
}

/** Daemon-scoped singleton (routes construct services per request). */
let singleton: ScipIndexCache | null = null
export function scipIndexCache(deps?: IndexCacheDeps): ScipIndexCache {
  if (singleton === null) singleton = new ScipIndexCache(deps)
  return singleton
}
/** Test seam — drop the singleton between tests. */
export function resetScipIndexCache(): void {
  singleton = null
}

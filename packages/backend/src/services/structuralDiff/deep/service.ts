// RFC-083 PR-E — deep-mode orchestrator: probe → run indexer → parse SCIP →
// precise reverse-reference impact, AUGMENTING the already-computed baseline
// (keeps its files/dependencyChanges/summary; replaces impact with 'extracted').
//
// On ANY failure it throws DeepUnavailableError(reason); the service-layer catch
// stamps engine='baseline' + degradedReason so the view degrades cleanly to the
// heuristic baseline. v1 runs ONE indexer (the first available for the changed
// languages) — sufficient for the common single-language diff; multi-language
// merging is a follow-up.

import type { StructuralDiff } from '@agent-workflow/shared'
import { parseScip, mergeScipGraphs, ScipParseError, type ScipGraph } from './scip'
import { preciseImpactFromBaseline } from './deepImpact'
import {
  INDEXER_SPECS,
  indexersForFiles,
  probeIndexer as defaultProbe,
  type DeepIndexerOverrides,
  type IndexerProbe,
  type IndexerSpec,
} from './indexers'
import { runIndexer as defaultRun, type DeepDegradedReason, type IndexerRunResult } from './runner'
import { scipIndexCache, type ScipIndexCache } from './indexCache'
import { worktreeSnapshotDigest } from '@/services/codeIntel/snapshot'

export class DeepUnavailableError extends Error {
  constructor(
    public readonly reason: DeepDegradedReason,
    message: string,
  ) {
    super(message)
    this.name = 'DeepUnavailableError'
  }
}

export interface ResolvedDeepConfig {
  overrides?: DeepIndexerOverrides
  timeoutMs: number
}

export interface DeepDeps {
  deepCfg?: ResolvedDeepConfig
  /** RFC-258 (impl-gate P1-2) — reuse the click path's index cache so a deep
   *  structural diff and code-intel clicks share ONE indexer run per snapshot.
   *  Callers that can name the cache scope pass it; tests with injected
   *  probe/run seams keep the direct path. */
  cacheScope?: { taskId: string; repoKey: string; cache?: ScipIndexCache }
  /** injection seams for tests (stub probe/run, no real indexer). */
  probeIndexer?: (spec: IndexerSpec, overrides?: DeepIndexerOverrides) => Promise<IndexerProbe>
  runIndexer?: (opts: {
    spec: IndexerSpec
    bin: string
    worktreePath: string
    timeoutMs: number
  }) => Promise<IndexerRunResult>
}

export async function computeDeepStructuralDiff(args: {
  baseline: StructuralDiff
  worktreePath: string
  deps: DeepDeps
}): Promise<StructuralDiff> {
  const { baseline, worktreePath, deps } = args
  const probe = deps.probeIndexer ?? defaultProbe
  const run = deps.runIndexer ?? defaultRun
  const cfg = deps.deepCfg

  const needed = indexersForFiles(baseline.files.map((f) => f.filePath))
  if (needed.length === 0) {
    throw new DeepUnavailableError('indexer-missing', 'no indexer covers the changed languages')
  }

  // RFC-258 (P1-2) — cache-backed path: one graph per (snapshot, indexer),
  // shared with code-intel. Only taken when the caller identifies the scope
  // AND no test seams are injected (the seams exercise the direct path).
  if (
    deps.cacheScope !== undefined &&
    deps.probeIndexer === undefined &&
    deps.runIndexer === undefined
  ) {
    const cache = deps.cacheScope.cache ?? scipIndexCache()
    const snapshotDigest = await worktreeSnapshotDigest(worktreePath)
    const graphs: ScipGraph[] = []
    let lastReason: DeepDegradedReason = 'indexer-missing'
    let anyAvailable = false
    for (const id of needed) {
      const answer = await cache.get({
        taskId: deps.cacheScope.taskId,
        repoKey: deps.cacheScope.repoKey,
        snapshotDigest,
        indexerId: id,
        worktreePath,
      })
      if (answer.ok) {
        anyAvailable = true
        graphs.push(answer.graph)
      } else if (answer.reason !== 'indexer-missing' && answer.reason !== 'indexer-cooldown') {
        anyAvailable = true
        lastReason = answer.reason as DeepDegradedReason
      }
    }
    if (graphs.length === 0) {
      throw new DeepUnavailableError(
        anyAvailable ? lastReason : 'indexer-missing',
        anyAvailable ? 'all available indexers failed' : 'no SCIP indexer installed',
      )
    }
    const impact = preciseImpactFromBaseline(mergeScipGraphs(graphs), baseline.files)
    return { ...baseline, engine: 'deep', impact, degradedReason: undefined }
  }

  // Run EVERY available indexer the changed languages need (a diff can span
  // multiple languages) and merge their SCIP graphs. Usable if at least one
  // available indexer produced a parseable index.
  const graphs: ScipGraph[] = []
  let anyAvailable = false
  let lastReason: DeepDegradedReason = 'indexer-missing'
  for (const id of needed) {
    const spec = INDEXER_SPECS[id]
    const p = await probe(spec, cfg?.overrides)
    if (!p.available) continue
    anyAvailable = true
    const result = await run({
      spec,
      bin: p.bin,
      worktreePath,
      timeoutMs: cfg?.timeoutMs ?? spec.timeoutMs,
    })
    if (!result.ok || result.scipBytes === undefined) {
      lastReason = result.reason ?? 'build-failed'
      continue
    }
    try {
      graphs.push(parseScip(result.scipBytes))
    } catch (e) {
      lastReason = e instanceof ScipParseError ? 'scip-parse-error' : 'build-failed'
    }
  }
  if (!anyAvailable) {
    throw new DeepUnavailableError(
      'indexer-missing',
      'no SCIP indexer installed for these languages',
    )
  }
  if (graphs.length === 0) {
    // Indexer(s) present but none produced a usable index (build/parse failed).
    throw new DeepUnavailableError(lastReason, 'all available indexers failed')
  }

  const impact = preciseImpactFromBaseline(mergeScipGraphs(graphs), baseline.files)
  return { ...baseline, engine: 'deep', impact, degradedReason: undefined }
}

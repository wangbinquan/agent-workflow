// RFC-453 — the deep (SCIP) indexing the structural-diff and code-intel use cases run on. The implementation
// probes and spawns external indexers, so it lives in `infrastructure/deep` and is bound by `composition`; the
// application layer only names these shapes.

import type { StructuralDiff } from '@agent-workflow/shared'
import type { IndexerRunResult, ResolvedDeepConfig } from '../../domain/deep/deepIndexing'
import type {
  DeepIndexerOverrides,
  IndexerId,
  IndexerProbe,
  IndexerSpec,
} from '../../domain/deep/indexers'
import type { ScipGraph } from '../../domain/deep/scip'

export type IndexAnswer = { ok: true; graph: ScipGraph } | { ok: false; reason: string }

/** The daemon-scoped SCIP index cache of the click path (`ScipIndexCache`): one graph per repo snapshot and indexer. */
export interface ScipIndexAnswers {
  get(q: {
    taskId: string
    repoKey: string
    snapshotDigest: string
    indexerId: IndexerId
    worktreePath: string
  }): Promise<IndexAnswer>
}

export interface DeepDeps {
  deepCfg?: ResolvedDeepConfig
  /** RFC-258 (impl-gate P1-2) — reuse the click path's index cache so a deep
   *  structural diff and code-intel clicks share ONE indexer run per snapshot.
   *  Callers that can name the cache scope pass it; tests with injected
   *  probe/run seams keep the direct path. */
  cacheScope?: { taskId: string; repoKey: string; cache?: ScipIndexAnswers }
  /** RFC-370 §10 V16 — the selected content's snapshot digest (the cache key);
   *  the native worktree's when absent. */
  snapshotDigest?: () => Promise<string>
  /** injection seams for tests (stub probe/run, no real indexer). */
  probeIndexer?: (spec: IndexerSpec, overrides?: DeepIndexerOverrides) => Promise<IndexerProbe>
  runIndexer?: (opts: {
    spec: IndexerSpec
    bin: string
    worktreePath: string
    timeoutMs: number
  }) => Promise<IndexerRunResult>
}

export interface StructuralDeepIndexing {
  /** RFC-083 PR-E — upgrade a baseline's impact with SCIP-resolved callers; throws `DeepUnavailableError`. */
  computeDeepStructuralDiff(args: {
    baseline: StructuralDiff
    worktreePath: string
    deps: DeepDeps
  }): Promise<StructuralDiff>
  /** The daemon-scoped index cache — read at each call, so a reset cache is the one served next. */
  indexCache(): ScipIndexAnswers
}

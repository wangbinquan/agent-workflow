// RFC-453 — binds the deep (SCIP) indexing port to this module's infrastructure: the deep structural diff and the
// index cache. RFC-547: the cache is built here, once per composed module (the daemon composes workspace-insight once),
// and handed to the deep structural diff and the code-intel reads alike — no module-level singleton.

import type { StructuralDeepIndexing } from '../application/ports/structuralDeepIndexing'
import { computeDeepStructuralDiff } from '../infrastructure/deep/deepStructuralDiff'
import { ScipIndexCache } from '../infrastructure/deep/scipIndexCache'

export function composeStructuralDeepIndexing(): StructuralDeepIndexing {
  const cache = new ScipIndexCache()
  return Object.freeze<StructuralDeepIndexing>({
    computeDeepStructuralDiff: (args) => computeDeepStructuralDiff(args, cache),
    indexCache: () => cache,
  })
}

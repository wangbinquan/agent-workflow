// RFC-453 — binds the deep (SCIP) indexing port to this module's infrastructure: the deep structural diff and the
// daemon-scoped index cache. The cache is read at each call, so a reset cache is the one served next — the same as
// when the use cases read the singleton themselves.

import type { StructuralDeepIndexing } from '../application/ports/structuralDeepIndexing'
import { computeDeepStructuralDiff } from '../infrastructure/deep/deepStructuralDiff'
import { scipIndexCache } from '../infrastructure/deep/scipIndexCache'

export function composeStructuralDeepIndexing(): StructuralDeepIndexing {
  return Object.freeze<StructuralDeepIndexing>({
    computeDeepStructuralDiff,
    indexCache: () => scipIndexCache(),
  })
}

// RFC-239 §3.6 — the canonical content digest for the change-narrative
// staleness check. Computed ONCE here on the backend and handed to the
// frontend on the structural-diff response; the narrative stores the value it
// saw at generation time and the frontend only compares the two backend
// values (design gate P0-4: any frontend recomputation drifts — the 1 MiB
// text truncation loses whole files, and group membership depends on line
// weights).
//
// Input = the PRE-GROUPING file manifest with SYMBOL IDENTITY (3rd-round
// P0-N1: per-file changeType counts alone miss "same counts, different
// method"): sorted (filePath, renamedFrom?, sorted per-change
// (qualifiedName, changeType) pairs). Line counts and severity stay OUT —
// they may differ between ends / evolve with heuristics.

import { createHash } from 'node:crypto'
import type { StructuralDiff } from '@agent-workflow/shared'

export function computeContentDigest(diff: StructuralDiff): string {
  const manifest = diff.files
    .map((f) => ({
      filePath: f.filePath,
      renamedFrom: f.renamedFrom ?? '',
      changes: f.changes
        .map((c) => {
          const node = c.after ?? c.before
          return `${node?.qualifiedName ?? '?'}\n${c.changeType}`
        })
        .sort(),
    }))
    .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0))
  const deps = diff.dependencyChanges
    .map((d) => `${d.ecosystem}\n${d.packageName}\n${d.changeType}`)
    .sort()
  const h = createHash('sha256')
  h.update(JSON.stringify({ manifest, deps }))
  return h.digest('hex').slice(0, 16)
}

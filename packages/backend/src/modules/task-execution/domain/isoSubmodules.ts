import { IsoSubmodulesSchema } from '@agent-workflow/shared'
import type { TaskRepositoryCheckpoint } from './taskCheckpoint'

/**
 * RFC-210 — read a node_run's persisted submodule topology back for replay.
 *
 * Defensive parse: a row that fails the schema is treated as ABSENT rather than
 * half-trusted. Absence matters — `replaySubmodulesMissing` below turns it into a
 * refusal instead of letting merge-back run parent-only, which for a gitlink both
 * sides moved silently resolves as "take theirs" and discards the sibling node's
 * submodule commits.
 *
 * RFC-404: one owner for the call-node adoption rebuild, wrapper iso rebuild and merge replay.
 */
export function parseIsoSubmodules(checkpoints: readonly TaskRepositoryCheckpoint[]): Record<
  string,
  {
    subBases: Record<string, string>
    poolDirs: Record<string, string>
    pendingSubResolves: string[]
  }
> {
  const out: Record<
    string,
    {
      subBases: Record<string, string>
      poolDirs: Record<string, string>
      pendingSubResolves: string[]
    }
  > = {}
  for (const checkpoint of checkpoints) {
    const one = IsoSubmodulesSchema.safeParse(checkpoint.submodules)
    if (one.success)
      out[checkpoint.mountPath] = {
        subBases: one.data.subBases,
        poolDirs: one.data.poolDirs,
        pendingSubResolves: one.data.pendingSubResolves ?? [],
      }
  }
  return out
}

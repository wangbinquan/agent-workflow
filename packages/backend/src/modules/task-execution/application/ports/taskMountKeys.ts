// RFC-395 II-b W0: T implements; N consumes for node_run_repo_checkpoints. Dormant.
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

export interface TaskMountKey {
  readonly repoKey: string
  readonly ordinal: number
  readonly mountPath: string
}

export interface TaskMountKeysReaderInTx {
  /** Read persisted mounts in ascending ordinal order in the caller's transaction.
   * repoKey is stable across reordering. Zero mounts returns [], never a synthetic
   * root mount. A sole non-root mount keeps its actual mountPath. Writers acquire
   * the task aggregate lock before this read and keep it through checkpoint writes.
   */
  list(tx: PersistenceTx, taskId: string): Promise<readonly TaskMountKey[]>
}

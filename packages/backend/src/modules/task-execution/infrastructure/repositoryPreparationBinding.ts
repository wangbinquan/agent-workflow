import type { GitCommitIdentity } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import type {
  RepositoryLaunchSnapshotInTx,
  RepositoryPreparationParticipant,
  RepositoryPreparationEffectCapability,
} from '@/modules/source-control/public/participants'
import type {
  FrozenRepositoryPreparationRef,
  RepositoryPreparationOperationRef,
  RepositoryLaunchSource,
} from '@/modules/source-control/public/types'
import type { MaterializedSpace, WorkspaceCleanupReport } from '@/services/task'

/** Provider-private binding assembled by the root. Task retains its transaction and owner. */
export interface TaskRepositoryPreparationBinding {
  snapshot(input: {
    transaction: ProviderNeutralDatabase
    authority: RequestAuthority
    now: number
  }): {
    participant: RepositoryLaunchSnapshotInTx
    source(input: {
      cachedRepoId: string | null
      repoGroupId: string | null
      base: string
    }): Promise<RepositoryLaunchSource>
    plan(source: FrozenRepositoryPreparationRef): Promise<RepositoryPreparationOperationRef>
    close(): void
  }
  nextAttempt(input: {
    transaction: ProviderNeutralDatabase
    operationRef: string
    now: number
  }): Promise<string>
  effect(input: {
    taskId: string
    operationRef: string
    workingBranch?: string
    gitCommitIdentity: GitCommitIdentity | null
    signal: AbortSignal
    assertCurrent(): Promise<void>
  }): Promise<{
    participant: RepositoryPreparationParticipant
    capability: RepositoryPreparationEffectCapability
    operation: RepositoryPreparationOperationRef
    source: FrozenRepositoryPreparationRef
    space(): Promise<MaterializedSpace>
    cleanup(): Promise<WorkspaceCleanupReport>
    close(): void
  }>
}

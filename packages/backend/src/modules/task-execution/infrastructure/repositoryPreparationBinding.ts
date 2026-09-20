import type { PlannedRepo, PlannedDirectoryNode, GitCommitIdentity } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import type {
  PublicRepositorySourceSealPort,
  RepositoryLaunchSnapshotInTx,
  RepositoryPreparationParticipant,
  RepositoryPreparationEffectCapability,
} from '@/modules/source-control/public/participants'
import type {
  SealedPublicRepositorySourceRef,
  FrozenRepositoryPreparationRef,
  RepositoryPreparationOperationRef,
  RepositoryLaunchSource,
} from '@/modules/source-control/public/types'
import type { MaterializedSpace, WorkspaceCleanupReport } from '@/services/task'

/** Provider-private binding assembled by the root. Task retains its transaction and owner. */
export interface TaskRepositoryPreparationBinding {
  readonly sourceSeal: PublicRepositorySourceSealPort
  sealedIdentity(reference: SealedPublicRepositorySourceRef): Promise<string>
  snapshot(input: {
    transaction: ProviderNeutralDatabase
    authority: RequestAuthority
    now: number
  }): {
    frozenLayout(input: {
      readonly repos: readonly PlannedRepo[]
      readonly nodes: readonly PlannedDirectoryNode[]
    }): Promise<FrozenRepositoryPreparationRef>
    participant: RepositoryLaunchSnapshotInTx
    source(input: {
      cachedRepoId: string | null
      repoGroupId: string | null
      base: string
      sealedSource?: SealedPublicRepositorySourceRef
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

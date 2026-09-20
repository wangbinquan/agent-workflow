import type { SecretBox } from '@/auth/secretBox'
import type {
  PlannedRepo,
  PlannedDirectoryNode,
  GitCommitIdentity,
  StartTask,
} from '@agent-workflow/shared'
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
import type {
  MaterializedSpace,
  WorkspaceCleanupReport,
  WorkspaceCleanupHookEvent,
  PlannedSpaceLayout,
} from '../application/ports/preparedWorkspace'

/** Provider-private binding assembled by the root. Task retains its transaction and owner. */
export interface TaskRepositoryPreparationBinding {
  groupName(groupId: string): Promise<string>
  /** Explicit compatibility for persisted Tasks created before RFC-363. */
  legacy: {
    reclaim(
      task: { id: string; cachedRepoId: string | null; repoGroupId: string | null },
      log: { warn(message: string, context: Record<string, unknown>): void },
    ): Promise<void>

    prepare(input: {
      task: StartTask
      taskId: string
      gitCommitIdentity: GitCommitIdentity | null
      signal?: AbortSignal
      secretBox?: SecretBox
      cloneTimeoutMs?: number
      workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
      loadFrozenSpaceLayout(sourceTaskId: string): Promise<PlannedSpaceLayout>
    }): Promise<MaterializedSpace>
    commit(space: MaterializedSpace): void
    cleanup(
      space: MaterializedSpace,
      hook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>,
    ): Promise<WorkspaceCleanupReport>
  }

  prepareScratch(input: {
    taskId: string
    gitCommitIdentity: GitCommitIdentity | null
    signal: AbortSignal
    assertCurrent(): Promise<void>
  }): Promise<MaterializedSpace>
  restoreScratch(taskId: string, artifactJson: string): MaterializedSpace
  cleanupScratch(input: {
    taskId: string
    assertCurrent(): Promise<void>
  }): Promise<WorkspaceCleanupReport>

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

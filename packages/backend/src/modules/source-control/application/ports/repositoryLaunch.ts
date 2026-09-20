/** RFC-362 declared-only SPI. Live-scope and effect factories belong to the E1 successor. */
import type {
  IdempotentCommandContext,
  RequestAuthority,
} from '../../../identity-access/public/participants'
import type {
  PublicRepositorySourceInput,
  SealedPublicRepositorySourceRef,
  RepositoryLaunchSource,
  FrozenRepositoryPreparationRef,
  RepositoryPreparationOperationRef,
  WorkspacePreparationExecutionOutcome,
  AuthorizedWorkspaceSnapshotRef,
  WorkspaceListRequest,
  WorkspaceReadRequest,
  WorkspaceEntryPage,
  BoundedWorkspaceContent,
} from '../../public/types'

declare const repositoryLaunchSnapshotBrand: unique symbol
declare const repositoryPreparationEffectBrand: unique symbol
export interface RepositoryLaunchSnapshotInTx {
  readonly [repositoryLaunchSnapshotBrand]: 'repository-launch-live-scope'
  resolveAuthorized(
    authority: RequestAuthority,
    source: RepositoryLaunchSource,
  ): Promise<FrozenRepositoryPreparationRef>
}
export interface RepositoryPreparationEffectCapability {
  readonly [repositoryPreparationEffectBrand]: 'repository-preparation-effect'
}
export interface PublicRepositorySourceSealPort {
  seal(
    context: IdempotentCommandContext,
    input: PublicRepositorySourceInput,
  ): Promise<SealedPublicRepositorySourceRef>
}
export interface RepositoryPreparationParticipant {
  prepare(
    capability: RepositoryPreparationEffectCapability,
    operation: RepositoryPreparationOperationRef,
    source: FrozenRepositoryPreparationRef,
  ): Promise<WorkspacePreparationExecutionOutcome>
}
export interface WorkspaceContentParticipant {
  list(
    snapshot: AuthorizedWorkspaceSnapshotRef,
    request: WorkspaceListRequest,
  ): Promise<WorkspaceEntryPage>
  read(
    snapshot: AuthorizedWorkspaceSnapshotRef,
    request: WorkspaceReadRequest,
  ): Promise<BoundedWorkspaceContent>
}

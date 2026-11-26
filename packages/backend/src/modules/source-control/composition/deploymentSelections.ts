// RFC-531 — what a deployment selects for Source Control (RFC-294 design §9.3). Each selection is typed by what the
// session hands it and the port it returns, never by a local factory's signature. The standalone profile hands over the
// local implementations (their parameters are supersets of these inputs; the extras are test seams); the hosted profile
// hands over its task-volume implementations, which need none of the inputs.
import type { Config } from '@agent-workflow/shared'
import type { SecretBox } from '@/platform/contracts/secretBox'
import type { RepositoryPublicationTransport } from '../public/types'
import type { RepositoryTransportCredentialRepository } from '../ports/repositoryTransportCredentialRepository'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'
import type { DevelopmentWorkspaceRepositoryPreparation } from '../application/ports/developmentWorkspaceRepositoryPreparation'
import type { RepositoryPreparationEffectFactory } from '../application/ports/repositoryPreparationEffects'
import type { ScratchWorkspaceEffects } from '../application/ports/scratchWorkspaceEffects'
import type { RepositoryMirrors } from '../application/ports/repositoryMirrors'
import type { RepositoryPreparationInput } from '../infrastructure/local/repositoryPreparation'
import type { RepositoryEndpointDiscoveryParticipant } from '../application/ports/repositoryEndpointDiscovery'

/** The session's publication transport (standalone: network Git over the session's credentials; hosted: in the task volume). */
export type RepositoryPublicationTransportSelection = (input: {
  readonly repository: RepositoryTransportCredentialRepository
  readonly secretBox: SecretBox
  readonly appHome: string
  readonly endpointDiscovery: RepositoryEndpointDiscoveryParticipant
}) => RepositoryPublicationTransport

/** The session's development workspace repository preparation. */
export type DevelopmentWorkspaceRepositoryPreparationSelection = (input: {
  readonly store: RepositoryWorkspaceStore
  readonly appHome: string
  readonly secretBox: SecretBox
}) => DevelopmentWorkspaceRepositoryPreparation

/** The session's task repository preparation, built from its preparation input. */
export type RepositoryPreparationEffectsSelection = (
  input: RepositoryPreparationInput,
) => RepositoryPreparationEffectFactory

/** The session's scratch workspaces, built from the same preparation input. */
export type ScratchWorkspaceEffectsSelection = (
  input: RepositoryPreparationInput,
) => ScratchWorkspaceEffects

/** The session's registered-repository reads, registration and refresh (standalone: its own mirror clones; hosted: the
 * release's system volume reads the remote). */
export type RepositoryMirrorsSelection = (input: {
  readonly store: RepositoryWorkspaceStore
  readonly secretBox: SecretBox
  readonly appHome: string
}) => RepositoryMirrors

/** A running mirror refresh; the daemon's `submodule-refresh` handle drives it. */
export interface RepositoryMirrorRefresh {
  stop(): void
  /** Re-reads the configuration; `true` when the schedule changed. */
  reconfigure(): Promise<boolean>
  awaitIdle(): Promise<void>
}

type MirrorRefreshConfiguration = Pick<Config, 'submoduleAutoRefresh'>

/** The session's periodic mirror refresh (standalone: its mirrors' submodules, started once the configuration is read;
 * hosted: nothing to refresh, so the one idle handle — the daemon awaits either). */
export type RepositoryMirrorRefreshSelection = (input: {
  readonly store: RepositoryWorkspaceStore
  readonly configuration: {
    readonly read: () => MirrorRefreshConfiguration | Promise<MirrorRefreshConfiguration>
  }
  readonly appHome: string
  readonly secretBox: SecretBox
}) => RepositoryMirrorRefresh | Promise<RepositoryMirrorRefresh>

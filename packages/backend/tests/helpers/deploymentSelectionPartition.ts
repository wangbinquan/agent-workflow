// RFC-431: the groups of `DeploymentSelections` (design/RFC-431-standalone-selection-defaults/design.md §1).
// The single list both the structural lock (`tests/architecture/rfc431-standalone-selections.test.ts`) and the
// per-selection wiring oracle (`tests/helpers/deploymentSelectionSource.ts`) read. RFC-433: no selection is
// optional any more — every key is required or required-nullable.

/** Both profiles state a value; the standalone profile builds it in `standaloneSelections`. */
export const REQUIRED_SELECTIONS = [
  'applicationConfiguration',
  'workspaceUploads',
  'isolationWorkspaces',
  'repositoryGitWorkspaces',
  'workspaceReads',
  'workspaceContent',
  'workspacePresence',
  'fusionWorkspaceEffects',
  'workspaceMaintenanceFilesystem',
  'workspaceExcludeProfiles',
  'employeeCaseWorkspaceEffects',
  // RFC-527: standalone selects the local candidate and conflict-merge effects.
  'repositoryCandidateEffects',
  'conflictMergeWorkspaceEffects',
  'repositoryRevisionContent',
  'codeReviewArtifacts',
  'taskRunSelection',
  'taskArchive',
  'taskDeletionEffects',
  'archivedNodeEvents',
  'reviewRollbackSnapshots',
  'runtimeInventoryContent',
  'bootExecutionRecovery',
  'programFixtureProcess',
  'actionWorkspaceEntries',
  'recoveredExecutionTaskIds',
  'hostedBackgroundOwners',
  'runtimeManagement',
  'systemAgentRunFamily',
  'mcpDiagnostics',
  'credentials',
  'customObserverPrograms',
  'pluginInstaller',
  'resourcePackagePluginArtifacts',
  'employeePrograms',
  'employeeInputArtifacts',
  'evidenceArtifacts',
  'graphDevelopmentArtifacts',
  'developmentPurposes',
  'verificationCommands',
  'repositoryBaselines',
  'actionWorkspaceEffects',
  // RFC-432: session-scoped factories (see SESSION_FACTORY_SELECTIONS).
  'contentStore',
  'skillContent',
  'reviewArtifacts',
  'resourcePackageSkillArtifacts',
  'intentArtifacts',
  'databaseBackup',
  'repositoryPublicationTransport',
  'developmentWorkspaceRepositoryPreparation',
  'repositoryPreparationEffects',
  'scratchWorkspaceEffects',
  // RFC-531: the mirrors and their refresh, selected by the profile (formerly the nullable `repositoryRemote`; see
  // SESSION_BUILT_SELECTIONS and SESSION_FACTORY_SELECTIONS).
  'repositoryMirrors',
  'repositoryMirrorRefresh',
  // RFC-433: the post-lock secret box factory (see PROCESS_FACTORY_SELECTIONS) and the execution authority.
  'secretBox',
  'executionAuthority',
  // RFC-532: the database installation (standalone: the local epoch path; formerly hosted-only and nullable).
  'databaseInstallation',
] as const

/**
 * RFC-432: the required selections a standalone deployment can only build from the session graph. Both profiles
 * state a factory each session calls: standalone gives the module's local constructor, hosted a closure over the
 * object its profile built (RFC-531: for the mirror refresh, source-control's one idle handle).
 */
export const SESSION_FACTORY_SELECTIONS = [
  'contentStore',
  'skillContent',
  'reviewArtifacts',
  'resourcePackageSkillArtifacts',
  'intentArtifacts',
  'databaseBackup',
  'repositoryPublicationTransport',
  'developmentWorkspaceRepositoryPreparation',
  'repositoryPreparationEffects',
  'scratchWorkspaceEffects',
  'repositoryMirrorRefresh',
] as const

/**
 * RFC-531: the required selection both deployments build from the session graph. Stated like a session factory
 * (standalone gives the module's local constructor, hosted a closure), but the hosted closure builds its remote reads
 * over the repository store of the session that calls it — the registered repositories live in that session's
 * database — so there is no one object for the hosted profile to build.
 */
export const SESSION_BUILT_SELECTIONS = ['repositoryMirrors'] as const

/**
 * RFC-433: the required selection opened once per process after the startup lock (standalone reads or creates
 * `appHome/secret.key` then). Stated like a session factory: standalone gives a function, hosted a closure.
 */
export const PROCESS_FACTORY_SELECTIONS = ['secretBox'] as const

/** Hosted-only capabilities: required, typed `X | null`; the standalone profile states `null`. */
export const NULLABLE_SELECTIONS = [
  'taskInputFiles',
  'humanGateArtifactRecovery',
  'beforeEventObservationWrite',
  'taskRecovery',
  'maintenanceEffectsBootstrap',
  'initializeExecution',
  // RFC-433: former presence switches, now explicit hosted-only capabilities (RFC-532: the database installation left).
  'crewStationEvents',
] as const

export type DeploymentSelectionGroup = 'required' | 'nullable'

export function deploymentSelectionGroup(key: string): DeploymentSelectionGroup | undefined {
  if ((REQUIRED_SELECTIONS as readonly string[]).includes(key)) return 'required'
  if ((NULLABLE_SELECTIONS as readonly string[]).includes(key)) return 'nullable'
  return undefined
}

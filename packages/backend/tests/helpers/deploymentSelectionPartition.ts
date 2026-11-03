// RFC-431: the three groups of `DeploymentSelections` (design/RFC-431-standalone-selection-defaults/design.md §1).
// The single list both the structural lock (`tests/architecture/rfc431-standalone-selections.test.ts`) and the
// per-selection wiring oracle (`tests/helpers/deploymentSelectionSource.ts`) read.

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
] as const

/** Hosted-only capabilities: required, typed `X | null`; the standalone profile states `null`. */
export const NULLABLE_SELECTIONS = [
  'taskInputFiles',
  'humanGateArtifactRecovery',
  'beforeEventObservationWrite',
  'taskRecovery',
  'maintenanceEffectsBootstrap',
  'initializeExecution',
] as const

/** Still optional, each with the step that removes it (RFC-294 S2c item 1). */
export const OPTIONAL_SELECTIONS = {
  /** Step 3: the standalone default needs the session graph (its database or content store). */
  sessionGraph: [
    'contentStore',
    'skillContent',
    'reviewArtifacts',
    'repositoryPreparationEffects',
    'scratchWorkspaceEffects',
    'repositoryPublicationTransport',
    'developmentWorkspaceRepositoryPreparation',
    'resourcePackageSkillArtifacts',
    'intentArtifacts',
    'databaseBackup',
  ],
  /** Step 4: a deployment switch, or a behaviour only the absent case has. */
  presence: [
    'databaseInstallation',
    'secretBox',
    'repositoryRemote',
    'crewStationEvents',
    'executionAuthority',
    'repositoryCandidateEffects',
    'conflictMergeWorkspaceEffects',
  ],
} as const

export type DeploymentSelectionGroup = 'required' | 'nullable' | 'optional'

export function deploymentSelectionGroup(key: string): DeploymentSelectionGroup | undefined {
  if ((REQUIRED_SELECTIONS as readonly string[]).includes(key)) return 'required'
  if ((NULLABLE_SELECTIONS as readonly string[]).includes(key)) return 'nullable'
  if ([...OPTIONAL_SELECTIONS.sessionGraph, ...OPTIONAL_SELECTIONS.presence].includes(key as never))
    return 'optional'
  return undefined
}

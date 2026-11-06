// RFC-394: the standalone profile owns local dependency probes and their existing diagnostics.
// RFC-431: it is also the standalone assembly root — it states every selection a standalone daemon uses.
import { join } from 'node:path'
import { detectGitCapabilities, mergeTreeGateError, MIN_GIT_VERSION } from '@/services/gitVersion'
import { getRuntimeDriver } from '@/services/runtime'
import { createResourcePackagePluginInstaller } from '@/services/resourcePackage/pluginInstallerAdapter'
import { materializingSpaces } from '@/platform/workspace/materializingSpaces'
import { createFileArchivedEventsReader } from '@/platform/background/eventsArchiveReader'
import { Paths } from '@/util/paths'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import {
  composeLocalWorkspaceExcludeProfiles,
  createFileEmployeeCaseWorkspaceEffectsFactory,
  createFileFusionWorkspaceEffects,
  createFileRepositoryGitWorkspaceFactory,
  createFileRepositoryWorkspaceReadQueries,
  createFileWorkspaceContentEffectsFactory,
  createFileWorkspacePresenceQueries,
  createFileWorkspaceUploadContentFactory,
  createLocalIsolationWorkspaceFactory,
  createNodeWorkspaceMaintenanceFilesystem,
  createRepositoryPublicationTransport,
} from '@/modules/source-control/composition'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/composition/repositoryRevisionContent'
import {
  composeLocalCodeReviewArtifacts,
  invalidateCallGraphIndex,
} from '@/modules/workspace-insight/composition'
import { composeLocalTaskRunSelection } from '@/modules/task-execution/composition/localTaskRunSelection'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { createFileTaskArchiveContent } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { composeLocalTaskDeletionEffects } from '@/modules/task-execution/composition/taskDeletionEffects'
import { createLocalTaskRuntimeInventoryContent } from '@/modules/task-execution/composition/taskRuntimeInventoryContent'
import { createLocalBootExecutionRecoveryFactory } from '@/modules/task-execution/composition/localBootExecutionRecovery'
import { createLocalScriptFixtureProcess } from '@/modules/task-execution/composition/programTools'
import { localActionWorkspaceEntries } from '@/modules/task-execution/composition/actionExecutionEnvironment'
import { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import { composeLocalWorkspaceRollbackSnapshots } from '@/modules/collaboration/composition'
import { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import { createLocalPluginInstaller } from '@/modules/resource-catalog/composition/pluginOperations'
import { createFileResourcePackagePluginArtifactOwner } from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { composeLocalCredentialAdapters } from '@/modules/identity-access/composition/authentication'
import { createLocalCustomObserverProgramFactory } from '@/modules/event-center/composition'
import {
  createEmployeeInputArtifactStore,
  createProgramArtifactStore,
} from '@/modules/digital-employee/composition'
import {
  createLocalEvidenceArtifactPort,
  createLocalGraphDevelopmentArtifactPort,
} from '@/modules/development-automation/composition/evidenceStaging'
import { createLocalVerificationCommandEffectsFactory } from '@/modules/development-automation/composition/localVerificationCommands'
import {
  createFileActionWorkspaceEffects,
  createFileRepositoryBaselineEffectsFactory,
} from '@/modules/development-automation/composition'
import { composeLocalDevelopmentPurposes } from './developmentPurposeRoot'
import { createLocalRuntimeContent } from './contentRuntime'
import { createFileSkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import { createLocalReviewArtifacts } from '@/modules/collaboration/composition/contentArtifacts'
import { createFileResourcePackageSkillArtifactOwner } from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { composeLocalIntentArtifacts } from '@/modules/intent/composition/apply'
import {
  composeLocalExecutionAuthority,
  createPostgresqlAdminBackupCoordinator,
} from '@/modules/system-operations/composition'
import { createSecretBox } from '@/auth/secretBox'
import { createDevelopmentWorkspaceRepositoryPreparation } from '@/modules/source-control/composition'
import {
  composeLocalRepositoryPreparationEffects,
  composeLocalScratchWorkspaceEffects,
} from '@/modules/source-control/composition/repositoryPreparation'
import type { DeploymentProfile, DeploymentSelections } from './deploymentProfile'

/**
 * RFC-431: every selection a standalone daemon makes, rooted at `appHome`. The hosted capabilities are stated as
 * `null`; the deployment switches stay unset (`DeploymentSelections`, optional group). RFC-432: what a standalone
 * session can only build from its own graph is stated as the module's local constructor, which each session calls.
 * Construction performs no IO: the profile is built before the startup lock, and the stores that create
 * directories open on first use.
 */
export function standaloneSelections(input: { readonly appHome: string }): DeploymentSelections {
  const { appHome } = input
  const evidenceArtifacts = createLocalEvidenceArtifactPort(appHome)
  return {
    applicationConfiguration: composeApplicationConfigurationBinding({
      kind: 'file',
      configPath: join(appHome, 'config.json'),
    }),
    workspaceUploads: createFileWorkspaceUploadContentFactory(),
    isolationWorkspaces: createLocalIsolationWorkspaceFactory(),
    repositoryGitWorkspaces: createFileRepositoryGitWorkspaceFactory(),
    workspaceReads: createFileRepositoryWorkspaceReadQueries(),
    workspaceContent: createFileWorkspaceContentEffectsFactory(),
    workspacePresence: createFileWorkspacePresenceQueries(),
    fusionWorkspaceEffects: createFileFusionWorkspaceEffects({ appHome }),
    workspaceMaintenanceFilesystem: createNodeWorkspaceMaintenanceFilesystem({
      appHome,
      isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
      invalidateWorkspacePath: invalidateCallGraphIndex,
    }),
    workspaceExcludeProfiles: composeLocalWorkspaceExcludeProfiles({ appHome }),
    employeeCaseWorkspaceEffects: createFileEmployeeCaseWorkspaceEffectsFactory(),
    repositoryRevisionContent: composeLocalRepositoryRevisionContent(),
    codeReviewArtifacts: composeLocalCodeReviewArtifacts(),
    taskRunSelection: composeLocalTaskRunSelection({
      nodeRunPrompts: composeNodeRunPromptOperations(undefined, join(appHome, 'runs')),
      portArtifacts: composePortArtifactOperations(undefined, appHome),
    }),
    taskArchive: { content: createFileTaskArchiveContent() },
    taskDeletionEffects: composeLocalTaskDeletionEffects(),
    archivedNodeEvents: createFileArchivedEventsReader(),
    reviewRollbackSnapshots: composeLocalWorkspaceRollbackSnapshots(),
    runtimeInventoryContent: createLocalTaskRuntimeInventoryContent(),
    bootExecutionRecovery: createLocalBootExecutionRecoveryFactory(),
    programFixtureProcess: createLocalScriptFixtureProcess(),
    actionWorkspaceEntries: localActionWorkspaceEntries,
    recoveredExecutionTaskIds: () => [],
    hostedBackgroundOwners: [],
    runtimeManagement: composeLocalRuntimeManagement,
    systemAgentRunFamily: composeLocalSystemAgentRunFamily,
    mcpDiagnostics: composeLocalMcpDiagnostics,
    credentials: composeLocalCredentialAdapters,
    customObserverPrograms: createLocalCustomObserverProgramFactory(),
    pluginInstaller: createLocalPluginInstaller(),
    resourcePackagePluginArtifacts: createFileResourcePackagePluginArtifactOwner({
      pluginsDir: join(appHome, 'plugins'),
      installer: createResourcePackagePluginInstaller(),
    }),
    employeePrograms: createProgramArtifactStore(appHome),
    employeeInputArtifacts: createEmployeeInputArtifactStore(
      join(appHome, 'artifacts', 'employee-inputs'),
    ),
    evidenceArtifacts,
    graphDevelopmentArtifacts: createLocalGraphDevelopmentArtifactPort(appHome),
    developmentPurposes: composeLocalDevelopmentPurposes({ appHome, evidenceArtifacts }),
    verificationCommands: createLocalVerificationCommandEffectsFactory(),
    repositoryBaselines: createFileRepositoryBaselineEffectsFactory(),
    actionWorkspaceEffects: createFileActionWorkspaceEffects(),
    // RFC-432: session-scoped factories — each session builds these from its own database and services.
    contentStore: (session) => createLocalRuntimeContent(session.db, session.appHome),
    skillContent: (session) => createFileSkillContentBinding(session.db, session.appHome),
    reviewArtifacts: createLocalReviewArtifacts,
    resourcePackageSkillArtifacts: createFileResourcePackageSkillArtifactOwner,
    intentArtifacts: composeLocalIntentArtifacts,
    databaseBackup: createPostgresqlAdminBackupCoordinator,
    repositoryPublicationTransport: createRepositoryPublicationTransport,
    developmentWorkspaceRepositoryPreparation: createDevelopmentWorkspaceRepositoryPreparation,
    repositoryPreparationEffects: composeLocalRepositoryPreparationEffects,
    scratchWorkspaceEffects: composeLocalScratchWorkspaceEffects,
    // RFC-433: opened once after the startup lock; reads or creates the local secret.key then, never here.
    secretBox: () => createSecretBox(join(appHome, 'secret.key')),
    // RFC-433: always active and never lost, so the session's activation gate starts everything at once.
    executionAuthority: composeLocalExecutionAuthority(),
    taskInputFiles: null,
    humanGateArtifactRecovery: null,
    beforeEventObservationWrite: null,
    taskRecovery: null,
    maintenanceEffectsBootstrap: null,
    initializeExecution: null,
    // RFC-433: hosted-only capabilities. Standalone runs its local epoch installation path, keeps its own
    // mirror clones, has no CrewStation events, and uses the participants' per-request local effects.
    databaseInstallation: null,
    repositoryRemote: null,
    crewStationEvents: null,
    repositoryCandidateEffects: null,
    conflictMergeWorkspaceEffects: null,
  }
}

export function composeStandaloneProfile(): DeploymentProfile {
  return {
    kind: 'standalone',
    frontendMarker: null,
    requiredProvider: null,
    listen: {},
    selections: standaloneSelections({ appHome: Paths.root }),
    async probeHost({ log, config }) {
      // 4. git version probe — RFC-130 D7: every node run merge-backs via
      // `git merge-tree --write-tree` (git >= 2.38). On older git the daemon boots
      // fine and every task dies at merge-back (AFTER its agent already ran) with a
      // cryptic `merge-back-failed: git merge-tree: usage: ...` — refuse at boot
      // instead. Unlike optional agent runtimes, git is a platform dependency for
      // repository/worktree/snapshot/merge-back operations. Side effect: populate
      // the RFC-034 capability cache read by resolveSubmoduleParams.
      const gitCaps = await detectGitCapabilities()
      const gitGateError = mergeTreeGateError(gitCaps)
      if (gitGateError !== null) {
        log.error('git incompatible', {
          found: gitCaps.version?.raw ?? null,
          requiredMinimum: MIN_GIT_VERSION,
        })
        return (
          `agent-workflow: ${gitGateError}\n` +
          `  upgrade git to >= ${MIN_GIT_VERSION} and restart; the daemon's PATH must resolve the upgraded binary.`
        )
      }
      log.info('git probe ok', { version: gitCaps.version?.raw ?? null })

      // RFC-111 D10: claude-code is optional — probe it SOFT (warn only, NEVER
      // refuse to start) when it is the configured default. RFC-226 makes OpenCode
      // optional too, but deliberately does not probe it here at all: its
      // version/build admission belongs to explicit runtime validation and use.
      if (config.defaultRuntime === 'claude-code') {
        const ccDriver = getRuntimeDriver('claude-code')
        const claudeProbe = await ccDriver.probe(ccDriver.defaultBinary(config)[0]!)
        if (!claudeProbe.compatible) {
          log.warn('claude-code default runtime unavailable (nodes selecting it will fail)', {
            binary: claudeProbe.binary,
            found: claudeProbe.version,
            requiredMinimum: ccDriver.minVersion,
            reason: claudeProbe.incompatibleReason ?? 'not found',
          })
        } else {
          log.info('claude-code probe ok', {
            version: claudeProbe.version,
            binary: claudeProbe.binary,
          })
        }
      }

      return null
    },
  }
}

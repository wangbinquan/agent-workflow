import { createCrewStationMcpDiagnostics } from '@/modules/resource-catalog/composition/crewstationMcpDiagnostics'
import { createLogger } from '@/util/log'
import { composeCrewStationRecovery } from '@/modules/task-execution/composition/crewstationRecovery'
import { createHostedScriptFixtureProcess } from '@/modules/task-execution/composition/programTools'
import {
  composeCrewStationCredentialAdapters,
  composeCrewStationRecoveryRequester,
  composeCrewStationSourceTokenVerifier,
  crewStationPlatformSourceAudiences,
} from '@/modules/identity-access/composition/authentication'
import { composeCrewStationTaskInputFiles } from '@/modules/task-execution/composition/crewstationTaskInputFiles'
import { composeCrewStationDatabaseBackups } from '@/modules/system-operations/composition/crewstationDatabaseBackups'
import { composeCrewStationObjectPublications } from '@/modules/system-operations/composition/crewstationObjectPublications'
import type { HostedRestoreNormalizationParticipant } from '@/modules/system-operations/public/participants'
import { createHostedRestoreTaskNormalization } from '@/modules/task-execution/public/participants'
import { composeCrewStationHumanGateRecovery } from '@/modules/collaboration/composition/crewstationHumanGateRecovery'
import { composeCrewStationNodeEventArchive } from '@/modules/task-execution/composition/crewstationNodeEventArchive'
import {
  composeCrewStationEventIngress,
  readCrewStationEventSources,
  validateCrewStationEventSubscriptions,
} from '@/modules/integration/composition/crewstationEvents'
import { composeCrewStationReviewArtifacts } from '@/modules/collaboration/composition/crewstationReviewArtifacts'
import { composeCrewStationCodeReviewArtifacts } from '@/modules/code-capability/composition/crewstationCodeReviewArtifacts'
import { composeCrewStationMaintenanceDescriptor } from './crewstationMaintenance'
import { composeCrewStationResourceArtifacts } from '@/modules/resource-catalog/composition/crewstationArtifacts'
import {
  composeCrewStationIntentArtifacts,
  composeCrewStationIntentPluginRetention,
} from '@/modules/intent/composition/crewstationArtifacts'
import { composeCrewStationTaskArchive } from '@/modules/task-execution/composition/crewstationArchive'
import { z } from 'zod'
import type { StartOptions } from './daemonStart'
import { composeCrewStationResourceContent } from '@/modules/resource-catalog/composition/skillContentBinding'
import {
  HOSTED_TASK_CONTRACT_VERSION,
  composeCrewStationSystemSelections,
  prepareCrewStationDatabase,
  readCrewStationEnvironment,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { createCrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import { createCrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import { composeCrewStationWorkspaceOwner } from '@/modules/source-control/composition/crewstationWorkspace'
import {
  createHostedGitCommandEnvironment,
  createHostedGitAgentEnvironment,
} from '@/modules/source-control/composition/crewstationGitCredentials'
import { composeCrewStationExecutionOwner } from '@/modules/task-execution/composition/crewstationExecution'
import { composeCrewStationMaterialObjects } from '@/modules/task-execution/composition/crewstationMaterialObjects'
import { createHostedNativePluginReader } from '@/modules/resource-catalog/composition/crewstationNativePlugin'
import { composeLocalTaskAgentRuntimeBindings } from '@/modules/runtime-management/composition/taskAgentRuntimeBindings'
import { selectExecutionInitialization } from './executionInitialization'
import { composeCrewStationDevelopmentWorkspaces } from '@/modules/development-automation/composition/crewstationWorkspace'
import { createCrewStationObserverProgramFactory } from '@/modules/event-center/composition'
import { composeCrewStationEmployeeContent } from '@/modules/digital-employee/composition'
import { composeCrewStationDevelopmentEvidence } from '@/modules/development-automation/composition/crewstationEvidence'
import { createCrewStationVerificationCommandEffectsFactory } from '@/modules/development-automation/composition/crewstationVerification'
import { HostedRuntimeCapabilitiesSchema } from '@/modules/runtime-management/composition/crewstationRuntimeManagement'
import type { HostedRuntimeCapabilities } from '@/modules/runtime-management/public/types'
import { composeCrewStationEvidenceStaging } from '@/modules/development-automation/composition/crewstationEvidenceStaging'
import { composeCrewStationDevelopmentAdapters } from '@/modules/integration/composition/crewstationDevelopmentAdapters'
import { composeStreamTaskRuntimeInventoryContent } from '@/modules/task-execution/composition/taskRuntimeInventoryContent'

/** RFC-370 v3 V5: owner restore-normalization participants for the CS RFC-042
 * restore Job (`agent-workflow migrate` with CS_DATABASE_RESTORE_REFERENCE). */
export function composeCrewStationRestoreNormalization(): readonly HostedRestoreNormalizationParticipant[] {
  return [createHostedRestoreTaskNormalization()]
}

const Profiles = z
  .array(
    z.object({
      protocol: z.enum(['opencode', 'claude-code']),
      model: z.string().nullable(),
      agentProfileId: z.string().uuid(),
    }),
  )
  .min(1)

/** The only hosted assembly root. Business applications consume the same
 * owner ports as standalone; no deployment branch enters a task or engine. */
export async function composeCrewStationStartOptions(
  env: Readonly<Record<string, string | undefined>>,
): Promise<StartOptions> {
  const environment = readCrewStationEnvironment(env)
  if (environment.objectsUrl === null || environment.objectSpaceId === null)
    throw new Error('CS_OBJECTS_URL and CS_OBJECT_SPACE_ID are required for hosted artifacts')
  const profiles = Profiles.parse(JSON.parse(env.AW_AGENT_PROFILES ?? '[]'))
  const eventSources = readCrewStationEventSources(JSON.parse(env.AW_EVENT_SOURCES ?? '[]'))
  validateCrewStationEventSubscriptions(eventSources, JSON.parse(env.AW_EVENT_TYPE_IDS ?? '[]'))
  const profileKeys = profiles.map((profile) => `${profile.protocol}:${profile.model ?? ''}`)
  if (new Set(profileKeys).size !== profileKeys.length)
    throw new Error('AW_AGENT_PROFILES contains duplicate runtime/model mappings')
  const prepared = await prepareCrewStationDatabase({ environment, schema: 'verify', env })
  const system = await composeCrewStationSystemSelections({ environment, prepared })
  const db = system.database
  const initialized = selectExecutionInitialization(system.executionAuthority)
  const fence = system.mutationFence
  const api = createCrewStationBusinessExecution(system.platform)
  const capabilities = async () =>
    HostedRuntimeCapabilitiesSchema.parse(
      await system.platform.get('/v3/business-execution/capabilities'),
    )
  // The control plane serves reads even while the platform API is down; the
  // capability snapshot is re-read before every dispatch (§9.2 V7).
  const initialCapabilities = await capabilities().catch(
    (): HostedRuntimeCapabilities => ({
      protocolVersion: 3,
      releaseId: 'unavailable',
      agentProfiles: [],
    }),
  )
  const objects = createCrewStationObjectStorage({ baseUrl: environment.objectsUrl, fence })
  const objectPublications = composeCrewStationObjectPublications({
    db,
    fence,
    objects,
    sealer: system.secretBox,
  })
  const publications = objectPublications.publications
  const resources = composeCrewStationResourceContent({ db })
  // Scratch owners' parents follow the running release; its id never changes
  // within a process and is re-read until the platform answers.
  let releaseId: string | null =
    initialCapabilities.releaseId === 'unavailable' ? null : initialCapabilities.releaseId
  const workspace = composeCrewStationWorkspaceOwner({
    db,
    api,
    fence,
    secretBox: system.secretBox,
    installation: `${environment.project}/${environment.service}`,
    taskContractVersion: HOSTED_TASK_CONTRACT_VERSION,
    release: async () =>
      (releaseId ??= await capabilities().then(
        (current) => current.releaseId,
        () => null,
      )),
    // §10 V21 (CS RFC-043): durable parents follow the task image this
    // release declares, once the platform can upgrade a parent's image.
    taskImage: async () => {
      const current = await capabilities()
      return current.runtimeImageUpgrade === 1 ? (current.taskRuntimeImageVersionId ?? null) : null
    },
    commandEnvironment: createHostedGitCommandEnvironment(env.AW_GIT_CREDENTIAL_BINDINGS),
  })
  // §9.2 V7 (CS RFC-027): during a migration or restore freeze this release
  // drains its own parents under the freeze's stop authority; the platform's
  // barrier only proves them stopped.
  system.executionAuthority.drainMigrationWith(
    workspace.migrationDrain(createLogger('crewstation-migration-drain')),
  )
  const materialObjects = composeCrewStationMaterialObjects({ api, publications })
  const execution = composeCrewStationExecutionOwner({
    commands: workspace.commands,
    log: createLogger('crewstation-execution'),
    materialEnvironment: createHostedGitAgentEnvironment(env.AW_GIT_CREDENTIAL_BINDINGS),
    materialFiles: materialObjects.files,
    db,
    fence,
    api,
    objects,
    publications,
    profiles,
    capabilities,
    initialCapabilities,
    workspaces: workspace.workspaces,
    taskDeletionRepositories: workspace.deletionRepositories,
    locate: workspace.locate,
    reference: workspace.reference,
    skills: resources.resourcePackageSkillContent,
    // Deferred until dispatch: plugin installation itself uses execution.helper.
    // All owners are initialized before this composition is returned to startup.
    pluginFiles: (plugin) => createHostedNativePluginReader(resourceArtifacts.generations)(plugin),
    runtimeBindingsFor: (binding) =>
      composeLocalTaskAgentRuntimeBindings({
        persistence: binding.nodeRunRuntime,
        registry: binding.runtimeRegistry,
        readBinaryConfiguration: async () => undefined,
      }).bindings,
  })
  const evidence = composeCrewStationDevelopmentEvidence({
    db,
    objects,
    publications,
    helper: execution.helper,
    locate: workspace.locate,
    reference: workspace.reference,
    openFile: workspace.openFile,
    writeFile: (reference, stream, facts) => workspace.writeStream(reference, stream, facts),
  })
  const staging = composeCrewStationEvidenceStaging({
    helper: execution.helper,
    evidence: evidence.evidenceArtifacts,
    reference: workspace.reference,
  })
  const adapters = composeCrewStationDevelopmentAdapters({ helper: execution.helper, staging })
  const reviewArtifacts = composeCrewStationReviewArtifacts({ db, objects, publications })
  const resourceArtifacts = composeCrewStationResourceArtifacts({
    db,
    fence,
    objects,
    publications,
    helper: execution.helper,
    reference: workspace.reference,
    openFile: workspace.openFile,
    retainedReferences: composeCrewStationIntentPluginRetention(db),
  })
  const archivedNodeEvents = composeCrewStationNodeEventArchive({
    db,
    fence,
    objects,
    publications,
  })
  const workspaceSelections = workspace.bind()
  return {
    taskInputFiles: composeCrewStationTaskInputFiles({ db, objects, publications }),
    databaseBackup: composeCrewStationDatabaseBackups({
      db,
      runtime: prepared.runtime.runtime,
      fence,
      objects,
      publications,
      installation: `${environment.project}/${environment.service}`,
      objectSpaceId: environment.objectSpaceId,
      secretKey: environment.secretKey,
    }).backup,
    archivedNodeEvents,
    runtimeInventoryContent: composeStreamTaskRuntimeInventoryContent(),
    humanGateArtifactRecovery: composeCrewStationHumanGateRecovery({
      db,
      fence,
      artifacts: reviewArtifacts.store,
    }),
    beforeEventObservationWrite: (tx) => fence.assertHeld(tx, fence.current()),
    crewStationEvents: composeCrewStationEventIngress({
      db,
      fence,
      installationId: `${environment.project}/${environment.service}`,
      sources: eventSources,
      verifySource: composeCrewStationSourceTokenVerifier({
        jwksUrl: environment.jwksUrl,
        audience: crewStationPlatformSourceAudiences(environment),
        source: { project: 'platform', service: 'cs-events' },
      }).verify,
    }),
    host: '0.0.0.0',
    port: environment.port,
    applicationConfiguration: system.applicationConfiguration,
    databaseInstallation: system.databaseInstallation,
    executionAuthority: initialized.authority,
    initializeExecution: initialized.initialize,
    ...execution.selections,
    // MCP diagnostics are a Resource Catalog capability running on the shared
    // hosted Agent execution; bootstrap is the only place both meet.
    mcpDiagnostics: createCrewStationMcpDiagnostics({
      ...execution.hostedAgents,
      workspaces: workspace.workspaces,
      locate: workspace.locate,
    }),
    hostedBackgroundOwners: [
      ...execution.backgroundOwners,
      // §9.2 V3: pause idle parents, finish lost closes (Source Control),
      // judged by Task Execution's volume-use facts.
      workspace.lifecycleOwner(execution.volumeActivity, {
        log: createLogger('crewstation-workspace-lifecycle'),
      }),
    ],
    taskRecovery: composeCrewStationRecovery({
      db,
      fence,
      platform: system.platform,
      api,
      log: createLogger('crewstation-recovery'),
      requesterFor: (identityAccess) => composeCrewStationRecoveryRequester({ db, identityAccess }),
    }),
    ...evidence,
    reviewArtifacts,
    // §10 V16: structural diffs and change narratives as object publications;
    // the code-review reads themselves arrive with the workspace selections.
    codeReviewArtifacts: composeCrewStationCodeReviewArtifacts({ objects, publications }),
    taskArchive: composeCrewStationTaskArchive({
      db,
      fence,
      objects,
      publications,
      helper: execution.helper,
      locate: workspace.locate,
      reference: workspace.reference,
      workspaces: workspace.workspaces,
      openFile: workspace.openFile,
      reviewFiles: reviewArtifacts.archiveFiles,
      eventFiles: archivedNodeEvents.files,
    }),
    missionInputBlobs: evidence.evidenceArtifacts,
    attemptContext: evidence.evidenceArtifacts.contexts,
    developmentPurposes: {
      requirement: {
        configurationFor: adapters.configurationFor,
        effects: adapters.requirement,
        staging: staging.factory,
        documentCommands: evidence.evidenceDocumentCommands,
      },
      pipeline: {
        configurationFor: adapters.configurationFor,
        effects: adapters.pipeline,
        staging: { collect: staging.factory, trigger: staging.factory, rerun: staging.factory },
      },
      approval: {
        configurationFor: adapters.configurationFor,
        effects: adapters.approval,
        staging: staging.factory,
      },
    },
    customObserverPrograms: createCrewStationObserverProgramFactory(execution.helper),
    // RFC-370 §10 V19: program tool contract fixtures run in the task image.
    programFixtureProcess: createHostedScriptFixtureProcess({ helper: execution.helper }),
    verificationCommands: createCrewStationVerificationCommandEffectsFactory({
      helper: execution.helper,
      locate: workspace.locate,
      reference: workspace.reference,
      retainWorkspace: workspace.retainWorkspace,
    }),
    ...composeCrewStationEmployeeContent({
      publications,
      objects,
      writeWorkspace: (reference, stream, facts) => workspace.writeStream(reference, stream, facts),
    }),
    secretBox: system.secretBox,
    credentials: composeCrewStationCredentialAdapters({
      jwksUrl: environment.jwksUrl,
      project: environment.project,
      service: environment.service,
      administratorSubjects: environment.adminSubjects,
    }),
    executionHost: 'remote',
    ...resources,
    ...resourceArtifacts.selections,
    intentArtifacts: composeCrewStationIntentArtifacts(resourceArtifacts.intent),
    maintenanceEffectsBootstrap: composeCrewStationMaintenanceDescriptor({
      database: prepared.databaseConfig,
      generationId: prepared.runtime.generation.payload.generationId,
      fence,
    }),
    ...workspaceSelections,
    ...composeCrewStationDevelopmentWorkspaces({
      helper: execution.helper,
      applicationRootReference: workspace.reference('development:shared', '/work'),
      locate: workspace.locate,
      reference: workspace.reference,
      readFile: workspace.readFile,
      // RFC-370 §9.2 V3: large tree-operation inputs travel as volume files.
      writeFile: workspace.writeFile,
    }),
  }
}

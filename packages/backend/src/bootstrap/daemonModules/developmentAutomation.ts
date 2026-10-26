// RFC-383: session-owned development automation, task operations and writer gates.
import {
  composeDevelopmentAutomation,
  composeDevelopmentAdmissionLookup,
} from '@/modules/development-automation/composition'
import { createDevelopmentMissionExecutionTerminalObserver } from '@/modules/development-automation/composition/executionTerminalObserver'
import {
  composeDevelopmentMissionOperations,
  createLegacyMissionAdmissionsEnabledQuery,
} from '@/modules/development-automation/composition/missionOperations'
import { composeMissionInputUploadOperations } from '@/modules/development-automation/composition/missionInputUploads'
import { composeSelectedRequirementSourceRunnerFor } from '@/modules/integration/composition/requirementSource'
import {
  bindChangeCandidateParticipant,
  bindCandidateDeliveryParticipant,
  bindConflictMergeParticipant,
} from '@/modules/source-control/composition'
import {
  buildDevelopmentDeliveryDeps,
  buildDevelopmentPipelineDeps,
  buildDevelopmentMrFactsDeps,
} from '@/services/developmentDeliveryDeps'
import { composeAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composeScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
import { createLocalVerificationCommandEffectsFactory } from '@/modules/development-automation/composition/localVerificationCommands'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { Logger } from '@/util/log'
import type { SelectedDevelopmentPurposeRoot } from '@/modules/development-automation/composition'
import {
  type DevelopmentWriterCutover,
  type selectDevelopmentWorkspaceEffectBinding,
} from '@/modules/development-automation/composition'
import type { DaemonTaskExecutionModules } from './taskExecution'
import type { DaemonRepositoryCredentials } from './repositoryCredentials'
import type { DaemonIntegrationModules } from './integration'

type AutomationInput = Parameters<typeof composeDevelopmentAutomation>[0]
export interface DaemonDevelopmentAutomationInput {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly log: Pick<Logger, 'info' | 'warn'>
  readonly developmentPurposeRoot: SelectedDevelopmentPurposeRoot
  readonly workspaceEffects: ReturnType<typeof selectDevelopmentWorkspaceEffectBinding>
  readonly repository: Pick<
    DaemonRepositoryCredentials,
    'developmentDeliveryProvider' | 'repositoryPublicationTransport'
  >
  readonly integration: Pick<DaemonIntegrationModules, 'developmentApprovalGateway'>
  readonly hostTasks: DaemonTaskExecutionModules['hostTasks']
  readonly writerCutover: DevelopmentWriterCutover
  readonly verificationCommands?: AutomationInput['verificationCommands']
  readonly repositoryBaselines?: AutomationInput['repositoryBaselines']
  readonly evidenceRead?: AutomationInput['evidenceRead']
  readonly attemptContext?: AutomationInput['attemptContext']
  readonly repositoryCandidateEffects?: NonNullable<
    Parameters<typeof bindChangeCandidateParticipant>[0]
  >['candidateEffects']
  readonly conflictMergeWorkspaceEffects?: NonNullable<
    Parameters<typeof bindConflictMergeParticipant>[0]
  >['effects']
  readonly missionInputBlobs?: Parameters<typeof composeMissionInputUploadOperations>[0]['blobs']
  readonly evidenceArtifacts?: Parameters<
    typeof composeMissionInputUploadOperations
  >[0]['artifacts']
  readonly actionWorkspaceEntries?: Parameters<
    typeof composeAgentActionExecution
  >[0]['workspaceEntries']
}

export function composeDaemonDevelopmentAutomationModules(input: DaemonDevelopmentAutomationInput) {
  const {
    db,
    appHome,
    log,
    repository,
    integration,
    developmentPurposeRoot,
    hostTasks,
    writerCutover,
  } = input
  const admissionLookup = composeDevelopmentAdmissionLookup(db)
  const developmentTerminalObserver = createDevelopmentMissionExecutionTerminalObserver({
    db,
    async drive(missionId) {
      try {
        const outcome = await automation.drive(missionId)
        if (outcome.stop === 'step-budget')
          log.warn('development mission drive reached its bounded step budget', {
            missionId,
            steps: outcome.steps,
          })
        return outcome
      } catch (err) {
        log.warn('development mission drive after execution terminal failed', {
          missionId,
          err: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  })
  const automation = composeDevelopmentAutomation({
    verificationCommands:
      input.verificationCommands ?? createLocalVerificationCommandEffectsFactory(),
    actionWorkspaceEffects: input.workspaceEffects.actionWorkspaceEffects,
    automationWorkspaceEffects: input.workspaceEffects.automationWorkspaceEffects,
    repositoryBaselines: input.repositoryBaselines,
    db,
    appHome,
    evidenceArtifacts: developmentPurposeRoot.evidenceArtifacts,
    evidenceRead: input.evidenceRead,
    evidenceDocumentCommands: developmentPurposeRoot.requirement.documentCommands,
    requirementStaging: developmentPurposeRoot.requirement.staging,
    attemptContext: input.attemptContext,
    admissionLookup,
    requirementSource: composeSelectedRequirementSourceRunnerFor(
      db,
      developmentPurposeRoot.requirement,
    ),
    changeCandidate: bindChangeCandidateParticipant({
      candidateEffects: input.repositoryCandidateEffects,
    }),
    candidateDelivery: bindCandidateDeliveryParticipant({
      candidateEffects: input.repositoryCandidateEffects,
      publicationTransport: repository.repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant({ effects: input.conflictMergeWorkspaceEffects }),
    ...buildDevelopmentDeliveryDeps(
      repository.developmentDeliveryProvider,
      developmentPurposeRoot.pipeline.staging,
    ),
    ...buildDevelopmentPipelineDeps(
      repository.developmentDeliveryProvider.pipeline,
      developmentPurposeRoot.pipeline.staging,
    ),
    ...buildDevelopmentMrFactsDeps(repository.developmentDeliveryProvider),
    approvalGateway: integration.developmentApprovalGateway,
    agentLauncher: composeAgentActionExecution({
      ...hostTasks,
      agents: { get: (id) => hostTasks.agents.get(id, 'agent-action-authority-not-admitted') },
      workspaceEntries: input.actionWorkspaceEntries,
      onTerminal: (executionRef) => {
        void developmentTerminalObserver.agent(executionRef)
      },
    }),
    scriptLauncher: composeScriptActionExecution({
      ...hostTasks,
      agents: { get: (id) => hostTasks.agents.get(id, 'agent-action-authority-not-admitted') },
      workspaceEntries: input.actionWorkspaceEntries,
      onTerminal: (executionRef) => {
        void developmentTerminalObserver.script(executionRef)
      },
    }),
  })
  const missionOperations = composeDevelopmentMissionOperations({
    repositoryBaselines: input.repositoryBaselines,
    db,
    deliveryProvider: repository.developmentDeliveryProvider,
    admissionLookup,
    automation,
    legacyAdmissionsEnabled: createLegacyMissionAdmissionsEnabledQuery(writerCutover),
  })
  const missionInputUploads = composeMissionInputUploadOperations({
    db,
    appHome,
    blobs: input.missionInputBlobs,
    artifacts: input.evidenceArtifacts,
  })
  return Object.freeze({
    admissionLookup,
    automation,
    missionOperations,
    missionInputUploads,
  })
}
export type DaemonDevelopmentAutomationModules = ReturnType<
  typeof composeDaemonDevelopmentAutomationModules
>

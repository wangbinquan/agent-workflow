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
  composeDevelopmentDeliveryDeps,
  composeDevelopmentMrFactsCollector,
  composeDevelopmentPipelineDeps,
} from '@/modules/development-automation/composition/developmentDelivery'
import { composeAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composeScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
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

import type { DeploymentSelections } from '../deploymentProfile'
export interface DaemonDevelopmentAutomationInput {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly log: Pick<Logger, 'info' | 'warn'>
  readonly developmentPurposeRoot: SelectedDevelopmentPurposeRoot
  readonly workspaceEffects: ReturnType<typeof selectDevelopmentWorkspaceEffectBinding>
  readonly repository: Pick<
    DaemonRepositoryCredentials,
    'developmentDeliveryProvider' | 'developmentCodeHost' | 'repositoryPublicationTransport'
  >
  readonly integration: Pick<DaemonIntegrationModules, 'developmentApprovalGateway'>
  readonly hostTasks: DaemonTaskExecutionModules['hostTasks']
  readonly writerCutover: DevelopmentWriterCutover
  // RFC-431: the deployment's selections arrive stated; this bundle substitutes no default.
  readonly verificationCommands: DeploymentSelections['verificationCommands']
  readonly repositoryBaselines: DeploymentSelections['repositoryBaselines']
  // RFC-433: hosted remote-volume effects; standalone states null (each participant's per-request local effects).
  readonly repositoryCandidateEffects: DeploymentSelections['repositoryCandidateEffects']
  readonly conflictMergeWorkspaceEffects: DeploymentSelections['conflictMergeWorkspaceEffects']
  readonly evidenceArtifacts: DeploymentSelections['evidenceArtifacts']
  readonly actionWorkspaceEntries: DeploymentSelections['actionWorkspaceEntries']
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
  const candidateEffects =
    input.repositoryCandidateEffects === null ? undefined : input.repositoryCandidateEffects
  const conflictMergeEffects =
    input.conflictMergeWorkspaceEffects === null ? undefined : input.conflictMergeWorkspaceEffects
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
    verificationCommands: input.verificationCommands,
    actionWorkspaceEffects: input.workspaceEffects.actionWorkspaceEffects,
    automationWorkspaceEffects: input.workspaceEffects.automationWorkspaceEffects,
    repositoryBaselines: input.repositoryBaselines,
    db,
    appHome,
    // RFC-429: evidence reads and attempt contexts are members of the deployment's evidenceArtifacts.
    evidenceArtifacts: developmentPurposeRoot.evidenceArtifacts,
    evidenceDocumentCommands: developmentPurposeRoot.requirement.documentCommands,
    requirementStaging: developmentPurposeRoot.requirement.staging,
    admissionLookup,
    requirementSource: composeSelectedRequirementSourceRunnerFor(
      db,
      developmentPurposeRoot.requirement,
    ),
    changeCandidate: bindChangeCandidateParticipant({ candidateEffects }),
    candidateDelivery: bindCandidateDeliveryParticipant({
      candidateEffects,
      publicationTransport: repository.repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant({ effects: conflictMergeEffects }),
    ...composeDevelopmentDeliveryDeps({
      provider: repository.developmentDeliveryProvider,
      mrEffects: repository.developmentCodeHost.mrEffects,
      mrFacts: repository.developmentCodeHost.mrFacts,
      staging: developmentPurposeRoot.pipeline.staging,
    }),
    ...composeDevelopmentPipelineDeps(
      repository.developmentDeliveryProvider.pipeline,
      developmentPurposeRoot.pipeline.staging,
    ),
    ...composeDevelopmentMrFactsCollector({
      provider: repository.developmentDeliveryProvider,
      mrFacts: repository.developmentCodeHost.mrFacts,
    }),
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
    mrEffects: repository.developmentCodeHost.mrEffects,
    repositoryClaimKeys: repository.developmentCodeHost.claimKeys,
    admissionLookup,
    automation,
    legacyAdmissionsEnabled: createLegacyMissionAdmissionsEnabledQuery(writerCutover),
  })
  const missionInputUploads = composeMissionInputUploadOperations({
    db,
    appHome,
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

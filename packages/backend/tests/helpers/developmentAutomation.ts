// RFC-524 — what the development-automation compositions used to build when the caller left a selection out. The
// compositions now take these as required inputs (the daemon always gave them); tests that relied on the fallbacks give
// them through these helpers. Each member is built only when the test did not give it, exactly as the fallback did.
// RFC-597 adds the doubles for the providers a test does not exercise (the composition requires all of them); RFC-598 adds
// the three effect selections the composition used to build when they were left out; RFC-603 adds the full reconciler
// port set for tests that drive the reconcile use case directly.
import { join } from 'node:path'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/application/evidenceDocumentCommands'
import type { AdmissionLookup } from '@/modules/development-automation/application/ports/admissionLookup'
import type { ActionWorkspaceEffects } from '@/modules/development-automation/application/ports/actionWorkspaceEffects'
import type { AutomationWorkspaceEffectsFactory } from '@/modules/development-automation/application/ports/automationWorkspaceEffects'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { EvidenceStagingFactory } from '@/modules/development-automation/application/ports/evidenceStaging'
import type { ReconcilerPorts } from '@/modules/development-automation/application/ports/reconcilerPorts'
import type { RepositoryBaselineEffectsFactory } from '@/modules/development-automation/application/ports/repositoryBaselineEffects'
import { createAdmissionLookup } from '@/modules/development-automation/infrastructure/admissionLookup'
import { selectedAutomationWorkspaceEffects } from '@/modules/development-automation/infrastructure/automationWorkspaceEffects'
import {
  createActionTemplatePersistence,
  createVerificationProfilePersistence,
} from '@/modules/development-automation/infrastructure/configResourceStore'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import {
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
} from '@/modules/development-automation/infrastructure/local/evidenceStaging'
import { createFileActionWorkspaceEffects } from '@/modules/development-automation/infrastructure/local/fileActionWorkspaceEffects'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import { createFileEvidenceDocumentCommands } from '@/modules/development-automation/infrastructure/local/fileEvidenceDocumentCommands'
import { createFileRepositoryBaselineEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileRepositoryBaselineEffects'
import { createPlaybookSagaPersistence } from '@/modules/development-automation/infrastructure/playbookSagaStore'
import { readUploadPlan } from '@/modules/development-automation/infrastructure/uploadPlanStore'
import { recordUploadPublicationReceipt } from '@/modules/development-automation/infrastructure/uploadPublicationReceipt'
import type { DevelopmentAutomationProviders } from '@/modules/development-automation/composition'
import type { DevelopmentEmployeeWorkspaceCompositionInput } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import type { DevelopmentEmployeePlatformWorkItemsCompositionInput } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export interface StandaloneDevelopmentAutomationSelections {
  readonly evidenceArtifacts: EvidenceArtifactPort
  readonly admissionLookup: AdmissionLookup
  readonly requirementStaging: EvidenceStagingFactory
  readonly evidenceDocumentCommands: EvidenceDocumentCommands
  readonly actionWorkspaceEffects: ActionWorkspaceEffects
  readonly automationWorkspaceEffects: AutomationWorkspaceEffectsFactory
  readonly repositoryBaselines: RepositoryBaselineEffectsFactory
}

/**
 * `composeDevelopmentAutomation`'s former fallbacks: the evidence store at `<appHome>/evidence` (built now, as the
 * composition built it at composition time), the admission lookup over the database, and — unless the test gave its own
 * staging — the local writer and requirement staging over the resolved evidence store at `<appHome>/evidence/staging`.
 * A test that gives staging gives its writer as well; it is passed through unchanged, so a missing writer is still
 * rejected by the composition with the same error. RFC-598: the three effect selections as the composition's fallbacks
 * built them — the file action workspace effects, the automation effects as their `contents`, and the file baseline
 * effects.
 */
export function composeStandaloneDevelopmentAutomationSelections(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly admissionLookup?: AdmissionLookup
  readonly requirementStaging?: EvidenceStagingFactory
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
  readonly actionWorkspaceEffects?: ActionWorkspaceEffects
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  readonly repositoryBaselines?: RepositoryBaselineEffectsFactory
}): StandaloneDevelopmentAutomationSelections {
  const admissionLookup = input.admissionLookup ?? createAdmissionLookup(input.db)
  const evidence = input.evidenceArtifacts ?? new EvidenceStore(join(input.appHome, 'evidence'))
  const actionWorkspaceEffects = input.actionWorkspaceEffects ?? createFileActionWorkspaceEffects()
  const effects = {
    actionWorkspaceEffects,
    automationWorkspaceEffects: input.automationWorkspaceEffects ?? actionWorkspaceEffects.contents,
    repositoryBaselines: input.repositoryBaselines ?? createFileRepositoryBaselineEffectsFactory(),
  }
  if (input.requirementStaging !== undefined)
    return {
      evidenceArtifacts: evidence,
      admissionLookup,
      requirementStaging: input.requirementStaging,
      evidenceDocumentCommands: input.evidenceDocumentCommands as EvidenceDocumentCommands,
      ...effects,
    }
  const stagingRoot = join(input.appHome, 'evidence', 'staging')
  return {
    ...effects,
    evidenceArtifacts: evidence,
    admissionLookup,
    evidenceDocumentCommands:
      input.evidenceDocumentCommands ??
      createFileEvidenceDocumentCommands({ evidence, stagingRoot }),
    requirementStaging: createLocalEvidenceStagingFactory(
      createLocalEvidenceStagingNamespace(evidence),
      { kind: 'requirement', root: stagingRoot },
    ),
  }
}

/** RFC-597: one method of a provider the test does not exercise. */
function notUsed(member: string): () => never {
  return () => {
    throw new Error(`${member} is not used by this test`)
  }
}

/**
 * RFC-597 — `composeDevelopmentAutomation` requires every provider (the daemon gives all eleven). A test that exercises
 * only some of them spreads these first and gives its own after. Every method throws a named error, so a test that
 * reaches a provider it did not give fails loudly instead of being blocked as "not wired" (RFC-603: no use case has that
 * state any more). Each port lists its methods, so the compiler checks the doubles are complete.
 */
export function unusedDevelopmentProviders(): DevelopmentAutomationProviders {
  return {
    requirementSource: {
      acquire: notUsed('requirementSource.acquire'),
      publishQuestions: notUsed('requirementSource.publishQuestions'),
      collectAnswers: notUsed('requirementSource.collectAnswers'),
    },
    agentLauncher: {
      launch: notUsed('agentLauncher.launch'),
      fetchOutcome: notUsed('agentLauncher.fetchOutcome'),
      cancel: notUsed('agentLauncher.cancel'),
    },
    scriptLauncher: {
      launch: notUsed('scriptLauncher.launch'),
      fetchOutcome: notUsed('scriptLauncher.fetchOutcome'),
      cancel: notUsed('scriptLauncher.cancel'),
    },
    approvalGateway: {
      submit: notUsed('approvalGateway.submit'),
      lookupByIdempotencyKey: notUsed('approvalGateway.lookupByIdempotencyKey'),
      observe: notUsed('approvalGateway.observe'),
    },
    changeCandidate: { derive: notUsed('changeCandidate.derive') },
    candidateDelivery: {
      stage: notUsed('candidateDelivery.stage'),
      commit: notUsed('candidateDelivery.commit'),
      push: notUsed('candidateDelivery.push'),
    },
    repoRemote: { resolve: notUsed('repoRemote.resolve') },
    mrEffects: {
      ensure: notUsed('mrEffects.ensure'),
      reply: notUsed('mrEffects.reply'),
      observe: notUsed('mrEffects.observe'),
    },
    pipelineEvidence: {
      collect: notUsed('pipelineEvidence.collect'),
      trigger: notUsed('pipelineEvidence.trigger'),
      rerun: notUsed('pipelineEvidence.rerun'),
    },
    mergeRequestFacts: { collect: notUsed('mergeRequestFacts.collect') },
    conflictMerge: {
      prepare: notUsed('conflictMerge.prepare'),
      finish: notUsed('conflictMerge.finish'),
      discard: notUsed('conflictMerge.discard'),
    },
  }
}

/**
 * RFC-603 — every `ReconcilerPorts` member, for a test that drives the reconcile use case (or one of its commands)
 * without the composition. The five database-backed ports are the composition's own — the playbook saga store, the upload
 * plan reader, the upload publication receipts, and the action template and verification profile contents — so the
 * reconcile reads what production reads (the saga digest, the playbook decision, the upload plan). Every other port is a
 * double whose methods throw a named error; `overrides` replaces any member.
 */
export function reconcilerPortsFor(
  db: PersistenceDb,
  overrides: Partial<ReconcilerPorts> = {},
): ReconcilerPorts {
  const { requirementSource: _requirementSource, ...providers } = unusedDevelopmentProviders()
  const templates = createActionTemplatePersistence(db)
  const profiles = createVerificationProfilePersistence(db)
  return {
    ...providers,
    repositoryFacts: { collect: notUsed('repositoryFacts.collect') },
    playbookSaga: createPlaybookSagaPersistence(db),
    childMissions: {
      createOrAdopt: notUsed('childMissions.createOrAdopt'),
      observe: notUsed('childMissions.observe'),
    },
    uploadPlacement: { place: notUsed('uploadPlacement.place') },
    requirementMaterialize: {
      materializeDirect: notUsed('requirementMaterialize.materializeDirect'),
      acquireExternal: notUsed('requirementMaterialize.acquireExternal'),
      getRequirementManifest: notUsed('requirementMaterialize.getRequirementManifest'),
      getRequirementManifestMount: notUsed('requirementMaterialize.getRequirementManifestMount'),
      carryOverRequirementEvidence: notUsed('requirementMaterialize.carryOverRequirementEvidence'),
      stashQuestionSet: notUsed('requirementMaterialize.stashQuestionSet'),
      publishQuestions: notUsed('requirementMaterialize.publishQuestions'),
      collectAnswers: notUsed('requirementMaterialize.collectAnswers'),
      stashAnswerSet: notUsed('requirementMaterialize.stashAnswerSet'),
    },
    actionBaseline: { resolve: notUsed('actionBaseline.resolve') },
    actionWorkspace: {
      materialize: notUsed('actionWorkspace.materialize'),
      adopt: notUsed('actionWorkspace.adopt'),
      discard: notUsed('actionWorkspace.discard'),
    },
    uploadPlanReader: { read: (planId) => readUploadPlan(db, planId) },
    attemptContext: {
      save: notUsed('attemptContext.save'),
      load: notUsed('attemptContext.load'),
    },
    actionTemplates: {
      content: async (id, revision) => {
        const row = await templates.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    workspaceValidation: {
      capturePreState: notUsed('workspaceValidation.capturePreState'),
      validate: notUsed('workspaceValidation.validate'),
    },
    verificationProfiles: {
      content: async (id, revision) => {
        const row = await profiles.getRevision(id, revision)
        return row === null ? null : (JSON.parse(row.contentJson) as unknown)
      },
    },
    verificationExecution: { run: notUsed('verificationExecution.run') },
    uploadPublication: { record: (input) => recordUploadPublicationReceipt(db, input) },
    pipelineImport: { import: notUsed('pipelineImport.import') },
    ...overrides,
  }
}

/**
 * RFC-601 — a graph delivery for a case without a graph design: verification before publishing passes and there is no
 * repair material. That is what the graph MR care answers for such a case, and what the use cases did when they were given
 * no graph delivery. Both employee compositions take it.
 */
export function graphDeliveryWithoutDesign(): DevelopmentEmployeeWorkspaceCompositionInput['graphDelivery'] &
  DevelopmentEmployeePlatformWorkItemsCompositionInput['graphDelivery'] {
  return {
    beforePublish: async () => ({ ok: true }),
    repairMaterial: async () => null,
  }
}

/**
 * RFC-601 — the platform work items' approval gateway, pipeline evidence and MR facts for a test that does not exercise
 * them: every method throws a named error, so a test that reaches one fails loudly instead of being blocked as "not
 * connected" (the composition requires them; the use case keeps that result for an input that lacks them).
 */
export function unusedEmployeePlatformProviders(): Pick<
  DevelopmentEmployeePlatformWorkItemsCompositionInput,
  'approvalGateway' | 'pipelineEvidence' | 'mrFacts'
> {
  return {
    approvalGateway: {
      submit: notUsed('approvalGateway.submit'),
      lookupByIdempotencyKey: notUsed('approvalGateway.lookupByIdempotencyKey'),
      observe: notUsed('approvalGateway.observe'),
    },
    pipelineEvidence: {
      collect: notUsed('pipelineEvidence.collect'),
      trigger: notUsed('pipelineEvidence.trigger'),
      rerun: notUsed('pipelineEvidence.rerun'),
    },
    mrFacts: { collect: notUsed('mrFacts.collect') },
  }
}

/**
 * `composeDevelopmentEmployeePlatformWorkItems`'s former fallback: the evidence store is built on first use — under the
 * selected workspace effects' application root, else `appHome` — and reused. Building it creates its directories, so
 * the store stays lazy: the port builds it when a member is first read.
 */
export function composeStandalonePlatformWorkItemEvidence(input: {
  readonly appHome: string
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
}): EvidenceArtifactPort {
  let store: EvidenceStore | undefined
  const current = (): EvidenceStore => {
    if (store === undefined) {
      // RFC-600: the former local fallback is the helper's, stated (the infrastructure check no longer builds one).
      const factory = selectedAutomationWorkspaceEffects(
        input.automationWorkspaceEffects ?? createFileAutomationWorkspaceEffectsFactory(),
      )
      store = new EvidenceStore(
        factory.resolve(factory.applicationRootReference ?? input.appHome, 'evidence'),
      )
    }
    return store
  }
  return new Proxy({} as EvidenceArtifactPort, {
    get(_target, key) {
      // Not a thenable: awaiting or returning the port must not build the store.
      if (key === 'then') return undefined
      const target = current()
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

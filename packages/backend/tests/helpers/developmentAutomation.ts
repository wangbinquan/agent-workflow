// RFC-524 — what the development-automation compositions used to build when the caller left a selection out. The
// compositions now take these as required inputs (the daemon always gave them); tests that relied on the fallbacks give
// them through these helpers. Each member is built only when the test did not give it, exactly as the fallback did.
// RFC-597 adds the doubles for the providers a test does not exercise (the composition requires all of them); RFC-598 adds
// the three effect selections the composition used to build when they were left out.
import { join } from 'node:path'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/application/evidenceDocumentCommands'
import type { AdmissionLookup } from '@/modules/development-automation/application/ports/admissionLookup'
import type { ActionWorkspaceEffects } from '@/modules/development-automation/application/ports/actionWorkspaceEffects'
import type { AutomationWorkspaceEffectsFactory } from '@/modules/development-automation/application/ports/automationWorkspaceEffects'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { EvidenceStagingFactory } from '@/modules/development-automation/application/ports/evidenceStaging'
import type { RepositoryBaselineEffectsFactory } from '@/modules/development-automation/application/ports/repositoryBaselineEffects'
import { createAdmissionLookup } from '@/modules/development-automation/infrastructure/admissionLookup'
import { selectedAutomationWorkspaceEffects } from '@/modules/development-automation/infrastructure/automationWorkspaceEffects'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import {
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
} from '@/modules/development-automation/infrastructure/local/evidenceStaging'
import { createFileActionWorkspaceEffects } from '@/modules/development-automation/infrastructure/local/fileActionWorkspaceEffects'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import { createFileEvidenceDocumentCommands } from '@/modules/development-automation/infrastructure/local/fileEvidenceDocumentCommands'
import { createFileRepositoryBaselineEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileRepositoryBaselineEffects'
import type { DevelopmentAutomationProviders } from '@/modules/development-automation/composition'
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
 * reaches a provider it did not give fails loudly instead of being blocked as "not wired": the composition no longer
 * has that state, and the reconciler's `*-not-wired` branches stay only for tests that build `ReconcilerPorts` directly.
 * Each port lists its methods, so the compiler checks the doubles are complete.
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

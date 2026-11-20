// RFC-524 — what the development-automation compositions used to build when the caller left a selection out. The
// compositions now take these as required inputs (the daemon always gave them); tests that relied on the fallbacks give
// them through these helpers. Each member is built only when the test did not give it, exactly as the fallback did.
import { join } from 'node:path'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/application/evidenceDocumentCommands'
import type { AdmissionLookup } from '@/modules/development-automation/application/ports/admissionLookup'
import type { AutomationWorkspaceEffectsFactory } from '@/modules/development-automation/application/ports/automationWorkspaceEffects'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { EvidenceStagingFactory } from '@/modules/development-automation/application/ports/evidenceStaging'
import { createAdmissionLookup } from '@/modules/development-automation/infrastructure/admissionLookup'
import { selectedAutomationWorkspaceEffects } from '@/modules/development-automation/infrastructure/automationWorkspaceEffects'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import {
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
} from '@/modules/development-automation/infrastructure/local/evidenceStaging'
import { createFileEvidenceDocumentCommands } from '@/modules/development-automation/infrastructure/local/fileEvidenceDocumentCommands'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export interface StandaloneDevelopmentAutomationSelections {
  readonly evidenceArtifacts: EvidenceArtifactPort
  readonly admissionLookup: AdmissionLookup
  readonly requirementStaging: EvidenceStagingFactory
  readonly evidenceDocumentCommands: EvidenceDocumentCommands
}

/**
 * `composeDevelopmentAutomation`'s former fallbacks: the evidence store at `<appHome>/evidence` (built now, as the
 * composition built it at composition time), the admission lookup over the database, and — unless the test gave its own
 * staging — the local writer and requirement staging over the resolved evidence store at `<appHome>/evidence/staging`.
 * A test that gives staging gives its writer as well; it is passed through unchanged, so a missing writer is still
 * rejected by the composition with the same error.
 */
export function composeStandaloneDevelopmentAutomationSelections(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly admissionLookup?: AdmissionLookup
  readonly requirementStaging?: EvidenceStagingFactory
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
}): StandaloneDevelopmentAutomationSelections {
  const admissionLookup = input.admissionLookup ?? createAdmissionLookup(input.db)
  const evidence = input.evidenceArtifacts ?? new EvidenceStore(join(input.appHome, 'evidence'))
  if (input.requirementStaging !== undefined)
    return {
      evidenceArtifacts: evidence,
      admissionLookup,
      requirementStaging: input.requirementStaging,
      evidenceDocumentCommands: input.evidenceDocumentCommands as EvidenceDocumentCommands,
    }
  const stagingRoot = join(input.appHome, 'evidence', 'staging')
  return {
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
      const factory = selectedAutomationWorkspaceEffects(input.automationWorkspaceEffects)
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

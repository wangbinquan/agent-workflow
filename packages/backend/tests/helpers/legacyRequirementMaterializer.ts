// RFC-607 — the native requirement materializer facade, moved out of production (RFC-584's practice for contract-test-only
// compatibility entries). Production composes `createSelectedRequirementMaterializer` with the stated requirement source;
// this facade keeps the tests' physical-directory source (`sinkPath`) and the file document writer they were written for.
// A test that gives no source gets a double whose methods throw a named error: the selected materializer requires one.
import type { EvidenceDocumentCommands } from '@/modules/development-automation/application/evidenceDocumentCommands'
import type { EvidenceDocumentQueries } from '@/modules/development-automation/application/evidenceDocuments'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { EvidenceBudget } from '@/modules/development-automation/domain/evidence'
import type { OperationFailureReceipt } from '@/modules/development-automation/domain/operationFailure'
import {
  createSelectedRequirementMaterializer,
  type RequirementMaterializer,
  type RequirementMaterializerDeps as SelectedDeps,
} from '@/modules/development-automation/application/requirementMaterializer'
import { createFileEvidenceDocumentCommands } from '@/modules/development-automation/infrastructure/local/fileEvidenceDocumentCommands'
import {
  createLocalEvidenceStagingNamespace,
  createLocalEvidenceStagingFactory,
} from '@/modules/development-automation/infrastructure/local/evidenceStaging'

export interface RequirementSourceRunnerDep {
  acquire(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly sinkPath: string
  }): Promise<
    | {
        readonly ok: true
        readonly sourceRevision: string
        readonly title: string
        readonly files: readonly { readonly relativePath: string; readonly role: string }[]
        readonly outputBudget: EvidenceBudget
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  publishQuestions(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly questionsJson: string
    readonly sinkPath: string
  }): Promise<
    | { readonly ok: true; readonly correlationRef: string }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
  collectAnswers(input: {
    readonly adapterBindingRef: string
    readonly externalId: string
    readonly correlationRef: string
    readonly sinkPath: string
  }): Promise<
    | {
        readonly ok: true
        readonly complete: boolean
        readonly answerRevision: string | null
        readonly answers: readonly { readonly questionId: string; readonly answer: string }[]
      }
    | { readonly ok: false; readonly failure: OperationFailureReceipt }
  >
}

export interface RequirementMaterializerDeps extends Omit<
  SelectedDeps,
  'staging' | 'source' | 'documentCommands'
> {
  readonly stagingRoot: string
  readonly source?: RequirementSourceRunnerDep
  readonly documentCommands?: EvidenceDocumentCommands
  /** RFC-607: a test's document reader, served as the evidence port's own `documents` (the materializer's override is gone). */
  readonly documents?: EvidenceDocumentQueries
}

/** The evidence port with `documents` replaced; every other member is the port's own, bound to it. */
function evidenceWithDocuments(
  evidence: EvidenceArtifactPort,
  documents: EvidenceDocumentQueries,
): EvidenceArtifactPort {
  return new Proxy(evidence, {
    get(target, key) {
      if (key === 'documents') return documents
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

/** Physical inputs remain supported only in this native composition facade. */
export function createRequirementMaterializer(
  deps: RequirementMaterializerDeps,
): RequirementMaterializer {
  const content = createLocalEvidenceStagingNamespace(deps.evidence)
  const staging = createLocalEvidenceStagingFactory(content, {
    kind: 'requirement',
    root: deps.stagingRoot,
  })
  const original = deps.source
  const notUsed = (member: string) => (): never => {
    throw new Error(`requirementSource.${member} is not used by this test`)
  }
  const source: SelectedDeps['source'] =
    original === undefined
      ? {
          acquire: notUsed('acquire'),
          publishQuestions: notUsed('publishQuestions'),
          collectAnswers: notUsed('collectAnswers'),
        }
      : {
          acquire(input: Parameters<SelectedDeps['source']['acquire']>[0]) {
            const { staging: reference, ...business } = input
            return original.acquire({ ...business, sinkPath: content.resolve(reference) })
          },
          publishQuestions(input: Parameters<SelectedDeps['source']['publishQuestions']>[0]) {
            const { staging: reference, ...business } = input
            return original.publishQuestions({ ...business, sinkPath: content.resolve(reference) })
          },
          collectAnswers(input: Parameters<SelectedDeps['source']['collectAnswers']>[0]) {
            const { staging: reference, ...business } = input
            return original.collectAnswers({ ...business, sinkPath: content.resolve(reference) })
          },
        }
  const { source: _source, stagingRoot: _root, documents, ...common } = deps
  return createSelectedRequirementMaterializer({
    ...common,
    evidence:
      documents === undefined ? deps.evidence : evidenceWithDocuments(deps.evidence, documents),
    now: () => deps.now(),
    staging,
    documentCommands:
      deps.documentCommands ??
      createFileEvidenceDocumentCommands({
        evidence: deps.evidence,
        stagingRoot: deps.stagingRoot,
      }),
    source,
  })
}

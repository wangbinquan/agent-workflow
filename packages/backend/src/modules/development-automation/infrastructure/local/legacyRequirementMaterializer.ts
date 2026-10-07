import type { EvidenceDocumentCommands } from '../../application/evidenceDocumentCommands'
import type { EvidenceBudget } from '../../domain/evidence'
import type { OperationFailureReceipt } from '../../domain/operationFailure'
import {
  createSelectedRequirementMaterializer,
  type RequirementMaterializer,
  type RequirementMaterializerDeps as SelectedDeps,
} from '../../application/requirementMaterializer'
import { createFileEvidenceDocumentCommands } from './fileEvidenceDocumentCommands'
import {
  createLocalEvidenceStagingNamespace,
  createLocalEvidenceStagingFactory,
} from './evidenceStaging'

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
  const source =
    original === undefined
      ? undefined
      : {
          acquire(input: Parameters<NonNullable<SelectedDeps['source']>['acquire']>[0]) {
            const { staging: reference, ...business } = input
            return original.acquire({ ...business, sinkPath: content.resolve(reference) })
          },
          publishQuestions(
            input: Parameters<NonNullable<SelectedDeps['source']>['publishQuestions']>[0],
          ) {
            const { staging: reference, ...business } = input
            return original.publishQuestions({ ...business, sinkPath: content.resolve(reference) })
          },
          collectAnswers(
            input: Parameters<NonNullable<SelectedDeps['source']>['collectAnswers']>[0],
          ) {
            const { staging: reference, ...business } = input
            return original.collectAnswers({ ...business, sinkPath: content.resolve(reference) })
          },
        }
  const { source: _source, stagingRoot: _root, ...common } = deps
  return createSelectedRequirementMaterializer({
    ...common,
    now: () => deps.now(),
    staging,
    documentCommands:
      deps.documentCommands ??
      createFileEvidenceDocumentCommands({
        evidence: deps.evidence,
        stagingRoot: deps.stagingRoot,
      }),
    ...(source === undefined ? {} : { source }),
  })
}

import type {
  ExecutionContractCheck,
  ExecutionContractImplementation,
  ExecutionContractRef,
} from '../domain/model'

export interface ExecutionContractResourceProjection {
  readonly kind: 'agent' | 'workflow'
  readonly name: string
  readonly available: boolean
  readonly detail: string
  /** Agent declarations are explicit. Workflows are accepted by structural closure. */
  readonly declaredContractRefs: readonly ExecutionContractRef[] | null
}

export interface ExecutionContractFixtureRequest {
  readonly implementation: Extract<ExecutionContractImplementation, { kind: 'program' }>
  readonly inputJson: string
}
export type ExecutionContractFixtureResult =
  | { readonly kind: 'completed'; readonly rawStdout: string }
  | { readonly kind: 'failed'; readonly checks: readonly ExecutionContractCheck[] }

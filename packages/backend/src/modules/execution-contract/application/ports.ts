import type {
  ExecutionContractCheck,
  ExecutionContractGuide,
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

export interface ExecutionContractResourcePort {
  inspect(input: {
    readonly implementation: Extract<
      ExecutionContractImplementation,
      { kind: 'agent' | 'workflow' }
    >
  }): Promise<ExecutionContractResourceProjection | null>
}

export interface ExecutionContractProgramFixturePort {
  validate(input: {
    readonly guide: ExecutionContractGuide
    readonly implementation: Extract<ExecutionContractImplementation, { kind: 'program' }>
  }): Promise<readonly ExecutionContractCheck[]>
}

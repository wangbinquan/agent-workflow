import type { ExecutionContractImplementation } from '../domain/model'
import type {
  ExecutionContractResourceProjection,
  ExecutionContractFixtureRequest,
  ExecutionContractFixtureResult,
} from '../application/ports'

export interface ExecutionContractResourcePort {
  inspect(input: {
    readonly implementation: Extract<
      ExecutionContractImplementation,
      { kind: 'agent' | 'workflow' }
    >
    readonly expectedOutputPort: string
  }): Promise<ExecutionContractResourceProjection | null>
}

export interface ExecutionContractProgramFixturePort {
  run(input: ExecutionContractFixtureRequest): Promise<ExecutionContractFixtureResult>
}

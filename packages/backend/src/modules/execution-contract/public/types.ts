export type {
  ExecutionContractCheck,
  ExecutionContractAgentCandidateReceipt,
  ExecutionContractField,
  ExecutionContractImplementation,
  ExecutionContractRef,
  ExecutionContractRegistration,
  ExecutionContractRuntimeView,
  ExecutionContractValidationReceipt,
} from '../domain/model'

export {
  EXECUTION_CONTRACT_RESULT_PORT,
  EXECUTION_CONTRACT_SCRIPT_INPUT_ENV,
  EXECUTION_CONTRACT_SCRIPT_INPUT_FILE_ENV,
  EXECUTION_CONTRACT_SCRIPT_INPUT_PORT,
  buildExecutionContractAgentPrompt,
  executionContractImplementationSchema,
  executionContractRefKey,
  executionContractRefSchema,
  parseExecutionContractRef,
} from '../domain/model'

import type {
  ExecutionContractAgentCandidateReceipt,
  ExecutionContractImplementation,
  ExecutionContractRef,
  ExecutionContractRuntimeView,
  ExecutionContractValidationReceipt,
} from '../domain/model'

export interface ExecutionContractParticipant {
  list(): readonly ExecutionContractRuntimeView[]
  get(ref: ExecutionContractRef): ExecutionContractRuntimeView
  validateExecutor(input: {
    readonly contractRef: ExecutionContractRef
    readonly implementation: ExecutionContractImplementation
  }): Promise<ExecutionContractValidationReceipt>
  validateAgentCandidates(input: {
    readonly contractRef: ExecutionContractRef
    readonly agentRefs: readonly { readonly id: string; readonly revision: number }[]
  }): Promise<readonly ExecutionContractAgentCandidateReceipt[]>
  validateEnvelope(
    input:
      | {
          readonly direction: 'input'
          readonly contractRef: ExecutionContractRef
          readonly roundRef: string
          readonly executionNonce: string
          readonly envelopeJson: string
        }
      | {
          readonly direction: 'output'
          readonly contractRef: ExecutionContractRef
          readonly roundRef: string
          readonly executionNonce: string
          readonly envelopeJson: string
        },
  ): string
}

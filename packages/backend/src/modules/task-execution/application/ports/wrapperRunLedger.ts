import type { WorkflowDefinition } from '@agent-workflow/shared'
import type {
  OpenWrapperGeneration,
  WrapperExecutionRequest,
  WrapperNodeKind,
  WrapperSettlement,
} from '../../domain/wrapperExecution'
import type { Logger } from './executionKernel'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { NodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import type { TaskExecutionContextRef } from './taskExecutionTopology'
import type { WrapperRunPersistence } from './wrapperRunPersistence'

/** Durable wrapper-row lifecycle. Concrete persistence remains at composition. */
export interface WrapperRunLedgerPort {
  openGeneration<K extends WrapperNodeKind>(
    kind: K,
    request: WrapperExecutionRequest<K>,
  ): Promise<OpenWrapperGeneration<K>>

  settle<K extends WrapperNodeKind>(
    generation: OpenWrapperGeneration<K>,
    settlement: WrapperSettlement,
  ): Promise<void>
}

/** RFC-413 — what the engine's wrapper run ledger (`engine/wrapper/wrapperRunLedger.ts`) runs on. */
export interface WrapperRunLedgerPorts {
  readonly taskId: string
  readonly definition: WorkflowDefinition
  readonly containerOf: Map<string, string>
  readonly execution: TaskExecutionContextRef | undefined
  /** The `scheduler` logger the superseded-finalize line has always written to. */
  readonly log: Logger
  readonly persistence: {
    readonly wrapperRuns: Pick<
      WrapperRunPersistence,
      'findResumable' | 'resolveConsumed' | 'readStatus' | 'clearReuseDisabled'
    >
    readonly nodeRuns: Pick<NodeRunLifecyclePersistence, 'set' | 'mint' | 'transition'>
    readonly nodeExecution: Pick<NodeExecutionPersistence, 'read'>
  }
  /** The consumed-inputs columns a fresh generation is minted with. */
  consumedInputs(record: Readonly<Record<string, string>>): {
    consumedUpstreamRunsJson: string | null
  }
}

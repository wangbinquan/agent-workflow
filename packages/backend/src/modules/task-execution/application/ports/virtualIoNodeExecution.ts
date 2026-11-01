import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { NodeRunLedger, NodeRunIdentityFactory } from './executionKernel'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { readPortRowAtFrame } from '../nodeInputs'
import type { NodeStatusEvents } from './nodeExecutionSupport'

export interface InputNodeExecutionPorts {
  readonly taskId: string
  readonly inputsMap: Readonly<Record<string, string>>
  readonly ledger: Pick<NodeRunLedger, 'mintNodeRun'> & NodeRunIdentityFactory
  readonly status: NodeStatusEvents
}
export interface OutputNodeExecutionPorts {
  readonly taskId: string
  readonly definition: WorkflowDefinition
  readonly containerOf: ReadonlyMap<string, string>
  readonly input: {
    read: NodeExecutionPersistence['read']
    readPortRowAtFrame(
      ...args: Parameters<typeof readPortRowAtFrame> extends [unknown, ...infer Rest] ? Rest : never
    ): ReturnType<typeof readPortRowAtFrame>
    prepareConsumedInputs(record: Record<string, string>): string
    copyPortArchive(archiveJson: string | null): string | null
  }
  readonly ledger: Pick<NodeRunLedger, 'mintNodeRun'> & NodeRunIdentityFactory
  readonly status: NodeStatusEvents
}

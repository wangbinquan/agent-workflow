import type { SystemAgentExecutionReceipt } from '@/modules/task-execution/public/participants'
import type { SystemAgentWorkspaceScope } from '@/modules/runtime-management/public/participants'
import type { AgentMaterialContentReference } from '@/modules/runtime-management/public/participants'
import type { PreparedSystemAgentRunResult } from '@/modules/task-execution/public/participants'
import type { MemoryDistillJobRecord } from './distillReadStore'

export interface MemoryDistillExecutionContext {
  readonly jobId: string
  readonly attemptIndex: number
  readonly roundIndex: number
  readonly original: readonly MemoryDistillJobRecord[]
  readonly scope: SystemAgentWorkspaceScope
  readonly protocol: string
  readonly envelopeNonce: string
  readonly prompt: string
  readonly runtimeBinding?: AgentMaterialContentReference | null
  readonly model?: string | null
  readonly isSandbox?: boolean
  readonly timeoutMs?: number
  readonly systemPrompt?: string
  readonly deadlineAt?: number
}

export interface MemoryDistillExecutionRecord extends MemoryDistillExecutionContext {
  readonly receipt: SystemAgentExecutionReceipt
  readonly state: 'prepared' | 'started' | 'terminal' | 'reaped' | 'closed'
  readonly preparedAt: number
  readonly terminal: Omit<PreparedSystemAgentRunResult, 'executionRecovery'> | null
  readonly settlement: string | null
}

/** Primary recovery facts, independent of the auxiliary conversation sink.
 * Method ACKs require the same durable context and original receipt identity. */
export interface MemoryDistillExecutionJournal {
  prepare(input: {
    readonly context: MemoryDistillExecutionContext
    readonly receipt: SystemAgentExecutionReceipt
    readonly preparedAt: number
  }): Promise<void>
  started(receipt: SystemAgentExecutionReceipt): Promise<void>
  terminal(input: {
    readonly receipt: SystemAgentExecutionReceipt
    readonly result: Omit<PreparedSystemAgentRunResult, 'executionRecovery'>
  }): Promise<void>
  reaped(receipt: SystemAgentExecutionReceipt): Promise<void>
  settlement(input: {
    readonly receipts: readonly SystemAgentExecutionReceipt[]
    readonly settlement: string
  }): Promise<void>
  close(input: {
    readonly receipts: readonly SystemAgentExecutionReceipt[]
    readonly settlement: string
  }): Promise<void>
  listOpen(): Promise<readonly MemoryDistillExecutionRecord[]>
  findByJob(jobId: string): Promise<readonly MemoryDistillExecutionRecord[]>
}

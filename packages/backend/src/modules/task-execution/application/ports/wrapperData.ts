import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { WrapperProgress } from '../../domain/wrapperProgress'

export interface WrapperOutputValue {
  readonly content: string
  readonly kind: string | null
  readonly archiveJson: string | null
  readonly active: boolean
}

export interface WrapperResolvedInputs {
  readonly inputs: Record<string, string>
  readonly consumed: Record<string, string>
}

export type WrapperFanoutAgentResolution =
  | { readonly kind: 'ok'; readonly agent: Agent }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly summary: string; readonly message: string }

export interface WrapperDataPort {
  readonly definition: WorkflowDefinition
  readonly fanoutMaxShardTotal: number

  fanoutAgentKey(node: WorkflowNode): string | null
  resolveFanoutAgent(node: WorkflowNode): Promise<WrapperFanoutAgentResolution>
  consumedProvenanceMatches(priorJson: string, current: Readonly<Record<string, string>>): boolean
  reportDiagnostic(input: {
    readonly level: 'info' | 'warn'
    readonly message: string
    readonly fields?: Readonly<Record<string, unknown>>
  }): void

  persistProgress(runId: string, progress: WrapperProgress): Promise<void>
  readPort(nodeId: string, portName: string, iteration: number): Promise<WrapperOutputValue>
  resolveInputs(nodeId: string, iteration: number): Promise<WrapperResolvedInputs>
  recordConsumed(runId: string, consumed: Readonly<Record<string, string>>): void
  priorFanoutConsumed(
    nodeId: string,
    iteration: number,
    excludeRunId: string,
  ): Promise<string | null>
  outputOf(runId: string, portName: string): Promise<WrapperOutputValue | null>
  upsertOutput(input: {
    readonly runId: string
    readonly portName: string
    readonly content: string
    readonly kind?: string | null
    readonly archiveJson?: string | null
    readonly active?: boolean
  }): Promise<void>
}

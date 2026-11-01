import type { Agent } from '@agent-workflow/shared'

export interface AgentExecutionQueries {
  read(agentId: string): Promise<Agent | null>
  /**
   * RFC-411 — these agents' stored rows in one IN read, with the bulk ('normalized') decoding the workgroup turn
   * snapshot always used; for well-formed rows the result equals `read`'s. Missing ids are absent.
   */
  readMany(agentIds: readonly string[]): Promise<readonly Agent[]>
  existingIds(agentIds: readonly string[]): Promise<readonly string[]>
  portNames(agentIds: readonly string[]): Promise<
    ReadonlyMap<
      string,
      {
        readonly inputs: readonly string[]
        readonly outputs: readonly string[]
      }
    >
  >
}

export interface WorkflowReferenceSummary {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly builtin: boolean
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
}

/** canonical definition 的原始文本参与 scriptRef 摘要；不得先 parse/stringify 改写字节。 */
export interface WorkflowExecutionDocument extends WorkflowReferenceSummary {
  readonly definition: string
}

export interface WorkflowExecutionQueries {
  summaries(ids: readonly string[]): Promise<WorkflowReferenceSummary[]>
  documents(ids: readonly string[], catalogOnly?: boolean): Promise<WorkflowExecutionDocument[]>
  namedDocuments(names: readonly string[]): Promise<WorkflowExecutionDocument[]>
}

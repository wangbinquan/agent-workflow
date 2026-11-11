export interface NodeOutputContent {
  readonly nodeRunId: string
  readonly portName: string
  readonly content: string
  readonly kind: string | null
  readonly archiveJson: string | null
}

/**
 * RFC-485: the node-output reads other contexts use — collaboration through the participant bindings, memory through its
 * assembly input. Offered from `public/types`; {@link NodeOutputQueries} adds the read only task-execution itself uses.
 */
export interface TaskNodeOutputReads {
  readPort(runId: string, portName: string, activeOnly?: boolean): Promise<NodeOutputContent | null>
  listPorts(runId: string): Promise<readonly string[]>
  runsWithOutput(runIds: readonly string[]): Promise<ReadonlySet<string>>
  listActiveContents(runIds: readonly string[]): Promise<readonly NodeOutputContent[]>
}

export interface NodeOutputQueries extends TaskNodeOutputReads {
  listProducedPorts(
    runIds: readonly string[],
  ): Promise<readonly { readonly nodeRunId: string; readonly portName: string }[]>
}

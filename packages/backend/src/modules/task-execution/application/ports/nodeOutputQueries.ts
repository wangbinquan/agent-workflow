export interface NodeOutputContent {
  readonly nodeRunId: string
  readonly portName: string
  readonly content: string
  readonly kind: string | null
  readonly archiveJson: string | null
}

export interface NodeOutputQueries {
  listProducedPorts(
    runIds: readonly string[],
  ): Promise<readonly { readonly nodeRunId: string; readonly portName: string }[]>
  readPort(runId: string, portName: string, activeOnly?: boolean): Promise<NodeOutputContent | null>
  listPorts(runId: string): Promise<readonly string[]>
  runsWithOutput(runIds: readonly string[]): Promise<ReadonlySet<string>>
  listActiveContents(runIds: readonly string[]): Promise<readonly NodeOutputContent[]>
}

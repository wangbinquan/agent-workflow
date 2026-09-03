export interface NodeActivationRunSnapshot {
  readonly id: string
  readonly nodeId: string
  readonly status: string
  readonly iteration: number
  readonly parentNodeRunId: string | null
  /** RFC-354 — the frame (wrapper generation row) the row hangs off. */
  readonly containerRunId: string | null
}

export interface NodeActivationSnapshotReader {
  findRuns(taskId: string, nodeId: string): Promise<readonly NodeActivationRunSnapshot[]>
  /** RFC-354 — one generation row by id, for the frame-chain walk. */
  findRun(nodeRunId: string): Promise<NodeActivationRunSnapshot | null>
  findOutputActivation(nodeRunId: string): Promise<ReadonlyMap<string, boolean>>
}

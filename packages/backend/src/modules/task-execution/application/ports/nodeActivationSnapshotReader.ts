export interface NodeActivationRunSnapshot {
  readonly id: string
  readonly status: string
  readonly iteration: number
  readonly parentNodeRunId: string | null
}

export interface NodeActivationSnapshotReader {
  findRuns(taskId: string, nodeId: string): Promise<readonly NodeActivationRunSnapshot[]>
  findOutputActivation(nodeRunId: string): Promise<ReadonlyMap<string, boolean>>
}

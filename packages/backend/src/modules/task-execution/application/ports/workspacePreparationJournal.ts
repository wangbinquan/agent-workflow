export type WorkspacePreparationState =
  | 'preparing'
  | 'prepared'
  | 'admitted'
  | 'compensating'
  | 'cleaned'
  | 'failed'

export interface WorkspacePreparationRecord {
  readonly id: string
  readonly admissionKey: string
  readonly requestDigest: string
  readonly lane: 'repository-preparation' | 'pre-materialized'
  readonly operationRef: string | null
  readonly artifactJson: string | null
  readonly admittedTaskId: string | null
  readonly state: WorkspacePreparationState
  readonly ownerFence: number
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface WorkspacePreparationJournal {
  read(id: string): Promise<WorkspacePreparationRecord | null>
  forTask(taskId: string): Promise<WorkspacePreparationRecord | null>
  /** Same admission transaction as the Task row; materialization is still pending. */
  bindTask(input: {
    id: string
    expectedVersion: number
    ownerFence: number
    taskId: string
    now: number
  }): Promise<WorkspacePreparationRecord | null>
  /** The caller first validates the real Task owner in this same transaction. */
  adoptOwner(input: {
    id: string
    expectedVersion: number
    previousFence: number
    ownerFence: number
    now: number
  }): Promise<WorkspacePreparationRecord | null>
  replaceOperation(input: {
    id: string
    expectedVersion: number
    ownerFence: number
    previousOperationRef: string
    operationRef: string
    now: number
  }): Promise<WorkspacePreparationRecord | null>
  prepare(
    input: Pick<
      WorkspacePreparationRecord,
      'id' | 'admissionKey' | 'requestDigest' | 'lane' | 'operationRef' | 'ownerFence'
    > & { readonly now: number },
  ): Promise<WorkspacePreparationRecord>
  advance(input: {
    readonly id: string
    readonly expectedVersion: number
    readonly ownerFence: number
    readonly from: WorkspacePreparationState
    readonly to: WorkspacePreparationState
    readonly now: number
    readonly artifactJson?: string
    readonly admittedTaskId?: string
  }): Promise<WorkspacePreparationRecord | null>
}

export type PendingHumanGateContinuation = Readonly<{
  taskId: string
  continuationRef: string
}>

export interface HumanGateContinuationRecoveryQueries {
  listPending(): Promise<readonly PendingHumanGateContinuation[]>
}

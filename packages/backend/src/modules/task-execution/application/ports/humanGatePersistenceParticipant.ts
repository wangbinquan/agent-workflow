/** 人工门场景的执行域写入；调用方绑定既有事务，操作顺序由调用方保留。 */
export interface HumanGatePersistenceParticipantInTx {
  lockTask(taskId: string): Promise<void>
  completeClarifyRun(runId: string, now: number): Promise<void>
  cancelClarifyRun(input: {
    readonly runId: string
    readonly now: number
    readonly cause: string
  }): Promise<boolean>
  cancelTaskGateRuns(input: {
    readonly taskId: string
    readonly now: number
    readonly cause: string
  }): Promise<{ nodeRunId: string; nodeId: string }[]>
  writeReviewOutput(input: {
    readonly nodeRunId: string
    readonly portName: string
    readonly content: string
    readonly kind?: string | null
    readonly archiveJson?: string | null
  }): Promise<void>
  transferTaskOwner(taskId: string, ownerUserId: string | null): Promise<void>
  appendTextEvent(input: {
    readonly nodeRunId: string
    readonly ts: number
    readonly payload: string
  }): Promise<void>
}

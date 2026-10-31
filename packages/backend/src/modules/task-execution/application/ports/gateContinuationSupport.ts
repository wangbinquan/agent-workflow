export interface TaskClarifyContinuationPort {
  finish(request: {
    readonly operationId: string
    readonly expectedTaskId: string
    readonly expectedOriginNodeRunId: string
    readonly expectedContinuationRef: string
  }): Promise<void>
}

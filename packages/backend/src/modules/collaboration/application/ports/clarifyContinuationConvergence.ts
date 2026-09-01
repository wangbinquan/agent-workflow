export interface ClarifyContinuationConvergenceRequest {
  readonly operationId: string
  readonly expectedTaskId: string
  readonly expectedOriginNodeRunId: string
  readonly expectedContinuationRef: string
}

/** Collaboration-owned command that converges an already committed clarify
 * decision. Implementations may enqueue memory work, but callers never receive
 * a database handle or transaction callback. */
export interface ClarifyContinuationConvergence {
  finish(request: ClarifyContinuationConvergenceRequest): Promise<void>
}

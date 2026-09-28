export class ObservationInvocationError extends Error {
  constructor(
    readonly code:
      | 'invalid-invocation'
      | 'invocation-conflict'
      | 'execution-already-mapped'
      | 'invocation-not-found',
    message: string,
  ) {
    super(message)
    this.name = 'ObservationInvocationError'
  }
}

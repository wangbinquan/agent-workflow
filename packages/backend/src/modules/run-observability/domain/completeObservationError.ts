export class CompleteObservationError extends Error {
  constructor(
    readonly code: 'not-found' | 'not-ready' | 'scope-changed' | 'generation-changed',
    message: string,
  ) {
    super(message)
    this.name = 'CompleteObservationError'
  }
}

export class ObservationIngestError extends Error {
  constructor(
    readonly code: 'invalid-batch' | 'cursor-conflict' | 'event-conflict' | 'revision-conflict',
    message: string,
  ) {
    super(message)
    this.name = 'ObservationIngestError'
  }
}

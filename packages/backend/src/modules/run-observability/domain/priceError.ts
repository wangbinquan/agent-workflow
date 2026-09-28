export class ObservationPriceError extends Error {
  constructor(
    readonly code:
      | 'invalid-price'
      | 'runtime-not-found'
      | 'runtime-changed'
      | 'price-conflict'
      | 'request-conflict'
      | 'activation-conflict',
    message: string,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message)
    this.name = 'ObservationPriceError'
  }
}

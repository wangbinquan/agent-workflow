// RFC-294 transaction boundary contract. Business modules receive only this
// live, opaque scope; the SQLite handle remains inside persistence adapters.

declare const transactionScopeBrand: unique symbol

export interface TransactionScope {
  readonly [transactionScopeBrand]: 'live-transaction-scope'
  readonly transactionId: string
}

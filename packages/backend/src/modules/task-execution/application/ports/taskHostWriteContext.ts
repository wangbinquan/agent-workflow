declare const taskHostWriteReceiptBrand: unique symbol
declare const taskHostWriteTransactionBrand: unique symbol

export interface TaskHostWriteReceipt {
  readonly [taskHostWriteReceiptBrand]: true
}

/** Task infrastructure owns the original transaction; no query surface escapes. */
export interface TaskHostWriteTransaction {
  readonly [taskHostWriteTransactionBrand]: true
}

export interface TaskHostWriteContext {
  capture(input: { readonly generation: string; readonly reference: object }): TaskHostWriteReceipt
  consumeNewWork(tx: TaskHostWriteTransaction, receipt: TaskHostWriteReceipt): Promise<void>
  consumeRecovery(tx: TaskHostWriteTransaction, receipt: TaskHostWriteReceipt): Promise<void>
  consumeIssuedAck(tx: TaskHostWriteTransaction, receipt: TaskHostWriteReceipt): Promise<void>
}

import type {
  HostExecutionAuthorityReference,
  HostExecutionGrantContext,
} from './hostExecutionAuthority'

declare const hostExecutionWriteReceiptBrand: unique symbol

/** The original SO binding owns this identity; consumers cannot reconstruct it. */
export interface HostExecutionWriteReceipt {
  readonly [hostExecutionWriteReceiptBrand]: true
}

export interface HostExecutionWriteContext {
  prepare(input: {
    readonly context: HostExecutionGrantContext
    readonly holder: string
    readonly expiresAt: number
  }): Promise<HostExecutionWriteReceipt>
  forGrant(input: {
    readonly generation: string
    readonly reference: HostExecutionAuthorityReference
  }): HostExecutionWriteReceipt | undefined
  activate(receipt: HostExecutionWriteReceipt): Promise<void>
  renew(receipt: HostExecutionWriteReceipt, expiresAt: number): Promise<void>
  drain(receipt: HostExecutionWriteReceipt): Promise<void>
  /** Call only after the original admitted transactions and issued ACKs settle. */
  retire(receipt: HostExecutionWriteReceipt): Promise<void>
}

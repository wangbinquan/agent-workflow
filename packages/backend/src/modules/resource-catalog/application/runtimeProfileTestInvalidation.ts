import type { RuntimeProfileTestInvalidationInTx } from '../public/participants'

const participants = new WeakSet<object>()

/** The Resource Catalog owner creates the only invalidation participant. */
export function createRuntimeProfileTestInvalidationInTx<Transaction>(writes: {
  invalidate(
    transaction: Transaction,
    input: Parameters<RuntimeProfileTestInvalidationInTx<Transaction>['invalidate']>[1],
  ): Promise<void>
}): RuntimeProfileTestInvalidationInTx<Transaction> {
  const participant = Object.freeze({
    invalidate(
      transaction: Transaction,
      input: Parameters<RuntimeProfileTestInvalidationInTx<Transaction>['invalidate']>[1],
    ) {
      if (!participants.has(this)) throw new Error('runtime-profile-test-invalidation-not-bound')
      return writes.invalidate(transaction, input)
    },
  }) as RuntimeProfileTestInvalidationInTx<Transaction>
  participants.add(participant)
  return participant
}

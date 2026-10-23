export type AtomicApplyReplayOutcome =
  | { readonly kind: 'committed'; readonly receiptJson: string }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unsettled' }

export function atomicApplyReplayOutcomeOf(row: {
  readonly state: string
  readonly receiptJson: string | null
}): AtomicApplyReplayOutcome {
  if (row.state === 'committed' && row.receiptJson !== null) {
    return { kind: 'committed', receiptJson: row.receiptJson }
  }
  return { kind: row.state === 'failed' ? 'failed' : 'unsettled' }
}

export function resolveAtomicApplyReplay<
  Row extends { readonly state: string; readonly receiptJson: string | null },
  Receipt,
>(
  row: Row,
  input: {
    decode(json: string): Receipt
    failedReplay(row: Row): Error
    unsettledReplay(row: Row): Error
  },
): Receipt {
  const outcome = atomicApplyReplayOutcomeOf(row)
  if (outcome.kind === 'committed') return input.decode(outcome.receiptJson)
  throw outcome.kind === 'failed' ? input.failedReplay(row) : input.unsettledReplay(row)
}

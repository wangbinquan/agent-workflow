/** Epoch-2 sequence is mandatory, including converted history. */
export function requireRunSequence(row: {
  readonly id: string
  readonly seq: number | null
}): number {
  if (row.seq === null || !Number.isSafeInteger(row.seq))
    throw new Error(`run-sequence-required:${row.id}`)
  return row.seq
}

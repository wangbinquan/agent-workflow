/** Epoch-2 sequence is mandatory, including converted history; reject a projection that lost it. */
export function requireRunSequence(row: { readonly id: string; readonly seq: number }): number {
  if (!Number.isSafeInteger(row.seq)) throw new Error(`run-sequence-required:${row.id}`)
  return row.seq
}

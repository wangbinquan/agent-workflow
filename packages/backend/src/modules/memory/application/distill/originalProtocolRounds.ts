import type { MemoryDistillExecutionRecord } from '../ports/distillExecutionJournal'

/** Retired pre-activation helpers retain their receipts for settlement, but
 * have consumed no model round. Only a new active owner may issue that round. */
export function originalProtocolRounds(
  records: readonly MemoryDistillExecutionRecord[],
): readonly MemoryDistillExecutionRecord[] | null {
  const rounds = new Map<number, MemoryDistillExecutionRecord>()
  for (const row of records) {
    if (
      row.receipt.startedAt === null &&
      row.terminal === null &&
      (row.state === 'reaped' || row.state === 'closed')
    )
      continue
    if (rounds.has(row.roundIndex)) return null
    rounds.set(row.roundIndex, row)
  }
  const ordered = [...rounds.values()].sort((a, b) => a.roundIndex - b.roundIndex)
  return ordered.some((row, index) => row.roundIndex !== index) ? null : ordered
}

/** Derived continuations bind original position to its report snapshot and source parent. */
export function completeSourceCursor(
  snapshotId: string,
  source: string,
  parent: string,
  position: string,
): string {
  if (!snapshotId || !source || !parent || !position)
    throw new RangeError('Complete source cursor identity is empty')
  return JSON.stringify([1, snapshotId, source, parent, position])
}
export function completeSourcePosition(
  cursor: string | null,
  snapshotId: string,
  source: string,
  parent: string,
): string | undefined {
  if (cursor === null) return undefined
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch {
    throw new RangeError('Invalid complete source cursor')
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== 1 ||
    value[1] !== snapshotId ||
    value[2] !== source ||
    value[3] !== parent ||
    typeof value[4] !== 'string' ||
    !value[4]
  )
    throw new RangeError('Complete source cursor changed snapshot or parent')
  return value[4]
}

/** 目标合同只按 seq 排序；负数合法，NULL/ID 兼容只留在 oracle。 */
export function compareRunSequence(
  a: { readonly seq: number },
  b: { readonly seq: number },
): number {
  if (!Number.isSafeInteger(a.seq) || !Number.isSafeInteger(b.seq))
    throw new Error('run-sequence-required')
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0
}

/** 集合判据；同一个 producer 经多个端口输入不重复计数。 */
export function aggregatorInputsMatch(
  recordedRunIds: readonly string[],
  selectedRunIds: readonly string[],
): boolean {
  const recorded = new Set(recordedRunIds)
  const selected = new Set(selectedRunIds)
  return recorded.size === selected.size && [...recorded].every((id) => selected.has(id))
}

// RFC-395 II-a A3：旧 schema 的 supersession oracle；II-b 供转换器复刻历史。
import { compareLegacyNodeRunMintOrder } from './legacyOrder'

export interface SupersessionRow {
  readonly id: string
  readonly seq: number | null
  readonly nodeId: string
  readonly iteration: number
  readonly containerRunId: string | null
  readonly parentNodeRunId: string | null
  readonly shardKey: string | null
}

const indexes = new WeakMap<readonly SupersessionRow[], ReadonlySet<string>>()

/** Index each immutable task snapshot once, including child rows as newer candidates. */
export function supersededRunIds(rows: readonly SupersessionRow[]): ReadonlySet<string> {
  const cached = indexes.get(rows)
  if (cached !== undefined) return cached
  const newest = new Map<string, SupersessionRow>()
  const key = (row: SupersessionRow, shard: string | null) =>
    JSON.stringify([row.nodeId, row.iteration, row.containerRunId, shard])
  for (const row of rows) {
    const slot = key(row, row.shardKey)
    const prior = newest.get(slot)
    if (prior === undefined || compareLegacyNodeRunMintOrder(row, prior) > 0) newest.set(slot, row)
  }
  const topLevel = new Set<string>()
  for (const row of rows) {
    if (row.parentNodeRunId !== null) continue
    const sameShard = newest.get(key(row, row.shardKey))
    const shardless = newest.get(key(row, null))
    if (
      (sameShard !== undefined && compareLegacyNodeRunMintOrder(sameShard, row) > 0) ||
      (shardless !== undefined && compareLegacyNodeRunMintOrder(shardless, row) > 0)
    )
      topLevel.add(row.id)
  }
  const result = new Set(
    rows
      .filter((row) =>
        row.parentNodeRunId === null ? topLevel.has(row.id) : topLevel.has(row.parentNodeRunId),
      )
      .map((row) => row.id),
  )
  indexes.set(rows, result)
  return result
}

/** rows must declare the complete same-task supersession comparison universe. */
export function isStructurallySuperseded(
  row: SupersessionRow,
  rows: readonly SupersessionRow[],
): boolean {
  return supersededRunIds(rows).has(row.id)
}

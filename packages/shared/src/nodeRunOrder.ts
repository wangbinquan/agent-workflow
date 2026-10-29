// RFC-374: one mint order for every task-local NodeRun consumer.
// RFC-395 D4: every epoch-2 row carries its allocated seq (converted history is backfilled
// once); the legacy NULL-first / ID fallback lives only in the epoch-1 migration oracle.
export interface NodeRunOrderKey {
  readonly id: string
  readonly seq: number
}

export function compareNodeRunMintOrder(a: NodeRunOrderKey, b: NodeRunOrderKey): number {
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0
}

export function isNewerNodeRun<T extends NodeRunOrderKey>(
  candidate: T,
  incumbent: T | undefined,
): boolean {
  return incumbent === undefined || compareNodeRunMintOrder(candidate, incumbent) > 0
}

export function newestNodeRun<T extends NodeRunOrderKey>(rows: readonly T[]): T | undefined {
  let newest: T | undefined
  for (const row of rows) if (isNewerNodeRun(row, newest)) newest = row
  return newest
}

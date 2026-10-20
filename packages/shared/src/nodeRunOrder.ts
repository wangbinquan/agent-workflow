// RFC-374: one mint order for every task-local NodeRun consumer.
export interface NodeRunOrderKey {
  readonly id: string
  readonly seq: number | null
}

/** Legacy NULL rows precede allocated rows. IDs only break legacy/theoretical ties. */
export function compareNodeRunMintOrder(a: NodeRunOrderKey, b: NodeRunOrderKey): number {
  if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq < b.seq ? -1 : 1
  if (a.seq === null && b.seq !== null) return -1
  if (a.seq !== null && b.seq === null) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
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

/** Resolve ID-only lineage anchors before comparing; absent historical anchors retain the ID fallback. */
export function nodeRunOrderAnchor(rows: readonly NodeRunOrderKey[], id: string): NodeRunOrderKey {
  return rows.find((row) => row.id === id) ?? { id, seq: null }
}

// RFC-395 D4: the epoch-1 mint order. Rows minted before RFC-374 have no seq; they precede
// allocated rows and only their IDs order them. Epoch-2 consumers use the shared seq-only
// `compareNodeRunMintOrder`; this fallback exists for the conversion oracle alone.
export interface LegacyNodeRunOrderKey {
  readonly id: string
  readonly seq: number | null
}

/** Legacy NULL rows precede allocated rows. IDs only break legacy/theoretical ties. */
export function compareLegacyNodeRunMintOrder(
  a: LegacyNodeRunOrderKey,
  b: LegacyNodeRunOrderKey,
): number {
  if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq < b.seq ? -1 : 1
  if (a.seq === null && b.seq !== null) return -1
  if (a.seq !== null && b.seq === null) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function isNewerLegacyNodeRun<T extends LegacyNodeRunOrderKey>(
  candidate: T,
  incumbent: T | undefined,
): boolean {
  return incumbent === undefined || compareLegacyNodeRunMintOrder(candidate, incumbent) > 0
}

/** Resolve ID-only lineage anchors before comparing; absent historical anchors retain the ID fallback. */
export function legacyNodeRunOrderAnchor(
  rows: readonly LegacyNodeRunOrderKey[],
  id: string,
): LegacyNodeRunOrderKey {
  return rows.find((row) => row.id === id) ?? { id, seq: null }
}

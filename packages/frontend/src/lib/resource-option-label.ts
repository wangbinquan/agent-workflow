/** Keep duplicate resource names distinguishable without making names identity. */
export function resourceOptionLabel(name: string, owner?: string): string {
  const trimmed = owner?.trim()
  return trimmed ? `${name} · ${trimmed}` : name
}

export interface ResourceOptionRow {
  id: string
  name: string
  owner?: string
}

/** How many trailing id characters identify a row when its label collides. */
export const RESOURCE_OPTION_ID_SUFFIX_LENGTH = 6

/**
 * RFC-264 — second disambiguation layer, added when names stopped being
 * lowercase slugs: two rows can now genuinely LOOK the same in a picker
 * (workflow names may repeat by design, and `resourceOptionLabel`'s owner
 * segment does not help when both belong to the same owner).
 *
 * Only the colliding rows get a suffix, so an ordinary dropdown shows none at
 * all. The suffix is the id's last 6 characters — a ULID's tail sits in its
 * 80-bit random segment, so it separates same-name rows at any realistic list
 * size. Deliberately fixed-width: an adaptive "widen until unique" rule would
 * make the same row render differently depending on what else is in the list.
 *
 * Returns id → label. Rows sharing an id (impossible from the API, cheap to be
 * safe about) resolve to the last one, matching Map semantics.
 */
export function buildResourceOptionLabels(
  rows: readonly ResourceOptionRow[],
): ReadonlyMap<string, string> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const base = resourceOptionLabel(row.name, row.owner)
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  for (const row of rows) {
    const base = resourceOptionLabel(row.name, row.owner)
    out.set(
      row.id,
      (counts.get(base) ?? 0) > 1
        ? `${base} · #${row.id.slice(-RESOURCE_OPTION_ID_SUFFIX_LENGTH)}`
        : base,
    )
  }
  return out
}

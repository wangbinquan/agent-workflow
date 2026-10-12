/** Bound SQL parameters and transfer sizes, never the selected population.
 * Independent identity packets share an original keyset continuation. The
 * merged extra row proves whether that continuation has an actual tail. */
export async function identityPacketPage<T>(input: {
  readonly ids?: readonly string[]
  readonly limit: number
  readonly key: (row: T) => string
  readonly compare?: (a: T, b: T) => number
  readonly read: (ids: readonly string[] | undefined, limit: number) => Promise<readonly T[]>
}): Promise<readonly T[]> {
  if (input.ids === undefined) return input.read(undefined, input.limit + 1)
  const ids = [...new Set(input.ids)],
    rows = new Map<string, T>()
  for (let at = 0; at < ids.length; at += 200) {
    for (const row of await input.read(ids.slice(at, at + 200), input.limit + 1))
      rows.set(input.key(row), row)
  }
  return [...rows.values()]
    .sort(
      input.compare ??
        ((a, b) => (input.key(a) < input.key(b) ? -1 : input.key(a) > input.key(b) ? 1 : 0)),
    )
    .slice(0, input.limit + 1)
}
export async function identityScopePage<T>(input: {
  readonly scope: Readonly<Record<string, readonly string[] | undefined>>
  readonly limit: number
  readonly key: (row: T) => string
  readonly read: (
    scope: Readonly<Record<string, readonly string[]>>,
    limit: number,
  ) => Promise<{ readonly items: readonly T[]; readonly nextCursor: string | null }>
}) {
  const rows = new Map<string, T>()
  for (const [field, raw] of Object.entries(input.scope)) {
    const ids = [...new Set(raw ?? [])]
    for (let at = 0; at < ids.length; at += 200)
      for (const item of (await input.read({ [field]: ids.slice(at, at + 200) }, input.limit + 1))
        .items)
        rows.set(input.key(item), item)
  }
  const ordered = [...rows.values()].sort((a, b) =>
      input.key(a) < input.key(b) ? -1 : input.key(a) > input.key(b) ? 1 : 0,
    ),
    items = ordered.slice(0, input.limit)
  return { items, nextCursor: ordered.length > input.limit ? input.key(items.at(-1)!) : null }
}

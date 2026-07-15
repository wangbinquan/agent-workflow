// RFC-169 (T2) — the split-page left-rail search filter, single-sourced.
//
// Case-insensitive substring match over a card's title, subtitle, OR optional
// visible-facts search text. An empty (or whitespace-only) query returns the
// input array by identity so the caller can skip re-rendering. Pure — the split
// page owns the search box state and passes the query in; this is the
// first-choice assertable surface (unit-tested directly in
// tests/resource-card-filter.test.ts).

export function filterResourceCards<
  T extends { title: string; subtitle?: string; searchText?: string },
>(query: string, items: T[]): T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return items
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      (it.subtitle !== undefined && it.subtitle.toLowerCase().includes(q)) ||
      (it.searchText !== undefined && it.searchText.toLowerCase().includes(q)),
  )
}

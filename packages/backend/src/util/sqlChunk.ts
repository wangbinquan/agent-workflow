// RFC-311 — bounded IN-list execution.
//
// SQLite rejects statements with more than SQLITE_MAX_VARIABLE_NUMBER (32766)
// bound parameters; an unchunked `inArray(col, ids)` over a production-sized id
// set is a hard runtime error, not just slow (the events archiver died exactly
// this way — audit L3-4). Every call site that feeds a caller-sized array into
// `inArray` goes through here.

/** Conservative chunk size: far below the 32766 hard limit, leaving room for
 *  other bound parameters in the same statement. */
export const SQL_IN_CHUNK = 500

/** Run `fn` over `items` in SQL-safe chunks and concatenate the results. */
export async function chunkedAll<T, R>(
  items: readonly T[],
  fn: (chunk: T[]) => Promise<R[]>,
  chunkSize: number = SQL_IN_CHUNK,
): Promise<R[]> {
  if (items.length === 0) return []
  if (items.length <= chunkSize) return fn([...items])
  const out: R[] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(...(await fn(items.slice(i, i + chunkSize))))
  }
  return out
}

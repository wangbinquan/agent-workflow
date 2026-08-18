// RFC-311 — bounded IN-list execution.
//
// SQLite rejects statements past SQLITE_MAX_VARIABLE_NUMBER bound parameters;
// an unchunked `inArray(col, ids)` over a production-sized id set is a hard
// runtime error, not just slow (the events archiver died this way — audit L3-4).
// Every call site that feeds a caller-sized array into `inArray` goes through here.
//
// 关于那个上限的**实测更正**(实现门 P0-1):它随构建而变——bun 1.3.13 打包的
// SQLite 3.51 在 5 万参数下不报错、10 万才抛,而其他构建仍可能是 32766 或 999。
// 所以别把「某个具体数字」写进判据,按最保守构建取一个远低的块大小即可。

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

import type { CompleteWorkingRows, CompleteWorkingPage } from '../ports/completeWorkingRows'

/** A nullable owner continuation is the only population boundary, including derived rows. */
export async function* completeWorkingPages<T>(
  rows: CompleteWorkingRows,
  namespace: string,
  signal?: AbortSignal,
) {
  let after: string | null = null
  for (;;) {
    signal?.throwIfAborted()
    const page: CompleteWorkingPage<T> = await rows.page<T>(namespace, after, 100)
    let previous: string | null = after
    for (const row of page.items) {
      if (!row.key || (previous !== null && row.key <= previous))
        throw new Error('Complete working row order did not advance')
      previous = row.key
    }
    yield page.items
    if (page.nextCursor === null) return
    if (!page.items.length || page.nextCursor !== previous || page.nextCursor === after)
      throw new Error('Complete working cursor did not advance')
    after = page.nextCursor
  }
}
export async function* completeWorkingTraversal<T>(
  rows: CompleteWorkingRows,
  namespace: string,
  signal?: AbortSignal,
) {
  for await (const page of completeWorkingPages<T>(rows, namespace, signal)) yield* page
}

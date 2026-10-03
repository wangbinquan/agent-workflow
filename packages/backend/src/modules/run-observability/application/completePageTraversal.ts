import type {
  CompletePageWorkspace,
  CompleteSourceReader,
  CompleteSourceReceipt,
} from '../ports/completeReport'

/** No task, invocation, record or page total is a reason to stop this traversal. */
export async function consumeCompleteSource<T>(input: {
  readonly source: string
  readonly snapshotId: string
  readonly reader: CompleteSourceReader<T>
  readonly workspace: CompletePageWorkspace<T>
  readonly signal?: AbortSignal
}): Promise<CompleteSourceReceipt> {
  if (!input.source || !input.snapshotId) throw new Error('Complete source identity missing')
  let after: string | null = null
  let rows = 0n
  let pages = 0n
  for (;;) {
    input.signal?.throwIfAborted()
    const page = await input.reader.next(after)
    input.signal?.throwIfAborted()
    if (page.snapshotId !== input.snapshotId) throw new Error('Complete source changed snapshot')
    if (page.nextCursor !== null && (!page.nextCursor || page.nextCursor === after))
      throw new Error('Complete source cursor did not advance')
    if (page.items.length === 0 && page.nextCursor !== null)
      throw new Error('Complete row source returned an empty continuing page')
    if (page.nextCursor !== null) await input.workspace.claimCursor(input.source, page.nextCursor)
    await input.workspace.append(input.source, page.items)
    rows += BigInt(page.items.length)
    pages += 1n
    if (page.nextCursor === null)
      return {
        source: input.source,
        snapshotId: input.snapshotId,
        rows: rows.toString(),
        pages: pages.toString(),
        eof: true,
      }
    after = page.nextCursor
  }
}

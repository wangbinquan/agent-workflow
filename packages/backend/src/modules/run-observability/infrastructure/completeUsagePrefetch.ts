/** Bound transport memory while retaining the original iterator order and affirmative EOF. */
export async function* completeUsagePrefetch<T>(
  records: AsyncIterable<T>,
  prepare: (batch: readonly T[]) => Promise<void>,
  signal?: AbortSignal,
  size: 100 | 500 = 100,
) {
  if (size !== 100 && size !== 500) throw new Error('Complete usage prefetch batch invalid')
  let batch: T[] = []
  for await (const record of records) {
    signal?.throwIfAborted()
    batch.push(record)
    if (batch.length === size) {
      await prepare(batch)
      signal?.throwIfAborted()
      yield* batch
      batch = []
    }
  }
  if (batch.length) {
    await prepare(batch)
    signal?.throwIfAborted()
    yield* batch
  }
}

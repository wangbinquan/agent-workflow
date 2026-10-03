import type { CompleteWorkingPage, CompleteWorkingRows } from '../ports/completeWorkingRows'
import { completeOrdinalKey } from '../domain/completeOrdinal'
interface SortRow<T> {
  readonly record: T
  readonly ordinal: string
}
interface Head<T> {
  readonly iterator: AsyncIterator<SortRow<T>>
  row: SortRow<T>
}
export interface CompleteExternalSort<T> {
  readonly rows: string
  readonly runs: string
  records(): AsyncIterable<T>
}
async function* runRows<T>(
  workspace: CompleteWorkingRows,
  namespace: string,
  signal?: AbortSignal,
): AsyncGenerator<SortRow<T>> {
  let after: string | null = null,
    previous: string | undefined,
    expected = 0n
  for (;;) {
    signal?.throwIfAborted()
    const page: CompleteWorkingPage<SortRow<T>> = await workspace.page<SortRow<T>>(
      namespace,
      after,
      100,
    )
    for (const row of page.items) {
      if (row.key !== completeOrdinalKey(expected++))
        throw new Error('External sort workspace is missing an original row')
      previous = row.key
      yield row.document
    }
    if (page.nextCursor === null) return
    if (!page.items.length || page.nextCursor !== previous || page.nextCursor === after)
      throw new Error('External sort workspace cursor did not advance')
    after = page.nextCursor
  }
}
async function* verifiedRecords<T>(
  workspace: CompleteWorkingRows,
  namespace: string,
  claims: string,
  count: bigint,
  compare: (a: SortRow<T>, b: SortRow<T>) => number,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  let seen = 0n,
    previous: SortRow<T> | undefined,
    buffer: Array<{ key: string; document: string }> = []
  try {
    for await (const row of runRows<T>(workspace, namespace, signal)) {
      if (!/^(0|[1-9]\d*)$/.test(row.ordinal) || BigInt(row.ordinal) >= count)
        throw new Error('External sort original ordinal is invalid')
      if (previous && compare(previous, row) > 0)
        throw new Error('External sort original ordering changed')
      buffer.push({ key: completeOrdinalKey(BigInt(row.ordinal)), document: row.ordinal })
      if (buffer.length === 500) {
        await workspace.insert(claims, buffer)
        buffer = []
      }
      seen++
      previous = row
      yield row.record
    }
    if (buffer.length) await workspace.insert(claims, buffer)
    if (seen !== count) throw new Error('External sort original population is incomplete')
  } finally {
    await workspace.clear(claims)
  }
}
function push<T>(
  heap: Head<T>[],
  value: Head<T>,
  compare: (a: SortRow<T>, b: SortRow<T>) => number,
) {
  heap.push(value)
  let i = heap.length - 1
  while (i > 0) {
    const p = Math.floor((i - 1) / 2)
    if (compare(heap[p]!.row, value.row) <= 0) break
    heap[i] = heap[p]!
    i = p
  }
  heap[i] = value
}
function pop<T>(heap: Head<T>[], compare: (a: SortRow<T>, b: SortRow<T>) => number) {
  const first = heap[0]!,
    last = heap.pop()!
  if (!heap.length) return first
  let i = 0
  for (;;) {
    const left = 2 * i + 1
    if (left >= heap.length) break
    const right = left + 1,
      child = right < heap.length && compare(heap[right]!.row, heap[left]!.row) < 0 ? right : left
    if (compare(last.row, heap[child]!.row) <= 0) break
    heap[i] = heap[child]!
    i = child
  }
  heap[i] = last
  return first
}
async function writeRun<T>(
  workspace: CompleteWorkingRows,
  namespace: string,
  rows: readonly SortRow<T>[],
) {
  for (let offset = 0; offset < rows.length; offset += 500)
    await workspace.insert(
      namespace,
      rows
        .slice(offset, offset + 500)
        .map((document, i) => ({ key: completeOrdinalKey(BigInt(offset + i)), document })),
    )
}
async function mergeRuns<T>(
  workspace: CompleteWorkingRows,
  inputs: readonly string[],
  output: string,
  compare: (a: SortRow<T>, b: SortRow<T>) => number,
  signal?: AbortSignal,
) {
  const heap: Head<T>[] = []
  for (const namespace of inputs) {
    const iterator = runRows<T>(workspace, namespace, signal)[Symbol.asyncIterator](),
      next = await iterator.next()
    if (!next.done) push(heap, { iterator, row: next.value }, compare)
  }
  let ordinal = 0n,
    buffer: Array<{ key: string; document: SortRow<T> }> = []
  while (heap.length) {
    signal?.throwIfAborted()
    const head = pop(heap, compare)
    buffer.push({ key: completeOrdinalKey(ordinal++), document: head.row })
    if (buffer.length === 500) {
      await workspace.insert(output, buffer)
      buffer = []
    }
    const next = await head.iterator.next()
    if (!next.done) push(heap, { iterator: head.iterator, row: next.value }, compare)
  }
  if (buffer.length) await workspace.insert(output, buffer)
  for (const namespace of inputs) await workspace.clear(namespace)
}
/** Fixed-memory stable JS ordering with bounded fan-in; no population-size stopping condition. */
export async function completeExternalSort<T>(input: {
  readonly workspace: CompleteWorkingRows
  readonly namespace: string
  readonly records: AsyncIterable<T>
  readonly compare: (a: T, b: T) => number
  readonly batchSize?: number
  readonly fanIn?: number
  readonly signal?: AbortSignal
}): Promise<CompleteExternalSort<T>> {
  const batchSize = input.batchSize ?? 1000,
    fanIn = input.fanIn ?? 16
  if (
    !input.namespace ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    !Number.isInteger(fanIn) ||
    fanIn < 2 ||
    fanIn > 16
  )
    throw new RangeError('External sort working batch is invalid')
  const compare = (a: SortRow<T>, b: SortRow<T>) =>
    input.compare(a.record, b.record) ||
    (BigInt(a.ordinal) < BigInt(b.ordinal) ? -1 : BigInt(a.ordinal) > BigInt(b.ordinal) ? 1 : 0)
  const namespace = (pass: bigint, run: bigint) => `${input.namespace}/pass/${pass}/run/${run}`
  let count = 0n,
    runs = 0n,
    pass = 0n,
    buffer: SortRow<T>[] = []
  for await (const record of input.records) {
    input.signal?.throwIfAborted()
    buffer.push({ record, ordinal: String(count++) })
    if (buffer.length === batchSize) {
      buffer.sort(compare)
      await writeRun(input.workspace, namespace(pass, runs++), buffer)
      buffer = []
    }
  }
  if (buffer.length) {
    buffer.sort(compare)
    await writeRun(input.workspace, namespace(pass, runs++), buffer)
  }
  const originalRuns = runs
  while (runs > 1n) {
    let nextRuns = 0n
    for (let first = 0n; first < runs; first += BigInt(fanIn)) {
      const inputs: string[] = []
      for (let i = first; i < runs && i < first + BigInt(fanIn); i++)
        inputs.push(namespace(pass, i))
      await mergeRuns(
        input.workspace,
        inputs,
        namespace(pass + 1n, nextRuns++),
        compare,
        input.signal,
      )
    }
    pass++
    runs = nextRuns
  }
  let replay = 0n
  return {
    rows: String(count),
    runs: String(originalRuns),
    records: async function* () {
      if (!count) return
      yield* verifiedRecords<T>(
        input.workspace,
        namespace(pass, 0n),
        `${input.namespace}/verified/${replay++}`,
        count,
        compare,
        input.signal,
      )
    },
  }
}

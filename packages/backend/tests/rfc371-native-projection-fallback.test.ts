import { expect, test } from 'bun:test'
import { createHistoricalOpencodeUsagePassFactory } from '../src/modules/runtime-management/infrastructure/opencodeUsagePass'
import {
  consumeProjection,
  instrumentProjectionDatabase,
  originalFields,
  projectionFixture,
  projectionIdentity,
  scalarRootEOF,
  scalarRows,
  type BatchFault,
} from './helpers/rfc371NativeProjectionFixture'

test('failed, missing, duplicated or reordered prefetch keeps every original point and EOF', () => {
  const fixture = projectionFixture(),
    expected = scalarRootEOF(fixture.db),
    expectedIds = scalarRows(fixture.db)
      .filter((row) => row.kind === 'step-finish')
      .map((row) => row.id)
  try {
    for (const batchFault of ['throw', 'missing', 'duplicate', 'reverse'] satisfies BatchFault[]) {
      const instrument = instrumentProjectionDatabase({ batchFault }),
        factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
          pageRows: 1000,
          pageBytes: 1024 * 1024,
          openDatabase: instrument.open,
        })
      try {
        const actual = consumeProjection(factory.open(projectionIdentity(batchFault)))
        expect(actual.eof).toEqual(expected)
        expect(actual.steps.map((step) => step.stepId)).toEqual(expectedIds)
        expect(instrument.counts.batches).toBe(4)
        expect(instrument.counts.points).toBe(603)
      } finally {
        factory.close()
      }
      expect(instrument.counts.closes).toBe(1)
    }
  } finally {
    fixture.close()
  }
})

test('prefetch failure retains an original late point error and exactly its acknowledged prefix', () => {
  const fixture = projectionFixture(),
    instrument = instrumentProjectionDatabase({
      batchFault: 'throw',
      pointFailureId: fixture.id(250),
    }),
    factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
      pageRows: 10,
      pageBytes: 1024 * 1024,
      openDatabase: instrument.open,
    }),
    reader = factory.open(projectionIdentity('late-point'))
  try {
    let cursor = reader.initialCursor,
      failure: unknown
    const acknowledged: ReturnType<typeof reader.next>[] = []
    for (;;) {
      try {
        const page = reader.next(cursor)
        expect(page.eof).toBeNull()
        reader.acknowledge(page.ordinal, page.payloadDigest)
        acknowledged.push(page)
        cursor = page.nextCursor!
      } catch (error) {
        failure = error
        break
      }
    }
    expect((failure as Error).message).toBe('original-point-failure')
    expect(acknowledged).toHaveLength(25)
    expect(acknowledged.at(-1)!.counts).toEqual({ sessions: '1', parts: '249', steps: '83' })
    expect(acknowledged.flatMap((page) => page.steps).map((step) => step.stepId)).toEqual(
      scalarRows(fixture.db)
        .slice(0, 249)
        .filter((row) => row.kind === 'step-finish')
        .map((row) => row.id as string),
    )
    expect(() => reader.next(cursor)).toThrow('snapshot closed')
    expect(instrument.counts.closes).toBe(1)
  } finally {
    factory.close()
    fixture.close()
  }
})

test('late malformed JSON uses the original range prefix and closes without inventing EOF', () => {
  const fixture = projectionFixture(3)
  fixture.db.query('INSERT INTO session VALUES (?,?,?)').run('child', 'root', 1000)
  fixture.db
    .query('INSERT INTO message VALUES (?,?,?)')
    .run(
      'child-message',
      'child',
      JSON.stringify({ role: 'assistant', providerID: 'p', modelID: 'm' }),
    )
  for (const [id, data] of [
    [
      'child-a',
      JSON.stringify({
        type: 'step-finish',
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ],
    ['child-z', '{'],
  ] as const)
    fixture.db
      .query('INSERT INTO part VALUES (?,?,?,?,?)')
      .run(id, 'child', 'child-message', 1234, data)
  const originalPrefix: string[] = []
  let after: string | null = null,
    originalError: unknown
  for (;;) {
    try {
      const row: Record<string, unknown> | null =
        after === null
          ? fixture.db
              .query<
                Record<string, unknown>,
                [string]
              >(originalFields + ' WHERE p.session_id=?1 ORDER BY p.id LIMIT 1')
              .get('child')
          : fixture.db
              .query<
                Record<string, unknown>,
                [string, string]
              >(originalFields + ' WHERE p.session_id=?1 AND p.id>?2 ORDER BY p.id LIMIT 1')
              .get('child', after)
      if (!row) throw new Error('Original malformed fixture did not fail')
      after = row.id as string
      originalPrefix.push(after)
    } catch (error) {
      originalError = error
      break
    }
  }
  const instrument = instrumentProjectionDatabase(),
    factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
      pageRows: 1,
      pageBytes: 1024,
      openDatabase: instrument.open,
    }),
    reader = factory.open(projectionIdentity('malformed'))
  try {
    let cursor = reader.initialCursor,
      failure: unknown
    const prefix: ReturnType<typeof reader.next>[] = []
    for (;;) {
      try {
        const page = reader.next(cursor)
        expect(page.eof).toBeNull()
        reader.acknowledge(page.ordinal, page.payloadDigest)
        prefix.push(page)
        cursor = page.nextCursor!
      } catch (error) {
        failure = error
        break
      }
    }
    expect((originalError as Error).message).toContain('malformed JSON')
    expect((failure as Error).message).toBe((originalError as Error).message)
    expect(prefix.flatMap((page) => page.steps).map((step) => step.stepId)).toEqual([
      fixture.id(1),
      ...originalPrefix,
    ])
    expect(prefix.flatMap((page) => page.sessions).map((session) => session.id)).toEqual([
      'root',
      'child',
    ])
    expect(instrument.projected.every((row) => row.session_id === 'root')).toBe(true)
    expect(instrument.counts.closes).toBe(1)
  } finally {
    factory.close()
    fixture.close()
  }
})

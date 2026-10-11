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
        expect<unknown[]>(actual.steps.map((step) => step.stepId)).toEqual(expectedIds)
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
    expect(instrument.counts.closes).toBe(0)
    factory.close()
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
    expect(instrument.counts.closes).toBe(0)
    factory.close()
    expect(instrument.counts.closes).toBe(1)
  } finally {
    factory.close()
    fixture.close()
  }
})

test('a late original message-cache error retains the full ACK prefix and a fresh pass recovers', () => {
  const fixture = projectionFixture()
  fixture.db.query('INSERT INTO message VALUES (?,?,?)').run(
    'message-late',
    'root',
    JSON.stringify({
      role: 'assistant',
      providerID: 'original-provider',
      modelID: 'original-late-model',
    }),
  )
  for (const n of [249, 250, 251])
    fixture.db.query('UPDATE part SET message_id=? WHERE id=?').run('message-late', fixture.id(n))
  const expectedRows = scalarRows(fixture.db),
    expectedEOF = scalarRootEOF(fixture.db),
    instrument = instrumentProjectionDatabase({ messageCacheFailureId: 'message-late' }),
    factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
      pageRows: 10,
      pageBytes: 1024 * 1024,
      openDatabase: instrument.open,
    }),
    reader = factory.open(projectionIdentity('late-message-cache'))
  try {
    let cursor = reader.initialCursor,
      failure: unknown
    const acknowledged: ReturnType<typeof reader.next>[] = []
    for (;;) {
      try {
        const page = reader.next(cursor)
        expect(page.eof).toBeNull()
        expect(reader.next(cursor)).toEqual(page)
        reader.acknowledge(page.ordinal, page.payloadDigest)
        acknowledged.push(page)
        cursor = page.nextCursor!
      } catch (error) {
        failure = error
        break
      }
    }
    expect((failure as Error).message).toBe('original-message-cache-failure')
    expect(acknowledged).toHaveLength(25)
    expect(acknowledged.at(-1)!.counts).toEqual({ sessions: '1', parts: '249', steps: '83' })
    expect(acknowledged.flatMap((page) => page.steps).map((step) => step.stepId)).toEqual(
      expectedRows
        .slice(0, 249)
        .filter((row) => row.kind === 'step-finish')
        .map((row) => row.id as string),
    )
    expect(() => reader.next(cursor)).toThrow('snapshot closed')
    expect(instrument.counts.messageWriteAttempts).toBe(4)
    expect(instrument.counts.messageWrites).toBe(3)
    expect(instrument.counts.closes).toBe(0)
    const recovered = consumeProjection(factory.open(projectionIdentity('fresh-message-cache')))
    expect(recovered.eof).toEqual(expectedEOF)
    expect(recovered.steps.map((step) => step.stepId)).toEqual(
      expectedRows.filter((row) => row.kind === 'step-finish').map((row) => row.id as string),
    )
    expect(recovered.steps.find((step) => step.stepId === fixture.id(250))!.model?.id).toBe(
      'original-late-model',
    )
    expect(instrument.counts.messageWriteAttempts).toBe(8)
    expect(instrument.counts.messageWrites).toBe(7)
    factory.close()
    expect(instrument.counts.closes).toBe(1)
  } finally {
    factory.close()
    fixture.close()
  }
})

// RFC-371 native-json-qualification: only referenced messages in this session
// may disable prefetch; the independent original SQL remains the data oracle.
test.each(['{', null] as const)(
  'unreferenced and cross-session invalid message %p keeps every projected field and EOF',
  (data) => {
    const fixture = projectionFixture()
    fixture.db.query('INSERT INTO session VALUES (?,?,?)').run('other', null, 2000)
    fixture.db.query('INSERT INTO message VALUES (?,?,?)').run('orphan', 'root', data)
    fixture.db.query('INSERT INTO message VALUES (?,?,?)').run('foreign', 'other', data)
    fixture.db.query('UPDATE part SET message_id=? WHERE id=?').run('foreign', fixture.id(2))
    fixture.db.query('UPDATE part SET message_id=? WHERE id=?').run('missing', fixture.id(5))
    const expectedRows = scalarRows(fixture.db),
      expectedEOF = scalarRootEOF(fixture.db),
      instrument = instrumentProjectionDatabase(),
      factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
        pageRows: 1000,
        pageBytes: 1024 * 1024,
        openDatabase: instrument.open,
      })
    try {
      const actual = consumeProjection(factory.open(projectionIdentity('unreferenced-' + data)))
      expect(actual.eof).toEqual(expectedEOF)
      expect(actual.steps.map((step) => step.stepId)).toEqual(
        expectedRows.filter((row) => row.kind === 'step-finish').map((row) => row.id as string),
      )
      expect(
        instrument.projected.map((row) => {
          const original = { ...row }
          delete original.cache_message
          return original
        }),
      ).toEqual(expectedRows)
      expect(actual.steps[0]!.usage).toEqual({
        input: '9007199254740993123456',
        output: '5',
        cacheRead: '7',
        cacheWrite: '13',
      })
      expect(actual.steps.find((step) => step.stepId === fixture.id(4))!.usage.input).toBeNull()
      expect(instrument.counts.batches).toBe(4)
      expect(instrument.counts.points).toBe(0)
    } finally {
      factory.close()
      fixture.close()
    }
  },
)

test('a referenced SQL NULL message retains the complete original range and token buckets', () => {
  const fixture = projectionFixture()
  fixture.db.query('INSERT INTO message VALUES (?,?,?)').run('null-late', 'root', null)
  fixture.db.query('UPDATE part SET message_id=? WHERE id=?').run('null-late', fixture.id(250))
  const expectedRows = scalarRows(fixture.db),
    expectedEOF = scalarRootEOF(fixture.db),
    instrument = instrumentProjectionDatabase(),
    factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
      pageRows: 1000,
      pageBytes: 1024 * 1024,
      openDatabase: instrument.open,
    })
  try {
    const actual = consumeProjection(factory.open(projectionIdentity('referenced-null')))
    expect(actual.eof).toEqual(expectedEOF)
    expect(actual.steps.map((step) => step.stepId)).toEqual(
      expectedRows.filter((row) => row.kind === 'step-finish').map((row) => row.id as string),
    )
    expect(actual.steps.find((step) => step.stepId === fixture.id(250))!.model).toBeNull()
    expect(actual.steps.find((step) => step.stepId === fixture.id(250))!.usage).toEqual({
      input: '9007199254740993123456',
      output: '5',
      cacheRead: '7',
      cacheWrite: '13',
    })
    expect(instrument.counts.batches).toBe(0)
    expect(instrument.counts.points).toBe(0)
    expect(instrument.projected).toEqual([])
  } finally {
    factory.close()
    fixture.close()
  }
})

test('a referenced malformed message retains the actual original ACK prefix without EOF', () => {
  const fixture = projectionFixture()
  fixture.db.query('INSERT INTO message VALUES (?,?,?)').run('malformed-late', 'root', '{')
  for (const n of [249, 250, 251])
    fixture.db.query('UPDATE part SET message_id=? WHERE id=?').run('malformed-late', fixture.id(n))
  const originalPrefix: Array<Record<string, unknown>> = []
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
              .get('root')
          : fixture.db
              .query<
                Record<string, unknown>,
                [string, string]
              >(originalFields + ' WHERE p.session_id=?1 AND p.id>?2 ORDER BY p.id LIMIT 1')
              .get('root', after)
      if (!row) throw new Error('Original malformed message did not fail')
      after = row.id as string
      originalPrefix.push(row)
    } catch (error) {
      originalError = error
      break
    }
  }
  const instrument = instrumentProjectionDatabase(),
    factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
      pageRows: 1,
      pageBytes: 1024 * 1024,
      openDatabase: instrument.open,
    }),
    reader = factory.open(projectionIdentity('referenced-malformed'))
  try {
    let cursor = reader.initialCursor,
      failure: unknown
    const acknowledged: ReturnType<typeof reader.next>[] = []
    for (;;) {
      try {
        const page = reader.next(cursor)
        expect(page.eof).toBeNull()
        expect(reader.next(cursor)).toEqual(page)
        reader.acknowledge(page.ordinal, page.payloadDigest)
        acknowledged.push(page)
        cursor = page.nextCursor!
      } catch (error) {
        failure = error
        break
      }
    }
    expect((originalError as Error).message).toContain('malformed JSON')
    expect((failure as Error).message).toBe((originalError as Error).message)
    expect(acknowledged.flatMap((page) => page.steps).map((step) => step.stepId)).toEqual(
      originalPrefix.filter((row) => row.kind === 'step-finish').map((row) => row.id as string),
    )
    expect(acknowledged.at(-1)!.counts.parts).toBe(String(originalPrefix.length))
    expect(acknowledged.flatMap((page) => page.sessions).map((session) => session.id)).toEqual([
      'root',
    ])
    expect(instrument.counts.batches).toBe(0)
    expect(instrument.projected).toEqual([])
    expect(() => reader.next(cursor)).toThrow('snapshot closed')
  } finally {
    factory.close()
    fixture.close()
  }
})

// Message-left comparisons carry the original column collation. Reversing the
// ID comparison misses BAD/bad and wrongly ACKs a before discovering bad b.
test.each(['message', 'part'] as const)(
  '%s NOCASE columns retain the original malformed range error before any Part ACK',
  (collation) => {
    const fixture = projectionFixture(0)
    if (collation === 'message')
      fixture.db.exec(`ALTER TABLE message RENAME TO original_message;
    CREATE TABLE message(id TEXT COLLATE NOCASE PRIMARY KEY,session_id TEXT COLLATE NOCASE,data TEXT);
    INSERT INTO message SELECT * FROM original_message;
    DROP TABLE original_message;`)
    else
      fixture.db.exec(`ALTER TABLE part RENAME TO original_part;
    DROP INDEX part_session;
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT COLLATE NOCASE,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id);
    DROP TABLE original_part;`)
    fixture.db.query('INSERT INTO message VALUES (?,?,?)').run('BAD', 'ROOT', '{')
    fixture.db.query('INSERT INTO message VALUES (?,?,?)').run(
      'GOOD',
      'ROOT',
      JSON.stringify({
        role: 'assistant',
        providerID: 'original-provider',
        modelID: 'original-model',
      }),
    )
    const data = JSON.stringify({
      type: 'step-finish',
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 4 } },
    })
    const session = collation === 'message' ? 'root' : 'ROOT'
    fixture.db
      .query('INSERT INTO part VALUES (?,?,?,?,?)')
      .run('b', session, collation === 'message' ? 'bad' : 'BAD', 1001, data)
    fixture.db.query('INSERT INTO part VALUES (?,?,?,?,?)').run('a', session, 'GOOD', 1002, data)
    const originalPrefix: Array<Record<string, unknown>> = []
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
                .get('root')
            : fixture.db
                .query<
                  Record<string, unknown>,
                  [string, string]
                >(originalFields + ' WHERE p.session_id=?1 AND p.id>?2 ORDER BY p.id LIMIT 1')
                .get('root', after)
        if (!row) throw new Error('Original NOCASE malformed message did not fail')
        after = row.id as string
        originalPrefix.push(row)
      } catch (error) {
        originalError = error
        break
      }
    }
    const instrument = instrumentProjectionDatabase(),
      factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
        pageRows: 1,
        pageBytes: 1024 * 1024,
        openDatabase: instrument.open,
      }),
      reader = factory.open(projectionIdentity('nocase-original-error-prefix-' + collation))
    try {
      let cursor = reader.initialCursor,
        failure: unknown
      const acknowledged: ReturnType<typeof reader.next>[] = []
      for (;;) {
        try {
          const page = reader.next(cursor)
          expect(page.eof).toBeNull()
          expect(reader.next(cursor)).toEqual(page)
          reader.acknowledge(page.ordinal, page.payloadDigest)
          acknowledged.push(page)
          cursor = page.nextCursor!
        } catch (error) {
          failure = error
          break
        }
      }
      expect((originalError as Error).message).toContain('malformed JSON')
      expect(originalPrefix).toEqual([])
      expect((failure as Error).message).toBe((originalError as Error).message)
      expect(acknowledged.flatMap((page) => page.steps).map((step) => step.stepId)).toEqual(
        originalPrefix.map((row) => row.id as string),
      )
      expect(acknowledged.at(-1)!.counts.parts).toBe(String(originalPrefix.length))
      expect(acknowledged.flatMap((page) => page.sessions).map((session) => session.id)).toEqual([
        'root',
      ])
      expect(instrument.counts.batches).toBe(0)
      expect(instrument.projected).toEqual([])
      expect(() => reader.next(cursor)).toThrow('snapshot closed')
    } finally {
      factory.close()
      fixture.close()
    }
  },
)

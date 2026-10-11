// RFC-371: persist the actual native Part position before a packet is frozen or a session ends.
// The independent original scalar SQL and real TEMP rows detect skipped/repeated Parts.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { ReadonlySqliteDatabase } from '../src/platform/persistence/sqlite/readonlySqliteDatabase'
import { createHistoricalOpencodeUsagePassFactory } from '../src/modules/runtime-management/infrastructure/opencodeUsagePass'
import {
  consumeProjection,
  instrumentProjectionDatabase,
  projectionFixture,
  projectionIdentity,
  scalarRootEOF,
  scalarRows,
} from './helpers/rfc371NativeProjectionFixture'

function cursorObservation(failOnWrite?: number) {
  const instrument = instrumentProjectionDatabase(),
    writes: Array<{ id: string; after: string }> = []
  let original: ReadonlySqliteDatabase | undefined,
    attempts = 0
  return {
    writes,
    instrument,
    rows() {
      return original!
        .query<
          { id: string; part_after: string | null },
          []
        >('SELECT id,part_after FROM temp.native_pass_queue ORDER BY id')
        .all()
    },
    open(path: string): ReadonlySqliteDatabase {
      original = instrument.open(path)
      const db = original
      return {
        query<Row, Parameters extends readonly unknown[]>(sql: string) {
          const statement = db.query<Row, Parameters>(sql)
          return {
            get(...parameters: Parameters) {
              const cursorWrite =
                sql === 'UPDATE temp.native_pass_queue SET part_after=? WHERE id=?'
              if (cursorWrite && ++attempts === failOnWrite)
                throw new Error('actual-cursor-write-unavailable')
              const result = statement.get(...parameters)
              if (cursorWrite)
                writes.push({ id: String(parameters[1]), after: String(parameters[0]) })
              return result
            },
            all: (...parameters: Parameters) => statement.all(...parameters),
          }
        },
        close: () => db.close(),
      }
    },
  }
}

test('real TEMP cursor packets preserve every original Part, child discovery, byte retry and EOF', () => {
  const fixture = projectionFixture()
  fixture.db.query('INSERT INTO session VALUES (?,?,?)').run('child', 'root', 1000)
  fixture.db
    .query('INSERT INTO message VALUES (?,?,?)')
    .run(
      'child-message',
      'child',
      JSON.stringify({ role: 'assistant', providerID: 'child-provider', modelID: 'child-model' }),
    )
  for (let n = 0; n < 6; n++)
    fixture.db.query('INSERT INTO part VALUES (?,?,?,?,?)').run(
      'child-part-' + n,
      'child',
      'child-message',
      1234 + n,
      JSON.stringify({
        type: ['step-start', 'step-finish', 'text'][n % 3],
        tokens: { input: '11', output: 3, reasoning: 2, cache: { read: 7, write: 13 } },
      }),
    )
  const rootRows = scalarRows(fixture.db),
    childRows = scalarRows(fixture.db, 'child'),
    originalBySession = new Map([
      ['root', rootRows],
      ['child', childRows],
    ]),
    hash = createHash('sha256')
  hash.update(
    JSON.stringify([
      'root',
      fixture.db.query('SELECT id,parent_id,time_created FROM session WHERE id=?').get('root'),
    ]),
  )
  hash.update(JSON.stringify(['session', { id: 'root', parentSessionId: null }]))
  for (const row of rootRows) hash.update(JSON.stringify(['part', row]))
  hash.update(
    JSON.stringify([
      'child',
      fixture.db.query('SELECT id,parent_id FROM session WHERE id=?').get('child'),
    ]),
  )
  hash.update(JSON.stringify(['session', { id: 'child', parentSessionId: 'root' }]))
  for (const row of childRows) hash.update(JSON.stringify(['part', row]))
  const expectedEOF = {
    fingerprint: hash.digest('hex'),
    counts: { sessions: '2', parts: '609', steps: '203' },
  }
  try {
    for (const [pageRows, pageBytes] of [
      [1000, 1024 * 1024],
      [200, 1024],
      [7, 1024],
    ] as const) {
      const trace = cursorObservation(),
        factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
          pageRows,
          pageBytes,
          openDatabase: trace.open,
        }),
        reader = factory.open(projectionIdentity('cursor-' + pageRows))
      try {
        let cursor: string | null = reader.initialCursor
        const pages: ReturnType<typeof reader.next>[] = []
        while (cursor !== null) {
          const page = reader.next(cursor),
            writes = trace.writes.length
          expect(reader.next(cursor)).toEqual(page)
          expect(trace.writes).toHaveLength(writes)
          if (page.nextCursor !== null)
            expect(() => reader.next(page.nextCursor!)).toThrow('awaits original owner ACK')
          expect(trace.writes).toHaveLength(writes)
          let persisted = 0
          for (const row of trace.rows()) {
            if (row.part_after === null) continue
            const position = originalBySession
              .get(row.id)!
              .findIndex((original) => original.id === row.part_after)
            expect(position).toBeGreaterThanOrEqual(0)
            persisted += position + 1
          }
          expect(String(persisted)).toBe(page.counts.parts)
          pages.push(page)
          reader.acknowledge(page.ordinal, page.payloadDigest)
          cursor = page.nextCursor
        }
        expect(pages.at(-1)!.eof).toEqual(expectedEOF)
        expect(pages.flatMap((page) => page.sessions)).toEqual([
          { id: 'root', parentSessionId: null },
          { id: 'child', parentSessionId: 'root' },
        ])
        expect(pages.flatMap((page) => page.steps).map((step) => step.stepId)).toEqual(
          [...rootRows, ...childRows]
            .filter((row) => row.kind === 'step-finish')
            .map((row) => row.id as string),
        )
        expect(trace.writes.length).toBeLessThan(609)
        expect(trace.writes.length).toBeLessThanOrEqual(pages.length + 2)
      } finally {
        factory.close()
      }
      expect(trace.instrument.counts.closes).toBe(1)
    }
  } finally {
    fixture.close()
  }
})

test('closing a partial cursor packet rolls back the original snapshot before physical reuse', () => {
  const fixture = projectionFixture(),
    expected = scalarRootEOF(fixture.db),
    trace = cursorObservation(),
    factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
      pageRows: 7,
      pageBytes: 1024,
      openDatabase: trace.open,
    })
  try {
    const first = factory.open(projectionIdentity('interrupted-cursor')),
      packet = first.next(first.initialCursor)
    expect(packet.eof).toBeNull()
    expect(packet.counts).toEqual({ sessions: '1', parts: '6', steps: '2' })
    expect(trace.rows()).toEqual([{ id: 'root', part_after: fixture.id(5) }])
    first.close()
    expect(() => first.acknowledge(packet.ordinal, packet.payloadDigest)).toThrow('ACK')
    const actual = consumeProjection(factory.open(projectionIdentity('new-original-cursor')))
    expect(actual.eof).toEqual(expected)
    expect(actual.steps).toHaveLength(201)
    expect(actual.steps[0]!.stepId).toBe(fixture.id(1))
    expect(trace.instrument.counts.closes).toBe(0)
    factory.close()
    expect(trace.instrument.counts.closes).toBe(1)
  } finally {
    factory.close()
    fixture.close()
  }
})

test('an actual cursor write error keeps only the acknowledged packet and never fabricates EOF', () => {
  const fixture = projectionFixture(),
    trace = cursorObservation(2),
    factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
      pageRows: 7,
      pageBytes: 1024,
      openDatabase: trace.open,
    }),
    reader = factory.open(projectionIdentity('failed-cursor'))
  try {
    const first = reader.next(reader.initialCursor)
    expect(first.eof).toBeNull()
    expect(first.counts).toEqual({ sessions: '1', parts: '6', steps: '2' })
    reader.acknowledge(first.ordinal, first.payloadDigest)
    expect(() => reader.next(first.nextCursor!)).toThrow('actual-cursor-write-unavailable')
    expect(() => reader.next(first.nextCursor!)).toThrow('snapshot closed')
    expect(first.steps.map((step) => step.stepId)).toEqual([fixture.id(1), fixture.id(4)])
    expect(trace.writes).toHaveLength(1)
    const actual = consumeProjection(factory.open(projectionIdentity('after-cursor-error')))
    expect(actual.eof).toEqual(scalarRootEOF(fixture.db))
    expect(actual.steps).toHaveLength(201)
    factory.close()
    expect(trace.instrument.counts.closes).toBe(1)
  } finally {
    factory.close()
    fixture.close()
  }
})

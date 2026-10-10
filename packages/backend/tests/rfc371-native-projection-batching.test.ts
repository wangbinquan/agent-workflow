import { expect, test } from 'bun:test'
import { createHistoricalOpencodeUsagePassFactory } from '../src/modules/runtime-management/infrastructure/opencodeUsagePass'
import type { HistoricalNativePassReader } from '../src/modules/runtime-management/application/ports/historicalNativeUsage'
import {
  instrumentProjectionDatabase,
  projectionFixture,
  projectionIdentity,
  scalarRootEOF,
  scalarRows,
} from './helpers/rfc371NativeProjectionFixture'

test('original scalar fields, order and EOF survive >200 parts and byte-budget retries', () => {
  const fixture = projectionFixture(),
    expectedRows = scalarRows(fixture.db),
    expectedEOF = scalarRootEOF(fixture.db),
    rowsById = new Map(expectedRows.map((row) => [row.id, row]))
  try {
    for (const [pageRows, pageBytes] of [
      [1000, 1024 * 1024],
      [200, 1024],
      [7, 1024],
    ] as const) {
      const instrument = instrumentProjectionDatabase(),
        factory = createHistoricalOpencodeUsagePassFactory(fixture.path, {
          pageRows,
          pageBytes,
          openDatabase: instrument.open,
        }),
        reader = factory.open(projectionIdentity('original-' + pageRows))
      try {
        const initial = reader.next(reader.initialCursor)
        expect(reader.next(reader.initialCursor)).toEqual(initial)
        reader.acknowledge(initial.ordinal, initial.payloadDigest)
        const tail = initial.nextCursor === null ? [] : consumeFrom(reader, initial.nextCursor!)
        const pages = [initial, ...tail],
          steps = pages.flatMap((page) => page.steps),
          last = pages.at(-1)!
        expect(last.eof).toEqual(expectedEOF)
        expect(steps.map((step) => step.stepId)).toEqual(
          expectedRows.filter((row) => row.kind === 'step-finish').map((row) => row.id as string),
        )
        expect(steps).toHaveLength(201)
        expect(steps[0]!.usage).toEqual({
          input: '9007199254740993123456',
          output: '5',
          cacheRead: '7',
          cacheWrite: '13',
        })
        expect(steps[1]!.usage.input).toBeNull()
        expect(steps.slice(0, 3).map((step) => step.model?.id ?? null)).toEqual([
          'original-model-0',
          'original-model-1',
          null,
        ])
        expect(last.issues).toEqual(['native-model-unavailable', 'native-token-bucket-unknown'])
        expect(JSON.stringify(pages)).not.toContain('original-body-not-transported')
        expect(JSON.stringify(pages)).not.toContain('cache_message')
        expect(instrument.counts.batches).toBeGreaterThan(1)
        expect(instrument.counts.points).toBe(0)
        expect(instrument.counts.messageWriteAttempts).toBe(3)
        expect(instrument.counts.messageWrites).toBe(3)
        for (const original of instrument.projected) {
          const row = { ...original }
          delete row.cache_message
          expect(JSON.stringify(row)).toBe(JSON.stringify(rowsById.get(row.id)))
        }
        if (pageRows === 1000) expect(instrument.counts.batches).toBe(4)
        else expect(pages.length).toBeGreaterThan(10)
      } finally {
        factory.close()
      }
      expect(instrument.counts.closes).toBe(1)
    }
  } finally {
    fixture.close()
  }
})

function consumeFrom(reader: HistoricalNativePassReader, start: string) {
  let cursor: string | null = start
  const pages: ReturnType<typeof reader.next>[] = []
  while (cursor !== null) {
    const page = reader.next(cursor)
    expect(reader.next(cursor)).toEqual(page)
    pages.push(page)
    reader.acknowledge(page.ordinal, page.payloadDigest)
    cursor = page.nextCursor
  }
  return pages
}

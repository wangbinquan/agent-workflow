// RFC-371: dedicated report caches must preserve every TEMP row and the original live WAL writer.
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { originalSqliteFileReportSnapshot } from '@/platform/persistence/reportSqliteSnapshot'
import type { ReportWorkspace } from '@/platform/persistence/reportWorkspace'

test('report-local disk caches preserve complete TEMP rows, snapshot and writer configuration', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aw-report-cache-')),
    filename = join(folder, 'original.sqlite'),
    original = new Database(filename)
  try {
    original.exec(
      "PRAGMA journal_mode=WAL;PRAGMA main.cache_size=-8192;PRAGMA temp_store=MEMORY;PRAGMA temp.cache_size=-1024;CREATE TABLE report_input(id text PRIMARY KEY,value text);INSERT INTO report_input VALUES('original','before')",
    )
    const writerSettings = () => ({
      main: original.query('PRAGMA main.cache_size').get(),
      temp: original.query('PRAGMA temp.cache_size').get(),
      store: original.query('PRAGMA temp_store').get(),
    })
    const beforeWriterSettings = writerSettings()
    expect(beforeWriterSettings).toEqual({
      main: { cache_size: -8192 },
      temp: { cache_size: -1024 },
      store: { temp_store: 2 },
    })
    const session = originalSqliteFileReportSnapshot({
      filename,
      generationId: 'original-cache-generation',
    })
    const expectedRows = Array.from({ length: 4501 }, (_, index) => ({
      key: `row-${String(index).padStart(4, '0')}`,
      document: {
        input: String(index + 1),
        cacheRead: '3',
        cacheWrite: '4',
        output: '5',
      },
    }))
    let closedWorkspace: ReportWorkspace | undefined
    await session.run(async (snapshot) => {
      closedWorkspace = snapshot.workspace
      expect(
        await snapshot.executor.all(sql`SELECT cache_size FROM pragma_cache_size('main')`),
      ).toEqual([{ cache_size: -65536 }])
      expect(
        await snapshot.executor.all(sql`SELECT cache_size FROM pragma_cache_size('temp')`),
      ).toEqual([{ cache_size: -32768 }])
      expect(await snapshot.executor.all(sql`SELECT temp_store FROM pragma_temp_store`)).toEqual([
        { temp_store: 1 },
      ])
      expect(await snapshot.executor.all(sql`SELECT value FROM report_input`)).toEqual([
        { value: 'before' },
      ])
      original.query('UPDATE report_input SET value=?').run('after')
      expect(writerSettings()).toEqual(beforeWriterSettings)
      for (let offset = 0; offset < expectedRows.length; offset += 500)
        await snapshot.workspace.insert('complete-tokens', expectedRows.slice(offset, offset + 500))
      const actualRows: typeof expectedRows = []
      let cursor: string | null = null
      do {
        const page = await snapshot.workspace.page<(typeof expectedRows)[number]['document']>(
          'complete-tokens',
          cursor,
          137,
        )
        actualRows.push(...page.items)
        expect(page.nextCursor === null || page.nextCursor !== cursor).toBe(true)
        cursor = page.nextCursor
      } while (cursor !== null)
      expect(actualRows).toEqual(expectedRows)
      const buckets = { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n }
      for (const row of actualRows)
        for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
          buckets[bucket] += BigInt(row.document[bucket])
      const count = BigInt(expectedRows.length)
      expect(buckets).toEqual({
        input: (count * (count + 1n)) / 2n,
        cacheRead: count * 3n,
        cacheWrite: count * 4n,
        output: count * 5n,
      })
      expect(await snapshot.executor.all(sql`SELECT value FROM report_input`)).toEqual([
        { value: 'before' },
      ])
    })
    expect(writerSettings()).toEqual(beforeWriterSettings)
    expect(original.query('SELECT value FROM report_input').get()).toEqual({ value: 'after' })
    expect(
      original
        .query("SELECT count(*) AS count FROM sqlite_temp_schema WHERE name='aw_report_workspace'")
        .get(),
    ).toEqual({ count: 0 })
    await expect(closedWorkspace!.get('complete-tokens', expectedRows[0]!.key)).rejects.toThrow(
      'Report snapshot already closed',
    )
    await session.run(async (snapshot) => {
      expect(await snapshot.workspace.page('complete-tokens', null, 137)).toEqual({
        items: [],
        nextCursor: null,
      })
      expect(await snapshot.executor.all(sql`SELECT value FROM report_input`)).toEqual([
        { value: 'after' },
      ])
    })
    expect(writerSettings()).toEqual(beforeWriterSettings)
  } finally {
    original.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

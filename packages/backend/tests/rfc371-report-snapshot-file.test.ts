// RFC-371: real WAL input stays frozen while the original writer continues; no copied dataset.
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { originalSqliteFileReportSnapshot } from '@/platform/persistence/reportSqliteSnapshot'
test.each(['direct', 'dot-path', 'symlink'] as const)(
  'original SQLite WAL %s file reads and TEMP writes are exact and never pin the original writer',
  async (pathKind) => {
    const folder = mkdtempSync(join(tmpdir(), 'aw-report-original-')),
      filename = join(folder, 'original.sqlite'),
      original = new Database(filename)
    try {
      original.exec(
        "PRAGMA journal_mode=WAL;CREATE TABLE report_input(id text PRIMARY KEY,value text);INSERT INTO report_input VALUES('original','before')",
      )
      const nested = join(folder, 'nested'),
        alias = join(folder, 'alias.sqlite')
      mkdirSync(nested)
      if (pathKind === 'symlink') symlinkSync(filename, alias, 'file')
      const session = originalSqliteFileReportSnapshot({
        filename:
          pathKind === 'symlink'
            ? alias
            : pathKind === 'dot-path'
              ? `${nested}/../original.sqlite`
              : original.filename,
        generationId: 'original-generation',
      })
      await session.run(async (snapshot) => {
        expect(await snapshot.executor.all(sql`SELECT value FROM report_input`)).toEqual([
          { value: 'before' },
        ])
        original.query('UPDATE report_input SET value=?').run('after')
        expect(await snapshot.executor.all(sql`SELECT value FROM report_input`)).toEqual([
          { value: 'before' },
        ])
        await snapshot.workspace.insert('temp', [
          { key: 'row', document: { input: '12', cacheRead: '3', cacheWrite: '4', output: '5' } },
        ])
        expect(
          await snapshot.workspace.get<{
            input: string
            cacheRead: string
            cacheWrite: string
            output: string
          }>('temp', 'row'),
        ).toEqual({
          input: '12',
          cacheRead: '3',
          cacheWrite: '4',
          output: '5',
        })
        let rejectedWrite: unknown
        try {
          await snapshot.executor.run(sql`UPDATE report_input SET value='forbidden'`)
        } catch (error) {
          rejectedWrite = error
        }
        expect(rejectedWrite).toBeInstanceOf(Error)
        expect((rejectedWrite as Error).cause).toBeInstanceOf(Error)
        expect(((rejectedWrite as Error).cause as Error).message).toBe(
          'Report input only supports original reads',
        )
      })
      expect(original.query('SELECT value FROM report_input').get()).toEqual({ value: 'after' })
      expect(
        original
          .query(
            "SELECT count(*) AS count FROM sqlite_temp_schema WHERE name='aw_report_workspace'",
          )
          .get(),
      ).toEqual({ count: 0 })
    } finally {
      original.close()
      rmSync(folder, { recursive: true, force: true })
    }
  },
)

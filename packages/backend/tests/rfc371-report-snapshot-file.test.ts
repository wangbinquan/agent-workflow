// RFC-371: real WAL input stays frozen while the original writer continues; no copied dataset.
import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { originalSqliteFileReportSnapshot } from '@/platform/persistence/reportSqliteSnapshot'
import type { OriginalReportSnapshot } from '@/platform/persistence/reportSnapshotTypes'
import type { ReportWorkspace } from '@/platform/persistence/reportWorkspace'
const openOriginalReportDatabase = (filename: string) => new Database(filename)
test.each(['direct', 'dot-path', 'symlink'] as const)(
  'original SQLite WAL %s file reads and TEMP writes are exact and never pin the original writer',
  async (pathKind) => {
    const folder = mkdtempSync(join(tmpdir(), 'aw-report-original-')),
      filename = join(folder, 'original.sqlite'),
      original = openOriginalReportDatabase(filename)
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

test('original report handle reuses workspace SQL after other queries without reusing rows or bindings', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aw-report-statements-')),
    filename = join(folder, 'original.sqlite'),
    original = openOriginalReportDatabase(filename)
  type Trace = { otherReads: Set<string>; preparations: number; executions: number }
  const handles = new Map<Database, Trace>()
  const originalQuery = Database.prototype.query
  const observedQuery = function (this: Database, statement: string) {
    const prepared = Reflect.apply(originalQuery, this, [statement]) as ReturnType<
      Database['query']
    >
    if (this === original) return prepared
    let trace = handles.get(this)
    if (!trace) {
      trace = { otherReads: new Set(), preparations: 0, executions: 0 }
      handles.set(this, trace)
    }
    if (statement.startsWith('SELECT value FROM report_input WHERE'))
      trace.otherReads.add(statement)
    if (!statement.includes('aw_report_workspace')) return prepared
    trace.preparations++
    const observed = trace
    return new Proxy(prepared, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (typeof value !== 'function') return value
        return (...parameters: unknown[]) => {
          if (key === 'all' || key === 'run') observed.executions++
          return Reflect.apply(value, target, parameters)
        }
      },
    })
  } as typeof originalQuery
  let restoreQuery: (() => void) | undefined
  try {
    original.exec(
      "PRAGMA journal_mode=WAL;CREATE TABLE report_input(id text PRIMARY KEY,value text);INSERT INTO report_input VALUES('original','before')",
    )
    const observation = spyOn(Database.prototype, 'query').mockImplementation(observedQuery)
    restoreQuery = () => observation.mockRestore()
    const session = originalSqliteFileReportSnapshot({
      filename,
      generationId: 'original-statement-generation',
    })
    const warmOtherReads = async (snapshot: OriginalReportSnapshot, value: string) => {
      for (let index = 0; index < 25; index++)
        expect(
          await snapshot.executor.all(
            sql.raw(`SELECT value FROM report_input WHERE id='original' AND ${index}=${index}`),
          ),
        ).toEqual([{ value }])
    }
    const round = async (workspace: ReportWorkspace, namespace: string, input: number) => {
      const a = { input: String(input), cacheRead: '3', cacheWrite: '4', output: '5' }
      const b = { input: String(input + 1), cacheRead: '6', cacheWrite: '7', output: '8' }
      const changed = { ...a, input: String(input + 2) }
      await workspace.put(namespace, { key: 'a', document: a })
      await workspace.put(namespace, { key: 'b', document: b })
      expect(await workspace.get<typeof a>(namespace, 'a')).toEqual(a)
      const found = await workspace.getMany(namespace, ['b', 'missing', 'a', 'b'])
      expect([...found.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual([
        ['a', a],
        ['b', b],
      ])
      expect(await workspace.page(namespace, null, 1)).toEqual({
        items: [{ key: 'a', document: a }],
        nextCursor: 'a',
      })
      expect(await workspace.page(namespace, 'a', 1)).toEqual({
        items: [{ key: 'b', document: b }],
        nextCursor: null,
      })
      await workspace.upsert(namespace, [
        { key: 'a', document: changed },
        { key: 'c', document: b },
      ])
      expect(await workspace.get<typeof a>(namespace, 'a')).toEqual(changed)
      await workspace.insert(namespace, [{ key: 'd', document: a }])
      await expect(workspace.insert(namespace, [{ key: 'd', document: b }])).rejects.toThrow()
      await workspace.insert(namespace, [{ key: 'e', document: b }])
      expect([...(await workspace.getMany(namespace, ['d'])).entries()]).toEqual([['d', a]])
      expect(await workspace.page(namespace, null, 137)).toEqual({
        items: [
          { key: 'a', document: changed },
          { key: 'b', document: b },
          { key: 'c', document: b },
          { key: 'd', document: a },
          { key: 'e', document: b },
        ],
        nextCursor: null,
      })
      await workspace.clear(namespace)
      expect(await workspace.get(namespace, 'a')).toBeUndefined()
    }
    let closedWorkspace: ReportWorkspace | undefined
    let firstPreparations = 0
    await session.run(async (snapshot) => {
      closedWorkspace = snapshot.workspace
      await warmOtherReads(snapshot, 'before')
      expect(handles.size).toBe(1)
      const trace = [...handles.values()][0]!
      expect(trace.otherReads.size).toBe(25)
      expect(trace.preparations).toBe(0)
      await round(snapshot.workspace, 'first', 12)
      firstPreparations = trace.preparations
      const firstExecutions = trace.executions
      expect(firstPreparations).toBeGreaterThan(0)
      expect(firstExecutions).toBeGreaterThan(firstPreparations)
      await round(snapshot.workspace, 'second', 42)
      expect(trace.preparations).toBe(firstPreparations)
      expect(trace.executions).toBe(firstExecutions * 2)
    })
    const firstExecutions = [...handles.values()][0]!.executions
    await expect(closedWorkspace!.get('second', 'a')).rejects.toThrow(
      'Report snapshot already closed',
    )
    expect([...handles.values()][0]!.executions).toBe(firstExecutions)
    original.query('UPDATE report_input SET value=?').run('after')
    await session.run(async (snapshot) => {
      await warmOtherReads(snapshot, 'after')
      expect(handles.size).toBe(2)
      const trace = [...handles.values()][1]!
      expect(trace.otherReads.size).toBe(25)
      expect(trace.preparations).toBe(0)
      expect(await snapshot.workspace.get('second', 'a')).toBeUndefined()
      await round(snapshot.workspace, 'third', 72)
      expect(trace.preparations).toBe(firstPreparations)
      expect(trace.executions).toBeGreaterThan(firstPreparations)
    })
  } finally {
    restoreQuery?.()
    original.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

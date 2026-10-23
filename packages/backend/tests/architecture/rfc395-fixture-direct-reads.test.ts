// RFC-395 II-a A1: moved columns are read through model fixtures so II-b changes adapters, not test journeys.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ledger from '../fixtures/rfc395-direct-read-ledger.json'
import { directFixtureReads, e2eFixtureSqlFindings } from '../helpers/model/directReads'

const root = resolve(import.meta.dir, '..')
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : []
  })
}
describe('RFC-395 II-a A1 fixture read boundary', () => {
  test('no moved-column reader outside the ledger and no stale exception', () => {
    const files = sources(root).filter(
      (file) => !relative(root, file).replaceAll('\\', '/').startsWith('helpers/model/'),
    )
    expect(files.length).toBeGreaterThan(2000)
    const readers = Object.fromEntries(
      files
        .map((file) => {
          const path = relative(root, file).replaceAll('\\', '/')
          return [path, directFixtureReads(path, readFileSync(file, 'utf8'))] as const
        })
        .filter(([, findings]) => findings.length),
    )
    expect(Object.keys(readers).sort()).toEqual(Object.keys(ledger.files).sort())
    for (const reason of Object.values(ledger.files))
      expect(ledger.reasonCategories).toHaveProperty(reason)
    // 全量扫描 2000+ 个测试文件：CI 机器上 5–8 s，超过 bun 默认的 5 s 单测上限。
  }, 60_000)
  test('negative controls include moved picks, filters, aliases, repositories and SQL', () => {
    const found = directFixtureReads(
      'negative.ts',
      `
      import { tasks as taskRows } from '@/db/schema'
      const { nodeRuns: runs, taskRepos } = tablesOf(db)
      const alias = taskRows
      const { workflowSnapshot: snapshot } = alias
      db.select({ path: alias.worktreePath }).from(alias).where(eq(alias.workflowId, id))
      db.select().from(taskRepos)
      const row = first(db.select().from(runs))
      row?.runtime
      const byId = new Map((await db.select().from(taskRows)).map((entry) => [entry.id, entry]))
      byId.get(id)?.branch
      async function storedRun() { return first(db.select().from(runs)) }
      expect(await storedRun()).toEqual({})
      function fixture() { async function read() { return first(db.select().from(runs)) }; return { read } }
      const fixtureHandle = fixture()
      const fixtureRow = await fixtureHandle.read()
      fixtureRow.isoNodeTree
      rawRows(db, sql\`SELECT trigger_context_json FROM tasks WHERE id = 1\`)
      db.query('SELECT content FROM node_run_outputs')
    `,
    )
    expect(found.map((finding) => finding.table)).toContain('tasks')
    expect(found.map((finding) => finding.table)).toContain('taskRepos')
    expect(found.map((finding) => finding.table)).toContain('nodeRuns')
    expect(found.map((finding) => finding.table)).toContain('nodeRunOutputs')
    expect(found.some((finding) => finding.column === 'workflowSnapshot')).toBe(true)
    expect(found.some((finding) => finding.column === 'branch')).toBe(true)
    expect(found.some((finding) => finding.column === 'isoNodeTree')).toBe(true)
    expect(found.some((finding) => finding.shape === 'whole-row')).toBe(true)
    expect(
      directFixtureReads(
        'stable.ts',
        `
      const { tasks, nodeRuns, workflows } = tablesOf(db)
      db.select({ id: tasks.id, status: tasks.status }).from(tasks)
      db.select({ id: nodeRuns.id, seq: nodeRuns.seq }).from(nodeRuns)
      db.select().from(workflows)
      db.query('SELECT id, status FROM tasks')
      await readNodeRunFixtures(db, { taskId })
      const ids = (await db.select().from(nodeRuns)).map((row) => row.id)
      expect(ids).toEqual(['run'])
    `,
      ),
    ).toEqual([])
  })
  test('e2e SQL writes and moved-column reads live only in the fixture module', () => {
    const e2eRoot = resolve(root, '../../../e2e')
    const files = sources(e2eRoot).filter((file) => file !== join(e2eRoot, 'fixtures/model.ts'))
    expect(files.length).toBeGreaterThan(100)
    const findings = files.flatMap((file) =>
      e2eFixtureSqlFindings(file, readFileSync(file, 'utf8')).map((finding) => ({
        file: relative(e2eRoot, file),
        ...finding,
      })),
    )
    expect(findings).toEqual([])
    expect(
      e2eFixtureSqlFindings(
        'negative.ts',
        `
      execFileSync('sqlite3', ['db', 'UPDATE TASKS SET status = 1'])
      execSql('DELETE FROM node_runs WHERE id = 1')
      querySqlite('db', 'SELECT pre_snapshot FROM node_runs')
      querySqlite('db', 'SELECT repo_url' + ' FROM tasks')
      execFileSync('python3', ['-c', "db.execute('SELECT repo_url FROM tasks WHERE id = 1')"])
    `,
      ).map((finding) => finding.kind),
    ).toEqual(['write', 'write', 'read', 'read', 'read'])
  })
})

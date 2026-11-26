import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { sql, SQL, StringChunk } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import {
  restorePre615TaskPrefixBindings,
  restorePre615TaskPrefixQuery,
  restorePre615TaskPrefixSource,
  restorePre615TaskPrefixText,
  renumberSqlParameters,
  sqlParameterCount,
} from './helpers/rfc615TaskPrefixOracle'

// Independent miniature before/after fixtures exercise the inverse itself;
// the conformance suites retain their original complete-source digest pins.
const CURRENT = `    root_prefix AS MATERIALIZED (
      -- tasks.id is unique and open_alerts is DISTINCT: each prefix row has
      -- at most one match. Fetch membership and root together, without two
      -- correlated expansions of the same NOT MATERIALIZED match query.
      -- CROSS JOIN keeps SQLite's bounded prefix outermost.
      SELECT p.id, m.rid, p.started_at
      FROM physical_prefix p CROSS JOIN matches m WHERE m.id = p.id
    ),
`
const PREVIOUS = `    root_prefix_lookup AS MATERIALIZED (
      SELECT p.id, p.started_at,
        (SELECT m.id FROM matches m WHERE m.id = p.id) AS matched_id,
        (SELECT m.rid FROM matches m WHERE m.id = p.id) AS rid
      FROM physical_prefix p
    ),
    root_prefix AS MATERIALIZED (
      SELECT p.id, p.rid, p.started_at FROM root_prefix_lookup p
      WHERE p.matched_id IS NOT NULL
    ),
`
const catalog = sql`(select ${TASK_DEFINITION_HOSTS.agent.id} as a,
  ${TASK_DEFINITION_HOSTS.workgroup.id} as b,
  ${TASK_DEFINITION_HOSTS['digital-employee'].id} as c,
  ${TASK_DEFINITION_HOSTS['code-round'].id} as d, ') "t" (''?)' as quoted from tasks) "t"`
const narrow = sql`(select id, started_at from tasks) "t"`
const tail = sql`cursor = ${890} AND id = ${'a ? $9 (quoted)'} AND label = 'after-comment $99' /* keep $77 ? ' */ LIMIT ${3}`

test('SQL binding counts ignore comment apostrophes and quoted placeholder lookalikes', () => {
  expect(
    sqlParameterCount(`-- SQLite's ? $99\n
      SELECT ?, $1, '?' AS literal, "$9" AS identifier /* ' ? $88 */
      , 'after comment '' ? $7' AS escaped
      WHERE id = $2 -- $3
    `),
  ).toBe(3)
  expect(renumberSqlParameters(`-- SQLite's $99\nSELECT $4, '$88', "$77", $8 /* $66 ? ' */`)).toBe(
    `-- SQLite's $99\nSELECT $1, '$88', "$77", $2 /* $66 ? ' */`,
  )
})

function fixture(root: string, projection: SQL): SQL {
  // raw root text belongs to the literal StringChunk, as in the real emitter.
  const before = sql`
    non_view_matches AS NOT MATERIALIZED (
      SELECT t.id
      FROM ${catalog}
    ),
    root_prefix_budget AS MATERIALIZED (SELECT ${3} AS page_rows),
    physical_prefix AS MATERIALIZED (
      SELECT t.id, t.started_at FROM ${projection}
      LIMIT 4 * CAST(${3} AS INTEGER)
    ),
`
  return new SQL([...before.queryChunks, new StringChunk(root), tail])
}

for (const [provider, dialect] of [
  ['sqlite', new SQLiteSyncDialect()],
  ['postgresql', new PgDialect()],
] as const) {
  test(`RFC-615 inverse retains frozen SQL, all bindings and unrelated objects (${provider})`, () => {
    const current = fixture(CURRENT, narrow)
    const previous = dialect.sqlToQuery(fixture(PREVIOUS, catalog))
    const compiled = dialect.sqlToQuery(current)
    const restored = restorePre615TaskPrefixQuery(current)
    expect(restored.queryChunks.at(-1)).toBe(tail)
    expect(current.queryChunks.at(-1)).toBe(tail)
    expect(dialect.sqlToQuery(restored)).toEqual(previous)
    expect(restorePre615TaskPrefixText(compiled.sql)).toBe(previous.sql)
    expect(restorePre615TaskPrefixBindings(compiled.sql, compiled.params)).toEqual(previous.params)
    expect(previous.params.length).toBe(compiled.params.length + 4)
  })

  test(`RFC-615 inverse rejects unexplained bindings and missing or duplicated sites (${provider})`, () => {
    const current = fixture(CURRENT, narrow)
    const compiled = dialect.sqlToQuery(current)
    expect(() => restorePre615TaskPrefixQuery(fixture('', narrow))).toThrow('unique RFC-615')
    expect(() => restorePre615TaskPrefixQuery(fixture(CURRENT + CURRENT, narrow))).toThrow(
      'unique RFC-615',
    )
    expect(() => restorePre615TaskPrefixText(compiled.sql.replace(CURRENT, ''))).toThrow(
      'unique RFC-615',
    )
    expect(() => restorePre615TaskPrefixBindings(compiled.sql, compiled.params.slice(1))).toThrow(
      'incomplete real binding vector',
    )
    const changed = [...compiled.params]
    changed[0] = 'wrong-host'
    expect(() => restorePre615TaskPrefixBindings(compiled.sql, changed)).toThrow(
      'catalog host bindings',
    )
    const extra = dialect.sqlToQuery(fixture(CURRENT, sql`(select ${'unexplained'} as id) "t"`))
    expect(() => restorePre615TaskPrefixBindings(extra.sql, extra.params)).toThrow(
      'narrow prefix projection bindings',
    )
  })
}

test('RFC-615 source inverse removes only the exact three reviewed changes', () => {
  const declaration = `  const columns = taskReadColumns(db)
  const prefixTasks = taskReadSql(db, 't', {
    id: columns.id,
    startedAt: columns.startedAt,
  })
`
  const current = `${declaration}      SELECT t.id, t.started_at FROM \${prefixTasks}\n${CURRENT}`
  const previous = `      SELECT t.id, t.started_at FROM \${taskCatalogReadSql(db, 't')}\n${PREVIOUS}`
  expect(restorePre615TaskPrefixSource(current)).toBe(previous)
  expect(() => restorePre615TaskPrefixSource(current.replace(declaration, ''))).toThrow(
    'unique RFC-615',
  )
  expect(() => restorePre615TaskPrefixSource(declaration + current)).toThrow('unique RFC-615')
})

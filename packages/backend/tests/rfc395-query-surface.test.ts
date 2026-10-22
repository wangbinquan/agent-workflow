// RFC-395 I-b: a Drizzle upgrade must preserve native assignability and neutral result inference.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq, sql } from 'drizzle-orm'
import { drizzle as sqliteDrizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { drizzle as pgDrizzle, type BunSQLDatabase } from 'drizzle-orm/bun-sql'
import { column as c, defineContribution, retention } from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'
import type { NeutralTable } from '@/platform/persistence/schema/neutral'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/querySurface'

const owner = defineContribution('example')
const definition = owner.table({
  id: 'neutral_query_examples',
  schemaSymbol: 'examples',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    createdAt: c.epochMs('created_at'),
    archived: c.bool('archived', { default: false }),
    note: c.text('note', { nullable: true }),
  },
})
const detailDefinition = owner.table({
  id: 'neutral_query_details',
  schemaSymbol: 'details',
  retention: retention.business,
  columns: { id: c.id('id', { primary: true }), exampleId: c.id('example_id') },
})

function nativeConformance(sqlite: BunSQLiteDatabase, pg: BunSQLDatabase) {
  const sqliteDb: PersistenceDb = sqlite
  const pgDb: PersistenceDb = pg
  const sqliteTx: PersistenceTx = sqlite
  const pgTx: PersistenceTx = pg
  return { sqliteDb, pgDb, sqliteTx, pgTx }
}
function queries(
  db: PersistenceDb,
  examples: NeutralTable<typeof definition>,
  details: NeutralTable<typeof detailDefinition>,
) {
  const flat = db
    .select({
      id: examples.id,
      createdAt: examples.createdAt,
      archived: examples.archived,
      note: examples.note,
      detailId: details.id,
    })
    .from(examples)
    .leftJoin(details, eq(details.exampleId, examples.id))
    .where(eq(examples.archived, false))
    .orderBy(examples.createdAt)
    .limit(1)
    .offset(0)
  const nested = db
    .select({ example: examples, detail: details })
    .from(examples)
    .leftJoin(details, eq(details.exampleId, examples.id))
  const all = db.select().from(examples).leftJoin(details, eq(details.exampleId, examples.id))
  const inner = db
    .select({ detailId: details.id })
    .from(examples)
    .innerJoin(details, eq(details.exampleId, examples.id))
  const grouped = db
    .selectDistinct({ id: examples.id, n: sql<number>`count(*)`.as('n') })
    .from(examples)
    .groupBy(examples.id)
    .having(sql`count(*) > 0`)

  const union = db
    .select({ id: examples.id })
    .from(examples)
    .unionAll(db.select({ id: details.id }).from(details))
    .orderBy(sql`1`)
    .limit(2)
  const insert = db
    .insert(examples)
    .values({ id: 'one', createdAt: 1 })
    .onConflictDoNothing({ target: examples.id })
    .returning()
  const upsert = db
    .insert(examples)
    .values([{ id: 'one', createdAt: 1 }])
    .onConflictDoUpdate({ target: examples.id, set: { archived: true } })
    .returning({ id: examples.id })
  const update = db
    .update(examples)
    .set({ archived: true })
    .where(eq(examples.id, 'one'))
    .returning({ note: examples.note })
  const remove = db.delete(examples).where(eq(examples.id, 'one')).returning()
  return { flat, nested, all, inner, grouped, union, insert, upsert, update, remove }
}
type Queries = ReturnType<typeof queries>
type Flat = Awaited<Queries['flat']>[number]
type Nested = Awaited<Queries['nested']>[number]
type All = Awaited<Queries['all']>[number]
type Inner = Awaited<Queries['inner']>[number]
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(value: T) {
  return value
}
const inference = {
  time: assertType<Equal<Flat['createdAt'], number>>(true),
  boolean: assertType<Equal<Flat['archived'], boolean>>(true),
  nullable: assertType<Equal<Flat['note'], string | null>>(true),
  left: assertType<Equal<Flat['detailId'], string | null>>(true),
  inner: assertType<Equal<Inner['detailId'], string>>(true),
  nested: assertType<Equal<Nested['detail'], { id: string; exampleId: string } | null>>(true),
  all: assertType<Equal<All['neutral_query_details'], { id: string; exampleId: string } | null>>(
    true,
  ),
  returning: assertType<Equal<Awaited<Queries['update']>[number]['note'], string | null>>(true),
}

function rejectedQueries(db: PersistenceDb, examples: NeutralTable<typeof definition>) {
  // @ts-expect-error boolean columns do not accept SQLite's driver representation
  db.insert(examples).values({ id: 'one', createdAt: 1, archived: 1 })
  // @ts-expect-error required fields cannot be omitted
  db.insert(examples).values({ id: 'one' })
  // @ts-expect-error update keeps the semantic column type
  db.update(examples).set({ createdAt: 'yesterday' })
  const filtered = db.select().from(examples).where(eq(examples.id, 'one'))
  // @ts-expect-error each where clause is used once, matching native Drizzle
  filtered.where(eq(examples.id, 'two'))
  // @ts-expect-error SQLite-only terminals are absent from the common surface
  filtered.get()
  // @ts-expect-error raw execution belongs to the codec-aware helpers
  db.all(sql`select 1`)
}

describe('RFC-395 I-b native query surface', () => {
  test('native databases implement the interface without casts or wrappers', () => {
    const client = new Database(':memory:')
    try {
      const sqlite = sqliteDrizzle(client)
      const pg = pgDrizzle.mock()
      const common = nativeConformance(sqlite, pg)
      expect(common.sqliteDb).toBe(sqlite)
      expect(common.pgDb).toBe(pg)
      expect(common.sqliteTx).toBe(sqlite)
      expect(common.pgTx).toBe(pg)
      expect(Object.values(inference).every(Boolean)).toBe(true)
      const examples = materializeDrizzle(definition)
      const details = materializeDrizzle(detailDefinition)
      const sqliteQueries = queries(common.sqliteDb, examples.sqlite, details.sqlite)
      const pgQueries = queries(common.pgDb, examples.postgresql, details.postgresql)
      expect(sqliteQueries.flat.toSQL().sql).toContain('left join')
      expect(pgQueries.flat.toSQL().sql).toContain('"agent_workflow".')
      expect(pgQueries.insert.toSQL().sql).toContain('on conflict')
      expect(sqliteQueries.upsert.toSQL().sql).toContain('on conflict')
      expect(pgQueries.union.toSQL().sql).toContain('union all')
    } finally {
      client.close()
    }
  })
  test('negative controls remain compile-only and cannot execute invalid SQL', () => {
    expect(rejectedQueries).toBeFunction()
  })
})

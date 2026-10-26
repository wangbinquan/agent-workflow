import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
// RFC-395 II-b R2: real R1 registry edges, direct head installs and generated PostgreSQL artifacts close review gaps.
import { expect, test, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  column,
  defineContribution,
  foreignKey,
  index,
  retention,
} from '@/platform/persistence/schema/dsl'
import { createSchemaRegistry, type SchemaRegistry } from '@/platform/persistence/schema/registry'
import type { TableDefinition } from '@/platform/persistence/schema/contribution'
import { installTime } from '@/platform/persistence/schema/seeds'
import { compileContract } from '@/platform/persistence/schema/contract'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { deriveSchemaEdge } from '@/platform/persistence/schema/history/edgeDiff'
import { readSchemaHistoryRows } from '@/platform/persistence/schema/history/apply'
import { firstLiveWriteAt } from '@/platform/persistence/schema/history/markers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import {
  HistoryCatalogCache,
  postgresqlCatalogLoader,
  verifyPostgresqlCatalogArtifact,
} from '@/platform/persistence/schema/history/catalog'
import { admitHistory } from '@/platform/persistence/schema/history/admission'
import {
  generateHistoryBaseline,
  generatePostgresqlCatalogArtifacts,
  readPostgresqlCatalogArtifact,
} from '@/platform/persistence/schema/history/artifacts'
import type { SchemaEdgeKind } from '@/platform/persistence/schema/history/types'
import { withR2TargetHarness } from './helpers/rfc395R2Harness'
import { describeEachProvider } from './helpers/eachProvider'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { compilePostgresqlPlan } from '@/platform/persistence/schema/postgresqlPlan'
import { rebindSqliteTableReferences } from '@/platform/persistence/schema/sqliteReferences'
import { r2Registry, itemTable, parentTable } from './helpers/rfc395R2Schema'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function replace(registry: SchemaRegistry, definition: TableDefinition): SchemaRegistry {
  return createSchemaRegistry(
    registry.contributions.map((entry) => ({
      ...entry,
      tables:
        entry.owner !== definition.owner
          ? entry.tables
          : [...entry.tables.filter((t) => t.id !== definition.id), definition],
    })),
    { schemaEpoch: 2 },
  )
}
const seeded = (id: string) =>
  r2Registry(undefined, [
    { table: 'r2_items', mode: 'install-only', rows: [{ id, label: id, amount: 1 }] },
  ])

describeEachProvider('RFC-395 II-b R2 real registry and install', (harness) => {
  withR2TargetHarness(harness, (h) => {
    test('rebuild preserves qualified CHECKs, partial indexes, self FKs and literal bytes', async () => {
      const owner = defineContribution('system-operations')
      const raw = (sql: string, postgresql = sql) => ({
        kind: 'raw' as const,
        reason: 'qualified rebuild regression',
        sqlite: sql,
        postgresql,
      })
      const table = owner.table({
        id: 'r2_qualified',
        schemaSymbol: 'r2Qualified',
        retention: retention.business,
        columns: {
          id: column.id('id', { primary: true }),
          parentId: column.id('parent_id', { nullable: true }),
          amount: column.int('amount', { default: 0 }),
          label: column.text('label'),
        },
        checks: [{ name: 'r2_qualified_amount', expression: raw('"r2_qualified"."amount" >= 0') }],
        foreignKeys: [
          foreignKey('r2_qualified_parent', ['parent_id'], 'r2_qualified', ['id'], {
            onDelete: 'set null',
          }),
        ],
        indexes: [
          index('r2_qualified_partial', [raw('"r2_qualified"."label"', '"label"')], {
            unique: true,
            nulls: 'distinct',
            where: raw(
              `"r2_qualified"."amount" > 0 AND "r2_qualified"."label" <> '"r2_qualified".skip'`,
              `"amount" > 0 AND "label" <> '"r2_qualified".skip'`,
            ),
          }),
        ],
      })
      const child = owner.table({
        id: 'r2_qualified_children',
        schemaSymbol: 'r2QualifiedChildren',
        retention: retention.business,
        columns: { id: column.id('id', { primary: true }), parentId: column.id('parent_id') },
        foreignKeys: [
          foreignKey('r2_qualified_incoming', ['parent_id'], table.id, ['id'], {
            onDelete: 'cascade',
          }),
        ],
      })
      const before = r2Registry([table, child])
      const baseline = createHistoryVersion({ registry: before, slug: 'qualified' })
      await h.apply(baseline)
      await h.native.execute(
        `INSERT INTO ${h.table(table.id)} (id, parent_id, amount, label) VALUES ('root', NULL, 1, 'kept'), ('leaf', 'root', 0, 'kept'), ('skip1', NULL, 1, '"r2_qualified".skip'), ('skip2', NULL, 1, '"r2_qualified".skip')`,
      )
      await h.native.execute(
        `INSERT INTO ${h.table(child.id)} (id, parent_id) VALUES ('child', 'root')`,
      )
      const extended = {
        ...table,
        columns: { ...table.columns, note: column.text('note', { default: 'new' }) },
      }
      const after = r2Registry([extended, child])
      const added = createHistoryVersion({
        registry: after,
        previous: baseline,
        slug: 'column',
        edge: { kind: 'add-column', tableId: table.id, column: 'note' },
      })
      await h.apply(added)
      await h.admit(added)
      const rebuilt = r2Registry([
        {
          ...extended,
          columns: { ...extended.columns, amount: column.int('amount', { default: 1 }) },
        },
        child,
      ])
      const next = createHistoryVersion({
        registry: rebuilt,
        previous: added,
        slug: 'rebuild',
        edge: { kind: 'rebuild-table', tableId: table.id },
      })
      await h.apply(next)
      await h.admit(next)
      expect(
        await h.native.execute(`SELECT id, parent_id, note FROM ${h.table(table.id)} ORDER BY id`),
      ).toEqual([
        { id: 'leaf', parent_id: 'root', note: 'new' },
        { id: 'root', parent_id: null, note: 'new' },
        { id: 'skip1', parent_id: null, note: 'new' },
        { id: 'skip2', parent_id: null, note: 'new' },
      ])
      await expect(
        h.native.execute(
          `INSERT INTO ${h.table(table.id)} (id, amount, label) VALUES ('negative', -1, 'negative')`,
        ),
      ).rejects.toThrow()
      await expect(
        h.native.execute(
          `INSERT INTO ${h.table(table.id)} (id, amount, label) VALUES ('duplicate', 1, 'kept')`,
        ),
      ).rejects.toThrow()
      await expect(
        h.native.execute(
          `INSERT INTO ${h.table(table.id)} (id, parent_id, label) VALUES ('orphan', 'missing', 'orphan')`,
        ),
      ).rejects.toThrow()
      await h.native.execute(`DELETE FROM ${h.table(table.id)} WHERE id = 'root'`)
      expect(
        await h.native.execute(`SELECT parent_id FROM ${h.table(table.id)} WHERE id = 'leaf'`),
      ).toEqual([{ parent_id: null }])
      expect(await h.native.execute(`SELECT id FROM ${h.table(child.id)}`)).toEqual([])
      await h.admit(next)
    }, 60_000)
    test('real target baseline, add-column and expand-only chain work; common constraint edges admit on both engines', async () => {
      let registry: SchemaRegistry = persistenceSchema
      const baseline = createHistoryVersion({ registry, slug: 'target' })
      const contract = baseline.contract.contract.tables
      expect(
        contract.find((table) => table.id === 'clarify_answer_attributions')?.primaryKey,
      ).toEqual(['round_id', 'question_id', 'occurrence'])
      const rounds = contract.find((table) => table.id === 'clarify_rounds')!
      expect(rounds.columns.attributionsRecorded?.name).toBe('attributions_recorded')
      expect(rounds.columns.legacyAnswersJson?.name).toBe('legacy_answers_json')
      expect(
        contract.find((table) => table.id === 'task_workspaces')?.columns.requestedSource?.document,
      ).toEqual({ kind: 'requested-source', version: 2 })
      expect(baseline.sqlite.head).toEqual(compileSqlitePlan(registry).statements)
      expect(baseline.postgresql.head).toEqual(
        compilePostgresqlPlan(registry).statements.filter(
          (statement) => !['metadata', 'seed'].includes(statement.kind),
        ),
      )
      let head = baseline
      await h.apply(baseline)
      expect((await h.admit(baseline)).contract.digest).toBe(baseline.contract.digest)
      const tasks = registry.tables.find((t) => t.id === 'tasks')!
      const constraintIds = () =>
        h.native.execute(
          "SELECT oid::text FROM pg_constraint WHERE conrelid = 'agent_workflow.tasks'::regclass OR confrelid = 'agent_workflow.tasks'::regclass ORDER BY oid",
        )
      const originalIds = h.provider === 'postgresql' ? await constraintIds() : []
      const append = async (definition: TableDefinition, kind: SchemaEdgeKind) => {
        registry = replace(registry, definition)
        const edge = deriveSchemaEdge(kind, head.contract.contract, compileContract(registry))
        const next = createHistoryVersion({ registry, previous: head, edge, slug: kind })
        await h.apply(next)
        expect((await h.admit(next)).contract.digest).toBe(next.contract.digest)
        head = next
        return next
      }
      const extendedTasks = {
        ...tasks,
        columns: { ...tasks.columns, reviewNote: column.text('review_note', { nullable: true }) },
      }
      const columnVersion = await append(extendedTasks, 'add-column')
      expect(columnVersion.contract.edge).toEqual({
        kind: 'add-column',
        tableId: 'tasks',
        column: 'review_note',
      })
      expect(columnVersion.postgresql.statements).toHaveLength(1)
      if (h.provider === 'postgresql') expect(await constraintIds()).toEqual(originalIds)
      if (h.provider === 'postgresql')
        expect(
          (
            await admitHistory(postgresqlHistorySession(h.pool), {
              binary: baseline,
              catalogCache: new HistoryCatalogCache(),
            })
          ).contract.digest,
        ).toBe(columnVersion.contract.digest)
      expect((await h.admit(baseline)).contract.digest).toBe(head.contract.digest)
      await append(
        { ...extendedTasks, indexes: [...tasks.indexes, index('r2_task_note', ['review_note'])] },
        'add-index',
      )
      expect((await h.admit(baseline)).contract.digest).toBe(head.contract.digest)
      const owner = defineContribution('system-operations')
      const extra = owner.table({
        id: 'r2_target_extra',
        schemaSymbol: 'r2TargetExtra',
        retention: retention.business,
        columns: {
          id: column.id('id', { primary: true }),
          userId: column.id('user_id', { nullable: true }),
          amount: column.int('amount', { default: 0 }),
        },
        checks: [
          {
            name: 'r2_target_amount',
            expression: {
              kind: 'binary',
              op: '>=',
              left: { kind: 'column', name: 'amount' },
              right: { kind: 'literal', value: 0 },
            },
          },
        ],
      })
      await append(extra, 'add-table')
      expect((await h.admit(baseline)).contract.digest).toBe(head.contract.digest)
      const withFk = {
        ...extra,
        foreignKeys: [foreignKey('r2_target_user', ['user_id'], 'users', ['id'])],
      }
      const fkVersion = await append(withFk, 'add-fk')
      expect(fkVersion.postgresql.statements).toHaveLength(1)
      expect(fkVersion.postgresql.statements[0]).toContain('ADD CONSTRAINT "r2_target_user"')
      await expect(h.admit(baseline)).rejects.toMatchObject({ code: 'non-expand-successor' })
      const checked = {
        ...withFk,
        checks: [
          {
            ...extra.checks[0]!,
            expression: {
              ...extra.checks[0]!.expression,
              right: { kind: 'literal' as const, value: -1 },
            },
          },
        ],
      }
      const checkVersion = await append(checked, 'replace-check')
      expect(checkVersion.postgresql.statements).toHaveLength(2)
      expect(
        checkVersion.postgresql.statements.every((statement) =>
          statement.includes('"r2_target_amount"'),
        ),
      ).toBe(true)
      const metadata = await append(
        {
          ...checked,
          migrationPolicy: 'DEFER',
          foreignKeys: checked.foreignKeys.map((fk) => ({
            ...fk,
            lifecycle: 'Reviewed task-independent fixture ownership.',
          })),
        },
        'owner-metadata',
      )
      expect(metadata.sqlite.statements).toEqual([])
      expect(metadata.postgresql.statements).toEqual([])
      await h.native.execute(`INSERT INTO ${h.table(extra.id)} (id, amount) VALUES ('kept', 2)`)
      const current = registry.tables.find((table) => table.id === extra.id)!
      await append(
        {
          ...current,
          columns: { ...current.columns, amount: column.real('amount', { default: 0 }) },
        },
        'rebuild-table',
      )
      expect(
        Number(
          (await h.native.execute(`SELECT amount FROM ${h.table(extra.id)} WHERE id = 'kept'`))[0]!
            .amount,
        ),
      ).toBe(2)
      registry = createSchemaRegistry(
        registry.contributions.map((entry) => ({
          ...entry,
          tables: entry.tables.filter((table) => table.id !== extra.id),
        })),
        { schemaEpoch: 2 },
      )
      const retired = createHistoryVersion({
        registry,
        previous: head,
        slug: 'retire-extra',
        edge: deriveSchemaEdge('retire-table', head.contract.contract, compileContract(registry)),
      })
      await h.apply(retired)
      expect((await h.admit(retired)).contract.digest).toBe(retired.contract.digest)
    }, 240_000)

    test('head install executes only the head plan and current seeds in the history transaction', async () => {
      const base = createHistoryVersion({ registry: seeded('old'), slug: 'baseline' })
      const registry = seeded('head')
      const delta = deriveSchemaEdge(
        'seed-delta',
        base.contract.contract,
        compileContract(registry),
      )
      const seededHead = createHistoryVersion({
        registry,
        previous: base,
        edge: delta,
        slug: 'seeds',
      })
      const head = createHistoryVersion({
        registry,
        previous: seededHead,
        slug: 'transform',
        edge: {
          kind: 'data-transform',
          receiptId: 'not-replayed',
          idempotent: true,
          review: 'A historical transform must not execute on head install.',
          sqlite: ["UPDATE r2_items SET label = 'replayed'"],
          postgresql: ["UPDATE agent_workflow.r2_items SET label = 'replayed'"],
        },
      })
      await h.installHead(head, { now: () => 41 })
      expect(await h.native.execute(`SELECT id, label FROM ${h.table('r2_items')}`)).toEqual([
        { id: 'head', label: 'head' },
      ])
      const rows = await readSchemaHistoryRows(h.native)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        version: 2,
        appliedAt: 41,
        contractDigest: head.contract.contract.digest,
      })
      expect(
        await h.native.execute(
          `SELECT * FROM ${metaTableName(h.provider, 'schema_transform_receipts')}`,
        ),
      ).toEqual([])
      expect(await firstLiveWriteAt(h.native, 'dbg_r2_install_head')).toBeNull()
      expect((await h.admit(head)).contract.digest).toBe(head.contract.digest)
    })

    test('seed-delta resets omitted seed cells to the same declared defaults as head installation', async () => {
      const before = r2Registry(undefined, [
        {
          table: 'r2_items',
          mode: 'install-only',
          rows: [{ id: 'seed', label: 'Old', amount: 8 }],
        },
      ])
      const base = createHistoryVersion({ registry: before, slug: 'baseline' })
      await h.installHead(base)
      const registry = r2Registry(undefined, [
        { table: 'r2_items', mode: 'install-only', rows: [{ id: 'seed' }] },
      ])
      const edge = deriveSchemaEdge('seed-delta', base.contract.contract, compileContract(registry))
      const next = createHistoryVersion({ registry, previous: base, edge, slug: 'default-seed' })
      await h.apply(next)
      expect(
        (
          await h.native.execute(`SELECT id, parent_id, amount, label FROM ${h.table('r2_items')}`)
        ).map((row): Record<string, unknown> => ({ ...row, amount: Number(row.amount) })),
      ).toEqual([{ id: 'seed', parent_id: null, amount: 0, label: 'Ready' }])
      expect((await h.admit(next)).contract.digest).toBe(next.contract.digest)
    })

    test('failed head install rolls back its DDL, seeds and metadata; absent epoch-2 meta has a typed error', async () => {
      const version = createHistoryVersion({ registry: seeded('head'), slug: 'baseline' })
      await expect(h.admit(version)).rejects.toMatchObject({ code: 'not-epoch-2-database' })
      await expect(
        h.installHead(version, {
          afterStatement(index) {
            if (index === version[h.provider].head.length + (h.provider === 'postgresql' ? 4 : 3))
              throw new Error('install-fault')
          },
        }),
      ).rejects.toThrow('install-fault')
      await expect(h.admit(version)).rejects.toMatchObject({ code: 'not-epoch-2-database' })
      await h.installHead(version)
      expect(await h.native.execute(`SELECT id FROM ${h.table('r2_items')}`)).toEqual([
        { id: 'head' },
      ])
    })

    test('generated catalog artifacts check against PostgreSQL and are sufficient for admission with another search_path', async () => {
      if (h.provider !== 'postgresql') return
      const root = mkdtempSync(join(tmpdir(), 'r2-pg-catalog-'))
      roots.push(root)
      const registry = r2Registry()
      const version = createHistoryVersion({ registry, slug: 'baseline' })
      generateHistoryBaseline(root, registry)
      const compile = async () => await h.catalog(version)
      await expect(
        generatePostgresqlCatalogArtifacts({ directory: root, check: true, compile }),
      ).rejects.toThrow('catalog-artifact-missing')
      const paths = await generatePostgresqlCatalogArtifacts({
        directory: root,
        check: false,
        compile,
      })
      const generatedCatalog = readPostgresqlCatalogArtifact(root, version)
      expect(paths.map((path) => path.slice(root.length + 1))).toEqual([
        `0000_baseline.postgresql-${generatedCatalog.postgresqlMajor}-catalog.json`,
      ])
      await generatePostgresqlCatalogArtifacts({ directory: root, check: true, compile })
      const artifact = readPostgresqlCatalogArtifact(root, version)
      expect(artifact.postgresqlMajor).toBeGreaterThanOrEqual(15)
      const embedded = JSON.parse(readFileSync(paths[0]!, 'utf8')) as typeof artifact
      const cache = new HistoryCatalogCache(postgresqlCatalogLoader([embedded]))
      expect(await cache.expected(version.postgresql, undefined, artifact.postgresqlMajor)).toEqual(
        artifact.catalog,
      )
      await h.apply(version)
      const connection = await h.pool.reserve()
      await connection.unsafe('SET search_path TO public')
      expect(
        (
          await admitHistory(postgresqlHistorySession({ reserve: async () => connection }), {
            binary: version,
            catalogCache: cache,
          })
        ).contract.digest,
      ).toBe(version.contract.digest)
      await expect(new HistoryCatalogCache().expected(version.postgresql)).rejects.toThrow(
        'catalog-artifact-required',
      )
      // Artifacts are per major: a database major without one is missing; a mismatched one is refused.
      await expect(
        cache.expected(version.postgresql, undefined, artifact.postgresqlMajor + 1),
      ).rejects.toThrow('catalog-artifact-missing')
      expect(() =>
        verifyPostgresqlCatalogArtifact(
          embedded,
          version.postgresql,
          undefined,
          artifact.postgresqlMajor + 1,
        ),
      ).toThrow('catalog-postgresql-major')
      const { digest: _digest, ...payload } = artifact
      const different = { ...payload, catalog: [] }
      writeFileSync(
        paths[0]!,
        JSON.stringify({ ...different, digest: digestSchemaContract(different) }),
      )
      await expect(
        generatePostgresqlCatalogArtifacts({ directory: root, check: true, compile }),
      ).rejects.toThrow('catalog-artifact-mismatch')
      writeFileSync(paths[0]!, JSON.stringify({ ...artifact, catalog: [] }))
      await expect(
        generatePostgresqlCatalogArtifacts({ directory: root, check: true, compile }),
      ).rejects.toThrow('catalog-artifact-digest')
    }, 60_000)
  })
})

test('SQLite rebinding changes identifiers in DDL, including generated expressions, without touching literals or comments', () => {
  const ddl = `CREATE TABLE "local" (id TEXT PRIMARY KEY, n INT, generated INT AS ("local".n + 1), CHECK (local.n >= 0 AND 'local.n' <> '"local".n'), FOREIGN KEY (id) REFERENCES "local" (id), FOREIGN KEY (id) REFERENCES other (id)) /* local.n */ -- "local".n\n`
  expect(rebindSqliteTableReferences(ddl, 'local', '__temporary')).toBe(
    `CREATE TABLE "__temporary" (id TEXT PRIMARY KEY, n INT, generated INT AS ("__temporary".n + 1), CHECK ("__temporary".n >= 0 AND 'local.n' <> '"local".n'), FOREIGN KEY (id) REFERENCES "__temporary" (id), FOREIGN KEY (id) REFERENCES other (id)) /* local.n */ -- "local".n\n`,
  )
  expect(
    rebindSqliteTableReferences('`local`.`n` + [local].[n] + LOCAL . n + "other".n', 'local', null),
  ).toBe('`n` + [n] +  n + "other".n')
  expect(rebindSqliteTableReferences('"a""b".n = \'"a""b".n\'', 'a"b', '__temporary')).toBe(
    '"__temporary".n = \'"a""b".n\'',
  )
})

test('explicit seed edges must equal the declared change and add-column cannot reorder old columns', () => {
  const before = compileContract(seeded('old'))
  const after = compileContract(seeded('next'))
  const edge = deriveSchemaEdge('seed-delta', before, after)
  expect(deriveSchemaEdge('seed-delta', before, after, edge)).toEqual(edge)
  expect(() => deriveSchemaEdge('seed-delta', before, before, edge)).toThrow('ambiguous-diff')
  if (edge.kind !== 'seed-delta') throw new Error('fixture')
  for (const changed of [
    { ...edge, upsert: [{ id: 'invented' }] },
    { ...edge, remove: [] },
  ])
    expect(() => deriveSchemaEdge('seed-delta', before, after, changed)).toThrow('ambiguous-diff')
  const base = createHistoryVersion({ registry: r2Registry(), slug: 'baseline' })
  const registry = r2Registry([
    parentTable,
    {
      ...itemTable,
      columns: { note: column.text('note', { nullable: true }), ...itemTable.columns },
    },
  ])
  expect(() =>
    deriveSchemaEdge('add-column', base.contract.contract, compileContract(registry)),
  ).toThrow('ambiguous-diff')
})

test('install-time seed changes require reviewed values only at declared placeholder cells', () => {
  const table = {
    ...itemTable,
    columns: { ...itemTable.columns, createdAt: column.epochMs('created_at') },
  }
  const registry = (label: string) =>
    r2Registry(
      [parentTable, table],
      [
        {
          table: 'r2_items',
          mode: 'install-only',
          rows: [{ id: 'seed', label, created_at: installTime }],
        },
      ],
    )
  const before = compileContract(registry('old'))
  const after = compileContract(registry('new'))
  expect(() => deriveSchemaEdge('seed-delta', before, after)).toThrow('install-time')
  const explicit = {
    kind: 'seed-delta' as const,
    tableId: 'r2_items',
    upsert: [{ id: 'seed', label: 'new', created_at: 42 }],
    remove: [],
  }
  expect(deriveSchemaEdge('seed-delta', before, after, explicit)).toEqual(explicit)
  expect(() =>
    deriveSchemaEdge('seed-delta', before, after, {
      ...explicit,
      upsert: [{ id: 'seed', label: 'invented', created_at: 42 }],
    }),
  ).toThrow('ambiguous-diff')
})

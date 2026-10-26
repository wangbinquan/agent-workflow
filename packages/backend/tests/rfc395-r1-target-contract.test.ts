import { loadPostgresqlMigrationHistory } from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'
// RFC-395 II-b R1: target plans, roster and all 70/62 source-column destinations must agree before activation.
import { describe, expect, expectTypeOf, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { getTableConfig as pgConfig } from 'drizzle-orm/pg-core'
import { buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { frozenEpoch1Registry } from '@/platform/persistence/migration/epoch1/definitions'
import {
  persistenceSchema,
  schemaContract,
  sqlitePlan,
  postgresqlPlan,
  nativeTableSets,
} from '@/bootstrap/persistenceSchema'
import roster from '@/bootstrap/targetSchemaRoster.json'
import destinations from '@/bootstrap/targetColumnDestinations.json'
import { compileContract } from '@/platform/persistence/schema/contract'
import type { ColumnDefinition, TableDefinition } from '@/platform/persistence/schema/contribution'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schema/canonical'
import {
  compilePostgresqlPlan,
  buildPostgresqlSchemaPlan,
} from '@/platform/persistence/schema/postgresqlPlan'
import {
  compileInstallSeeds,
  renderInstallSeedStatements,
} from '@/platform/persistence/schema/seeds'
import {
  renderSchemaExpression,
  quoteSchemaIdentifier as quote,
} from '@/platform/persistence/schema/expressions'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'
import { targetCodecChecks } from '@/platform/persistence/schema/nativeConstraints'
import {
  bindDatabaseHandle,
  tablesOf,
  inheritDatabaseHandle,
} from '@/platform/persistence/sessionTables'

import {
  createSqliteCapabilities,
  createPostgresqlCapabilities,
} from '@/platform/persistence/capabilities'
import type { NativeTableSets } from '@/platform/persistence/schema/tables'
import { decodeLegacyClarifyAnswerColumns } from '@/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { clarifyAnswerContentForPrompt } from '@/modules/collaboration/domain/clarifyAnswerContent'

describe('RFC-395 II-b R1 target contract', () => {
  test('clarify attribution is an independent ordered map with a round-level presence fact', () => {
    const find = (id: string): TableDefinition =>
      persistenceSchema.tables.find((table) => table.id === id)!
    const attributions = find('clarify_answer_attributions')
    expect(attributions.owner).toBe('collaboration')
    expect(attributions.primaryKey).toEqual(['round_id', 'question_id', 'occurrence'])
    expect(attributions.unique).toEqual([
      {
        name: 'clarify_answer_attributions_order',
        columns: ['round_id', 'ordinal'],
        nulls: 'distinct',
      },
    ])
    expect(attributions.foreignKeys).toHaveLength(1)
    expect(attributions.foreignKeys[0]).toMatchObject({
      columns: ['round_id'],
      foreignTable: 'clarify_rounds',
      foreignColumns: ['id'],
      onDelete: 'cascade',
    })
    expect(attributions.columns.valueJson).toMatchObject({
      name: 'value_json',
      codec: 'jsonText',
      nullable: false,
      originalTextDigest: true,
    })
    expect(find('clarify_rounds').columns.attributionsRecorded).toMatchObject({
      name: 'attributions_recorded',
      codec: 'bool',
      nullable: false,
      default: { kind: 'literal', value: false },
    })
    for (const raw of [null, 'null'])
      expect(
        decodeLegacyClarifyAnswerColumns({ answerAttributionsJson: raw }).answerAttributions,
      ).toBeNull()
    expect(
      decodeLegacyClarifyAnswerColumns({ answerAttributionsJson: '{}' }).answerAttributions,
    ).toEqual({})
    for (const id of ['clarify_answers', 'clarify_answer_drafts'])
      expect(
        Object.values(find(id).columns).some((column) => column.name.includes('attribution')),
      ).toBe(false)
    expect(destinations.clarify_rounds.answer_attributions_json).toMatchObject({
      table: 'clarify_answer_attributions',
      column: 'value_json',
    })
    expect(
      roster.filter((row) => row.sources.includes('clarify_rounds')).map((row) => row.table),
    ).toEqual([
      'clarify_answer_attributions',
      'clarify_answer_drafts',
      'clarify_answers',
      'clarify_rounds',
    ])
  })
  test('non-array answers keep the REST detail and distillation value plus verbatim storage', () => {
    const rounds: TableDefinition = persistenceSchema.tables.find(
      (table) => table.id === 'clarify_rounds',
    )!
    expect(rounds.columns.legacyAnswersJson).toMatchObject({
      name: 'legacy_answers_json',
      codec: 'text',
      nullable: true,
    })
    expect(destinations.clarify_rounds.answers_json.conversion).toContain(
      'clarify_rounds.legacy_answers_json',
    )
    for (const raw of ['{}', '"legacy"', '0', 'null', ' { "值": 1 }\n']) {
      const projection = decodeLegacyClarifyAnswerColumns({ answersJson: raw })
      expect(projection.answers).toBeNull()
      expect(projection.detailAnswers).toEqual(JSON.parse(raw))
      expect(projection.content).toEqual({
        kind: 'legacy-value',
        json: JSON.stringify(JSON.parse(raw)),
      })
      expect(clarifyAnswerContentForPrompt(projection.content)).toBe(
        JSON.stringify(JSON.parse(raw)),
      )
    }
    const absent = decodeLegacyClarifyAnswerColumns({ answersJson: null })
    expect(absent.detailAnswers).toBeUndefined()
    expect(absent.content).toEqual({ kind: 'absent' })
    expect(decodeLegacyClarifyAnswerColumns({ answersJson: '[]' }).content).toEqual({
      kind: 'answers',
      values: [],
    })
  })
  test('requested source metadata names v2 while the document type still accepts v1', () => {
    type RequestedSourceDocument = Extract<
      NonNullable<ColumnDefinition['document']>,
      { kind: 'requested-source' }
    >
    expectTypeOf<RequestedSourceDocument['version']>().toEqualTypeOf<1 | 2>()
    const workspace = schemaContract.tables.find((table) => table.id === 'task_workspaces')!
    expect(workspace.columns.requestedSource?.document).toEqual({
      kind: 'requested-source',
      version: 2,
    })
  })
  test('both compiled forms carry the same epoch-2 canonical contract and declared column order', () => {
    expect(schemaContract.schemaEpoch).toBe(2)
    expect(canonicalSchemaJson(sqlitePlan.contract)).toBe(canonicalSchemaJson(schemaContract))
    expect(canonicalSchemaJson(postgresqlPlan.contract)).toBe(canonicalSchemaJson(schemaContract))
    expect(sqlitePlan.contractDigest).toBe(schemaContract.digest)
    expect(postgresqlPlan.contractDigest).toBe(schemaContract.digest)
    expect(schemaContract.digest).not.toBe(compileContract(frozenEpoch1Registry).digest)
    for (const definition of persistenceSchema.tables) {
      const sqlite = sqlitePlan.statements.find(
        (statement) => statement.kind === 'table' && statement.logicalId === definition.id,
      )!
      const pg = postgresqlPlan.statements.find(
        (statement) => statement.kind === 'table' && statement.logicalId === definition.id,
      )!
      expect(sqlite, definition.id).toBeDefined()
      expect(pg, definition.id).toBeDefined()
      const native = materializeDrizzle(definition, { schemaEpoch: 2 })
      const names = Object.values(definition.columns).map((column) => column.name)
      expect(getTableConfig(native.sqlite).columns.map((column) => column.name)).toEqual(names)
      expect(pgConfig(native.postgresql).columns.map((column) => column.name)).toEqual(names)
      for (const sql of [sqlite.sql, pg.sql]) {
        const positions = names.map((name) => sql.indexOf(quote(name)))
        expect(
          positions.every(
            (position, i) => position >= 0 && (i === 0 || position > positions[i - 1]!),
          ),
          definition.id,
        ).toBe(true)
      }
      const compiledDefinition = schemaContract.tables.find((table) => table.id === definition.id)!
      for (const column of Object.values(compiledDefinition.columns)) {
        if (!column.unique) continue
        if (column.nullable)
          expect(column.uniqueNulls === 'distinct' || column.uniqueNulls === 'not-distinct').toBe(
            true,
          )
        expect(sqlite.sql).toContain(`CONSTRAINT ${quote(column.unique)} UNIQUE`)
        expect(
          postgresqlPlan.statements.find(
            (statement) => statement.logicalId === `${definition.id}:unique:${column.unique}`,
          )?.sql,
        ).toContain(`UNIQUE (${quote(column.name)})`)
      }
      for (const check of targetCodecChecks(compiledDefinition, 'sqlite'))
        expect(sqlite.sql).toContain(`CHECK (${check.sql})`)
      for (const check of targetCodecChecks(compiledDefinition, 'postgresql'))
        expect(
          postgresqlPlan.statements.find(
            (statement) => statement.logicalId === `${definition.id}:check:${check.name}`,
          )?.sql,
        ).toContain(`CHECK (${check.sql})`)
      for (const fk of definition.foreignKeys) {
        expect(sqlite.sql).toContain(
          `CONSTRAINT ${quote(fk.name)} FOREIGN KEY (${fk.columns.map(quote).join(', ')}) REFERENCES ${quote(fk.foreignTable)} (${fk.foreignColumns.map(quote).join(', ')})`,
        )
        expect(sqlite.sql).toContain(
          `ON UPDATE ${fk.onUpdate.toUpperCase()} ON DELETE ${fk.onDelete.toUpperCase()}`,
        )
        const constraint = postgresqlPlan.statements.find(
          (statement) => statement.logicalId === `${definition.id}:fk:${fk.name}`,
        )!
        expect(constraint.sql).toContain(`FOREIGN KEY (${fk.columns.map(quote).join(', ')})`)
        expect(constraint.sql).toContain(`ON DELETE ${fk.onDelete.toUpperCase()}`)
        expect(constraint.sql).toContain(
          `"agent_workflow".${quote(fk.foreignTable)} (${fk.foreignColumns.map(quote).join(', ')})`,
        )
      }
      for (const check of definition.checks) {
        // SQLite drops the local table qualifier so a rebuild under a temporary name still binds.
        expect(sqlite.sql).toContain(
          renderSchemaExpression(check.expression, 'sqlite').replaceAll(
            `${quote(definition.id)}.`,
            '',
          ),
        )
        expect(
          postgresqlPlan.statements.find(
            (statement) => statement.logicalId === `${definition.id}:check:${check.name}`,
          )?.sql,
        ).toContain(renderSchemaExpression(check.expression, 'postgresql'))
      }
      for (const unique of definition.unique) {
        expect(['distinct', 'not-distinct']).toContain(unique.nulls)
        expect(sqlite.sql).toContain(`UNIQUE (${unique.columns.map(quote).join(', ')})`)
        expect(
          postgresqlPlan.statements.find(
            (statement) => statement.logicalId === `${definition.id}:unique:${unique.name}`,
          )?.sql,
        ).toContain(`UNIQUE (${unique.columns.map(quote).join(', ')})`)
      }
      for (const index of definition.indexes) {
        if (index.unique) expect(['distinct', 'not-distinct']).toContain(index.nulls)
        for (const [provider, statements] of [
          ['sqlite', sqlitePlan.statements],
          ['postgresql', postgresqlPlan.statements],
        ] as const) {
          const statement = statements.find(
            (statement) => statement.logicalId === `${definition.id}:index:${index.name}`,
          )!
          expect(statement.sql).toContain(index.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX')
          if (index.where)
            expect(statement.sql).toContain(
              renderSchemaExpression(index.where, provider).replaceAll(
                `${quote(definition.id)}.`,
                '',
              ),
            )
        }
      }
    }
  })
  test('the epoch-1 explicit digest payload and frozen v2/provider projection remain unchanged', async () => {
    const expected = {
      contractVersion: 3 as const,
      contributions: frozenEpoch1Registry.contributions.map(({ owner, version }) => ({
        owner,
        version,
      })),
      tables: frozenEpoch1Registry.tables,
    }
    expect(compileContract(frozenEpoch1Registry)).toEqual({
      ...expected,
      digest: digestSchemaContract(expected),
    })
    const artifact = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dir,
          '../../../design/RFC-349-postgresql-provider-one-click-migration/schema-contract.json',
        ),
        'utf8',
      ),
    ) as { digest: string }
    expect(buildLogicalSchemaContract().digest).toBe(artifact.digest)
    expect(() => compilePostgresqlPlan(frozenEpoch1Registry)).toThrow(
      'epoch-1-schema-compilation-is-offline-only',
    )
    const contract = buildLogicalSchemaContract()
    const published = await loadPostgresqlMigrationHistory({ headContract: contract })
    expect(buildPostgresqlSchemaPlan(contract)).toEqual(published.head.plan)
  })
  test('the roster covers exactly the registry, every reviewed source, and retained definitions by value', () => {
    expect(persistenceSchema.tables.map((table): string => table.id).sort()).toEqual(
      roster.map((row) => row.table).sort(),
    )
    const byId = new Map<string, TableDefinition>(
      persistenceSchema.tables.map((table) => [table.id, table]),
    )
    const source = new Map<string, TableDefinition>(
      frozenEpoch1Registry.tables.map((table) => [table.id, table]),
    )
    for (const tableId of [
      'task_workspace_preparations',
      'sc_preparation_operations',
      'hosted_database_backups',
    ]) {
      expect(byId.get(tableId)).toEqual(source.get(tableId))
      const compiled = schemaContract.tables.find((table) => table.id === tableId)!
      for (const column of Object.values(compiled.columns))
        if (column.unique && column.nullable) expect(column.uniqueNulls).toBe('distinct')
    }
    for (const row of roster) {
      expect(byId.get(row.table)?.owner).toBe(row.owner)
      if (row.definition === 'reused') expect(byId.get(row.table)).toEqual(source.get(row.table))
    }
    const mapping = readFileSync(
      resolve(
        import.meta.dir,
        '../../../design/RFC-395-database-target-schema-rebuild/table-mapping.md',
      ),
      'utf8',
    )
    const rows = [...mapping.matchAll(/^\| `([^`]+)` \| [^|]+ \| ([^|]+) \| ([^|]+) \|/gm)]
    expect(rows).toHaveLength(217)
    for (const [, table, owner] of rows) {
      if (table === 'employee_os_writer_state') {
        expect(destinations.employee_os_writer_state).toBeDefined()
        continue
      }
      const targets = roster.filter((row) => row.sources.includes(table!))
      expect(targets.length, table).toBeGreaterThan(0)
      const expectedOwner = owner!.trim().split(' (')[0]
      if (table !== 'employee_os_writer_state')
        expect(
          targets.some((row) => row.owner === expectedOwner),
          table,
        ).toBe(true)
    }
    expect(
      roster
        .filter(
          (row) =>
            row.sources.length === 1 &&
            !rows.some(([, table]) => row.sources[0] === table) &&
            source.has(row.sources[0]!),
        )
        .map((row) => row.table)
        .sort(),
    ).toEqual([
      'development_design_baselines',
      'development_design_links',
      'development_design_proposals',
      'development_design_revisions',
      'development_designs',
    ])
    for (const retired of [
      'task_repos',
      'employee_os_writer_state',
      'hosted_object_publications',
      'code_work_observations',
      'code_work_items',
      'legacy_code_work_item_links',
    ])
      expect(byId.has(retired)).toBe(false)
  })
  test('every Task/NodeRun source column has exactly one conversion entry and a real destination', () => {
    for (const [name, count] of [
      ['tasks', 70],
      ['node_runs', 62],
    ] as const) {
      const source = frozenEpoch1Registry.tables.find((table) => table.id === name)!
      const entries: Record<string, { table: string | null; column: string }> = destinations[name]
      expect(Object.keys(entries)).toHaveLength(count)
      expect(Object.keys(entries).sort()).toEqual(
        Object.values(source.columns)
          .map((column) => column.name)
          .sort(),
      )
      for (const destination of Object.values(entries)) {
        if (destination.table === null) {
          expect(destination.column).toBe('repoCount')
          continue
        }
        const table = persistenceSchema.tables.find((table) => table.id === destination.table)!
        expect(table, destination.table).toBeDefined()
        expect(Object.values(table.columns).map((column) => column.name)).toContain(
          destination.column,
        )
      }
    }
    expect(Object.keys(nativeTableSets.sqlite.tasks)).toContain('workspaceRootRef')
    expect(
      Object.values(persistenceSchema.tables.find((table) => table.id === 'tasks')!.columns),
    ).toHaveLength(28)
  })
  test('all install paths receive byte-identical seeds, with a single resolved installation time', () => {
    const compiled = (['new-install', 'test-baseline', 'hosted-installation'] as const).map(
      (path) => compileInstallSeeds(persistenceSchema, { path, installedAt: 1800000000123 }),
    )
    expect(new Set(compiled.map((seed) => seed.canonicalJson)).size).toBe(1)
    expect(compiled[0]!.rows).toHaveLength(6)
    const rows = compiled[0]!.rows
    expect(rows.find((row) => row.table === 'users')?.values).toMatchObject({
      id: '__system__',
      role: 'admin',
      git_name: 'System',
      created_at: 1800000000123,
      updated_at: 1800000000123,
    })
    expect(rows.find((row) => row.table === 'auth_login_policy')?.values).toMatchObject({
      id: 'global',
      password_login_enabled: true,
      oidc_default_role: 'guest',
      bootstrap_completed_at: null,
    })
    expect(
      rows
        .filter((row) => row.table === 'committed_event_family_cutovers')
        .map((row) => row.values),
    ).toEqual([
      {
        producer: 'task-execution',
        family: 'task-lifecycle',
        epoch: 2,
        changed_at: 1789574412066,
        change_ref: 'rfc341:task-lifecycle-cutover',
      },
      ...['review', 'clarify', 'questions'].map((family) => ({
        producer: 'collaboration',
        family,
        epoch: 2,
        changed_at: 1789833612066,
        change_ref: 'rfc341:collaboration-cutover',
      })),
    ])
    for (const provider of ['sqlite', 'postgresql'] as const)
      expect(
        new Set(
          compiled.map((seed) =>
            canonicalSchemaJson(renderInstallSeedStatements(seed.rows, provider)),
          ),
        ).size,
      ).toBe(1)
    expect(() =>
      compileInstallSeeds(persistenceSchema, {
        path: 'conversion' as 'new-install',
        installedAt: 1,
      }),
    ).toThrow('install-only')
  })
  test('the single native accessor is dialect-specific, and inherited by transactions', () => {
    expectTypeOf<NativeTableSets['sqlite']>().toEqualTypeOf<typeof nativeTableSets.sqlite>()
    expectTypeOf<NativeTableSets['postgresql']>().toEqualTypeOf<typeof nativeTableSets.postgresql>()
    for (const engine of [createSqliteCapabilities(), createPostgresqlCapabilities()]) {
      const client = {}
      const handle = bindDatabaseHandle(
        { session: { client } },
        nativeTableSets[engine.provider],
        engine,
      )
      expect(tablesOf({ session: { client } })).toBe(nativeTableSets[engine.provider])
      expect(() => tablesOf({})).toThrow('no session table set')
      expect(tablesOf(handle)).toBe(nativeTableSets[engine.provider])
      expect(Object.hasOwn(tablesOf(handle).tasks, 'workflowId')).toBe(false)
      expect(tablesOf(inheritDatabaseHandle({}, handle))).toBe(nativeTableSets[engine.provider])
    }
  })
})

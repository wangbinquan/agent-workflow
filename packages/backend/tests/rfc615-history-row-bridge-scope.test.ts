// RFC-615 T2: the RFC-401 all-history bridge exceeded its unchanged 5 s budget in CI.
// Bridge-only payloads must avoid intermediate hashes without weakening any row check.
// In particular, successful validation is not a license to cache mutable history across calls.
import { describe, expect, test } from 'bun:test'
import {
  createPostgresqlAdditiveUpgrade,
  postgresqlSqliteMigrationIdentity,
  resolvePostgresqlAdditiveRowBridge,
  resolvePostgresqlIndexOnlyRowBridge,
  type PostgresqlMigrationHistory,
  type PostgresqlMigrationVersion,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { createPostgresqlAdditiveUpgrade as createFrozenAdditiveUpgrade } from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import {
  buildPostgresqlSchemaPlan,
  POSTGRESQL_BASELINE_ID,
} from '@/platform/persistence/postgresqlSchema'
import {
  canonicalSchemaJson,
  createCanonicalFragmentCache,
  digestSchemaContract,
  withCanonicalFragmentCache,
  type LogicalTableContract,
} from '@/platform/persistence/schemaContract'
import type { HistoryStatement, SchemaEdge } from '@/platform/persistence/schema/history/types'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/schema/history/logicalHistory'
import { projectLogicalSchemaContract } from '@/platform/persistence/schema/logicalContract'
import { registryFromContract } from '@/platform/persistence/schema/contract'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { index } from '@/platform/persistence/schema/dsl'
import { itemTable, parentTable, r2Registry } from './helpers/rfc395R2Schema'

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
type MutableHistory = Mutable<PostgresqlMigrationHistory>

const ROW_CHANGED = 'historical row, codec, key or disposition changed'
const UNUSED_DIGEST = `sha256:${'0'.repeat(64)}`

function table(id: string, archived = false): LogicalTableContract {
  return {
    id,
    schemaSymbol: id,
    ownerContext: 'system-operations',
    disposition: archived ? 'ARCHIVE_THEN_OMIT' : 'KEEP',
    sourceTable: id,
    providerTables: { sqlite: id, postgresql: id },
    migrationKey: ['id'],
    columns: [
      {
        name: 'id',
        logicalCodec: 'text-identity',
        nullable: false,
        primary: true,
        hasDefault: false,
        defaultKind: 'none',
        defaultValue: null,
        providerDefault: { sqlite: null, postgresql: null },
        identity: false,
        uniqueName: null,
        enumValues: [],
        providerType: { sqlite: 'text', postgresql: 'text' },
      },
    ],
    primaryKey: ['id'],
    unique: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    retention: {
      class: archived ? 'archive-only' : 'owner-managed-operational',
      owner: 'system-operations',
      rule: 'RFC-615 fixture',
    },
    consumers: {
      productionReader: 'owner-required',
      productionWriter: 'owner-required-or-immutable',
      backgroundRecoveryDiagnostic: 'owner-reviewed',
      evidence: 'RFC-615 fixture',
    },
    ...(archived
      ? {
          archive: {
            format: 'agent-workflow-logical-table-v1' as const,
            stableOrder: ['id'],
            verifies: ['row-count', 'key-bounds', 'chunk-digest', 'root-digest'] as const,
            restoreIntoActiveSchema: false as const,
            approval: 'RFC-349-D9' as const,
          },
        }
      : {}),
    rationale: 'RFC-615 fixture',
  }
}

function version(
  tables: readonly LogicalTableContract[],
  sequence: number,
  schemaEdge?: SchemaEdge | null,
): PostgresqlMigrationVersion {
  const payload = {
    contractVersion: 2,
    sourceProjection: 'sqlite' as const,
    sourceTableCount: tables.length,
    activeTableCount: tables.filter((entry) => entry.disposition !== 'ARCHIVE_THEN_OMIT').length,
    archiveOnlyTableCount: tables.filter((entry) => entry.disposition === 'ARCHIVE_THEN_OMIT')
      .length,
    tables,
  }
  const contract = { ...payload, digest: digestSchemaContract(payload) }
  const sqliteMigrations = Array.from({ length: sequence + 1 }, (_, index) => ({
    index,
    tag: `rfc615_fixture_${index}`,
    hash: String(index).padStart(64, '0'),
    folderMillis: index + 1,
  }))
  return {
    contract,
    plan: buildPostgresqlSchemaPlan(contract),
    sqliteMigrations,
    sqliteMigration: postgresqlSqliteMigrationIdentity(sqliteMigrations),
    ...(schemaEdge === undefined ? {} : { schemaEdge }),
  }
}

function historyFixture(): MutableHistory {
  const baseline = version([table('original'), table('other'), table('archived', true)], 0, null)
  const baselineTables = structuredClone(baseline.contract.tables)
  const added = version([baselineTables[0]!, table('added'), ...baselineTables.slice(1)], 1, {
    kind: 'add-table',
    tableId: 'added',
  })
  const indexedTables = structuredClone(added.contract.tables) as Mutable<LogicalTableContract>[]
  indexedTables[0]!.indexes.push({
    name: 'idx_rfc615_covering',
    unique: false,
    columns: ['id'],
    where: null,
  })
  const indexed = version(indexedTables, 2, {
    kind: 'add-index',
    tableId: 'original',
    name: 'idx_rfc615_covering',
  })
  // The bridge reads the contract/edge history, not the root's SQL artifacts.
  const history: PostgresqlMigrationHistory = {
    root: {
      ...baseline,
      version: 1,
      baselineSqlDigest: UNUSED_DIGEST,
      legacyJournalDigest: UNUSED_DIGEST,
    },
    versions: [baseline, added, indexed],
    steps: [],
    head: indexed,
  }
  // structuredClone gives these mutation cases their own writable graph and preserves
  // head/versions aliases; the production contract's readonly annotations do not change that.
  return structuredClone(history) as unknown as MutableHistory
}

function endpoints(history: PostgresqlMigrationHistory, from = 0) {
  return {
    fromContractDigest: history.versions[from]!.contract.digest,
    toContractDigest: history.head.contract.digest,
  }
}

function intermediate(history: MutableHistory) {
  return history.versions[1]!.contract
}

const mutations: readonly {
  name: string
  change: (history: MutableHistory) => void
  error?: string
}[] = [
  {
    name: 'column name',
    change: (history) => {
      intermediate(history).tables[0]!.columns[0]!.name = 'changed_id'
    },
  },
  {
    name: 'logical codec',
    change: (history) => {
      intermediate(history).tables[0]!.columns[0]!.logicalCodec = 'integer'
    },
  },
  {
    name: 'nested provider type',
    change: (history) => {
      intermediate(history).tables[0]!.columns[0]!.providerType.postgresql = 'bigint'
    },
  },
  {
    name: 'rationale',
    change: (history) => {
      intermediate(history).tables[0]!.rationale = 'changed after validation'
    },
  },
  {
    name: 'existing-table disposition',
    change: (history) => {
      intermediate(history).tables[0]!.disposition = 'DEFER'
    },
  },
  {
    name: 'added-table disposition',
    change: (history) => {
      intermediate(history).tables[1]!.disposition = 'DEFER'
    },
    error: 'table addition requires an active KEEP table',
  },
  {
    name: 'existing-table order',
    change: (history) => {
      const tables = intermediate(history).tables
      const original = tables[0]!
      tables[0] = tables[2]!
      tables[2] = original
    },
  },
  {
    name: 'source table count',
    change: (history) => {
      intermediate(history).sourceTableCount += 1
    },
  },
  {
    name: 'active table count',
    change: (history) => {
      intermediate(history).activeTableCount += 1
    },
  },
  {
    name: 'archive table count',
    change: (history) => {
      intermediate(history).archiveOnlyTableCount += 1
    },
  },
  {
    name: 'contract metadata',
    change: (history) => {
      intermediate(history).contractVersion += 1
    },
  },
  {
    name: 'reviewed edge kind',
    change: (history) => {
      history.versions[1]!.schemaEdge = { kind: 'add-column', tableId: 'original', column: 'extra' }
    },
  },
  {
    name: 'missing added table',
    change: (history) => {
      intermediate(history).tables.splice(1, 1)
    },
  },
  {
    name: 'duplicate added-table identity',
    change: (history) => {
      history.versions[1]!.schemaEdge = { kind: 'add-table', tableId: 'original' }
    },
    error: 'table addition duplicates an existing table',
  },
  {
    name: 'target row at a later edge',
    change: (history) => {
      history.head.contract.tables[0]!.rationale = 'changed at the final version'
    },
  },
]

describe('RFC-615 row bridge invocation scope', () => {
  test('SQLite compiled heads preserve the exact row contracts admitted by additive and index-only bridges', async () => {
    const indexName = 'idx_rfc615_parent_name'
    const indexedParent = { ...parentTable, indexes: [index(indexName, ['name'])] }
    const registries = [
      r2Registry([parentTable]),
      r2Registry([parentTable, itemTable]),
      r2Registry([indexedParent, itemTable]),
    ]
    const baseline = createHistoryVersion({ registry: registries[0]!, slug: 'baseline' })
    const added = createHistoryVersion({
      registry: registries[1]!,
      slug: 'add_items',
      previous: baseline,
      edge: { kind: 'add-table', tableId: itemTable.id },
    })
    const indexed = createHistoryVersion({
      registry: registries[2]!,
      slug: 'index_parent',
      previous: added,
      edge: { kind: 'add-index', tableId: parentTable.id, name: indexName },
    })
    const versions = [baseline, added, indexed]
    const history = await loadPostgresqlMigrationHistory({
      schemaHistory: { head: () => indexed, history: () => versions, metaTables: [] },
      headContract: projectLogicalSchemaContract(registries[2]!),
    })
    // Drive the SQLite compiler directly, then verify both its stored DDL and the
    // logical row contract used by the bridge. A symbol reference alone proves neither.
    const plans = registries.map((registry) => compileSqlitePlan(registry))
    for (const [i, plan] of plans.entries()) {
      expect<readonly HistoryStatement[]>(plan.statements).toEqual(versions[i]!.sqlite.head)
      expect(plan.contractDigest).toBe(versions[i]!.contract.contract.digest)
      expect(projectLogicalSchemaContract(registryFromContract(plan.contract!))).toEqual(
        history.versions[i]!.contract,
      )
    }
    const parentSql = (plan: (typeof plans)[number]) =>
      plan.statements.find(
        (statement) => statement.kind === 'table' && statement.logicalId === parentTable.id,
      )!.sql
    expect(parentSql(plans[1]!)).toBe(parentSql(plans[0]!))
    expect(parentSql(plans[2]!)).toBe(parentSql(plans[0]!))
    expect(added.sqlite.statements).toEqual(
      plans[1]!.statements
        .filter(
          (statement) =>
            statement.logicalId === itemTable.id ||
            statement.logicalId.startsWith(`${itemTable.id}:`),
        )
        .map((statement) => statement.sql),
    )
    expect(added.sqlite.statements[0]).toContain('CREATE TABLE "r2_items"')
    expect(added.sqlite.statements[0]).toContain(
      'FOREIGN KEY ("parent_id") REFERENCES "r2_parents" ("id") ON UPDATE NO ACTION ON DELETE CASCADE',
    )
    expect(indexed.sqlite.statements).toEqual([
      'CREATE INDEX "idx_rfc615_parent_name" ON "r2_parents" ("name")',
    ])
    expect(resolvePostgresqlAdditiveRowBridge(history, endpoints(history)).target).toBe(
      history.head.contract,
    )
    expect(resolvePostgresqlIndexOnlyRowBridge(history, endpoints(history, 1)).target).toBe(
      history.head.contract,
    )
    expect(() => resolvePostgresqlIndexOnlyRowBridge(history, endpoints(history))).toThrow(
      ROW_CHANGED,
    )

    // A SQLite column change changes real DDL and must still invalidate the same
    // reviewed index edge; the faster bridge cannot trust only that edge's label.
    const changedRegistry = r2Registry([
      {
        ...indexedParent,
        columns: {
          ...indexedParent.columns,
          name: { ...indexedParent.columns.name, nullable: true },
        },
      },
      itemTable,
    ])
    const changedPlan = compileSqlitePlan(changedRegistry)
    expect(parentSql(changedPlan)).not.toBe(parentSql(plans[2]!))
    const changedHead = {
      ...history.head,
      contract: projectLogicalSchemaContract(registryFromContract(changedPlan.contract!)),
    }
    const changedHistory = {
      ...history,
      versions: [...history.versions.slice(0, -1), changedHead],
      head: changedHead,
    }
    for (const resolve of [resolvePostgresqlAdditiveRowBridge, resolvePostgresqlIndexOnlyRowBridge])
      expect(() => resolve(changedHistory, endpoints(changedHistory, 1))).toThrow(ROW_CHANGED)
  })

  test('keeps source/target identity and both bridge modes across insertion and index edges', () => {
    const history = historyFixture()
    for (let from = 0; from < history.versions.length; from += 1) {
      const result = resolvePostgresqlAdditiveRowBridge(history, endpoints(history, from))
      expect(result.source).toBe(history.versions[from]!.contract)
      expect(result.target).toBe(history.head.contract)
      expect(result.steps).toEqual([])
    }
    expect(() => resolvePostgresqlIndexOnlyRowBridge(history, endpoints(history))).toThrow(
      ROW_CHANGED,
    )
    expect(resolvePostgresqlIndexOnlyRowBridge(history, endpoints(history, 1)).target).toBe(
      history.head.contract,
    )
  })

  for (const mutation of mutations) {
    test(`rechecks ${mutation.name} on the same history and digests after a successful call`, () => {
      const history = historyFixture()
      const input = endpoints(history)
      const digests = history.versions.map((entry) => entry.contract.digest)
      expect(resolvePostgresqlAdditiveRowBridge(history, input).target).toBe(history.head.contract)
      mutation.change(history)
      expect(history.versions.map((entry) => entry.contract.digest)).toEqual(digests)
      expect(() => resolvePostgresqlAdditiveRowBridge(history, input)).toThrow(
        mutation.error ?? ROW_CHANGED,
      )
    })
  }

  test('archive-only indexes remain exact even though row projections omit indexes', () => {
    const history = historyFixture()
    const input = endpoints(history, 1)
    resolvePostgresqlIndexOnlyRowBridge(history, input)
    history.head.contract.tables.at(-1)!.indexes.push({
      name: 'idx_changed_archive',
      unique: false,
      columns: ['id'],
      where: null,
    })
    for (const resolve of [
      resolvePostgresqlIndexOnlyRowBridge,
      resolvePostgresqlAdditiveRowBridge,
    ]) {
      expect(() => resolve(history, input)).toThrow(
        'historical archive-only table contract changed',
      )
    }
  })

  test('a stale outer canonical cache cannot admit mutated rows and is restored after failure', () => {
    const history = historyFixture()
    const input = endpoints(history)
    const outer = createCanonicalFragmentCache()
    const column = intermediate(history).tables[0]!.columns[0]!
    const originalName = column.name
    const afterSuccess = { phase: 'after success' }
    const afterFailure = { phase: 'after failure' }
    withCanonicalFragmentCache(outer, () => {
      resolvePostgresqlAdditiveRowBridge(history, input)
      canonicalSchemaJson(afterSuccess)
      expect(outer.fragments.has(afterSuccess)).toBe(true)
      // Prime the nested column/array fragments at the same depth as the row projection.
      canonicalSchemaJson(intermediate(history))
      column.name = 'changed_inside_outer_scope'
      expect(() => resolvePostgresqlAdditiveRowBridge(history, input)).toThrow(ROW_CHANGED)
      canonicalSchemaJson(afterFailure)
      expect(outer.fragments.has(afterFailure)).toBe(true)
      column.name = originalName
      expect(resolvePostgresqlAdditiveRowBridge(history, input).target).toBe(history.head.contract)
    })
    const outside = { phase: 'outside' }
    canonicalSchemaJson(outside)
    expect(outer.fragments.has(outside)).toBe(false)
  })

  test('unknown endpoints and backwards bridges still fail after a valid call', () => {
    const history = historyFixture()
    const input = endpoints(history)
    resolvePostgresqlAdditiveRowBridge(history, input)
    for (const invalid of [
      { ...input, fromContractDigest: UNUSED_DIGEST },
      { ...input, toContractDigest: UNUSED_DIGEST },
      { fromContractDigest: input.toContractDigest, toContractDigest: input.fromContractDigest },
    ]) {
      expect(() => resolvePostgresqlAdditiveRowBridge(history, invalid)).toThrow(
        'unsupported historical index-only row bridge',
      )
    }
  })

  test('artifact-producing additive upgrades still match the frozen epoch-1 bytes and digests', () => {
    const base = version([table('original')], 0)
    const added = version([table('original'), table('added')], 1)
    const input = {
      from: { ...base, plan: { ...base.plan, baselineId: POSTGRESQL_BASELINE_ID } },
      to: { ...added, plan: { ...added.plan, baselineId: POSTGRESQL_BASELINE_ID } },
      id: '0001_rfc615_additive_probe',
      sequence: 1,
      previousEntryDigest: UNUSED_DIGEST,
    } satisfies Parameters<typeof createFrozenAdditiveUpgrade>[0]
    const generated = createPostgresqlAdditiveUpgrade(input)
    const frozen = createFrozenAdditiveUpgrade(input)
    expect(canonicalSchemaJson(generated)).toBe(canonicalSchemaJson(frozen))
    expect(generated.to.contractDigest).toBe(added.contract.digest)
    expect(generated.digest).toBe(frozen.digest)
    expect(generated.sqlDigest).toBe(frozen.sqlDigest)
  })
})

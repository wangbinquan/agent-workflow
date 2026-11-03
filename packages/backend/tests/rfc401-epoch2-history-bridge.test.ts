// RFC-401 —— epoch-2 history 的行桥（design §10.4）。
//
// 由来：RFC-401 Part B 加入 epoch-2 的头两个增量版本（0001 add-table atomic_apply_claims、0002 add-table
// skill_apply_journal）。epoch-2 history 没有 epoch-1 的 upgrade steps，而行桥此前只折叠 steps，于是任何跨版本的桥
// 都报 "historical row, codec, key or disposition changed"：迁移状态探测与恢复源解析在升级后失败，PostgreSQL
// 逻辑恢复也拒收升级前的备份。现在行桥按每个版本记录的 edge 折叠：add-index 行不变；add-table（仅 additive 桥）
// 新增一张空的 KEEP 表；其余 edge 都终止桥。每一步都与下一版本自身的合同比对，不凭 edge 标签放行。

import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { beforeAll, describe, expect, test } from 'bun:test'

import { resolveLogicalDatabaseRestoreSourceContract } from '@/platform/persistence/logicalDatabaseRestore'
import {
  resolvePostgresqlAdditiveRowBridge,
  resolvePostgresqlIndexOnlyRowBridge,
  type PostgresqlMigrationHistory,
  type PostgresqlMigrationVersion,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/schema/history/logicalHistory'
import type { SchemaEdge } from '@/platform/persistence/schema/history/types'
import type {
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const ROW_CHANGED = 'historical row, codec, key or disposition changed'
let history: PostgresqlMigrationHistory

beforeAll(async () => {
  history = await loadPostgresqlMigrationHistory({ headContract: logicalSchemaContract })
})

function between(from: PostgresqlMigrationVersion, to: PostgresqlMigrationVersion) {
  return { fromContractDigest: from.contract.digest, toContractDigest: to.contract.digest }
}

function withTable(
  contract: LogicalSchemaContract,
  tableId: string,
  change: (table: LogicalTableContract) => LogicalTableContract,
): LogicalSchemaContract {
  return {
    ...contract,
    tables: contract.tables.map((table) => (table.id === tableId ? change(table) : table)),
  }
}

function historyOf(versions: readonly PostgresqlMigrationVersion[]): PostgresqlMigrationHistory {
  return { ...history, versions, head: versions.at(-1)! }
}

function withVersion(
  index: number,
  change: (version: PostgresqlMigrationVersion) => PostgresqlMigrationVersion,
): PostgresqlMigrationHistory {
  return historyOf(
    history.versions.map((version, at) => (at === index ? change(version) : version)),
  )
}

describe('RFC-401 epoch-2 history row bridge', () => {
  test('each incremental version records its reviewed edge; today they all add whole tables', () => {
    expect(history.versions[0]!.schemaEdge).toBeNull()
    // The additive bridge below folds only add-table / add-index. A later version with another
    // edge kind fails this line on purpose: restoring older backups and resuming migrations across
    // that edge needs its own row bridge, decided by the RFC that adds the edge.
    expect(history.versions.slice(1).map((version) => version.schemaEdge?.kind)).toEqual(
      history.versions.slice(1).map(() => 'add-table'),
    )
    expect(history.versions.length).toBeGreaterThan(1)
  })

  test('the additive bridge carries every older version to the head across whole new tables', () => {
    for (const version of history.versions) {
      const bridge = resolvePostgresqlAdditiveRowBridge(history, between(version, history.head))
      expect(bridge.source).toBe(version.contract)
      expect(bridge.target).toBe(history.head.contract)
      expect(bridge.steps).toEqual([])
    }
  })

  test('the index-only bridge still rejects a new table, and no bridge runs backwards', () => {
    expect(() =>
      resolvePostgresqlIndexOnlyRowBridge(history, between(history.versions[0]!, history.head)),
    ).toThrow(ROW_CHANGED)
    expect(
      resolvePostgresqlIndexOnlyRowBridge(history, between(history.head, history.head)).source,
    ).toBe(history.head.contract)
    expect(() =>
      resolvePostgresqlAdditiveRowBridge(history, between(history.head, history.versions[0]!)),
    ).toThrow('unsupported historical index-only row bridge')
  })

  test('an edge kind that rewrites, drops or re-validates rows ends the bridge', () => {
    const tableId = 'tasks'
    const edges: readonly SchemaEdge[] = [
      { kind: 'rebuild-table', tableId },
      { kind: 'retire-table', tableId },
      { kind: 'add-column', tableId, column: 'probe' },
      { kind: 'replace-check', tableId, name: 'probe' },
      { kind: 'add-fk', tableId, name: 'probe' },
      { kind: 'owner-metadata', tableId },
      { kind: 'seed-delta', tableId, upsert: [], remove: [] },
      {
        kind: 'data-transform',
        receiptId: 'probe',
        idempotent: true,
        review: 'probe',
        sqlite: [],
        postgresql: [],
      },
    ]
    for (const edge of edges) {
      const relabeled = withVersion(1, (version) => ({ ...version, schemaEdge: edge }))
      expect(() =>
        resolvePostgresqlAdditiveRowBridge(
          relabeled,
          between(relabeled.versions[0]!, relabeled.head),
        ),
      ).toThrow(ROW_CHANGED)
    }
  })

  test('each fold is checked against the version contract, not the edge label', () => {
    const changedRows = withVersion(1, (version) => ({
      ...version,
      contract: withTable(version.contract, 'tasks', (table) => ({
        ...table,
        rationale: `${table.rationale} changed`,
      })),
    }))
    expect(() =>
      resolvePostgresqlAdditiveRowBridge(
        changedRows,
        between(changedRows.versions[0]!, changedRows.versions[1]!),
      ),
    ).toThrow(ROW_CHANGED)
    const absentTable = withVersion(1, (version) => ({
      ...version,
      schemaEdge: { kind: 'add-table', tableId: 'rfc401_absent_table' },
    }))
    expect(() =>
      resolvePostgresqlAdditiveRowBridge(
        absentTable,
        between(absentTable.versions[0]!, absentTable.versions[1]!),
      ),
    ).toThrow(ROW_CHANGED)
  })

  test('an index-only edge bridges in both modes while every row stays the same', () => {
    const root = history.versions[0]!
    const indexed: PostgresqlMigrationVersion = {
      ...root,
      contract: {
        ...withTable(root.contract, 'tasks', (table) => ({
          ...table,
          indexes: [
            ...table.indexes,
            {
              name: 'idx_rfc401_bridge_probe',
              unique: false,
              columns: [table.columns[0]!.name],
              where: null,
            },
          ],
        })),
        digest: `sha256:${'e'.repeat(64)}`,
      },
      schemaEdge: { kind: 'add-index', tableId: 'tasks', name: 'idx_rfc401_bridge_probe' },
    }
    const synthetic = historyOf([root, indexed])
    expect(resolvePostgresqlIndexOnlyRowBridge(synthetic, between(root, indexed)).source).toBe(
      root.contract,
    )
    expect(resolvePostgresqlAdditiveRowBridge(synthetic, between(root, indexed)).target).toBe(
      indexed.contract,
    )
    const alsoRows: PostgresqlMigrationVersion = {
      ...indexed,
      contract: withTable(indexed.contract, 'tasks', (table) => ({
        ...table,
        rationale: `${table.rationale} changed`,
      })),
    }
    expect(() =>
      resolvePostgresqlAdditiveRowBridge(historyOf([root, alsoRows]), between(root, alsoRows)),
    ).toThrow(ROW_CHANGED)
  })
})

describe('RFC-401 logical restore source across epoch-2 versions', () => {
  test('an older epoch-2 backup resolves to its own history contract', async () => {
    expect(
      await resolveLogicalDatabaseRestoreSourceContract({
        sourceSchemaDigest: history.versions[0]!.contract.digest,
        headContract: logicalSchemaContract,
        targetContract: logicalSchemaContract,
      }),
    ).toEqual(history.versions[0]!.contract)
    expect(
      await resolveLogicalDatabaseRestoreSourceContract({
        sourceSchemaDigest: logicalSchemaContract.digest,
        headContract: logicalSchemaContract,
        targetContract: logicalSchemaContract,
      }),
    ).toBe(logicalSchemaContract)
  })

  test('a digest outside the epoch-2 history is refused', async () => {
    await expect(
      resolveLogicalDatabaseRestoreSourceContract({
        sourceSchemaDigest: `sha256:${'5'.repeat(64)}`,
        headContract: logicalSchemaContract,
        targetContract: logicalSchemaContract,
      }),
    ).rejects.toMatchObject({
      code: 'logical-restore-artifact-corrupt',
      message: expect.stringContaining('restore contract is not in the live epoch-2 history'),
    })
  })

  test('only the complete current head is a cross-version target', async () => {
    await expect(
      resolveLogicalDatabaseRestoreSourceContract({
        sourceSchemaDigest: history.versions[0]!.contract.digest,
        headContract: logicalSchemaContract,
        targetContract: withTable(logicalSchemaContract, 'tasks', (table) => ({
          ...table,
          rationale: `${table.rationale} changed`,
        })),
      }),
    ).rejects.toMatchObject({
      code: 'logical-restore-artifact-corrupt',
      message: expect.stringContaining(
        'restore target differs from the complete current schema head',
      ),
    })
  })
})

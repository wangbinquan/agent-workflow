// RFC-395 II-b R2: every closed edge executes on real engines; catalog/rollback/old-binary semantics stay paired.
import { expect, test } from 'bun:test'
import { column, foreignKey, index, retention } from '@/platform/persistence/schema/dsl'
import type { TableDefinition } from '@/platform/persistence/schema/contribution'
import { compileContract } from '@/platform/persistence/schema/contract'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { deriveSchemaEdge } from '@/platform/persistence/schema/history/edgeDiff'
import { readSchemaHistoryRows } from '@/platform/persistence/schema/history/apply'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import type { SchemaEdge, SchemaEdgeKind } from '@/platform/persistence/schema/history/types'
import { describeR2Providers } from './helpers/rfc395R2Harness'
import { itemTable, parentTable, positive, r2Owner, r2Registry } from './helpers/rfc395R2Schema'

const baseline = () => createHistoryVersion({ registry: r2Registry(), slug: 'baseline' })
const scenarios: readonly {
  kind: SchemaEdgeKind
  tables: readonly TableDefinition[]
  edge?: SchemaEdge
}[] = [
  {
    kind: 'add-table',
    tables: [
      parentTable,
      itemTable,
      r2Owner.table({
        id: 'r2_extra',
        schemaSymbol: 'r2Extra',
        columns: { id: column.id('id', { primary: true }) },
        retention: retention.business,
      }),
    ],
  },
  {
    kind: 'add-column',
    tables: [
      parentTable,
      {
        ...itemTable,
        columns: { ...itemTable.columns, memo: column.text('memo', { nullable: true }) },
      },
    ],
  },
  {
    kind: 'add-index',
    tables: [
      parentTable,
      {
        ...itemTable,
        indexes: [
          ...itemTable.indexes,
          index('r2_partial_idx', ['amount'], {
            where: {
              kind: 'binary',
              op: '>',
              left: { kind: 'column', name: 'amount' },
              right: { kind: 'literal', value: 0 },
            },
          }),
        ],
      },
    ],
  },
  {
    kind: 'replace-check',
    tables: [
      parentTable,
      {
        ...itemTable,
        checks: [
          {
            name: 'r2_amount_check',
            expression: {
              ...positive,
              kind: 'binary',
              op: '>=',
              left: { kind: 'column', name: 'amount' },
              right: { kind: 'literal', value: -1 },
            },
          },
        ],
      },
    ],
  },
  {
    kind: 'add-fk',
    tables: [
      parentTable,
      {
        ...itemTable,
        foreignKeys: [
          ...itemTable.foreignKeys,
          foreignKey('r2_second_fk', ['parent_id'], 'r2_parents', ['id'], { onDelete: 'cascade' }),
        ],
      },
    ],
  },
  { kind: 'retire-table', tables: [parentTable] },
  {
    kind: 'rebuild-table',
    tables: [
      parentTable,
      {
        ...itemTable,
        columns: {
          ...itemTable.columns,
          amount: column.real('amount', { default: 0 }),
          memo: column.text('memo', { default: 'preserved' }),
        },
      },
    ],
  },
  {
    kind: 'seed-delta',
    tables: [parentTable, itemTable],
    edge: {
      kind: 'seed-delta',
      tableId: 'r2_items',
      upsert: [{ id: 'seed', label: 'Seed', amount: 2 }],
      remove: [{ id: 'old' }],
    },
  },
  {
    kind: 'data-transform',
    tables: [parentTable, itemTable],
    edge: {
      kind: 'data-transform',
      receiptId: 'r2_uppercase_v1',
      idempotent: true,
      review: 'RFC-395 R2 fixture: upper is idempotent',
      sqlite: ['UPDATE "r2_items" SET label = upper(label)'],
      postgresql: ['UPDATE "agent_workflow"."r2_items" SET label = upper(label)'],
    },
  },
  { kind: 'owner-metadata', tables: [parentTable, { ...itemTable, owner: 'task-execution' }] },
]

describeR2Providers('RFC-395 II-b R2 history', (h) => {
  for (const scenario of scenarios)
    test(`${scenario.kind}: compile, apply, catalog equality and idempotent replay`, async () => {
      const base =
        scenario.kind === 'seed-delta'
          ? createHistoryVersion({
              registry: r2Registry(undefined, [
                {
                  table: 'r2_items',
                  mode: 'install-only',
                  rows: [{ id: 'old', label: 'Old', amount: 0 }],
                },
              ]),
              slug: 'baseline',
            })
          : baseline()
      await h.apply(base)
      await h.native.execute(
        `INSERT INTO ${h.table('r2_parents')} (id, name) VALUES ('parent', 'Parent')`,
      )
      await h.native.execute(
        `INSERT INTO ${h.table('r2_items')} (id, parent_id, amount, label) VALUES ('item', 'parent', 2, 'Mixed'), ('old', NULL, 0, 'Old')`,
      )
      const registry = r2Registry(
        scenario.tables,
        scenario.kind === 'seed-delta'
          ? [
              {
                table: 'r2_items',
                mode: 'install-only',
                rows: [{ id: 'seed', label: 'Seed', amount: 2 }],
              },
            ]
          : undefined,
      )
      const edge =
        scenario.edge ??
        deriveSchemaEdge(scenario.kind, base.contract.contract, compileContract(registry))
      const version = createHistoryVersion({ registry, slug: scenario.kind, previous: base, edge })
      expect(await h.apply(version, { now: () => 42 })).toBe(true)
      expect(await h.apply(version)).toBe(false)
      expect((await h.admit(version)).contract.digest).toBe(version.contract.digest)
      const rows = await readSchemaHistoryRows(h.native)
      expect(rows).toHaveLength(2)
      expect(rows[1]).toMatchObject({
        version: 1,
        contractDigest: version.contract.contract.digest,
        sqlitePlanDigest: version.sqlite.digest,
        postgresqlPlanDigest: version.postgresql.digest,
        appliedAt: 42,
      })
      if (scenario.kind === 'rebuild-table') {
        const retained = await h.native.execute(
          `SELECT id, parent_id, amount, label, memo FROM ${h.table('r2_items')} WHERE id = 'item'`,
        )
        expect(retained[0]).toMatchObject({
          id: 'item',
          parent_id: 'parent',
          amount: 2,
          label: 'Mixed',
          memo: 'preserved',
        })
        await expect(
          h.native.execute(
            `INSERT INTO ${h.table('r2_items')} (id, parent_id) VALUES ('bad', 'missing')`,
          ),
        ).rejects.toThrow()
        await h.native.execute(`DELETE FROM ${h.table('r2_parents')} WHERE id = 'parent'`)
        expect(
          await h.native.execute(`SELECT id FROM ${h.table('r2_items')} WHERE id = 'item'`),
        ).toEqual([])
      }
      if (scenario.kind === 'data-transform') {
        expect(
          (await h.native.execute(`SELECT label FROM ${h.table('r2_items')} WHERE id = 'item'`))[0]!
            .label,
        ).toBe('MIXED')
        expect(
          await h.native.execute(
            `SELECT receipt_id FROM ${metaTableName(h.provider, 'schema_transform_receipts')}`,
          ),
        ).toEqual([{ receipt_id: 'r2_uppercase_v1' }])
      }
      if (scenario.kind === 'seed-delta') {
        expect(await h.native.execute(`SELECT id FROM ${h.table('r2_items')} ORDER BY id`)).toEqual(
          [{ id: 'item' }, { id: 'seed' }],
        )
      }
    }, 30_000)

  test('typed non-null default is backfilled and remains the insert default', async () => {
    const base = baseline()
    await h.apply(base)
    await h.native.execute(`INSERT INTO ${h.table('r2_items')} (id) VALUES ('before')`)
    const registry = r2Registry([
      parentTable,
      {
        ...itemTable,
        columns: { ...itemTable.columns, enabled: column.bool('enabled', { default: true }) },
      },
    ])
    const version = createHistoryVersion({
      registry,
      slug: 'default',
      previous: base,
      edge: { kind: 'add-column', tableId: 'r2_items', column: 'enabled' },
    })
    await h.apply(version)
    await h.native.execute(`INSERT INTO ${h.table('r2_items')} (id) VALUES ('after')`)
    const rows = await h.native.execute(`SELECT enabled FROM ${h.table('r2_items')} ORDER BY id`)
    expect(rows.map((row) => Boolean(row.enabled))).toEqual([true, true])
    await h.admit(version)
    await h.admit(base)
  })

  test('failure rolls back DDL, copied rows, version and transform receipt', async () => {
    const base = baseline()
    await h.apply(base)
    await h.native.execute(
      `INSERT INTO ${h.table('r2_items')} (id, label) VALUES ('item', 'Before')`,
    )
    const rebuild = scenarios.find((s) => s.kind === 'rebuild-table')!
    const version = createHistoryVersion({
      registry: r2Registry(rebuild.tables),
      slug: 'rollback',
      previous: base,
      edge: { kind: 'rebuild-table', tableId: 'r2_items' },
    })
    await expect(
      h.apply(version, {
        afterStatement: (index) => {
          if (index === 2) throw new Error('injected-ddl-failure')
        },
      }),
    ).rejects.toThrow('injected-ddl-failure')
    expect(
      (await h.native.execute(`SELECT label FROM ${h.table('r2_items')} WHERE id = 'item'`))[0]!
        .label,
    ).toBe('Before')
    expect(await readSchemaHistoryRows(h.native)).toHaveLength(1)
    await h.admit(base)
    const transform: SchemaEdge = {
      kind: 'data-transform',
      receiptId: 'fails',
      idempotent: true,
      review: 'intentional second-statement failure',
      sqlite: ["UPDATE r2_items SET label = 'After'", 'INSERT INTO r2_missing VALUES (1)'],
      postgresql: [
        "UPDATE agent_workflow.r2_items SET label = 'After'",
        'INSERT INTO agent_workflow.r2_missing VALUES (1)',
      ],
    }
    await expect(
      h.apply(
        createHistoryVersion({
          registry: r2Registry(),
          slug: 'bad-transform',
          previous: base,
          edge: transform,
        }),
      ),
    ).rejects.toThrow()
    expect(
      await h.native.execute(
        `SELECT receipt_id FROM ${metaTableName(h.provider, 'schema_transform_receipts')}`,
      ),
    ).toEqual([])
    expect(
      (await h.native.execute(`SELECT label FROM ${h.table('r2_items')} WHERE id = 'item'`))[0]!
        .label,
    ).toBe('Before')
  })

  test('FK validation occurs before commit, including SQLite rebuilds with enforcement disabled', async () => {
    const withoutFk = { ...itemTable, foreignKeys: [] }
    const base = createHistoryVersion({
      registry: r2Registry([parentTable, withoutFk]),
      slug: 'no-fk',
    })
    await h.apply(base)
    await h.native.execute(
      `INSERT INTO ${h.table('r2_items')} (id, parent_id) VALUES ('orphan', 'missing')`,
    )
    const version = createHistoryVersion({
      registry: r2Registry(),
      slug: 'add-fk',
      previous: base,
      edge: { kind: 'add-fk', tableId: 'r2_items', name: 'r2_parent_fk' },
    })
    await expect(h.apply(version)).rejects.toThrow()
    expect(await readSchemaHistoryRows(h.native)).toHaveLength(1)
    expect(await h.native.execute(`SELECT id FROM ${h.table('r2_items')}`)).toEqual([
      { id: 'orphan' },
    ])
    await h.admit(base)
    if (h.provider === 'sqlite')
      expect(h.sqlite.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  for (const drift of ['missing-index', 'extra-column', 'wrong-nullability'] as const)
    test(`admission refuses ${drift}, even after caching expected catalog`, async () => {
      const base = baseline()
      await h.apply(base)
      await h.admit(base)
      if (drift === 'missing-index')
        await h.native.execute(
          `DROP INDEX ${h.provider === 'sqlite' ? '"r2_label_idx"' : '"agent_workflow"."r2_label_idx"'}`,
        )
      if (drift === 'extra-column')
        await h.native.execute(`ALTER TABLE ${h.table('r2_items')} ADD COLUMN unclaimed TEXT`)
      if (drift === 'wrong-nullability') {
        if (h.provider === 'postgresql')
          await h.native.execute(
            `ALTER TABLE ${h.table('r2_items')} ALTER COLUMN label DROP NOT NULL`,
          )
        else {
          const changed = {
            ...itemTable,
            columns: {
              ...itemTable.columns,
              label: column.text('label', { nullable: true, default: 'Ready' }),
            },
          }
          h.sqlite.exec('DROP TABLE r2_items')
          for (const statement of compileSqlitePlan(
            r2Registry([parentTable, changed]),
          ).statements.filter(
            (s) => s.logicalId === 'r2_items' || s.logicalId.startsWith('r2_items:'),
          ))
            h.sqlite.exec(statement.sql)
        }
      }
      await expect(h.admit(base)).rejects.toThrow('physical-drift')
    })
  test('older binaries serve only an unbroken expand-only successor chain', async () => {
    const base = baseline()
    await h.apply(base)
    const add = scenarios.find((s) => s.kind === 'add-column')!
    const registry = r2Registry(add.tables)
    const version = createHistoryVersion({
      registry,
      slug: 'expand',
      previous: base,
      edge: { kind: 'add-column', tableId: 'r2_items', column: 'memo' },
    })
    await h.apply(version)
    expect((await h.admit(base)).contract.version).toBe(1)
    const shrink = createHistoryVersion({
      registry: r2Registry([parentTable]),
      slug: 'retire',
      previous: version,
      edge: { kind: 'retire-table', tableId: 'r2_items' },
    })
    await h.apply(shrink)
    await expect(h.admit(base)).rejects.toThrow('non-expand-successor')
    await h.admit(shrink)
  })
  test('a second transform version with the same receipt never reapplies the data operation', async () => {
    const base = baseline()
    await h.apply(base)
    await h.native.execute(
      `INSERT INTO ${h.table('r2_items')} (id, label) VALUES ('item', 'Initial')`,
    )
    const edge = scenarios.find((s) => s.kind === 'data-transform')!.edge!
    const first = createHistoryVersion({
      registry: r2Registry(),
      slug: 'transform',
      previous: base,
      edge,
    })
    await h.apply(first)
    await h.native.execute(`UPDATE ${h.table('r2_items')} SET label = 'Later' WHERE id = 'item'`)
    const second = createHistoryVersion({
      registry: r2Registry(),
      slug: 'receipt-reuse',
      previous: first,
      edge,
    })
    await h.apply(second)
    expect(
      (await h.native.execute(`SELECT label FROM ${h.table('r2_items')} WHERE id = 'item'`))[0]!
        .label,
    ).toBe('Later')
    expect(
      await h.native.execute(
        `SELECT receipt_id FROM ${metaTableName(h.provider, 'schema_transform_receipts')}`,
      ),
    ).toHaveLength(1)
    if (edge.kind !== 'data-transform') throw new Error('fixture')
    const conflicting = createHistoryVersion({
      registry: r2Registry(),
      slug: 'receipt-conflict',
      previous: second,
      edge: {
        ...edge,
        sqlite: ["UPDATE r2_items SET label = 'Wrong'"],
        postgresql: ["UPDATE agent_workflow.r2_items SET label = 'Wrong'"],
      },
    })
    await expect(h.apply(conflicting)).rejects.toThrow('transform-receipt-conflict')
  })
  test('rebuild retains incoming FK rows, declared indexes and identity high-water', async () => {
    const numbered = r2Owner.table({
      id: 'r2_numbered',
      schemaSymbol: 'r2Numbered',
      retention: retention.business,
      columns: { id: column.identity('id', { primary: true }), label: column.text('label') },
      indexes: [index('r2_numbered_label', ['label'])],
    })
    const child = r2Owner.table({
      id: 'r2_children',
      schemaSymbol: 'r2Children',
      retention: retention.business,
      columns: { id: column.id('id', { primary: true }), parentId: column.bigint('parent_id') },
      foreignKeys: [
        foreignKey('r2_child_fk', ['parent_id'], 'r2_numbered', ['id'], { onDelete: 'cascade' }),
      ],
    })
    const base = createHistoryVersion({ registry: r2Registry([numbered, child]), slug: 'identity' })
    await h.apply(base)
    await h.native.execute(
      `INSERT INTO ${h.table('r2_numbered')} (label) VALUES ('first'), ('deleted')`,
    )
    await h.native.execute(
      `INSERT INTO ${h.table('r2_children')} (id, parent_id) VALUES ('child', 1)`,
    )
    await h.native.execute(`DELETE FROM ${h.table('r2_numbered')} WHERE id = 2`)
    const next = {
      ...numbered,
      columns: { ...numbered.columns, memo: column.text('memo', { default: 'new' }) },
    }
    const version = createHistoryVersion({
      registry: r2Registry([next, child]),
      slug: 'identity-rebuild',
      previous: base,
      edge: { kind: 'rebuild-table', tableId: 'r2_numbered' },
    })
    await h.apply(version)
    expect(await h.native.execute(`SELECT id FROM ${h.table('r2_children')}`)).toEqual([
      { id: 'child' },
    ])
    const inserted = await h.native.execute(
      `INSERT INTO ${h.table('r2_numbered')} (label) VALUES ('after') RETURNING id`,
    )
    expect(Number(inserted[0]!.id)).toBe(3)
    await h.admit(version)
  })
  test('PG applies under its transaction advisory lock; SQLite restores the caller FK mode', async () => {
    const base = baseline()
    if (h.provider === 'sqlite') {
      await h.apply(base)
      expect(h.sqlite.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      return
    }
    const held = await h.pool.reserve()
    await held.unsafe('BEGIN')
    await held.unsafe('SELECT pg_advisory_xact_lock(395, 2)')
    let finished = false
    const pending = h.apply(base).then((value) => {
      finished = true
      return value
    })
    try {
      // Wait on the server's actual lock queue, not a timing-only promise race.
      const deadline = Date.now() + 10_000
      let queued = false
      while (!queued && Date.now() < deadline) {
        const rows = await held.unsafe(
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 395 AND objid = 2 AND NOT granted",
        )
        queued = rows.length > 0
        if (!queued) await Bun.sleep(10)
      }
      expect(queued).toBe(true)
      expect(finished).toBe(false)
    } finally {
      await held.unsafe('ROLLBACK')
      held.release()
      await pending
    }
    expect(finished).toBe(true)
  }, 30_000)
})

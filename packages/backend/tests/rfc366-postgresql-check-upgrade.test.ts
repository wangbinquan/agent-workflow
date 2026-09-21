// RFC-366 —— PostgreSQL 迁移序列的第三种边：**值域升级**（具名 CHECK 的表达式
// 替换 + 同一值域在列上的 `enumValues` 声明）。
//
// 为什么非加不可：RFC-349/359 的序列是纯 expand-only 的——只接受「新表」和
// 「新索引」，对任何既有语句的改动一律拒绝。而 `source_kind` / `status` /
// `scope_type` 这些值域全是 CHECK 约束，PostgreSQL 又没有 `ALTER CONSTRAINT …
// CHECK`，于是「给枚举加一个值」在这套框架里原本无法表达。更关键的是：逻辑契约是
// 从 `db/schema.ts` 推导的，所以哪怕只想改 SQLite，契约摘要照样会动、历史头断言
// 照样会红——绕不过去。
//
// 这条边刻意只admit一件事：**替换一个具名 CHECK 的表达式，其余一切不变**。
// 下面每条用例各锁一个「不得混进来」的形态——它们都是不报错就会悄悄改掉生产库
// 结构的那类改动。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  createPostgresqlAdditiveUpgrade,
  createPostgresqlCheckUpgrade,
  createPostgresqlIndexUpgrade,
  postgresqlMigrationDigest,
  replayPostgresqlMigrationHistory,
  type PostgresqlMigrationHistory,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { readPostgresqlMigrationHistoryPrefix } from '@/platform/persistence/postgresqlMigrationHistory'

const FOLDER = resolve(import.meta.dir, '..', 'db', 'postgresql-migrations')
const STEP_ID = '0004_rfc366_distill_source_kinds'

let cached: PostgresqlMigrationHistory | null = null
async function history(): Promise<PostgresqlMigrationHistory> {
  cached ??= await readPostgresqlMigrationHistoryPrefix({ migrationsFolder: FOLDER })
  return cached
}

async function checkStep() {
  const committed = await history()
  const index = committed.steps.findIndex((step) => step.id === STEP_ID)
  expect(index).toBeGreaterThanOrEqual(0)
  return { committed, index, step: committed.steps[index]! }
}

describe('RFC-366 — 提交的值域边（0004）', () => {
  test('是 V3，且带着成对的逻辑增量与可执行语句', async () => {
    const { step } = await checkStep()
    expect(step.version).toBe(3)
    expect(step.logicalChecks).toHaveLength(2)
    expect(step.checkReplacements).toHaveLength(2)
    // 只改值域，不新增表/索引。
    expect(step.logicalTables).toBeUndefined()
    expect(step.logicalIndexes).toEqual([])
    expect(step.indexAdditions).toEqual([])
  })

  test('改的就是那两张表的 source_kind，加的就是那两个值', async () => {
    const { step } = await checkStep()
    const byTable = Object.fromEntries(
      (step.logicalChecks ?? []).map((item) => [item.tableId, item]),
    )
    expect(Object.keys(byTable).sort()).toEqual(['memories', 'memory_distill_jobs'])
    for (const [table, change] of Object.entries(byTable)) {
      expect(change.name).toBe(`${table}_source_kind_enum`)
      expect(change.fromExpression).not.toContain('agent-run')
      expect(change.toExpression).toContain("'agent-run'")
      expect(change.toExpression).toContain("'task-run'")
      // 只加不减：老值一个都不能掉，否则存量行会在下一次写入时撞约束。
      for (const old of ['clarify', 'review', 'feedback']) {
        expect(change.toExpression).toContain(`'${old}'`)
      }
    }
    // `manual` 只在 memories 一侧——它不是蒸馏触发源。
    expect(byTable['memories']!.toExpression).toContain("'manual'")
    expect(byTable['memory_distill_jobs']!.toExpression).not.toContain("'manual'")
  })

  test('列上的 enumValues 与 CHECK 同步——同一值域的两处声明不许走散', async () => {
    const { step } = await checkStep()
    expect(step.logicalEnums).toHaveLength(2)
    for (const change of step.logicalEnums ?? []) {
      expect(change.column).toBe('source_kind')
      expect(change.toValues).toContain('agent-run')
      expect(change.toValues).toContain('task-run')
      expect(change.fromValues).not.toContain('agent-run')
    }
  })

  test('可执行 SQL 是 DROP 紧跟 ADD，最后推进契约行', async () => {
    const { step } = await checkStep()
    const ids = step.executableStatements.map((statement) => statement.logicalId)
    expect(ids).toEqual([
      'memories:check:memories_source_kind_enum:drop',
      'memories:check:memories_source_kind_enum',
      'memory_distill_jobs:check:memory_distill_jobs_source_kind_enum:drop',
      'memory_distill_jobs:check:memory_distill_jobs_source_kind_enum',
      'advance-contract-row',
    ])
    // DROP 必须紧挨着它自己的 ADD：中间插别的语句，文件跑到一半失败就会留下
    // 一张既没有旧域也没有新域的表。
    expect(step.executableStatements[0]!.sql).toContain(
      'DROP CONSTRAINT "memories_source_kind_enum"',
    )
    expect(step.executableStatements[1]!.sql).toContain(
      'ADD CONSTRAINT "memories_source_kind_enum"',
    )
  })

  test('重放整条历史到达同一个头（提交的构件自洽）', async () => {
    const committed = await history()
    const replayed = replayPostgresqlMigrationHistory(committed.root, committed.steps)
    expect(replayed.head.contract.digest).toBe(committed.head.contract.digest)
    expect(replayed.head.plan.digest).toBe(committed.head.plan.digest)
  })
})

describe('RFC-366 — 值域边的准入边界', () => {
  test('expand-only 的两种创建器当场拒绝值域改动', async () => {
    const { committed, index } = await checkStep()
    const input = {
      from: committed.versions[index]!,
      to: committed.versions[index + 1]!,
      id: STEP_ID,
      sequence: index + 1,
      previousEntryDigest:
        index === 0
          ? postgresqlMigrationDigest(committed.root)
          : committed.steps[index - 1]!.digest,
    }
    for (const create of [createPostgresqlIndexUpgrade, createPostgresqlAdditiveUpgrade]) {
      expect(() => create(input)).toThrow(
        'index-only upgrade changed a row, codec, key or disposition',
      )
    }
    // 而值域创建器能原样重建出提交的那一条（逐字节）。
    expect(createPostgresqlCheckUpgrade(input)).toEqual(committed.steps[index]!)
  })

  test('两个相邻版本之间没有值域改动时，值域创建器拒绝空边', async () => {
    const committed = await history()
    // 0001 是一条纯索引边：用值域创建器去做它，必须报「没有被替换的约束」。
    const input = {
      from: committed.versions[0]!,
      to: committed.versions[1]!,
      id: committed.steps[0]!.id,
      sequence: 1,
      previousEntryDigest: postgresqlMigrationDigest(committed.root),
    }
    expect(() => createPostgresqlCheckUpgrade(input)).toThrow(
      'check upgrade has no replaced constraint',
    )
  })

  test('V1 / V2 构件不带 V3 的键——它们的 canonical JSON 与摘要逐字节不变', async () => {
    const committed = await history()
    for (const step of committed.steps) {
      if (step.version === 3) continue
      expect(step.logicalChecks).toBeUndefined()
      expect(step.checkReplacements).toBeUndefined()
      expect(step.logicalEnums).toBeUndefined()
    }
  })

  test('篡改任一替换的 SQL 会被重放当场拒绝', async () => {
    const { committed, index, step } = await checkStep()
    const tampered = {
      ...step,
      checkReplacements: (step.checkReplacements ?? []).map((item, at) =>
        at === 0
          ? { ...item, after: { ...item.after, sql: `${item.after.sql} -- tampered` } }
          : item,
      ),
    }
    const steps = committed.steps.map((item, at) => (at === index ? tampered : item))
    expect(() => replayPostgresqlMigrationHistory(committed.root, steps)).toThrow()
  })
})

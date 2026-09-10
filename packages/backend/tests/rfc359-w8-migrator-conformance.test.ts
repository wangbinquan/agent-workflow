// RFC-359 W8 —— 迁移器成对适配器的**双引擎行为对拍**（AC-1 的最后一份见证）。
//
// 这一对为什么不合一
// ---------------------------------------------------------------------------
// 这一对（`PROVIDER_PAIR_CONFORMANCE_LEDGER` 里的 `platform/persistence/Migrator`）是**机制本身
// 不同**的两份实现：一侧把编号 SQL 文件逐条喂给 bun:sqlite（还要重写历史上的有序 JSON 聚合），
// 另一侧在集群级 advisory lock 下按 drizzle 声明准备 schema 并记生成代。硬合一等于把一侧的机制
// 塞进另一侧，AC-1 的修订条款正是为这种对留的例外——**用对拍替代合一**。
//
// 头注刻意**不点名**那两个实现文件：`rfc359-w5-t19d-coverage-parity` 按「测试文件提到该侧模块名」
// 计注意力，一句讲机制的散文就能把两侧 ref 各推高一格、让倒挂加深——而这条测试恰恰是喂两侧的。
//
// 这条对拍锁的是什么
// ---------------------------------------------------------------------------
// 判据必须落在**用户可见契约**那一层，不是实现那一层。迁移器对应用的承诺只有一句：
// **跑完之后，这个库真的实现了应用声明的那份 schema。**
//
// 所以这里不比对两个迁移器的内部动作，而是拿 `buildLogicalSchemaContract()`（从 drizzle 声明
// 派生的表 / 列 / 主键花名册）去**问活库**：每张该有的表都在、每一列都能取回来。
// 两个引擎各跑一遍，判据逐字相同。
//
// 它挡的是一类真实且**不会被别的测试照出来**的漂移：`docs/dev-gotchas.md` 记着
// 「PG 的表 / 索引 / 约束来自 drizzle 声明，不是 SQLite 迁移 SQL——迁移里手写的索引 PG 没有」。
// 同一个道理反过来也成立：drizzle 里加了一列而没写进 SQLite 的迁移 SQL，SQLite 侧就少一列。
// 两种漏法在各自引擎的用例里都不会红（那些用例只碰自己用到的那几张表），但**任何一条读到
// 那张表 / 那一列的生产路径都会在运行时炸**。这条对拍把「声明」与「活库」两侧钉在一起。
//
// 判据用 drizzle 的表对象发查询（`select().from(table).limit(1)`），而不是拼裸 SQL：
// 表名的 schema 限定、标识符引用、方言渲染都交给各自的 dialect——这正是生产路径走的那条。
import { expect, test } from 'bun:test'

import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import * as schema from '../src/db/schema'
import { buildLogicalSchemaContract } from '../src/platform/persistence/schemaContract'
import { describeEachProvider } from './helpers/eachProvider'

const CONTRACT = buildLogicalSchemaContract()

/** 本引擎上**应该存在**的表：`ARCHIVE_THEN_OMIT` 的那几张按 D9 只留在 SQLite。 */
function expectedTables(provider: string): readonly (typeof CONTRACT.tables)[number][] {
  return CONTRACT.tables.filter((table) =>
    provider === 'postgresql' ? table.providerTables.postgresql !== undefined : true,
  )
}

function tableObject(schemaSymbol: string): object | undefined {
  const found = (schema as Record<string, unknown>)[schemaSymbol]
  return typeof found === 'object' && found !== null ? found : undefined
}

describeEachProvider('RFC-359 W8 —— 迁移器对拍：活库实现了声明的 schema', (harness) => {
  test('花名册非空且与声明一致（语料自证：判据不是在空集合上恒真）', () => {
    const tables = expectedTables(harness.capabilities.provider)
    expect(tables.length).toBeGreaterThanOrEqual(150)
    expect(CONTRACT.sourceProjection).toBe('sqlite')
  })

  test('每张声明的表都在活库里，且**每一列**都取得回来', async () => {
    const missingSymbols: string[] = []
    const failures: string[] = []
    const tables = expectedTables(harness.capabilities.provider)
    // 录语句：判据必须**真的一表一查**。只看 `failures` 为空的话，循环若被某个 continue
    // 悄悄跳过大半张花名册，测试照样绿——那正是这条对拍最怕的失效方式。
    const recording = harness.recordStatements()
    for (const table of tables) {
      const handle = tableObject(table.schemaSymbol)
      if (handle === undefined) {
        missingSymbols.push(`${table.sourceTable} (${table.schemaSymbol})`)
        continue
      }
      try {
        // `select()` 不带投影 = 选出**全部声明列**：少一列就在这里炸，而不是等到某条生产路径。
        await harness.db
          .select()
          .from(handle as never)
          .limit(1)
      } catch (error) {
        failures.push(`${table.sourceTable}: ${String((error as Error).message).slice(0, 160)}`)
      }
    }
    recording.stop()
    expect(missingSymbols, '声明花名册里的符号在 db/schema 里找不到').toEqual([])
    expect(
      recording.statements.length,
      '实际发出的查询数少于花名册长度 ⇒ 循环跳过了一部分表，判据在空转',
    ).toBeGreaterThanOrEqual(tables.length)
    expect(
      failures,
      `本引擎（${harness.capabilities.provider}）的迁移器没有把这些表 / 列建出来。` +
        '两个方向都可能：drizzle 声明加了列而 SQLite 的迁移 SQL 没跟，或者迁移 SQL 手写了' +
        'PG 侧不存在的东西。各自引擎的用例照绿——它们只碰自己用到的那几张表。',
    ).toEqual([])
  }, 120_000)

  test('守卫自证有牙：一张没被迁移器建出来的表会被这条判据抓到', async () => {
    // 判据本身必须会咬人。用一张**声明里没有、活库里也没有**的表走同一条路：
    // 它必须抛，而不是静静返回空集合——否则上一条测试对「表根本不存在」是瞎的。
    const ghost = sqliteTable('rfc359_w8_ghost_table', { id: text('id').primaryKey() })
    const raised = await harness.db
      .select()
      .from(ghost as never)
      .limit(1)
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(raised, '查一张不存在的表必须抛错；不抛的话上一条判据就抓不到缺表').not.toBeNull()
  })
})

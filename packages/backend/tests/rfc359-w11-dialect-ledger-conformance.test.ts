// RFC-359 W11 —— 裸方言账本（`tests/architecture/rfc359-w5-t20-dialect-completeness.test.ts`
// 的 `RAW_DIALECT_DEBT`）四条清偿的**双引擎实测**。
//
// 四条债的形状各不相同，处置也各不相同；本文件按「清偿之后，什么必须仍然成立」逐条钉：
//
//   ① `nulls-ordering` —— 能力矩阵早已收编这条资产，但**原件还在、还有一个调用方**。
//      清偿 = 调用方改指 `engineOf(db).ascNullsFirst(...)`，原件删除。
//      要钉的是：删完之后 NULL 的落位一格没变（认领 / 时间线类查询靠它，排错了是**饿死**，
//      不是排序不好看），且全树再没有第二处渲染。
//
//   ② `indexed-by` —— 同一个「还有没有活跃执行」的存在性探针分成两份实现：一份裸写
//      `INDEXED BY`，一份走查询构造器。清偿 = 用矩阵的 `indexHint()` 合成一份。
//      要钉的是：合一之后 SQLite 侧**仍然**走覆盖索引（那正是当年裸写它的全部理由），
//      PostgreSQL 侧那句 SQL 仍然合法（矩阵在 PG 侧把索引提示渲染成空），两侧答案一致。
//
//   ③ `pg-greatest` —— 「只前进不后退」的时间戳回填在 PG 侧裸写 `GREATEST(...)`。
//      清偿 = 换成矩阵的 `greatest()`。
//      要钉的是：`greatest()` 在两个引擎上的**真实执行**——它此前一次都没有被真跑过，
//      而它是矩阵里唯一一个**两侧语义不完全相同**的算子（NULL 的处理，见下面的用例）。
//
//   ④ `for-update` —— 聚合根行锁裸写 `select … for update` 而不是调
//      `capabilities.lockAggregateRoot`。清偿 = 改调矩阵；同文件里**零生产调用方**的
//      那两个导出（它们的活路径在 W4-B1 就已经改走矩阵了）随之删除。
//      要钉的是：这个事务 opener 从此在**两个引擎上都跑得动**——裸 `for update` 在 SQLite
//      上是语法错误，所以「SQLite 也能跑」本身就是渲染权归位的可执行证据。
//
// 双引擎是缺省（`helpers/eachProvider.ts`）：缺 `AW_TEST_POSTGRESQL_URL` 是硬红不是 skip。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import ts from 'typescript'

import { CANCELABLE_TASK_STATUSES } from '@agent-workflow/shared'
import { asc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, users, workflows } from '@/db/schema'
import { withPostgresqlTaskAggregateTransaction } from '@/modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { createMaintenanceExecutionFence } from '@/platform/persistence/maintenanceExecutionFence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider } from './helpers/eachProvider'

const SRC = resolve(import.meta.dir, '..', 'src')
const OWNER = 'u_rfc359_w11_owner'

/**
 * ④ 的两个 opener 的形参类型仍写着 PG 客户端（RFC-349 把它们定为 task-execution 的私有
 * atom，本波只换渲染权、不改契约）。渲染权归位之后它们的语义已经不依赖任何一个引擎，
 * 于是同一份实现在 SQLite 客户端上也跑得动——**这正是本文件要证的事**，所以这里按客户端
 * 句柄的实际角色转型，而不是去放宽生产签名。
 */
const asClient = (db: ProviderNeutralDatabase): PostgresqlDatabaseClient =>
  db as unknown as PostgresqlDatabaseClient

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

async function seedTask(db: ProviderNeutralDatabase, startedAt: number): Promise<string> {
  const now = Date.now()
  await db
    .insert(users)
    .values({
      id: OWNER,
      username: OWNER,
      displayName: OWNER,
      role: 'user' as const,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc359-w11',
    description: '',
    definition: JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] }),
    version: 1,
    schemaVersion: 4,
  })
  const id = `t_${ulid()}`
  await db.insert(tasks).values({
    id,
    name: 'rfc359 w11 task',
    workflowId,
    workflowSnapshot: '{}',
    workflowVersion: 1,
    repoPath: '/tmp/aw-rfc359-w11-repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    baseCommit: null,
    status: 'failed' as const,
    inputs: '{}',
    startedAt,
    branchStartedAt: startedAt,
    finishedAt: startedAt + 1,
    ownerUserId: OWNER,
    repoCount: 1,
    spaceKind: 'local' as const,
    parentTaskId: null,
    executionLineageId: id,
  })
  return id
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  values: Partial<typeof nodeRuns.$inferInsert> & { nodeId: string },
): Promise<string> {
  const id = `nr_${ulid()}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    ...values,
  } as typeof nodeRuns.$inferInsert)
  return id
}

/** 一格标量：两个引擎上 `db.all` 都回一行一列的对象。 */
async function scalar(
  db: ProviderNeutralDatabase,
  query: ReturnType<typeof sql>,
): Promise<unknown> {
  const rows = (await db.all<Record<string, unknown>>(query)) as Record<string, unknown>[]
  const row = rows[0]
  return row === undefined ? undefined : Object.values(row)[0]
}

/** 数值归一：PG 的 int8 经驱动回来是字符串（矩阵的 `numericFromRawRow` 是同一判据）。 */
function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'number' ? value : Number(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// ① nulls-ordering —— 渲染权归位后语义一格没变
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W11 ① NULL 落位：矩阵是唯一渲染处', (harness) => {
  test('时间线排序：没开始过的 run（started_at IS NULL）排在最前，两个引擎同一个答案', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 1_700_000_000_000)
    await seedRun(db, taskId, { nodeId: 'b', startedAt: 20 })
    await seedRun(db, taskId, { nodeId: 'a', startedAt: null })
    await seedRun(db, taskId, { nodeId: 'c', startedAt: 10 })

    const rows = await db
      .select({ nodeId: nodeRuns.nodeId })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      .orderBy(engineOf(db).ascNullsFirst(nodeRuns.startedAt), asc(nodeRuns.nodeId))

    expect(
      rows.map((row) => row.nodeId),
      'NULL 掉到队尾 ⇒ 还没开始的 node run 在时间线上跑到了已完成的后面（PG 的默认落位）',
    ).toEqual(['a', 'c', 'b'])
  })

  test('降序同一条资产：NULL 排最后', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 1_700_000_000_000)
    await seedRun(db, taskId, { nodeId: 'b', startedAt: 20 })
    await seedRun(db, taskId, { nodeId: 'a', startedAt: null })
    await seedRun(db, taskId, { nodeId: 'c', startedAt: 10 })

    const rows = await db
      .select({ nodeId: nodeRuns.nodeId })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      .orderBy(engineOf(db).descNullsLast(nodeRuns.startedAt), asc(nodeRuns.nodeId))

    expect(rows.map((row) => row.nodeId)).toEqual(['b', 'c', 'a'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② indexed-by —— 一份实现，两个引擎；SQLite 侧仍然走覆盖索引
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W11 ② 维护围栏：一份实现，两个引擎', (harness) => {
  test('没有活跃执行 ⇒ clear', async () => {
    expect(await createMaintenanceExecutionFence(harness.db)()).toBe('clear')
  })

  test('有一条可取消状态的 node run ⇒ busy', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 1_700_000_000_000)
    const active = CANCELABLE_TASK_STATUSES[0]
    expect(active, '可取消状态集空了 ⇒ 这条围栏永远 clear，本用例零预言力').toBeDefined()
    await seedRun(db, taskId, { nodeId: 'n1', status: active as 'running' })

    expect(await createMaintenanceExecutionFence(db)()).toBe('busy')
  })

  test('终态 node run 不算活跃 ⇒ 仍是 clear（判据是状态集，不是「有没有行」）', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 1_700_000_000_000)
    await seedRun(db, taskId, { nodeId: 'n1', status: 'done' })

    expect(await createMaintenanceExecutionFence(db)()).toBe('clear')
  })

  test('探针只发一条语句，且当前引擎解释得动它（PG 侧索引提示渲染成空 ⇒ 语法仍合法）', async () => {
    const db = harness.db
    const recording = harness.recordStatements()
    try {
      expect(await createMaintenanceExecutionFence(db)()).toBe('clear')
    } finally {
      recording.stop()
    }
    const selects = recording.selects()
    expect(selects, '存在性探针不是一条 SELECT ⇒ 合一时把它拆开了').toHaveLength(1)

    const plan = await harness.explain(selects[0]!)
    expect(plan, '当前引擎解释不动这条语句 ⇒ 它在这个引擎上根本不是合法 SQL').not.toBe('')
    // **分支判据不能取自 `indexHint` 自己**——那样把索引提示改成空的变异会顺手把这条断言
    // 一起关掉（本文件落地时实测撞过一次：变异全绿）。按引擎的隔离形态分支：`exclusive`
    // 就是 SQLite。
    if (engineOf(db).isolation === 'exclusive') {
      // 判据分两层，缺一不可：
      //  · **强制**——`INDEXED BY` 必须真的出现在发出去的语句里。这是唯一能咬住「索引提示
      //    被合一时弄丢了」的判据：空库上 planner 本来就会选覆盖索引，所以下面那条计划断言
      //    在**这里**不discriminate（实测：把矩阵的 indexHint 改成空，计划一字不变）。裸写它
      //    的理由是满量语料 + ANALYZE 之后 planner 会改选整表扫，而那个规模不适合进单测。
      //  · **语义**——计划里确实走了那条索引，保证提示指向的索引名没写错、也还存在。
      expect(
        selects[0]!.sql,
        '索引提示在合一里丢了 ⇒ 满库终态 node run 时这条探针会退化成整表扫',
      ).toContain('INDEXED BY')
      expect(plan, '提示指向的索引不存在 / 名字写错了 ⇒ 提示形同虚设').toContain(
        'idx_node_runs_status_active',
      )
    } else {
      expect(
        selects[0]!.sql,
        'PG 上出现了 SQLite 的索引强制语法 ⇒ 那句 SQL 在 PG 上根本不合法',
      ).not.toContain('INDEXED BY')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ pg-greatest —— 矩阵算子的首次双引擎真实执行（含 NULL 分歧）
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W11 ③ greatest()：两个引擎上的真实执行', (harness) => {
  test('取两者之大，左右对称', async () => {
    const engine = engineOf(harness.db)
    expect(
      asNumber(await scalar(harness.db, sql`select ${engine.greatest(sql`1`, sql`2`)} as v`)),
    ).toBe(2)
    expect(
      asNumber(await scalar(harness.db, sql`select ${engine.greatest(sql`2`, sql`1`)} as v`)),
    ).toBe(2)
    expect(
      asNumber(await scalar(harness.db, sql`select ${engine.greatest(sql`7`, sql`7`)} as v`)),
    ).toBe(7)
    expect(
      asNumber(await scalar(harness.db, sql`select ${engine.greatest(sql`-3`, sql`-9`)} as v`)),
    ).toBe(-3)
  })

  test('生产用法：COALESCE 包住可空侧之后，两个引擎给同一个答案（NULL / 0 / 更小 / 更大）', async () => {
    const engine = engineOf(harness.db)
    const bump = (stored: string, incoming: number) =>
      scalar(
        harness.db,
        sql`select ${engine.greatest(sql`coalesce(${sql.raw(stored)}, 0)`, sql`${incoming}`)} as v`,
      )
    expect(
      asNumber(await bump('null', 50)),
      '存量为 NULL 时回填不到新值 ⇒ 分支时间戳永远是空',
    ).toBe(50)
    expect(asNumber(await bump('0', 50))).toBe(50)
    expect(asNumber(await bump('90', 50)), '回填把时间戳往回拨了 ⇒ 它不再是「只前进」').toBe(90)
    expect(asNumber(await bump('50', 50))).toBe(50)
  })

  test('前提：裸的 NULL 参数在两个引擎上**不同**——所以生产用法里的 COALESCE 是必需的', async () => {
    const engine = engineOf(harness.db)
    const withNull = asNumber(
      await scalar(harness.db, sql`select ${engine.greatest(sql`null`, sql`5`)} as v`),
    )
    // SQLite 的多参数 max：任一参数为 NULL ⇒ 结果 NULL。
    // PostgreSQL 的 GREATEST：忽略 NULL，全 NULL 才回 NULL。
    // 这条分歧**没有**被矩阵抹平（抹平要在两侧各包一层 COALESCE，会改变「全 NULL」那一格的
    // 语义），所以它是调用方的责任：可空侧必须自己 COALESCE。哪天矩阵决定抹平它，先红在这里。
    const exclusive = engineOf(harness.db).isolation === 'exclusive'
    expect(
      withNull,
      exclusive
        ? 'SQLite 的多参数 max 不再对 NULL 传染 ⇒ 「可空侧必须 COALESCE」这条纪律的前提变了'
        : 'PostgreSQL 的 GREATEST 不再忽略 NULL ⇒ 同上',
    ).toBe(exclusive ? null : 5)
  })

  test('落到真列上：祖先链的分支时间戳只前进不后退', async () => {
    const db = harness.db
    const engine = engineOf(db)
    const taskId = await seedTask(db, 100)
    const bumpTo = async (occurredAt: number): Promise<void> => {
      await db
        .update(tasks)
        .set({
          branchStartedAt: engine.greatest(
            sql`coalesce(${tasks.branchStartedAt}, 0)`,
            sql`${occurredAt}`,
          ),
        })
        .where(eq(tasks.id, taskId))
    }
    const read = async (): Promise<number | null> =>
      asNumber(
        (await db.select({ v: tasks.branchStartedAt }).from(tasks).where(eq(tasks.id, taskId)))[0]
          ?.v,
      )

    await bumpTo(200)
    expect(await read()).toBe(200)
    await bumpTo(150)
    expect(await read(), '更早的子任务把祖先的分支时间戳往回拨了').toBe(200)
    await bumpTo(300)
    expect(await read()).toBe(300)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ for-update —— 聚合根行锁改调矩阵之后，同一个 opener 在两个引擎上都跑得动
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W11 ④ 聚合根行锁：渲染权归矩阵', (harness) => {
  test('事务 opener 在两个引擎上都跑得动（裸 `for update` 在 SQLite 上是语法错误）', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 100)

    const seen = await withPostgresqlTaskAggregateTransaction(asClient(db), taskId, async (tx) => {
      const rows = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      return rows.length
    })

    expect(seen, '事务体没看见被锁的那一行').toBe(1)
  })

  test('行锁只在需要它的引擎上发语句：PG 发一条 FOR UPDATE，SQLite 一条不发（已独占）', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 100)
    const exclusive = engineOf(db).isolation === 'exclusive'

    const recording = harness.recordStatements()
    try {
      await withPostgresqlTaskAggregateTransaction(asClient(db), taskId, async () => undefined)
    } finally {
      recording.stop()
    }
    const locks = recording.statements.filter((statement) => /for\s+update/i.test(statement.sql))

    if (exclusive) {
      expect(
        locks,
        'SQLite 上发出了行锁语句 ⇒ 渲染权没在矩阵手里（SQLite 没有 FOR UPDATE，BEGIN IMMEDIATE 已独占）',
      ).toEqual([])
    } else {
      expect(locks, 'PG 上没有行锁 ⇒ 「读—改—写」中间不锁，回到 RFC-349 之前的竞态').toHaveLength(1)
      expect(locks[0]!.sql.toLowerCase(), '锁错了表').toContain('tasks')
    }
  })

  test('隔离级别没有被顺手抬高（SERIALIZABLE 回来 ⇒ 跨任务假冲突一起回来）', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 100)

    const recording = harness.recordStatements()
    try {
      await withPostgresqlTaskAggregateTransaction(asClient(db), taskId, async () => undefined)
    } finally {
      recording.stop()
    }

    for (const statement of recording.statements) {
      expect(statement.sql.toUpperCase()).not.toContain('SERIALIZABLE')
    }
  })

  test('体内抛错 ⇒ 整笔回滚（两个引擎同一个语义）', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 100)
    const runId = `nr_${ulid()}`

    await expect(
      withPostgresqlTaskAggregateTransaction(asClient(db), taskId, async (tx) => {
        await tx.insert(nodeRuns).values({
          id: runId,
          taskId,
          nodeId: 'n1',
          status: 'done',
          retryIndex: 0,
          iteration: 0,
        } as typeof nodeRuns.$inferInsert)
        throw new Error('body failed')
      }),
    ).rejects.toThrow('body failed')

    const rows = await db.select({ id: nodeRuns.id }).from(nodeRuns).where(eq(nodeRuns.id, runId))
    expect(rows, '体内抛错却留下了行 ⇒ 这笔事务没有回滚').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 渲染权归位的源码锁：账本上的四条各留一个「不许回来」的锚点
//
// 这几条与上面的行为判据互补——行为判据证明「新写法是对的」，源码锁证明「旧写法没有
// 第二处存活」。本仓的经验是后者更容易在重构里被静默恢复（守卫没红不是证据，它可能
// 只是不再看那些代码了）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个源文件里的全部**字符串 / 模板字面量文本**（走 AST）。判「这段方言还在不在」只能看
 * 会被发往数据库的那些文本——`text.includes(...)` 会把**注释**一起算进去，而退役理由恰恰
 * 就写在同一份文件的注释里（本仓踩过同族的坑：按文本出现次数计的守卫，注释与字符串字面量
 * 都会计入）。
 */
function literalTexts(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) out.push(node.text)
    else if (ts.isTemplateExpression(node)) {
      out.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ? '))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

let cachedSources: ReadonlyMap<string, string> | undefined

/** 整棵 backend src，按相对路径缓存（全树扫描的守卫必须缓存，否则在 CI 分片上按秒累加）。 */
function sources(): ReadonlyMap<string, string> {
  if (cachedSources !== undefined) return cachedSources
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.set(rel, readFileSync(join(SRC, rel), 'utf8'))
    }
  }
  walk('')
  cachedSources = out
  return out
}

describe('RFC-359 W11 —— 四条清偿的源码锚点', () => {
  test('语料下限：扫空了下面每条断言都是假绿', () => {
    expect(sources().size, '扫到的 backend 源文件太少 ⇒ 扫描根失效').toBeGreaterThanOrEqual(1_500)
  }, 30_000)

  test('① NULL 落位只剩矩阵一处渲染：独立的 postgresqlNullOrdering 模块已退役', () => {
    const survivors = [...sources()]
      .filter(([, text]) => text.includes('postgresqlNullOrdering'))
      .map(([path]) => path)
      .sort()
    expect(
      survivors,
      '还有文件在引用已退役的 NULL 排序原件 ⇒ 同一个方言点两份渲染，改一处不会红另一处。' +
        '正确动作：改调 `engineOf(db).ascNullsFirst / descNullsLast`。',
    ).toEqual([])
  }, 30_000)

  test('③ task-execution 里不再有裸写的 GREATEST：只前进不后退的回填一律走矩阵', () => {
    const offenders = [...sources()]
      .filter(
        ([path, text]) =>
          path.startsWith('modules/task-execution/') &&
          literalTexts(path, text).some((fragment) => /\bgreatest\s*\(/iu.test(fragment)),
      )
      .map(([path]) => path)
      .sort()
    expect(
      offenders,
      'PG 专属的 GREATEST 又被裸写进来了 ⇒ 它的 SQLite 孪生只能另写一份 max(...)，两份实现从此各漂各的。' +
        '正确动作：`engineOf(tx).greatest(左, 右)`，可空侧自己 COALESCE（见上面的 NULL 用例）。',
    ).toEqual([])
  }, 30_000)

  test('④ 聚合根行锁改调矩阵，且两个零生产调用方的导出已删除', () => {
    const text = sources().get(
      'modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts',
    )
    const module = 'modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts'
    expect(text, '生命周期事务模块不见了 ⇒ 本条断言零预言力').toBeDefined()
    expect(
      literalTexts(module, text ?? '').filter((fragment) => /\bfor\s+update\b/iu.test(fragment)),
      '裸写 `select … for update` 回来了 ⇒ 同一个聚合根锁又有了第二份渲染，矩阵改了这里不会跟着改',
    ).toEqual([])
    expect(text).toContain('lockAggregateRoot(')

    // 判「导出面」而不是「文本里提没提到」：退役理由写在同一份文件的注释里，那是**应该**
    // 留下的（删掉会连同「这里曾经有一对死代码」这个信息一起丢掉）。
    const exported = [
      ...(text ?? '').matchAll(
        /^export\s+(?:declare\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ]
      .map((match) => match[1])
      .sort()
    expect(
      exported,
      'node run 那一对（非 SERIALIZABLE 的事务边界 + node_runs 行锁）回来了：它在 W4-B1 之后' +
        '就零生产调用方——写路径已合成一份并改走统一写事务原语 + 矩阵的 lockAggregateRoot。' +
        '留着只会让下一次「谁在用它」的普查再数错一次（判零消费者时要把测试排除在消费者之外）。',
    ).toEqual([
      'PostgresqlTaskExecutionTransaction',
      'withPostgresqlSerializableTaskExecution',
      'withPostgresqlTaskAggregateTransaction',
    ])
  }, 30_000)
})

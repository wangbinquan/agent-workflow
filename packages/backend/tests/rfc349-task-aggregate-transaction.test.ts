// RFC-349 —— 成员替换从 SERIALIZABLE 换成「聚合根行锁 + READ COMMITTED」的回归锁。
//
// 为什么换：2026-09-03 托管取证里 31 个用户可见的 500 全是同一条——
// `PUT /api/tasks/:id/members` 的 SERIALIZABLE 冲突耗尽重试预算。对着真 PostgreSQL 的
// 合成实验（10 万行、32 并发）逐项排除后定位到根因是 predicate lock 落在索引**页**而不是
// 行，于是改**不同任务**的事务也互判读写依赖：
//
//   基线（SERIALIZABLE）                     22.9%
//   去掉 generation fence 那次读                  23.1%   ← 不是 fence
//   读改成整主键精确命中                          22.7%   ← 不是读的形状
//   删掉 user 索引 / 每任务换不同 user      22.5% / 22.7%  ← 不是热点用户
//   去掉 insert（只 delete）                       0%     ← 冲突来自 delete+insert 这一对
//   READ COMMITTED + 聚合根 FOR UPDATE            0.0%
//
// 重试预算填不平：取证门同时要求 `httpErrors === 0` 与单请求 < 1000ms，加重试只会把尾延迟
// 推高（托管 2 核上已量到 API max 1066.8ms）。
import { describe, expect, test } from 'bun:test'
import { getTableName, is, Table } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { withPostgresqlTaskAggregateTransaction } from '@/modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction'

const backendRoot = resolve(import.meta.dir, '..')

/** Flatten a drizzle SQL template into the literal text it will render. */
function literalText(query: unknown): string {
  const chunks = (query as { queryChunks?: readonly unknown[] }).queryChunks ?? []
  const parts: string[] = []
  const walk = (chunk: unknown): void => {
    if (typeof chunk === 'string') parts.push(chunk)
    else if (Array.isArray(chunk)) for (const item of chunk) walk(item)
    else if (chunk !== null && typeof chunk === 'object') {
      // Tables and columns are objects, not strings: render their names so an
      // assertion can tell `node_runs` from any other row lock.
      const columnName = (chunk as { name?: unknown }).name
      if (is(chunk, Table)) parts.push(getTableName(chunk))
      else if (typeof columnName === 'string') parts.push(columnName)
      const value = (chunk as { value?: unknown }).value
      if (value !== undefined) walk(value)
    }
  }
  for (const chunk of chunks) walk(chunk)
  return parts.join('')
}

function recordingClient(): {
  readonly db: PostgresqlDatabaseClient
  readonly statements: string[]
  readonly order: string[]
} {
  const statements: string[] = []
  const order: string[] = []
  const db = {
    // RFC-359 W5-T18：这几个 helper 的事务边界改走中立会话 `databaseSessionFor(db)`，
    // 而它按客户端句柄自述的 `$provider` 品牌分派（`platform/persistence/databaseTransaction.ts`
    // 的 `databaseProviderOf`：没有品牌 ⇒ 当 bun:sqlite 处理，会去发 `BEGIN IMMEDIATE`）。
    // 假客户端必须像真客户端一样自报家门，否则它冒充的就不是 PostgreSQL 客户端。
    $provider: 'postgresql',
    async transaction<T>(body: (tx: unknown) => Promise<T>): Promise<T> {
      order.push('begin')
      return await body({
        // RFC-359 W11：行锁的渲染权归能力矩阵，而矩阵按**事务句柄**自述的 `resultKind` 取引擎
        // （`engineOf`：sqlite-proxy 是 `'async'`，bun:sqlite 是 `'sync'`）。判据一字未变——
        // 假事务句柄同样要自报家门，否则它冒充的是 SQLite，行锁会被渲染成 no-op。
        resultKind: 'async',
        async run(query: unknown) {
          statements.push(literalText(query))
          order.push('run')
        },
      })
    },
  } as unknown as PostgresqlDatabaseClient
  return { db, statements, order }
}

describe('RFC-349 single-aggregate task transaction', () => {
  test('locks the aggregate root row before the body runs', async () => {
    const client = recordingClient()

    await withPostgresqlTaskAggregateTransaction(client.db, 'task-1', async () => {
      client.order.push('body')
      return 'done'
    })

    expect(client.order).toEqual(['begin', 'run', 'body'])
    expect(client.statements).toHaveLength(1)
    expect(client.statements[0]?.toLowerCase(), '没有 FOR UPDATE 就没有任何互斥').toContain(
      'for update',
    )
  })

  test('does not raise the isolation level: that is the whole point', async () => {
    const client = recordingClient()

    await withPostgresqlTaskAggregateTransaction(client.db, 'task-1', async () => undefined)

    for (const statement of client.statements) {
      expect(
        statement.toUpperCase(),
        'SERIALIZABLE 回来了 ⇒ 跨任务的假冲突也一起回来了',
      ).not.toContain('SERIALIZABLE')
    }
  })

  test('the body result is returned and its failure is not swallowed', async () => {
    const client = recordingClient()

    await expect(
      withPostgresqlTaskAggregateTransaction(client.db, 'task-1', async () => {
        throw new Error('body failed')
      }),
    ).rejects.toThrow('body failed')
  })

  test('member replacement uses it, and the shared serializable helper is still there for the rest', () => {
    const source = readFileSync(
      resolve(
        backendRoot,
        'src/modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts',
      ),
      'utf8',
    )
    const replaceMembers = source.slice(source.indexOf('async function replaceTaskMembers'))
    const body = replaceMembers.slice(
      0,
      replaceMembers.indexOf('\nfunction workflowLaunchSnapshot'),
    )

    expect(body).toContain('withPostgresqlTaskAggregateTransaction')
    expect(body, '成员替换又回到 SERIALIZABLE ⇒ 托管上那 31 个 500 会一起回来').not.toContain(
      'withPostgresqlSerializableTaskExecution',
    )
    // 跨聚合不变量仍然必须留在 SERIALIZABLE 上；别把这次替换扩大成全面降级。
    expect(source).toContain('withPostgresqlSerializableTaskExecution(')
  })

  test('the helper documents when it may be used at all', () => {
    const source = readFileSync(
      resolve(
        backendRoot,
        'src/modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts',
      ),
      'utf8',
    )
    const doc = source.slice(
      0,
      source.indexOf('export async function withPostgresqlTaskAggregateTransaction'),
    )
    expect(doc).toContain('同一个聚合根')
    expect(doc).toContain('withPostgresqlSerializableTaskExecution')
  })
})

// —————————————————————————————————————————————————————————————————————————————
// 2026-09-03 第二例同类：node run 的写事务。
//
// 这几个是产品里最热的写——agent 每吐一行 stdout/stderr 就 `appendEvents` 一次，而它们
// 全都先过 `assertPostgresqlTaskOwnerTx`（对 `task_execution_owners` 的条件 UPDATE）。
// 那张表每个任务只有一行，**全新安装 / 小库割接后就是一张几行的小表**，小表上 predicate
// lock 落到页这一级，于是每个任务的写都和其它任务的写互判读写依赖。对着真 PostgreSQL
// （10 万任务的迁移目标库、只把 owners 缩到 4 行）实测：
//
//   8 并发满速     SERIALIZABLE  冲突率 81.2%，逃逸 234，156 ops/s，p95 106.4ms
//                  聚合根行锁    冲突率  0.0%，逃逸   0，893 ops/s，p95  11.7ms
//   4 并发 × 20 次/秒（真实速率）
//                  SERIALIZABLE  冲突率 63.0%，逃逸   1，p95 50.7ms
//                  聚合根行锁    冲突率  0.0%，逃逸   0，p95 24.9ms
//
// 生产规模（owners 10 万行）下 SERIALIZABLE 只有 0.25% 且零逃逸——所以这条回归锁的是
// **小部署**这一形态，别因为「大库上看起来没事」把它改回去。
//
// RFC-359 W11：这一档当年的两个 PG 私有 helper（非 SERIALIZABLE 的事务边界 + `node_runs` 行的
// 聚合根锁）**已删除**——W4-B1 把两份 provider 投影合成一份之后它们就零生产调用方，只剩这份
// 测试还在引用，也就是「测试在给死代码续命」。判据一格没少：下面这条源码锁盯的一直是**活的**
// 那条路径（统一写事务原语 + 能力矩阵的 `lockAggregateRoot`），此前那两条只是在验一段没人跑的
// 代码。事务边界本身的回滚 / 可重入语义由 `rfc359-w5-t18-…` 与 `rfc359-w11-…` 在两个引擎上跑。
describe('RFC-349 single-aggregate node run transaction', () => {
  test('every node-run writer uses it, and the fence takes the lock after the owner check', () => {
    // RFC-359 W4-B1 批 2f：两份 provider 投影合成一份（nodeExecutionPersistence.ts），写事务走统一原语
    // （PG 上 READ COMMITTED），聚合根行锁经能力矩阵 `lockAggregateRoot` 表达。
    const source = readFileSync(
      resolve(backendRoot, 'src/modules/task-execution/infrastructure/nodeExecutionPersistence.ts'),
      'utf8',
    )
    expect(
      source,
      'node run 的写手回到 SERIALIZABLE ⇒ 小部署上 agent 输出会边写边丢',
    ).not.toContain('serializable(')
    // patch / upsertOutputs / replaceOutputs / appendEvents / retagSessionEpochs
    expect(source.split('withTaskExecutionWrite(this.db').length - 1).toBe(5)

    const fence = source.slice(
      source.indexOf('async function fencedTaskId'),
      source.indexOf('export class DrizzleNodeExecutionPersistence'),
    )
    const owner = fence.indexOf('fenceTaskWrite(')
    const lock = fence.indexOf('lockAggregateRoot(')
    expect(owner, 'fence 不见了').toBeGreaterThan(-1)
    expect(
      lock,
      '聚合根行锁跑到 owner fence 之前 ⇒ 和「先 fence 再动 node_runs」的其它写手锁序相反，会死锁',
    ).toBeGreaterThan(owner)
  })
})

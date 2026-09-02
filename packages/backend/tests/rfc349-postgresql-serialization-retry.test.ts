// RFC-349 —— SERIALIZABLE 的合同是「冲突了要重试」，而本仓的重试判据以前一次都没
// 命中过。
//
// Bun.SQL 的 `PostgresError` 把 SQLSTATE 放在 **`errno`**，`code` 恒为
// `ERR_POSTGRES_SERVER_ERROR`（本机对着真 PostgreSQL 实测：`SELECT 1/0` 得到
// `{ name: 'PostgresError', code: 'ERR_POSTGRES_SERVER_ERROR', errno: '22012' }`）。
// 十九处 `if (code === '40001' || code === '40P01')` 于是全是死代码：托管取证跑里
// `PUT /api/tasks/:id/members` 的并发写打出 77 次
// `could not serialize access due to read/write dependencies among transactions`，
// 每一次都直接变成用户可见的 500，还顺带把连接留在失败事务里，后续复用该连接的
// 事务再吃 36 次 `SET TRANSACTION ISOLATION LEVEL must be called before any query`。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { withPostgresqlSerializableTaskExecution } from '@/modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction'

const SRC_ROOT = resolve(import.meta.dir, '..', 'src')

function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

/** What Bun.SQL actually throws for a server error. */
function bunPostgresError(sqlState: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: sqlState,
    severity: 'ERROR',
  })
}

function clientThatFails(errors: readonly unknown[]): {
  readonly db: PostgresqlDatabaseClient
  attempts(): number
} {
  const pending = [...errors]
  let attempts = 0
  const db = {
    async transaction<T>(body: (tx: unknown) => Promise<T>): Promise<T> {
      attempts += 1
      const failure = pending.shift()
      if (failure !== undefined) throw failure
      return await body({ async run() {} })
    },
  } as unknown as PostgresqlDatabaseClient
  return { db, attempts: () => attempts }
}

describe('RFC-349 PostgreSQL serialization retry', () => {
  test('a Bun-shaped serialization failure is retried, not surfaced', async () => {
    const fixture = clientThatFails([
      bunPostgresError(
        '40001',
        'could not serialize access due to read/write dependencies among transactions',
      ),
    ])

    await expect(
      withPostgresqlSerializableTaskExecution(fixture.db, async () => 'committed'),
    ).resolves.toBe('committed')
    expect(fixture.attempts()).toBe(2)
  })

  test('a deadlock nested under drizzle’s query wrapper is retried too', async () => {
    const fixture = clientThatFails([
      Object.assign(new Error('Failed query: insert into "agent_workflow"."task_collaborators"'), {
        cause: bunPostgresError('40P01', 'deadlock detected'),
      }),
    ])

    await expect(
      withPostgresqlSerializableTaskExecution(fixture.db, async () => 'committed'),
    ).resolves.toBe('committed')
    expect(fixture.attempts()).toBe(2)
  })

  test('an unrelated failure still propagates on the first attempt', async () => {
    const fixture = clientThatFails([bunPostgresError('23505', 'duplicate key value')])

    await expect(
      withPostgresqlSerializableTaskExecution(fixture.db, async () => 'committed'),
    ).rejects.toThrow('duplicate key value')
    expect(fixture.attempts()).toBe(1)
  })

  test('every retry predicate in src reads the SQLSTATE Bun actually sets', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes("'40001'")) continue
      if (source.includes('errno')) continue
      offenders.push(file.slice(SRC_ROOT.length + 1))
    }
    expect(offenders).toEqual([])
  })
})

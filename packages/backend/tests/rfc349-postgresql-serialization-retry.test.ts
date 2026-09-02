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
import {
  POSTGRESQL_SERIALIZATION_ATTEMPTS,
  postgresqlSerializationBackoffMs,
  postgresqlSerializationFailureCode,
  retryPostgresqlSerialization,
} from '@/db/postgresqlSerializationRetry'

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

  // 2026-09-02：本机 100 客户端全量取证实测——服务端记录 3210 次 40001，其中 429 次
  // （13.4%）耗尽「3 次、无退避」的预算后原样变成 500，`postgresql-normal` 相位因此
  // 判红（`runtimePhaseFailures` 要求 httpErrors===0）。预算与退避从此只有一份。
  test('the SQLSTATE decision lives in exactly one module', () => {
    const owners: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8')
      if (!/(?:code|sqlState|errno)\s*===\s*'40001'/.test(source)) continue
      owners.push(file.slice(SRC_ROOT.length + 1))
    }
    expect(
      owners,
      '又有人自带了一份 SQLSTATE 判据。判据、重试预算与退避是一体的策略，' +
        '复制一份就意味着那条路径悄悄退回「3 次、无退避」',
    ).toEqual(['db/postgresqlSerializationRetry.ts'])
  })

  test('the shared policy reads both code and errno, through the cause chain', () => {
    expect(postgresqlSerializationFailureCode(bunPostgresError('40001', 'conflict'))).toBe('40001')
    expect(
      postgresqlSerializationFailureCode(
        Object.assign(new Error('Failed query: commit'), {
          cause: bunPostgresError('40P01', 'deadlock detected'),
        }),
      ),
    ).toBe('40P01')
    // Some drivers put SQLSTATE on `code` directly; both spellings decide the same.
    expect(
      postgresqlSerializationFailureCode(Object.assign(new Error('x'), { code: '40001' })),
    ).toBe('40001')
    expect(
      postgresqlSerializationFailureCode(bunPostgresError('23505', 'duplicate')),
    ).toBeUndefined()
    expect(postgresqlSerializationFailureCode('boom')).toBeUndefined()
  })

  test('the budget is bounded and every retry backs off with full jitter', async () => {
    expect(POSTGRESQL_SERIALIZATION_ATTEMPTS).toBeGreaterThan(3)

    // Full jitter: the delay is uniform in [0, ceiling), and the ceiling doubles
    // per attempt until it is capped. A fixed delay would let a batch of
    // conflicting transactions retry in lockstep and collide again.
    expect(postgresqlSerializationBackoffMs(0, () => 0.999)).toBeCloseTo(2 * 0.999, 5)
    expect(postgresqlSerializationBackoffMs(3, () => 0.999)).toBeCloseTo(16 * 0.999, 5)
    expect(postgresqlSerializationBackoffMs(0, () => 0)).toBe(0)
    // Capped, so a long budget cannot blow the evidence gate's 1000ms per request.
    const worst = Array.from({ length: POSTGRESQL_SERIALIZATION_ATTEMPTS }, (_unused, attempt) =>
      postgresqlSerializationBackoffMs(attempt, () => 1),
    ).reduce((total, delay) => total + delay, 0)
    expect(worst).toBeLessThan(200)

    const conflict = bunPostgresError('40001', 'conflict')
    expect(await retryPostgresqlSerialization(0, conflict)).toBe(true)
    expect(
      await retryPostgresqlSerialization(POSTGRESQL_SERIALIZATION_ATTEMPTS - 1, conflict),
    ).toBe(false)
    expect(await retryPostgresqlSerialization(0, bunPostgresError('23505', 'duplicate'))).toBe(
      false,
    )
  })

  test('a task-execution transaction consumes the whole shared budget before failing', async () => {
    const conflicts = Array.from({ length: POSTGRESQL_SERIALIZATION_ATTEMPTS - 1 }, () =>
      bunPostgresError('40001', 'conflict'),
    )
    const fixture = clientThatFails(conflicts)

    await expect(
      withPostgresqlSerializableTaskExecution(fixture.db, async () => 'committed'),
    ).resolves.toBe('committed')
    expect(fixture.attempts()).toBe(POSTGRESQL_SERIALIZATION_ATTEMPTS)
  })
})

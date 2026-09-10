// RFC-359 W8 —— 夹具复位 `TRUNCATE` 的 40P01 重试策略。
//
// 这条用例锁的是 2026-09-11 CI ubuntu shard 6 的那次红：`tasks-multipart.test.ts` 的
// `[postgresql]` 半边报 `40P01 deadlock detected`，现场是同一个库里两个 backend 互等
// （一个要 AccessExclusiveLock、一个要 AccessShareLock）。成因不是跨文件争用（每文件一库
// 已经消掉那一类），而是**文件内部**：真 HTTP 应用的后台维护作业在用例之间继续读表，
// 与 `beforeEach` 的整表 `TRUNCATE` 锁序相反。
//
// 处置是有界重试，而重试最容易退化成「重跑就过了」。所以判据写在**纯函数**上，逐条钉死：
// 非序列化错一次都不重试、预算耗尽照样抛、重试次数有上限。改宽任何一条都会在这里红。
import { describe, expect, test } from 'bun:test'

import { retryOnPostgresqlSerializationFailure } from './helpers/eachProvider'

/** Bun.SQL 的 `PostgresError` 形状：SQLSTATE 在 `errno`，`code` 恒为通用值。 */
function postgresError(sqlState: string): Error {
  return Object.assign(new Error(`postgres ${sqlState}`), {
    errno: sqlState,
    code: 'ERR_POSTGRES_SERVER_ERROR',
  })
}

const noSleep = async (): Promise<void> => undefined

describe('RFC-359 W8 —— 夹具 TRUNCATE 的序列化失败重试', () => {
  test('一次就成功时不重试，也不睡', async () => {
    let calls = 0
    let slept = 0
    const value = await retryOnPostgresqlSerializationFailure(
      async () => {
        calls += 1
        return 'ok'
      },
      {
        maxAttempts: 4,
        sleep: async () => {
          slept += 1
        },
      },
    )
    expect(value).toBe('ok')
    expect(calls).toBe(1)
    expect(slept).toBe(0)
  })

  test('40P01 / 40001 会重试，退避随尝试次数增长', async () => {
    for (const sqlState of ['40P01', '40001']) {
      let calls = 0
      const delays: number[] = []
      const value = await retryOnPostgresqlSerializationFailure(
        async () => {
          calls += 1
          if (calls < 3) throw postgresError(sqlState)
          return calls
        },
        {
          maxAttempts: 4,
          sleep: async (ms) => {
            delays.push(ms)
          },
        },
      )
      expect(value).toBe(3)
      expect(calls).toBe(3)
      expect(delays).toEqual([25, 50])
    }
  })

  test('包在 drizzle 的 `cause` 链里也认得出来（只看最外层的判据一次都不会命中）', async () => {
    let calls = 0
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: postgresError('40P01'),
    })
    await retryOnPostgresqlSerializationFailure(
      async () => {
        calls += 1
        if (calls === 1) throw wrapped
        return calls
      },
      { maxAttempts: 4, sleep: noSleep },
    )
    expect(calls).toBe(2)
  })

  test('非序列化失败一次都不重试，原样抛出', async () => {
    let calls = 0
    const boom = postgresError('23503')
    await expect(
      retryOnPostgresqlSerializationFailure(
        async () => {
          calls += 1
          throw boom
        },
        { maxAttempts: 4, sleep: noSleep },
      ),
    ).rejects.toBe(boom)
    expect(calls).toBe(1)
  })

  test('预算耗尽照样抛——重试不是「重跑就过了」的许可证', async () => {
    let calls = 0
    const boom = postgresError('40P01')
    await expect(
      retryOnPostgresqlSerializationFailure(
        async () => {
          calls += 1
          throw boom
        },
        { maxAttempts: 4, sleep: noSleep },
      ),
    ).rejects.toBe(boom)
    expect(calls).toBe(4)
  })
})

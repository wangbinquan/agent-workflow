// RFC-359 AC-8 —— 准入在两个引擎上给同一个回答：并发续跑的输家拿到 `task-continuation-conflict`，
// 永远不会是裸驱动错误。
//
// 这条判据存在的理由（2026-09-11 CI 实撞两轮）：准入的跨行不变量走 SERIALIZABLE，PostgreSQL 的
// SSI 把并发准入判成 40001。`serializable()` 按满抖动退避重试 10 次，绝大多数情况下重试后的那一遍
// 就在「活跃 intent 检查」上拿到领域错误——但预算耗尽时原先会把 40001 原样抛出去，于是同一场竞争
// SQLite 回 409、PostgreSQL 回 500。`rfc359-w8-t29-unique-insert-conflict` 的并发续跑判据连红两轮，
// 逐层导出的 cause 链坐实是 `1:PostgresError/code=ERR_POSTGRES_SERVER_ERROR/errno=40001`
//（完整取证在 `docs/audit-backlog.md`）。
//
// 本文件锁的是**翻译本身**，而不是那场竞争：真库跑不出「必然耗尽预算」，所以直接对着注入的
// 驱动错误验——判据因此是确定的、不靠时序。那场竞争本身仍由 `rfc359-w8-t29-unique-insert-conflict`
// 在两个引擎上守着。
import { describe, expect, test } from 'bun:test'

import { TaskExecutionError } from '@/modules/task-execution/application/taskExecutionError'
import { admissionSerializationConflict } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'

/** Bun.SQL 的 `PostgresError` 形状：SQLSTATE 在 `errno`，被 drizzle 包进外层 `Error.cause`。 */
function driverSerializationFailure(sqlState: '40001' | '40P01'): Error {
  const driver = Object.assign(new Error('could not serialize access'), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: sqlState,
  })
  return Object.assign(new Error('Failed query: insert into "task_execution_intents" …'), {
    cause: driver,
  })
}

describe('RFC-359 AC-8 —— 准入耗尽序列化重试后仍然是领域冲突', () => {
  test.each(['40001', '40P01'] as const)(
    '%s 被翻成 task-continuation-conflict（409），原始驱动错误保留在 cause 上',
    (sqlState) => {
      const driverError = driverSerializationFailure(sqlState)
      const conflict = admissionSerializationConflict('task-admission', driverError)
      expect(conflict).toBeInstanceOf(TaskExecutionError)
      expect(conflict?.code).toBe('task-continuation-conflict')
      expect(conflict?.status).toBe(409)
      expect(conflict?.message).toContain('task-admission')
      // 原始 SQLSTATE 不能丢：日志与后续归因都靠它。
      expect((conflict as unknown as { cause?: unknown }).cause).toBe(driverError)
    },
  )

  test('不是序列化冲突的就不翻——这一层只认它认识的那两个 SQLSTATE', () => {
    for (const other of [
      Object.assign(new Error('check violation'), { name: 'PostgresError', errno: '23514' }),
      Object.assign(new Error('unique violation'), { name: 'PostgresError', errno: '23505' }),
      new Error('plain'),
      undefined,
    ]) {
      expect(admissionSerializationConflict('task-admission', other)).toBeUndefined()
    }
  })

  test('两个准入入口都经这一层收口（源码锁：漏接一个就等于那条路仍然回 500）', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'infrastructure',
        'taskExecutionIntentPersistence.ts',
      ),
      'utf8',
    )
    expect(
      source.match(/throw admissionSerializationConflict\([^)]*\) \?\? error/g) ?? [],
    ).toHaveLength(2)
  })
})

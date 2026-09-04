// RFC-359 —— 对账 F-I-13 的回归防护。
//
// 为什么这条测试存在：`isPostgresqlUniqueViolation` 此前只看 `code === '23505'`，而 Bun.SQL 把
// SQLSTATE 放在 `errno`、`code` 恒为 `ERR_POSTGRES_SERVER_ERROR`（2026-09-04 对本机 postgres:17.11
// 实测，形状逐字如下）。于是它在真 PostgreSQL 上恒返回 false，并发同名新建/重命名拿到的是
// 500 internal-error 而不是 409 `*-name-in-use`。本仓在 postgresqlSerializationRetry.ts 早已按
// errno 修好 40001——这一处漏改，是「同一类陷阱修过一次仍漏一处」的样本。
//
// 修复前本文件第一条必红（先红后绿）；真库上的 23505 由 rfc359-engine-capabilities ⑥ 覆盖。

import { describe, expect, test } from 'bun:test'

import { isPostgresqlUniqueViolation } from '@/modules/resource-catalog/infrastructure/postgresql/repositorySupport'
import { postgresqlUniqueViolationConstraint } from '@/platform/persistence/capabilities'

/** 逐字复刻 Bun.SQL 的 PostgresError 形状（keys: name,code,errno,detail,…,constraint,…）。 */
function bunSqlUniqueViolation(constraint: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '23505',
    constraint,
  })
}

describe('F-I-13 —— 唯一冲突判据必须看 errno（Bun.SQL 的 SQLSTATE 在这里）', () => {
  test('真实形状：code 是 ERR_*、errno 是 23505 ⇒ 必须判为唯一冲突', () => {
    const error = bunSqlUniqueViolation('workflows_owner_name_unique')
    expect(isPostgresqlUniqueViolation(error, ['workflows_owner_name_unique'])).toBe(true)
    expect(isPostgresqlUniqueViolation(error, [])).toBe(true)
  })

  test('约束名不在清单里 ⇒ false（约束匹配语义保留）', () => {
    const error = bunSqlUniqueViolation('other_constraint')
    expect(isPostgresqlUniqueViolation(error, ['workflows_owner_name_unique'])).toBe(false)
  })

  test('包在 cause 链里（drizzle 或调用方再包一层）也能识别', () => {
    const wrapped = new Error('Failed query', { cause: bunSqlUniqueViolation('c1') })
    expect(isPostgresqlUniqueViolation(wrapped, ['c1'])).toBe(true)
    expect(postgresqlUniqueViolationConstraint(wrapped)).toBe('c1')
  })

  test('不是唯一冲突的 PG 错误 ⇒ false', () => {
    const other = Object.assign(new Error('x'), {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '42P01',
    })
    expect(isPostgresqlUniqueViolation(other, [])).toBe(false)
    expect(postgresqlUniqueViolationConstraint(other)).toBeUndefined()
  })
})

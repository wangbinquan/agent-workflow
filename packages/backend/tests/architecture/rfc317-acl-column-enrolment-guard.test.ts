// RFC-317 T9 / findings.md ACL-02 —— 带 ACL 列的表必须真的是 ACL 资源。
//
// 事故形态
// --------
// `employee_definitions` 声明了完整的 RFC-099 列集（`owner_user_id` +
// `visibility NOT NULL DEFAULT 'private'` + `acl_revision` + owner×name 唯一索引），
// 看上去就是一类 ACL 资源；但 `'employee_definition'` 不在 `ACL_RESOURCE_TYPES`
// 里，于是**没有任何 ACL 内核函数能作用到它**：三列完全惰性，
// `listEmployeeDefinitions` 只按 `archivedAt` 过滤，**全员可见全部员工定义**。
//
// 这比「忘了加过滤」更坏：列的存在会让下一个读代码的人以为可见性已经受控。
//
// 两个方向都要锁：
//   ① 有列 ⇒ 必须是 ACL 类型（否则列是装饰品，且是**误导性**的装饰品）；
//   ② 是 ACL 类型 ⇒ 必须有列（否则内核的 SQL 在运行时才炸）。
//
// 豁免只能带**具名清偿波次**，不接受「以后再说」。

import { describe, expect, test } from 'bun:test'
import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'

import * as schema from '../../src/db/schema'
import { SQLITE_ACL_TABLES } from '../../src/modules/resource-catalog/infrastructure/sqliteAclRegistry'

/** RFC-099 的行级 ACL 列集。 */
const ACL_COLUMNS = ['owner_user_id', 'visibility'] as const

/**
 * 声明了 ACL 列却尚未入网的表。**每条必须写清为什么、以及哪一波清偿**。
 *
 * 这不是「允许存在」，是「已知、已定去向、且不许再多一个」。
 */
const PENDING_ENROLMENT: Readonly<Record<string, { why: string; removeWhen: string }>> = {
  // 空表是**目标态**，不是「还没开始」：RFC-317 T8 已把最后一张（employee_definitions）
  // 入网。往这里加一行，等于承认新增了一张「看着受控、实则惰性」的表——那必须是
  // 有意识的决定，并带具名清偿波次。
}

interface TableFacts {
  readonly name: string
  readonly columns: ReadonlySet<string>
}

function allTables(): TableFacts[] {
  const out: TableFacts[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue
    const config = getTableConfig(value)
    out.push({ name: config.name, columns: new Set(config.columns.map((column) => column.name)) })
  }
  return out.sort((left, right) => left.name.localeCompare(right.name))
}

const TABLES = allTables()
const ACL_TABLE_NAMES = new Set(
  Object.values(SQLITE_ACL_TABLES).map((table) => getTableConfig(table).name),
)
const hasAclColumns = (table: TableFacts): boolean =>
  ACL_COLUMNS.every((column) => table.columns.has(column))

describe('RFC-317 T9 —— ACL 列与 ACL 类型必须一一对应', () => {
  test('语料非空：schema 反射确实读到了表（读到 0 张说明反射口径失效，此刻零预言力）', () => {
    expect(TABLES.length).toBeGreaterThan(50)
    expect(ACL_TABLE_NAMES.size).toBeGreaterThan(5)
  })

  test('①声明了 owner_user_id + visibility 的表，必须是 AclResourceType（或带具名清偿波次入账）', () => {
    const offenders = TABLES.filter(
      (table) =>
        hasAclColumns(table) &&
        !ACL_TABLE_NAMES.has(table.name) &&
        PENDING_ENROLMENT[table.name] === undefined,
    ).map((table) => table.name)
    expect(
      offenders,
      '这些表带着完整的行级 ACL 列却不是 ACL 资源类型——列是惰性的，而且会误导读代码的人以为可见性已受控。' +
        '要么把它加进 ACL_RESOURCE_TYPES/ACL_TABLES，要么删列，要么进 PENDING_ENROLMENT 并写清清偿波次',
    ).toEqual([])
  })

  test('②每个 ACL 类型对应的表都必须真的有那两列（否则内核 SQL 运行时才炸）', () => {
    const missing = [...ACL_TABLE_NAMES]
      .map((name) => TABLES.find((table) => table.name === name))
      .filter((table): table is TableFacts => table !== undefined)
      .filter((table) => !hasAclColumns(table))
      .map((table) => table.name)
    expect(missing, 'ACL 内核会对这些表读写 owner_user_id / visibility，而列不存在').toEqual([])
  })

  test('PENDING_ENROLMENT 无过期条目（表没了 / 已入网 ⇒ 删掉这一行）', () => {
    const byName = new Map(TABLES.map((table) => [table.name, table]))
    const stale: string[] = []
    for (const name of Object.keys(PENDING_ENROLMENT)) {
      const table = byName.get(name)
      if (table === undefined) {
        stale.push(`${name}（表已不存在）`)
        continue
      }
      if (ACL_TABLE_NAMES.has(name)) stale.push(`${name}（已入网 ACL_TABLES，豁免应删除）`)
      else if (!hasAclColumns(table)) stale.push(`${name}（已不再声明 ACL 列，豁免应删除）`)
    }
    expect(stale, '豁免只能缩、不能涨；过期条目必须删').toEqual([])
  })

  test('每条豁免都写清了理由与**具名**清偿波次（不接受「以后再说」）', () => {
    const bad = Object.entries(PENDING_ENROLMENT)
      .filter(
        ([, entry]) =>
          entry.why.trim().length < 20 ||
          entry.removeWhen.trim().length < 10 ||
          !/RFC-\d{3}|W\d/.test(entry.removeWhen),
      )
      .map(([name]) => name)
    expect(bad, 'removeWhen 必须点名具体 RFC / 波次').toEqual([])
  })

  test('今天的待入网集合恰好是已知的那一张表（新增一张就红）', () => {
    const pending = TABLES.filter(
      (table) => hasAclColumns(table) && !ACL_TABLE_NAMES.has(table.name),
    ).map((table) => table.name)
    expect(
      pending,
      'RFC-317 T8 之后，13 张带 ACL 列的表**全部**入网；新增一张未入网的就红',
    ).toEqual([])
  })
})

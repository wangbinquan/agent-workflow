// RFC-359 —— 「同名并发创建」在两个 provider 上必须是**同一个** 409。
//
// 为什么这条测试存在：`isOwnerScopedNameConflict`（legacy 三个资源门面 agent / skill /
// workgroup 共用的冲突分类器）此前只读 `error.code === '23505'`。Bun 的 PostgreSQL 驱动把
// SQLSTATE 放在 **`errno`**——`code` 是它自己的 `ERR_POSTGRES_SERVER_ERROR`。于是判据在真 PG 上
// **恒 false**：同名并发创建在 SQLite 上是干净的 409 `agent-name-in-use`，在 PostgreSQL 上是
// 一个裸的 `DrizzleQueryError` 冒到路由层（500）。
//
// 这个坑本仓踩过第二次了：`postgresqlUniqueViolationConstraint` 的注释里记着同一件事
// （「此前只看 `code`，在真 PG 上恒 false ⇒ 并发同名拿 500 而非 409」）。所以修法不是再手写一份
// errno 匹配，而是让分类器**复用那份唯一真值来源**。这条测试锁的就是「两个引擎同一个结论」。
//
// 锁的是**引擎形态**这一半：分类器对索引名的匹配是与表无关的字符串比较，而「SQLSTATE 藏在
// 哪个字段」才是两个引擎真正不同的地方。所以用 agents 的真实唯一冲突把两个引擎各走一遍就够；
// skill / workgroup 走的是同一个分类器、同一条判据，当时坏也是坏在同一处。

import { expect, test } from 'bun:test'

import { isOwnerScopedNameConflict } from '@/modules/identity-access/public/operations'
import { agents } from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

const CASES = [
  {
    label: 'agents',
    table: agents,
    indexName: 'agents_owner_name_unique',
    row: (id: string) => ({
      id,
      name: 'raced',
      description: '',
      outputs: '[]',
      inputs: '[]',
      syncOutputsOnIterate: true,
      runtime: null,
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: 'owner-a',
      visibility: 'private' as const,
      aclRevision: 0,
      builtin: false,
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    }),
  },
] as const

describeEachProvider('RFC-359 owner-scoped name conflict is one verdict on both engines', (h) => {
  for (const testCase of CASES) {
    test(`${testCase.label}: the unique violation classifies as an owner/name conflict`, async () => {
      await h.db.insert(testCase.table).values(testCase.row('conflict-1'))
      let raised: unknown
      try {
        await h.db.insert(testCase.table).values(testCase.row('conflict-2'))
      } catch (error) {
        raised = error
      }
      expect(raised, 'the second insert must violate the owner/name unique index').toBeDefined()
      expect(
        isOwnerScopedNameConflict(raised, {
          table: testCase.label,
          indexName: testCase.indexName,
        }),
        'PostgreSQL 把 SQLSTATE 放在 `errno`——只读 `code` 的判据在这里恒 false，' +
          '同名并发就会从 409 退化成 500。',
      ).toBe(true)
    })
  }

  // 负向：**另一个**索引上的唯一冲突（主键）不得被读成 owner/name 冲突——否则「id 撞了」
  // 会被回成 409「同名已存在」，把用户指向一个不存在的问题。
  test('a unique violation on a different index is not an owner/name conflict', async () => {
    const row = CASES[0].row('same-id')
    await h.db.insert(agents).values(row)
    let raised: unknown
    try {
      await h.db.insert(agents).values({ ...row, name: 'a-different-name' })
    } catch (error) {
      raised = error
    }
    expect(raised, 'reusing the primary key must fail').toBeDefined()
    expect(
      isOwnerScopedNameConflict(raised, { table: 'agents', indexName: 'agents_owner_name_unique' }),
    ).toBe(false)
  })
})

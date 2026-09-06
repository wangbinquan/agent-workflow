// RFC-359 W4-D22 —— 数字员工岗位模版目录合一：此前 SQLite 是套在 legacy Agent 写面上的 59 行薄壳、
// PostgreSQL 是 390 行原生实现，两份各自演进。现在只剩一份中立实现 + 一份装配，两个 bootstrap 共用。
//
// 这套断言两个引擎各跑一遍模版写面的四条判据：建 builtin（系统 owner + public + builtin）、
// id 被占用与同名冲突、改名与更新的双 OCC 围栏（updatedAt + aclRevision），以及「不是系统 builtin 的行
// 一律按 id 被占用拒绝」。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents } from '@/db/schema'
import { createDigitalEmployeeAgentTemplateRepository } from '@/modules/resource-catalog/infrastructure/digitalEmployeeAgentTemplateCatalog'
import type { CreateAgent } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'

function definition(name: string): CreateAgent {
  return {
    name,
    description: 'code-owned template',
    outputs: ['result'],
    inputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'template body',
  }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

describeEachProvider('RFC-359 W4-D22 —— 数字员工岗位模版目录', (harness) => {
  test('建 builtin：系统 owner + public + builtin，重复 id 与同名都按占用拒绝', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const repository = createDigitalEmployeeAgentTemplateRepository(db)
    const id = ulid()
    const name = `tpl-${id.slice(-8).toLowerCase()}`

    await repository.createBuiltin({ id, definition: definition(name) })

    const stored = await repository.get(id)
    expect(stored?.ownerUserId).toBe(SYSTEM_USER_ID)
    expect(stored?.builtin).toBe(true)
    expect(stored?.visibility).toBe('public')
    expect(stored?.name).toBe(name)

    // 同一个 id 再建 → 占用。
    expect(
      await codeOf(() => repository.createBuiltin({ id, definition: definition(`${name}-other`) })),
    ).toBe('builtin-agent-id-collision')
    // 换 id 但同名 → 名字冲突。
    expect(
      await codeOf(() => repository.createBuiltin({ id: ulid(), definition: definition(name) })),
    ).toBe('agent-name-in-use')
  })

  test('改名与更新都过 updatedAt + aclRevision 双 OCC；陈旧围栏一律拒绝', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const repository = createDigitalEmployeeAgentTemplateRepository(db)
    const id = ulid()
    const name = `tpl-${id.slice(-8).toLowerCase()}`
    await repository.createBuiltin({ id, definition: definition(name) })
    const created = await repository.get(id)
    expect(created).not.toBeNull()

    // 陈旧的 updatedAt → 拒绝。
    expect(
      await codeOf(() =>
        repository.renameBuiltin({
          id,
          newName: `${name}-v2`,
          expectedUpdatedAt: (created?.updatedAt ?? 0) - 1,
          expectedAclRevision: created?.aclRevision ?? 0,
        }),
      ),
    ).toBe('resource-operation-stale')

    await repository.renameBuiltin({
      id,
      newName: `${name}-v2`,
      expectedUpdatedAt: created?.updatedAt ?? 0,
      expectedAclRevision: created?.aclRevision ?? 0,
    })
    const renamed = await repository.get(id)
    expect(renamed?.name).toBe(`${name}-v2`)

    // 陈旧的 aclRevision → 拒绝。
    expect(
      await codeOf(() =>
        repository.updateBuiltin({
          id,
          patch: { description: 'next' },
          expectedUpdatedAt: renamed?.updatedAt ?? 0,
          expectedAclRevision: (renamed?.aclRevision ?? 0) + 1,
        }),
      ),
    ).toBe('resource-operation-stale')

    await repository.updateBuiltin({
      id,
      patch: { description: 'next' },
      expectedUpdatedAt: renamed?.updatedAt ?? 0,
      expectedAclRevision: renamed?.aclRevision ?? 0,
    })
    expect((await repository.get(id))?.description).toBe('next')
  })

  test('不是系统 builtin 的行按 id 被占用拒绝（不泄漏它是谁的）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const repository = createDigitalEmployeeAgentTemplateRepository(db)
    const id = ulid()
    await db.insert(agents).values({
      id,
      name: `user-agent-${id.slice(-8).toLowerCase()}`,
      description: '',
      bodyMd: 'user owned',
      ownerUserId: 'someone-else',
      createdAt: 1,
      updatedAt: 1,
    })
    const row = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
    expect(row?.builtin ?? false).toBe(false)

    for (const attempt of [
      () =>
        repository.renameBuiltin({
          id,
          newName: 'whatever',
          expectedUpdatedAt: 1,
          expectedAclRevision: 0,
        }),
      () =>
        repository.updateBuiltin({
          id,
          patch: { description: 'x' },
          expectedUpdatedAt: 1,
          expectedAclRevision: 0,
        }),
    ]) {
      expect(await codeOf(attempt)).toBe('builtin-agent-id-collision')
    }
  })
})

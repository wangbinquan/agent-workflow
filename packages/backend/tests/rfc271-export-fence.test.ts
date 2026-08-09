// RFC-271 AC-12 —— 导出的 exact-revision fence，**六类各自的完整形态**。
//
// 覆盖验收条款：AC-12（根资源沿用 exact-revision 保护，六类都要且用各自的完整形态）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// 这条 AC 我一度在验收清单里勾成「已覆盖」，而实现只有 `expectedVersion` +
// `expectedSnapshotHash` —— 即只覆盖 workflow / workgroup。AC-12 自己的警告写的正是
// 那个状态：「另一标签把 agent 的 `network` 从 deny 改成 allow 后，原标签点导出会
// **静默导出新版本**而不是 409」。
//
// 所以这里测的是**行为**，不是源码里有没有那几个字段名：源码断言挡不住「字段解析了
// 但没参与比对」这类失败。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, users, workflows } from '../src/db/schema'
import { exportResourcePackage } from '../src/services/resourcePackage/export'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const actorOf = (id: string): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set(['scripts:author']),
  }) as unknown as Actor

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code,
  )

async function seed(): Promise<{ db: DbClient; appHome: string; agentId: string; mcpId: string }> {
  const db = createInMemoryDb(MIGRATIONS)
  const appHome = mkdtempSync(join(tmpdir(), 'rfc271-fence-'))
  await db.insert(users).values({
    id: 'u1',
    username: 'alice',
    displayName: 'A',
    role: 'user',
    status: 'active',
    passwordHash: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as never)
  const agentId = ulid()
  await db.insert(agents).values({
    id: agentId,
    name: 'auditor',
    description: '',
    outputs: '[]',
    permission: '{}',
    skills: '[]',
    dependsOn: '[]',
    mcp: '[]',
    plugins: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    ownerUserId: 'u1',
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1000,
    aclRevision: 3,
  } as never)
  const mcpId = ulid()
  await db.insert(mcps).values({
    id: mcpId,
    name: 'gh',
    description: '',
    type: 'remote',
    config: JSON.stringify({ url: 'https://x.test' }),
    enabled: true,
    ownerUserId: 'u1',
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
  } as never)
  return { db, appHome, agentId, mcpId }
}

describe('AC-12 · agent 用 updatedAt + aclRevision 两个（少一个就漏漂移）', () => {
  test('两个都对上 ⇒ 导出成功', async () => {
    const { db, appHome, agentId } = await seed()
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'agent', id: agentId },
      { appHome, expect: { expectedUpdatedAt: 1000, expectedAclRevision: 3 } },
    )
    expect(pkg.zip.byteLength).toBeGreaterThan(0)
  })

  test('`updatedAt` 对不上 ⇒ 409 package-root-changed', async () => {
    const { db, appHome, agentId } = await seed()
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'agent', id: agentId },
          { appHome, expect: { expectedUpdatedAt: 999, expectedAclRevision: 3 } },
        ),
      ),
    ).toBe('package-root-changed')
  })

  test('**只带 aclRevision 漂移**也要拦下 —— 这正是「完整形态」的意义', async () => {
    // ACL 变了而内容没变：只比 updatedAt 的 fence 会放它过去。
    const { db, appHome, agentId } = await seed()
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'agent', id: agentId },
          { appHome, expect: { expectedUpdatedAt: 1000, expectedAclRevision: 2 } },
        ),
      ),
    ).toBe('package-root-changed')
  })

  test('给了就必须**给全**：少一个字段 ⇒ 拒绝，而不是只比给了的那个', async () => {
    // 少给一维等于放过那一维的漂移，而调用方会以为自己有保护。
    const { db, appHome, agentId } = await seed()
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'agent', id: agentId },
          { appHome, expect: { expectedUpdatedAt: 1000 } },
        ),
      ),
    ).toBe('package-invalid')
  })

  test('拿错类型的 fence 字段 ⇒ 拒绝，不静默忽略', async () => {
    // 「我明明传了 expectedConfigHash」不该变成一次没有保护的导出。
    const { db, appHome, agentId } = await seed()
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'agent', id: agentId },
          {
            appHome,
            expect: { expectedUpdatedAt: 1000, expectedAclRevision: 3, expectedConfigHash: 'x' },
          },
        ),
      ),
    ).toBe('package-invalid')
  })
})

describe('AC-12 · mcp 用 configHash（形态与 agent 不同，取自同一份 expectTokenOf）', () => {
  test('错的 hash ⇒ 409；完全不给 fence ⇒ 正常导出', async () => {
    const { db, appHome, mcpId } = await seed()
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'mcp', id: mcpId },
          { appHome, expect: { expectedConfigHash: 'definitely-not-it' } },
        ),
      ),
    ).toBe('package-root-changed')

    // 不给 fence 是合法的（「所见非所得」防护是可选的）。
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'mcp', id: mcpId },
      { appHome },
    )
    expect(pkg.zip.byteLength).toBeGreaterThan(0)
  })

  test('给 mcp 传 expectedVersion（workflow 的形态）⇒ 拒绝', async () => {
    const { db, appHome, mcpId } = await seed()
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'mcp', id: mcpId },
          { appHome, expect: { expectedVersion: 1 } },
        ),
      ),
    ).toBe('package-invalid')
  })
})

describe('AC-12 · workflow 仍用 expectedVersion（不得因为补齐别的类型而回归）', () => {
  test('对得上导出成功；对不上 409', async () => {
    const { db, appHome } = await seed()
    const wfId = ulid()
    await db.insert(workflows).values({
      id: wfId,
      name: 'wf',
      description: '',
      definition: JSON.stringify({ $schema_version: 4, inputs: [], edges: [], nodes: [] }),
      ownerUserId: 'u1',
      visibility: 'private',
      version: 2,
      createdAt: 1,
      updatedAt: 1,
    } as never)

    const ok = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wfId },
      { appHome, expect: { expectedVersion: 2 } },
    )
    expect(ok.zip.byteLength).toBeGreaterThan(0)

    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'workflow', id: wfId },
          { appHome, expect: { expectedVersion: 1 } },
        ),
      ),
    ).toBe('package-root-changed')
  })
})

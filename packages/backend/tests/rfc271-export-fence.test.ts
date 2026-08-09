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
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, plugins, skills, users, workflows, workgroups } from '../src/db/schema'
import { exportResourcePackage } from '../src/services/resourcePackage/export'
import { exportFenceTokenOf } from '../src/services/resourcePackage/preview'

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

describe('AC-12 · workflow / workgroup：version + aclRevision 两维', () => {
  // 这两类曾经**只**比 `version`。问题在于 `version` 只被内容写路径推进
  // （definition / 成员 / 设置），而 ACL 写路径改的是 visibility / grants，只推
  // `aclRevision` 与 `updatedAt`。于是「把工作流从 private 改成 public」对 fence
  // 完全不可见：页面上是 v3、导出的也是 v3，但它的可见面已经换了一个。
  test('两维都对上 ⇒ 成功；version 对不上 ⇒ 409', async () => {
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
      aclRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    } as never)

    const ok = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wfId },
      { appHome, expect: { expectedVersion: 2, expectedAclRevision: 0 } },
    )
    expect(ok.zip.byteLength).toBeGreaterThan(0)

    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'workflow', id: wfId },
          { appHome, expect: { expectedVersion: 1, expectedAclRevision: 0 } },
        ),
      ),
    ).toBe('package-root-changed')
  })

  test('**只有 ACL 漂移**（version 不变）也必须 409 —— 这是补这一维的全部理由', async () => {
    const { db, appHome } = await seed()
    const wfId = ulid()
    await db.insert(workflows).values({
      id: wfId,
      name: 'wf-acl',
      description: '',
      definition: JSON.stringify({ $schema_version: 4, inputs: [], edges: [], nodes: [] }),
      ownerUserId: 'u1',
      visibility: 'private',
      version: 3,
      aclRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    } as never)

    // 模拟 ACL 写路径：只推 aclRevision / visibility，**不动 version**。
    await db
      .update(workflows)
      .set({ visibility: 'public', aclRevision: 1, updatedAt: 2 } as never)
      .where(eq(workflows.id, wfId))

    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'workflow', id: wfId },
          // 页面加载时看到的是 v3 / acl 0。
          { appHome, expect: { expectedVersion: 3, expectedAclRevision: 0 } },
        ),
      ),
    ).toBe('package-root-changed')
  })

  test('workgroup 同形（两维齐；缺一维 ⇒ package-invalid）', async () => {
    const { db, appHome } = await seed()
    const wgId = ulid()
    await db.insert(workgroups).values({
      id: wgId,
      name: 'squad',
      description: '',
      instructions: '',
      mode: 'free_collab',
      leaderMemberId: null,
      shareOutputs: true,
      directMessages: false,
      blackboard: false,
      maxRounds: 20,
      completionGate: false,
      clarifyBudget: 3,
      fanOut: false,
      ownerUserId: 'u1',
      visibility: 'private',
      version: 5,
      aclRevision: 2,
      createdAt: 1,
      updatedAt: 1,
    } as never)

    const ok = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workgroup', id: wgId },
      { appHome, expect: { expectedVersion: 5, expectedAclRevision: 2 } },
    )
    expect(ok.zip.byteLength).toBeGreaterThan(0)

    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'workgroup', id: wgId },
          { appHome, expect: { expectedVersion: 5 } },
        ),
      ),
    ).toBe('package-invalid')
  })
})

describe('AC-12 · skill 三维（contentVersion + metaRevision + aclRevision）', () => {
  // 技能是唯一三维的：只改 description 会推 metaRevision 而 contentVersion 不变，
  // 只带后者的 fence 完全看不见这次修改。
  const seedSkill = async (db: DbClient): Promise<string> => {
    const id = ulid()
    await db.insert(skills).values({
      id,
      name: 'helper',
      description: '',
      sourceKind: 'managed',
      managedPath: null,
      ownerUserId: 'u1',
      visibility: 'private',
      contentVersion: 4,
      metaRevision: 2,
      aclRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    } as never)
    return id
  }

  test('三维齐且都对 ⇒ 成功', async () => {
    const { db, appHome } = await seed()
    const id = await seedSkill(db)
    const ok = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'skill', id },
      {
        appHome,
        expect: { expectedContentVersion: 4, expectedMetaRevision: 2, expectedAclRevision: 1 },
      },
    )
    expect(ok.zip.byteLength).toBeGreaterThan(0)
  })

  test('**只有 metaRevision 漂移** ⇒ 409（内容没变不等于没改）', async () => {
    const { db, appHome } = await seed()
    const id = await seedSkill(db)
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'skill', id },
          {
            appHome,
            expect: { expectedContentVersion: 4, expectedMetaRevision: 1, expectedAclRevision: 1 },
          },
        ),
      ),
    ).toBe('package-root-changed')
  })

  test('少给一维 ⇒ package-invalid（不能只比给了的那两维）', async () => {
    const { db, appHome } = await seed()
    const id = await seedSkill(db)
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'skill', id },
          { appHome, expect: { expectedContentVersion: 4, expectedMetaRevision: 2 } },
        ),
      ),
    ).toBe('package-invalid')
  })
})

describe('AC-12 · plugin 用 configHash（含安装态，不只是配置文本）', () => {
  const seedPlugin = async (db: DbClient): Promise<string> => {
    const id = ulid()
    await db.insert(plugins).values({
      id,
      name: 'fmt',
      description: '',
      spec: 'npm:some-plugin@1.0.0',
      sourceKind: 'npm',
      enabled: true,
      cachedPath: '/tmp/p/1',
      resolvedVersion: '1.0.0',
      installedAt: 100,
      ownerUserId: 'u1',
      visibility: 'private',
      aclRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    } as never)
    return id
  }

  test('错的 hash ⇒ 409；不给 fence ⇒ 正常导出', async () => {
    const { db, appHome } = await seed()
    const id = await seedPlugin(db)
    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'plugin', id },
          { appHome, expect: { expectedConfigHash: 'nope' } },
        ),
      ),
    ).toBe('package-root-changed')

    const ok = await exportResourcePackage(db, actorOf('u1'), { type: 'plugin', id }, { appHome })
    expect(ok.zip.byteLength).toBeGreaterThan(0)
  })

  test('**只改 enabled** 也要让 hash 变 —— 安装/启用态属于导出语义的一部分', async () => {
    const { db, appHome } = await seed()
    const id = await seedPlugin(db)
    // 先拿到当前 hash（用一次成功导出证明它是对的）。
    const before = exportFenceTokenOf('plugin', {
      ...(db
        .select()
        .from(plugins)
        .all()
        .find((r) => r.id === id) as Record<string, unknown>),
    }) as { expectedConfigHash: string }

    await db
      .update(plugins)
      .set({ enabled: false } as never)
      .where(eq(plugins.id, id))

    expect(
      await codeOf(
        exportResourcePackage(
          db,
          actorOf('u1'),
          { type: 'plugin', id },
          { appHome, expect: before },
        ),
      ),
    ).toBe('package-root-changed')
  })
})

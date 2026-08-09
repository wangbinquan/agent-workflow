// RFC-271 T27/T28 —— 导入提交。
//
// 四条承重断言，每条都对应一个具体的失败形态：
//
//  ① **duplicate lookup 先于过期检查**。反过来写，「commit 成功但响应丢失、用户过了
//     有效期再重试」会撞在过期上而**进不了 replay**——用户看到错误，资源其实已经建好。
//  ② **`(target, expect)` 必须是签名基线里的一对**。不是「expect 形状对就行」——那正是
//     「包没变、把 expect 换成用户从未确认过的那一版」那一招。
//  ③ **`allowedActions` 服务端重算**，不信客户端回传（别人的资源没有 overwrite）。
//  ④ **reuse 也要复核**。它不产 op，没有任何 commit 内核会替它把关，而用户确认的正是
//     「复用**这一版**」——`revalidateInTx` 就是为这条存在的；留空则全 reuse 的包完全免检。

//
// 覆盖验收条款：AC-21（新建归导入者 + private + 零 grants）/ AC-24（内容级 exact token CAS） / AC-24e（稳定 importId 进 wire）/ AC-24h（reuse 目标在 big tx 内复核） / AC-17（权限不满足 ⇒ 整包不可提交）/ AC-22（跨资源引用绑到本次导入结果）
// 覆盖不变量：I6（CAS prepared→applying 之后、任何 commit 内核之前的二次校验 —— reuse 目标的 revalidateInTx）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { PACKAGE_SECRET_PLACEHOLDER } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { mcps, resourceBundleApplies, users, workgroups } from '../src/db/schema'
import { encodeZip } from '../src/util/zip'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import { buildPackagePreview } from '../src/services/resourcePackage/preview'
import { commitResourcePackage } from '../src/services/resourcePackage/commit'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(randomBytes(32))
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// 六类写权限齐全的普通用户。**默认给全**是因为绝大多数用例断言的不是权限，
// 而是决策/基线逻辑；缺权限的那条单独立用例（见「写权限」describe）。
const WRITE_ALL = ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups'].flatMap(
  (t) => [`${t}:create`, `${t}:update`],
)

const actorOf = (id: string, permissions: readonly string[] = WRITE_ALL): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(permissions),
  }) as unknown as Actor

const mcpManifest = `formatVersion: 1
exportedAt: 0
root:
  slug: mcp-tools
  type: mcp
  name: tools
resources:
  - slug: mcp-tools
    type: mcp
    name: tools
requirements: {}
secrets: []
danglingCallRefs: []
`

const packageZip = (): Uint8Array =>
  encodeZip([
    { path: 'manifest.yaml', bytes: utf8(mcpManifest) },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'mcp-create',
              slug: 'mcp-tools',
              payload: {
                name: 'tools',
                description: 'from package',
                type: 'remote',
                config: { url: 'https://pkg.test/mcp' },
                enabled: true,
              },
            },
          ],
          rootRef: 'local:mcp-tools',
        }),
      ),
    },
  ])

const secretPackageZip = (): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: mcp-tools
  type: mcp
  name: tools
resources:
  - slug: mcp-tools
    type: mcp
    name: tools
requirements: {}
secrets:
  - resourceType: mcp
    resourceName: tools
    field: config.env.TOKEN
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'mcp-create',
              slug: 'mcp-tools',
              payload: {
                name: 'tools',
                description: 'from package',
                type: 'local',
                config: {
                  command: ['tool-server'],
                  env: { TOKEN: PACKAGE_SECRET_PLACEHOLDER },
                },
                enabled: true,
              },
            },
          ],
          rootRef: 'local:mcp-tools',
        }),
      ),
    },
  ])

const workgroupManifest = `formatVersion: 1
exportedAt: 0
root:
  slug: workgroup-squad
  type: workgroup
  name: squad
resources:
  - slug: workgroup-squad
    type: workgroup
    name: squad
requirements: {}
secrets: []
danglingCallRefs: []
`

const workgroupPackageZip = (): Uint8Array =>
  encodeZip([
    { path: 'manifest.yaml', bytes: utf8(workgroupManifest) },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'workgroup-create',
              slug: 'workgroup-squad',
              payload: {
                name: 'squad',
                description: '',
                instructions: '',
                mode: 'free_collab',
                switches: { shareOutputs: true, directMessages: false, blackboard: false },
                maxRounds: 20,
                completionGate: false,
                clarifyBudget: 3,
                fanOut: false,
                members: [
                  {
                    memberType: 'human',
                    username: 'alice',
                    displayName: 'reviewer',
                    roleDesc: 'reviews',
                    sortOrder: 0,
                  },
                ],
                leaderDisplayName: null,
              },
            },
          ],
          rootRef: 'local:workgroup-squad',
        }),
      ),
    },
  ])

const workflowPackageZip = (): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: workflow-deploy
  type: workflow
  name: deploy
resources:
  - slug: workflow-deploy
    type: workflow
    name: deploy
requirements: {}
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'workflow-create',
              slug: 'workflow-deploy',
              payload: {
                name: 'deploy',
                description: '',
                // Permission inspection happens before the definition reaches the write kernel.
                definition: { nodes: [{ id: 'run', kind: 'script' }] },
              },
            },
          ],
          rootRef: 'local:workflow-deploy',
        }),
      ),
    },
  ])

const agentWithExternalMcpPackageZip = (mcpId: string): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: agent-worker
  type: agent
  name: worker
resources:
  - slug: agent-worker
    type: agent
    name: worker
requirements: {}
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'agent-create',
              slug: 'agent-worker',
              payload: {
                name: 'worker',
                description: '',
                outputs: [],
                syncOutputsOnIterate: true,
                permission: {},
                skills: [],
                dependsOn: [],
                mcp: [`external:${mcpId}`],
                plugins: [],
                frontmatterExtra: {},
                bodyMd: '',
              },
            },
          ],
          rootRef: 'local:agent-worker',
        }),
      ),
    },
  ])

const dirs: string[] = []
function deps(db: DbClient) {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-commit-'))
  dirs.push(appHome)
  return { db, appHome, box }
}

const seedMcp = async (db: DbClient, owner: string, name: string): Promise<string> => {
  const id = ulid()
  await db
    .insert(mcps)
    .values({
      id,
      name,
      description: 'local original',
      type: 'remote',
      config: JSON.stringify({ url: 'https://local.test/mcp' }),
      enabled: true,
      ownerUserId: owner,
      visibility: 'public',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
  return id
}

const seedWorkgroup = async (db: DbClient, owner: string, name: string): Promise<string> => {
  const id = ulid()
  await db
    .insert(workgroups)
    .values({
      id,
      name,
      description: 'local original',
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
      ownerUserId: owner,
      visibility: 'public',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
  return id
}

const seedUser = async (
  db: DbClient,
  id: string,
  status: 'active' | 'disabled' | 'invited',
): Promise<void> => {
  await db
    .insert(users)
    .values({
      id,
      username: id,
      displayName: id,
      role: 'user',
      status,
      passwordHash: 'x',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
}

describe('基础：new 动作把包内资源建出来', () => {
  test('本地无同名 ⇒ new，落库且归导入者', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new' }],
    })
    expect(receipt.applied).toHaveLength(1)
    const row = db.select().from(mcps).get()
    if (row === undefined) throw new Error('expected imported MCP row')
    expect(row?.name).toBe('tools')
    // 「谁导入的整体所有资源权限就归谁」。
    expect(row?.ownerUserId).toBe('u1')
    expect(row?.visibility).toBe('private')
    expect(receipt.root).toEqual({
      resourceType: 'mcp',
      resourceId: row.id,
      name: 'tools',
      action: 'create',
    })
    expect(JSON.parse(db.select().from(resourceBundleApplies).get()!.receiptJson!)).toEqual(receipt)
  })
})

describe('① duplicate lookup **先于**过期检查', () => {
  test('已 committed 的 importId 即使 token 早已过期，仍返回原 receipt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const importId = ulid()
    // 造一个**已经过期**的 preview。
    const preview = await buildPackagePreview(db, actor, pkg, {
      box,
      importId,
      now: Date.now() - 60 * 60 * 1000,
    })
    // 先手工塞一条 committed journal，模拟「上次成功但响应丢了」。
    const receiptValue = { journalId: 'J1', applied: [] }
    db.insert(resourceBundleApplies)
      .values({
        id: 'J1',
        scope: 'package',
        key: importId,
        actorUserId: 'u1',
        state: 'committed',
        receiptJson: JSON.stringify(receiptValue),
        preparedArtifactsJson: '[]',
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run()

    const out = await commitResourcePackage(deps(db), actorOf('u1', []), {
      pkg,
      previewToken: preview.previewToken,
      // Replay is before mutable permissions and even decision completeness.
      decisions: [],
    })
    // 过期检查若排在前面，这里会抛 package-preview-expired，用户看到错误而资源已存在。
    expect(out).toEqual(receiptValue)
  })

  test('**首次** claim 且已过期 ⇒ 拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, {
      box,
      importId: ulid(),
      now: Date.now() - 60 * 60 * 1000,
    })
    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new' }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-preview-expired')
  })

  test('相同 key 的其它 scope 不是 package 重放', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const importId = ulid()
    const preview = await buildPackagePreview(db, actor, pkg, {
      box,
      importId,
      now: Date.now() - 60 * 60 * 1000,
    })
    db.insert(resourceBundleApplies)
      .values({
        id: 'OTHER-SCOPE',
        scope: 'intent',
        key: importId,
        actorUserId: 'u1',
        state: 'committed',
        receiptJson: JSON.stringify({ journalId: 'OTHER-SCOPE', applied: [] }),
        preparedArtifactsJson: '[]',
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run()

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new' }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-preview-expired')
  })
})

describe('② / ③ 决策必须落在签名基线内，且服务端重算 allowedActions', () => {
  test('伪造一个不在候选里的 targetId ⇒ 拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'overwrite', targetId: '01FORGED' }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-decision-unconfirmed')
  })

  test('**别人的资源没有 overwrite** —— 客户端硬提交也拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const foreign = await seedMcp(db, 'u-other', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    expect(preview.entries[0]?.allowedActions).not.toContain('overwrite')

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'overwrite', targetId: foreign }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-decision-not-allowed')
    // 别人那一行一个字节没变。
    expect(db.select().from(mcps).where(eq(mcps.id, foreign)).get()?.description).toBe(
      'local original',
    )
  })

  test('缺决策的条目 ⇒ 拒绝（不静默跳过）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-decision-missing')
  })

  test('preview 后撤销资源写权限 ⇒ commit 按当前 actor 拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const previewActor = actorOf('u1')
    const preview = await buildPackagePreview(db, previewActor, pkg, { box, importId: ulid() })

    const err = await commitResourcePackage(deps(db), actorOf('u1', []), {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new' }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string; details?: unknown },
    )
    expect(err).toMatchObject({
      code: 'package-write-forbidden',
      details: { missingPermissions: ['mcps:create'] },
    })
    expect(await db.select().from(resourceBundleApplies)).toHaveLength(0)
  })

  test('workflow author 权限在 preview 后被撤销 ⇒ commit 重新计算并拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(workflowPackageZip())
    const previewActor = actorOf('u1', ['workflows:create', 'scripts:author'])
    const preview = await buildPackagePreview(db, previewActor, pkg, { box, importId: ulid() })

    const err = await commitResourcePackage(deps(db), actorOf('u1', ['workflows:create']), {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'workflow-deploy', action: 'new' }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string; details?: unknown },
    )
    expect(err).toMatchObject({
      code: 'package-write-forbidden',
      details: { missingPermissions: ['scripts:author'] },
    })
  })
})

describe('④ reuse 也要复核 —— 它不产 op，没有内核替它把关', () => {
  test('全 reuse 的包：目标在预检之后被改动 ⇒ 提交拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const target = await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    // 预检之后、提交之前，目标被改了。
    await db
      .update(mcps)
      .set({ config: JSON.stringify({ url: 'https://changed.test/mcp' }) })
      .where(eq(mcps.id, target))
      .run()

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'reuse', targetId: target }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    // `revalidateInTx` 留空的话，这个包一个 op 都没有 ⇒ 完全免检、静默通过。
    expect(err?.code).toBe('package-selected-target-changed')
  })

  test('目标没变 ⇒ 全 reuse 的包正常通过（不误伤）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const target = await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'reuse', targetId: target }],
    })
    // reuse 不产 op ⇒ receipt 为空，但**这一次导入确实发生过**（journal 落了 committed）。
    expect(receipt.applied).toHaveLength(0)
    expect(receipt.root).toEqual({
      resourceType: 'mcp',
      resourceId: target,
      name: 'tools',
      action: 'reuse',
    })
    expect(db.select().from(resourceBundleApplies).get()?.state).toBe('committed')
    // 也没有多建一行。
    expect(await db.select().from(mcps)).toHaveLength(1)
  })

  test('预检后目标变为不可见 ⇒ 与不存在一样拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const target = await seedMcp(db, 'u-other', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    await db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, target)).run()

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'reuse', targetId: target }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-selected-target-gone')
  })

  test('root overwrite 改写为 external target，receipt 指向被更新行', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const target = await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'overwrite', targetId: target }],
    })
    expect(receipt.root).toEqual({
      resourceType: 'mcp',
      resourceId: target,
      name: 'tools',
      action: 'update',
    })
    expect(db.select().from(mcps).where(eq(mcps.id, target)).get()?.description).toBe(
      'from package',
    )
  })
})

describe('external 引用不提供隐藏资源存在性预言机', () => {
  test('不存在与存在但不可见返回同形拒绝', async () => {
    const hiddenDb = createInMemoryDb(MIGRATIONS)
    const target = await seedMcp(hiddenDb, 'u-other', 'private-tools')
    await hiddenDb.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, target)).run()
    const zip = agentWithExternalMcpPackageZip(target)
    const actor = actorOf('u1')

    const hiddenPkg = await parseResourcePackage(zip)
    const hiddenPreview = await buildPackagePreview(hiddenDb, actor, hiddenPkg, {
      box,
      importId: ulid(),
    })
    const hiddenError = await commitResourcePackage(deps(hiddenDb), actor, {
      pkg: hiddenPkg,
      previewToken: hiddenPreview.previewToken,
      decisions: [{ localSlug: 'agent-worker', action: 'new' }],
    }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    )

    const absentDb = createInMemoryDb(MIGRATIONS)
    const absentPkg = await parseResourcePackage(zip)
    const absentPreview = await buildPackagePreview(absentDb, actor, absentPkg, {
      box,
      importId: ulid(),
    })
    const absentError = await commitResourcePackage(deps(absentDb), actor, {
      pkg: absentPkg,
      previewToken: absentPreview.previewToken,
      decisions: [{ localSlug: 'agent-worker', action: 'new' }],
    }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    )

    expect(hiddenError).toEqual(absentError)
    expect(hiddenError?.code).toBe('package-external-unresolved')
  })
})

describe('⑤ human 映射只属于会落地的 workgroup', () => {
  test('reuse 不要求映射，也不消费附带的重复/无效映射', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const target = await seedWorkgroup(db, 'u1', 'squad')
    const pkg = await parseResourcePackage(workgroupPackageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'workgroup-squad', action: 'reuse', targetId: target }],
      // 旧计划可能仍附带这些行。reuse 不写 roster，因此不查 user、不报 duplicate。
      humanMemberMappings: [
        { workgroupSlug: 'workgroup-squad', username: 'alice', userId: 'missing-user' },
        { workgroupSlug: 'workgroup-squad', username: 'alice', userId: 'also-missing' },
      ],
    })

    expect(receipt.applied).toHaveLength(0)
    expect(await db.select().from(workgroups)).toHaveLength(1)
  })

  test('new 工作组缺少已确认的映射 ⇒ 拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(workgroupPackageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'workgroup-squad', action: 'new' }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-human-mapping-missing')
  })

  test('free_collab 的 null leader 经 lowering 归一后可成功新建', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'active-user', 'active')
    const pkg = await parseResourcePackage(workgroupPackageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'workgroup-squad', action: 'new' }],
      humanMemberMappings: [
        { workgroupSlug: 'workgroup-squad', username: 'alice', userId: 'active-user' },
      ],
    })

    expect(receipt.root).toMatchObject({ resourceType: 'workgroup', action: 'create' })
    expect(db.select().from(workgroups).get()?.leaderMemberId).toBeNull()
  })

  test('overwrite 工作组仍拒绝映射到非 active 用户', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const target = await seedWorkgroup(db, 'u1', 'squad')
    await seedUser(db, 'disabled-user', 'disabled')
    const pkg = await parseResourcePackage(workgroupPackageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'workgroup-squad', action: 'overwrite', targetId: target }],
      humanMemberMappings: [
        { workgroupSlug: 'workgroup-squad', username: 'alice', userId: 'disabled-user' },
      ],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-human-mapping-invalid')
  })

  test('基线外的映射即使没有任何 human 槽也不能凭空注入', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new' }],
      humanMemberMappings: [{ workgroupSlug: 'workgroup-forged', username: 'alice', userId: null }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-human-mapping-unconfirmed')
  })
})

describe('⑥ secret inputs 只投影到会落地的资源', () => {
  test('new 重命名后按 manifest 身份接收凭据，并写入实际目标', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(secretPackageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new', finalName: 'tools-copy' }],
      secretInputs: [
        {
          resourceType: 'mcp',
          resourceName: 'tools',
          field: 'config.env.TOKEN',
          value: 'local-secret',
        },
      ],
    })

    const row = db.select().from(mcps).where(eq(mcps.name, 'tools-copy')).get()
    expect(JSON.parse(row?.config ?? '{}')).toMatchObject({ env: { TOKEN: 'local-secret' } })
    expect(receipt.skippedSecrets).toBeUndefined()
    expect(receipt.root?.name).toBe('tools-copy')
  })

  test('optional credential left empty is omitted and recorded in the durable receipt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(secretPackageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new', finalName: 'tools-copy' }],
      secretInputs: [
        {
          resourceType: 'mcp',
          resourceName: 'tools',
          field: 'config.env.TOKEN',
          value: '',
        },
      ],
    })

    const row = db.select().from(mcps).where(eq(mcps.name, 'tools-copy')).get()
    const stored = JSON.parse(row?.config ?? '{}') as { env?: Record<string, string> }
    expect(stored.env?.TOKEN).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain(PACKAGE_SECRET_PLACEHOLDER)
    expect(receipt.skippedSecrets).toEqual([
      { resourceType: 'mcp', resourceName: 'tools-copy', field: 'config.env.TOKEN' },
    ])
    const replayed = db
      .select({ receiptJson: resourceBundleApplies.receiptJson })
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.id, receipt.journalId))
      .get()
    expect(JSON.parse(replayed?.receiptJson ?? '{}').skippedSecrets).toEqual(receipt.skippedSecrets)
  })
})

describe('清理', () => {
  test('临时目录', () => {
    for (const d of dirs.splice(0)) removeTempDirSync(d)
    expect(dirs).toHaveLength(0)
  })
})

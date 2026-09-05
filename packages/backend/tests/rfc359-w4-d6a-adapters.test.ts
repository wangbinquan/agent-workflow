// RFC-359 W4-D6a —— development adapter 链合一（中立 store / 异步命令 / 单一配置装配）与 resource-catalog 的
// foreign-owner ACL 路径（identity 行由 owner 在同一个目录写事务里交出），同一段断言在两个引擎上各跑一遍：
// store 的 identity + immutable revisions 与撞名归类；配置装配的可见性 / 技术细节读面 / 改名栅栏；ACL 读写经目录
// 中立路径——CAS、grants 整体替换、owner 变更时的撞名判定与旧 owner 降级为 read。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { ProviderNeutralDatabase } from '@/db/query'
import { developmentAdapterDefinitions, resourceGrants, users } from '@/db/schema'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
  reviseDevelopmentAdapterDraft,
} from '@/modules/integration/application/developmentAdapterCommands'
import { composeDevelopmentAdapterConfigOperationsFor } from '@/modules/integration/composition/developmentAdapterConfigOperations'
import { createDevelopmentAdapterStore } from '@/modules/integration/infrastructure/developmentAdapterStore'
import { composeForeignResourceAclFor } from '@/modules/resource-catalog/composition/resourceAcl'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

function actorOf(
  id: string,
  role: 'admin' | 'user' = 'user',
  permissions: readonly string[] = [],
): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
    additionalPermissions: [...permissions] as never,
  })
}

async function seedUser(
  db: ProviderNeutralDatabase,
  role: 'admin' | 'user' = 'user',
): Promise<string> {
  const id = `u_d6_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

function content(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    purpose: 'requirement-source',
    operations: ['acquire'],
    contractVersion: 1,
    executableRef: 'programs/req-fetch.ts',
    parameterSchemaRef: null,
    connectionRef: null,
    secretProjection: ['REQ_SYS_TOKEN'],
    outputBudget: { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 },
    timeoutMs: 60_000,
    ...overrides,
  }
}

/** 配置装配吃 identity-access 的 direct authority；本用例只关心授权判定，按既有用例的写法把 actor 投影过去。 */
function authorityOf(actor: Actor): DirectAuthenticatedAuthority {
  return actor as unknown as DirectAuthenticatedAuthority
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describeEachProvider('RFC-359 W4-D6a —— development adapter 链与 foreign-owner ACL', (harness) => {
  test('store：identity + immutable revisions、publish 原子、撞名经能力矩阵归类', async () => {
    const db = harness.db
    const store = createDevelopmentAdapterStore(db)
    const author = { userId: 'author-1', actorHasScriptsAuthor: true }
    const row = await createDevelopmentAdapter(store, author, {
      name: 'req-sys',
      content: content(),
      now: 1000,
    })
    expect(row).toMatchObject({
      publishedRevision: null,
      visibility: 'private',
      ownerUserId: 'author-1',
    })
    expect(
      await codeOf(() =>
        createDevelopmentAdapter(store, author, { name: 'req-sys', content: content(), now: 1001 }),
      ),
    ).toBe('development-adapter-name-taken')
    expect(
      await codeOf(() =>
        createDevelopmentAdapter(
          store,
          { userId: 'x', actorHasScriptsAuthor: false },
          { name: 'gated', content: content(), now: 1 },
        ),
      ),
    ).toBe('scripts-author-required')

    const first = await publishDevelopmentAdapter(store, author, { id: row.id, now: 2000 })
    expect(first.revision).toBe(1)
    await reviseDevelopmentAdapterDraft(store, author, {
      id: row.id,
      content: content({ timeoutMs: 120_000 }),
      now: 3000,
    })
    const second = await publishDevelopmentAdapter(store, author, { id: row.id, now: 4000 })
    expect(second.revision).toBe(2)
    expect(second.contentDigest).not.toBe(first.contentDigest)
    const revisionOne = await store.getRevision(row.id, 1)
    expect(revisionOne?.contentDigest).toBe(first.contentDigest)
    expect(JSON.parse(revisionOne!.contentJson).timeoutMs).toBe(60_000)
    expect((await store.getById(row.id))?.publishedRevision).toBe(2)
    expect(await store.getRevision(row.id, 9)).toBeNull()
    expect((await store.list()).map((item) => item.id)).toContain(row.id)

    // owner 改名经 store；purpose 不可变；归档后不可再发布。
    await reviseDevelopmentAdapterDraft(store, author, {
      id: row.id,
      content: content(),
      name: 'req-sys-2',
      now: 5000,
    })
    expect((await store.getById(row.id))?.name).toBe('req-sys-2')
    expect(
      await codeOf(() =>
        reviseDevelopmentAdapterDraft(store, author, {
          id: row.id,
          content: content({
            purpose: 'pipeline-gate',
            operations: ['collect'],
            secretProjection: [],
          }),
          now: 6,
        }),
      ),
    ).toBe('development-adapter-purpose-immutable')
    await store.archive({ id: row.id, now: 7000 })
    expect(
      await codeOf(() => publishDevelopmentAdapter(store, author, { id: row.id, now: 8 })),
    ).toBe('development-adapter-not-found')
  })

  test('配置装配：可见性、技术细节读面、editor 改名栅栏——两个 provider 同一份', async () => {
    const db = harness.db
    const catalog = composeResourceCatalogFor({ db })
    const owner = await seedUser(db)
    const editor = await seedUser(db)
    const reader = await seedUser(db)
    const stranger = await seedUser(db)
    const access = {
      filterVisible: (actor: Actor, type: never, rows: never) =>
        catalog.authorization.filterVisibleRows(actor, type, rows),
      canView: (actor: Actor, type: never, row: never) =>
        catalog.authorization.canViewResource(actor, type, row),
      requireEdit: (actor: Actor, type: never, row: never) =>
        catalog.authorization.requireResourceEdit(actor, type, row),
      requireGovern: (actor: Actor, type: never, row: never) =>
        catalog.authorization.requireResourceGovern(actor, type, row),
      assertNameUnchangedForEditor: catalog.authorization.assertNameUnchangedForEditor,
    }
    const store = createDevelopmentAdapterStore(db)
    const operations = composeDevelopmentAdapterConfigOperationsFor({
      db,
      access: access as never,
      grants: catalog.persistence.grants,
      now: () => NOW,
    })
    // `user` 基线已含 adapter-definitions:update；技术细节读面还要 scripts:author（可作附加权限授予）。
    const technical = ['scripts:author'] as const
    const ownerActor = authorityOf(actorOf(owner, 'user', technical))
    const editorActor = authorityOf(actorOf(editor, 'user', technical))
    const created = await operations.create(ownerActor, {
      name: 'adapter-a',
      purpose: 'requirement-source',
      draft: content(),
    })
    expect(created).toMatchObject({
      name: 'adapter-a',
      purpose: 'requirement-source',
      visibility: 'private',
    })
    await db.insert(resourceGrants).values([
      {
        resourceType: 'development_adapter',
        resourceId: created.id,
        userId: editor,
        level: 'write',
        addedBy: owner,
        addedAt: NOW,
      },
      {
        resourceType: 'development_adapter',
        resourceId: created.id,
        userId: reader,
        level: 'read',
        addedBy: owner,
        addedAt: NOW,
      },
    ])

    // 技术细节（draft）只对「有权限点 + 可编辑」开放；显式被授权者只看 identity；陌生人看不见。
    expect((await operations.get(ownerActor, created.id)) as { draft?: unknown }).toHaveProperty(
      'draft',
    )
    expect((await operations.get(editorActor, created.id)) as { draft?: unknown }).toHaveProperty(
      'draft',
    )
    const readerView = (await operations.get(authorityOf(actorOf(reader)), created.id)) as {
      draft?: unknown
    }
    expect(readerView).not.toHaveProperty('draft')
    expect(readerView).toMatchObject({ id: created.id, name: 'adapter-a' })
    expect(await codeOf(() => operations.get(authorityOf(actorOf(stranger)), created.id))).toBe(
      'adapter-technical-details-forbidden',
    )
    expect(await codeOf(() => operations.get(ownerActor, 'missing'))).toBe('resource-not-found')
    expect(
      (await operations.list(authorityOf(actorOf(stranger)))).map((row) => row.id),
    ).not.toContain(created.id)
    expect((await operations.list(authorityOf(actorOf(reader)))).map((row) => row.id)).toContain(
      created.id,
    )

    // editor 只能改内容不能改名；owner 可以改名；publish / archive 各走各的门。
    expect(
      await codeOf(() =>
        operations.revise(editorActor, created.id, {
          name: 'renamed-by-editor',
          draft: content(),
        }),
      ),
    ).toBe('resource-rename-owner-only')
    await operations.revise(ownerActor, created.id, {
      name: 'adapter-b',
      draft: content({ timeoutMs: 90_000 }),
    })
    expect((await store.getById(created.id))?.name).toBe('adapter-b')
    const published = await operations.publish(editorActor, created.id)
    expect(published.revision).toBe(1)
    expect(await codeOf(() => operations.archive(editorActor, created.id))).toBe(
      'resource-govern-owner-only',
    )
    await operations.archive(ownerActor, created.id)
    expect((await store.getById(created.id))?.archivedAt).toBe(NOW)
    expect((await operations.loadAclRow(created.id))?.id).toBe(created.id)
  })

  test('foreign-owner ACL：目录的中立路径在同一事务里读 / 写 owner 的 identity 行', async () => {
    const db = harness.db
    const store = createDevelopmentAdapterStore(db)
    const owner = await seedUser(db)
    const grantee = await seedUser(db)
    const nextOwner = await seedUser(db)
    const created = await createDevelopmentAdapter(
      store,
      { userId: owner, actorHasScriptsAuthor: true },
      { name: 'shared', content: content(), now: NOW },
    )
    await createDevelopmentAdapter(
      store,
      { userId: nextOwner, actorHasScriptsAuthor: true },
      { name: 'shared', content: content(), now: NOW },
    )
    const acl = composeForeignResourceAclFor({ db, identity: store.resourceAclIdentity })
    const ownerActor = actorOf(owner)
    const row = { id: created.id, ownerUserId: owner, visibility: 'private' as const }

    const initial = await acl.getResourceAcl(ownerActor, 'development_adapter', row)
    expect(initial).toMatchObject({
      resourceType: 'development_adapter',
      ownerUserId: owner,
      aclRevision: 0,
      grants: [],
      canManage: true,
    })

    const granted = await acl.updateResourceAcl(
      ownerActor,
      'development_adapter',
      row,
      {
        expectedResourceId: created.id,
        expectedAclRevision: 0,
        grants: [{ userId: grantee, level: 'write' }],
      },
      { updatedAt: NOW + 1 },
    )
    expect(granted.aclRevision).toBe(1)
    expect(granted.grants.map((grant) => [grant.user.id, grant.level])).toEqual([
      [grantee, 'write'],
    ])
    expect(
      (
        await db
          .select()
          .from(developmentAdapterDefinitions)
          .where(eq(developmentAdapterDefinitions.id, created.id))
      )[0],
    ).toMatchObject({
      aclRevision: 1,
      updatedAt: NOW + 1,
    })

    // 过期的 aclRevision → 409；陌生人 → 404（看不见即不存在）。
    expect(
      await codeOf(() =>
        acl.updateResourceAcl(ownerActor, 'development_adapter', row, {
          expectedResourceId: created.id,
          expectedAclRevision: 0,
          grants: [],
        }),
      ),
    ).toBe('acl-revision-conflict')
    const outsider = actorOf(await seedUser(db))
    expect(await codeOf(() => acl.getResourceAcl(outsider, 'development_adapter', row))).toBe(
      'not-found',
    )

    // 换 owner：目标 owner 名下已有同名 → 撞名 409；换到无冲突的 owner 后旧 owner 降为 read。
    expect(
      await codeOf(() =>
        acl.updateResourceAcl(ownerActor, 'development_adapter', row, {
          expectedResourceId: created.id,
          expectedAclRevision: 1,
          ownerUserId: nextOwner,
        }),
      ),
    ).toBe('resource-name-conflict')
    const fresh = await seedUser(db)
    const transferred = await acl.updateResourceAcl(
      ownerActor,
      'development_adapter',
      row,
      { expectedResourceId: created.id, expectedAclRevision: 1, ownerUserId: fresh },
      { updatedAt: NOW + 2 },
    )
    expect(transferred.ownerUserId).toBe(fresh)
    expect(transferred.grants.map((grant) => [grant.user.id, grant.level]).sort()).toEqual(
      [
        [grantee, 'write'],
        [owner, 'read'],
      ].sort(),
    )
    expect(await store.resourceAclIdentity.getRevision(created.id)).toBe(2)
  })
})

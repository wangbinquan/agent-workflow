// RFC-359 W4-B2 批 b —— 目录资源的 ACL 表注册 / 可见性谓词 / grant 读端口 / 概览计数 / 目录摘要查询合成一份，
// 两个引擎各跑一遍：可见性阶梯（bypass ⇒ 全部；private 权限 ⇒ public + 自有 + 被授权；无 private 权限 ⇒ 仅 public）、
// grant 读端口三法、概览计数、摘要查询的搜索（`instr(lower(…))` 两方言同一句）与 after 游标。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, resourceGrants, users } from '@/db/schema'
import { createDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/application/demoResourceCatalogSeed'
import { createResourceCatalogSummaryReadPort } from '@/modules/resource-catalog/infrastructure/catalogQuery'
import { createDemoResourceCatalogSeedPersistence } from '@/modules/resource-catalog/infrastructure/demoResourceCatalogSeed'
import { createResourceCatalogOverviewCountPort } from '@/modules/resource-catalog/infrastructure/resourceCatalogOverview'
import {
  ACL_TABLES,
  createResourceGrantReadPort,
} from '@/modules/resource-catalog/infrastructure/resourceVisibility'
import { POSTGRESQL_ACL_TABLES } from '@/modules/resource-catalog/infrastructure/aclRegistry'
import { SQLITE_ACL_TABLES } from '@/modules/resource-catalog/infrastructure/sqliteAclRegistry'
import { describeEachProvider } from './helpers/eachProvider'

async function seedUser(db: ProviderNeutralDatabase, role: 'admin' | 'user'): Promise<string> {
  const id = `u_b2b_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

function actorFor(userId: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id: userId, username: userId, displayName: userId, role, status: 'active' },
    source: 'session',
  })
}

/** 没有任何权限的 actor：只看得见 public 行（与 nodeMechanics 的 ownerless legacy actor 同形）。 */
function publicOnlyActor(userId: string): Actor {
  return Object.freeze({
    user: Object.freeze({
      id: userId,
      username: userId,
      displayName: userId,
      role: 'user',
      status: 'active',
    }),
    source: 'daemon',
    permissions: new Set(),
    authorityRevision: 0,
  }) as Actor
}

/** 用演示种子造两个 agent（种子恒 public），再把其中一个改成某 owner 的 private。 */
async function seedAgents(db: ProviderNeutralDatabase, owner: string, tag: string) {
  const participant = createDemoResourceCatalogSeedParticipant(
    createDemoResourceCatalogSeedPersistence(db),
  )
  const definition: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [{ kind: 'text', key: 'k', label: 'k' }],
    nodes: [{ id: 'in', kind: 'input', inputKey: 'k' }],
    edges: [],
  }
  const seedOne = async (agentId: string, name: string) =>
    participant.seed({
      marker: { kind: 'initial-demo-offer', ownerUserId: owner, offeredAt: 10 },
      agent: {
        id: agentId,
        name,
        description: `${tag} agent ${name}`,
        outputs: ['summary'],
        syncOutputsOnIterate: false,
        readonly: true,
        bodyMd: 'x',
      },
      workflows: [
        {
          id: `wf_${ulid()}`,
          name: `wf-a-${ulid().slice(-6).toLowerCase()}`,
          description: '',
          definition,
        },
        {
          id: `wf_${ulid()}`,
          name: `wf-b-${ulid().slice(-6).toLowerCase()}`,
          description: '',
          definition,
        },
      ],
    })
  const publicId = `a_${ulid()}`
  const privateId = `a_${ulid()}`
  await seedOne(publicId, `${tag}-public`)
  await seedOne(privateId, `${tag}-private`)
  await db
    .update(agents)
    .set({ visibility: 'private', ownerUserId: owner })
    .where(eq(agents.id, privateId))
  return { publicId, privateId }
}

describeEachProvider('RFC-359 W4-B2b —— 可见性阶梯与 grant 读端口', (harness) => {
  test('概览计数按阶梯：bypass 全见、owner 见自有、grantee 见被授权、无权限只见 public', async () => {
    const db = harness.db
    const owner = await seedUser(db, 'user')
    const grantee = await seedUser(db, 'user')
    const stranger = await seedUser(db, 'user')
    const admin = await seedUser(db, 'admin')
    const tag = `t${ulid().slice(-5).toLowerCase()}`
    const { privateId } = await seedAgents(db, owner, tag)
    await db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: privateId,
      userId: grantee,
      level: 'read',
      addedBy: owner,
      addedAt: 1,
    })
    const counts = createResourceCatalogOverviewCountPort(db)
    const countFor = (actor: Actor) =>
      counts.countVisible(actor, 'agent', { excludeBuiltin: false })
    const all = await countFor(actorFor(admin, 'admin'))
    const ownerSees = await countFor(actorFor(owner, 'user'))
    const granteeSees = await countFor(actorFor(grantee, 'user'))
    const strangerSees = await countFor(actorFor(stranger, 'user'))
    const publicOnly = await countFor(publicOnlyActor(stranger))
    expect(ownerSees).toBe(all)
    expect(granteeSees).toBe(all)
    expect(strangerSees).toBe(all - 1)
    expect(publicOnly).toBe(all - 1)

    const grants = createResourceGrantReadPort(db)
    expect(await grants.listGrantedResourceIds(actorFor(grantee, 'user'), 'agent')).toEqual(
      new Set([privateId]),
    )
    expect(await grants.loadGrantLevel('agent', privateId, grantee)).toBe('read')
    expect(await grants.loadGrantLevel('agent', privateId, stranger)).toBeNull()
    expect(await grants.loadGrantLevelsForUser('agent', [privateId, 'missing'], grantee)).toEqual(
      new Map([[privateId, 'read']]),
    )
  })

  test('摘要查询：搜索用 instr(lower(…))、按名 + id 排序、after 游标翻页；三个表注册是同一份', async () => {
    const db = harness.db
    const owner = await seedUser(db, 'user')
    const tag = `s${ulid().slice(-5).toLowerCase()}`
    const { publicId, privateId } = await seedAgents(db, owner, tag)
    const summaries = createResourceCatalogSummaryReadPort(db)
    const ownerActor = actorFor(owner, 'user')
    const page = await summaries.listKind(ownerActor, 'agent', {
      limit: 10,
      search: tag.toUpperCase(),
    })
    expect(page.map((item) => item.ref.id).sort()).toEqual([publicId, privateId].sort())
    // 无权限 actor 搜同一段：只剩 public 那条。
    const publicPage = await summaries.listKind(publicOnlyActor(owner), 'agent', {
      limit: 10,
      search: tag,
    })
    expect(publicPage.map((item) => item.ref.id)).toEqual([publicId])
    // after 游标：第一页 1 条，第二页从它之后接着。
    const first = await summaries.listKind(ownerActor, 'agent', { limit: 1, search: tag })
    expect(first).toHaveLength(1)
    const second = await summaries.listKind(ownerActor, 'agent', {
      limit: 1,
      search: tag,
      after: { name: first[0]!.name, id: first[0]!.ref.id },
    })
    expect(second).toHaveLength(1)
    expect(second[0]!.ref.id).not.toBe(first[0]!.ref.id)
    expect(SQLITE_ACL_TABLES).toBe(ACL_TABLES)
    expect(POSTGRESQL_ACL_TABLES).toBe(ACL_TABLES)
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'resource-catalog',
    'infrastructure',
  )
  for (const entry of [
    'postgresqlResourceGrantRepository.ts',
    'sqliteResourceCatalogOverview.ts',
    'postgresqlResourceCatalogOverview.ts',
    'sqliteCatalogQuery.ts',
    'postgresqlCatalogQuery.ts',
  ]) {
    expect(existsSync(resolve(infra, entry))).toBe(false)
  }
})

// RFC-359 W4-D18 —— resource-catalog 的 Workgroup 聚合：异步仓库成为唯一实现（`sqliteWorkgroupRepository` /
// `postgresqlWorkgroupRepository` 退役），agent 引用可用性判定只剩一份（`referenceUsability.ts`），目录装配一份。
// 同一段断言在两个引擎上各跑一遍：创建（成员名解析）/ owner 级同名冲突 / 不可见 agent 报 acl-missing-refs / 不存在的
// agent 报 workgroup-member-agent-invalid / 复制（版本 + 快照哈希 OCC）/ save 三态 / 删除 OCC 与受众；附源码锁。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CreateAgentSchema, CreateWorkgroupSchema } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, resourceGrants, users } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { workgroupRepositoryDependencies } from '@/modules/resource-catalog/composition/workgroupOperations'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { resolveAgentIdsUsable } from '@/modules/resource-catalog/infrastructure/referenceUsability'
import { createWorkgroupRepository } from '@/modules/resource-catalog/infrastructure/workgroupRepository'
import { staleConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

async function seedUser(
  db: ProviderNeutralDatabase,
): Promise<{ id: string; authority: DirectAuthenticatedAuthority }> {
  const id = ulid()
  const username = `u-${id.slice(-8).toLowerCase()}`
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    role: 'user',
    createdAt: T0,
    updatedAt: T0,
  })
  const authority = buildActor({
    source: 'pat',
    patId: `pat-${id}`,
    patScopes: [],
    user: { id, username, displayName: username, role: 'user', status: 'active' },
  }) as unknown as DirectAuthenticatedAuthority
  return { id, authority }
}

async function seedAgent(db: ProviderNeutralDatabase, ownerUserId: string): Promise<string> {
  const id = ulid()
  await db.insert(agents).values(
    createAgentPersistenceValues({
      id,
      agent: CreateAgentSchema.parse({ name: `agent-${id.slice(-6).toLowerCase()}` }),
      ownerUserId,
      now: T0,
    }),
  )
  return id
}

function document(name: string, agentId: string) {
  return CreateWorkgroupSchema.parse({
    name,
    mode: 'free_collab',
    members: [{ memberType: 'agent', agentId, displayName: 'worker', roleDesc: 'does work' }],
  })
}

function initialAcl(ownerUserId: string) {
  return { ownerUserId, visibility: 'private' as const, aclRevision: 0 as const }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

function repositoryFor(db: ProviderNeutralDatabase) {
  return createWorkgroupRepository(db, workgroupRepositoryDependencies({ db, now: () => T0 + 10 }))
}

describeEachProvider('RFC-359 W4-D18 —— Workgroup 仓库', (harness) => {
  test('创建：成员 agent 名在事务里解析；同 owner 同名冲突；不可见 / 不存在的 agent 各按其码拒绝', async () => {
    const { repository } = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    const stranger = await seedUser(harness.db)
    const agentId = await seedAgent(harness.db, owner.id)
    const privateAgentOfStranger = await seedAgent(harness.db, stranger.id)
    const name = `wg-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create({
      authority: owner.authority,
      id: ulid(),
      document: document(name, agentId),
      initialAcl: initialAcl(owner.id),
      now: T0,
    })
    expect(created).toMatchObject({
      name,
      version: 1,
      ownerUserId: owner.id,
      visibility: 'private',
    })
    expect(created.members).toHaveLength(1)
    expect(created.members[0]).toMatchObject({
      memberType: 'agent',
      agentId,
      displayName: 'worker',
    })
    expect(created.members[0]?.agentName).toMatch(/^agent-/)
    expect(created.snapshotHash).toHaveLength(64)
    expect((await repository.get(created.id))?.id).toBe(created.id)
    expect((await repository.list()).map((row) => row.id)).toContain(created.id)
    expect(
      await codeOf(() =>
        repository.create({
          authority: owner.authority,
          id: ulid(),
          document: document(name, agentId),
          initialAcl: initialAcl(owner.id),
          now: T0,
        }),
      ),
    ).toBe('workgroup-name-in-use')
    expect(
      await codeOf(() =>
        repository.create({
          authority: owner.authority,
          id: ulid(),
          document: document(`${name}-x`, privateAgentOfStranger),
          initialAcl: initialAcl(owner.id),
          now: T0,
        }),
      ),
    ).toBe('acl-missing-refs')
    expect(
      await codeOf(() =>
        repository.create({
          authority: owner.authority,
          id: ulid(),
          document: document(`${name}-y`, 'no-such-agent'),
          initialAcl: initialAcl(owner.id),
          now: T0,
        }),
      ),
    ).toBe('workgroup-member-agent-invalid')
    // 引用可用性判定自身：不可见的 agent 被列出，grandfathered 的不再重审。
    expect(
      await resolveAgentIdsUsable(
        harness.db,
        owner.authority,
        [agentId, privateAgentOfStranger],
        new Set(),
      ),
    ).toEqual([privateAgentOfStranger])
    expect(
      await resolveAgentIdsUsable(
        harness.db,
        owner.authority,
        [privateAgentOfStranger],
        new Set([privateAgentOfStranger]),
      ),
    ).toEqual([])
  })

  test('复制按版本 + 快照哈希 OCC，复制品拿新名字；save 三态：committed / already-current / stale', async () => {
    const { repository, projection } = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    const agentId = await seedAgent(harness.db, owner.id)
    const name = `wg-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create({
      authority: owner.authority,
      id: ulid(),
      document: document(name, agentId),
      initialAcl: initialAcl(owner.id),
      now: T0,
    })
    expect(
      await codeOf(() =>
        repository.copy({
          authority: owner.authority,
          request: {
            id: created.id,
            copy: { expectedVersion: 1, expectedSnapshotHash: 'f'.repeat(64) },
          },
          id: ulid(),
          now: T0 + 1,
          initialAcl: initialAcl(owner.id),
        }),
      ),
    ).toBe(staleConflictError('workgroup', 'x').code)
    const copy = await repository.copy({
      authority: owner.authority,
      request: {
        id: created.id,
        copy: { expectedVersion: 1, expectedSnapshotHash: created.snapshotHash },
      },
      id: ulid(),
      now: T0 + 1,
      initialAcl: initialAcl(owner.id),
    })
    expect(copy.name).not.toBe(name)
    expect(copy.name.startsWith(name)).toBe(true)
    expect(copy.members.map((member) => member.agentId)).toEqual([agentId])

    const snapshot = projection.snapshotOf(created)
    const committed = await repository.save(owner.authority, {
      id: created.id,
      update: {
        expectedVersion: 1,
        clientMutationId: 'm-1',
        snapshot: { ...snapshot, description: 'v2' },
      },
    })
    expect(committed.committed).toBe(true)
    expect(committed.receipt).toMatchObject({ outcome: 'committed', clientMutationId: 'm-1' })
    expect(committed.receipt.revision.version).toBe(2)
    expect(committed.receipt.workgroup.description).toBe('v2')
    const replay = await repository.save(owner.authority, {
      id: created.id,
      update: {
        expectedVersion: 2,
        clientMutationId: 'm-2',
        snapshot: { ...snapshot, description: 'v2' },
      },
    })
    expect(replay.committed).toBe(false)
    expect(replay.receipt.outcome).toBe('already-current')
    expect(
      await codeOf(() =>
        repository.save(owner.authority, {
          id: created.id,
          update: {
            expectedVersion: 1,
            clientMutationId: 'm-3',
            snapshot: { ...snapshot, description: 'v3' },
          },
        }),
      ),
    ).toBe(staleConflictError('workgroup', 'x').code)
  })

  test('删除：版本不符报 stale；成功删除的回执带受众（可见性 / owner / 授权用户）', async () => {
    const { repository } = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    const viewer = await seedUser(harness.db)
    const agentId = await seedAgent(harness.db, owner.id)
    const created = await repository.create({
      authority: owner.authority,
      id: ulid(),
      document: document(`wg-${ulid().slice(-6).toLowerCase()}`, agentId),
      initialAcl: initialAcl(owner.id),
      now: T0,
    })
    await harness.db.insert(resourceGrants).values({
      resourceType: 'workgroup',
      resourceId: created.id,
      userId: viewer.id,
      addedBy: owner.id,
      addedAt: T0,
      level: 'read',
    })
    expect(
      await codeOf(() =>
        repository.delete(owner.authority, {
          id: created.id,
          deletion: { expectedVersion: 5, clientMutationId: 'd-0' },
        }),
      ),
    ).toBe(staleConflictError('workgroup', 'x').code)
    const deleted = await repository.delete(owner.authority, {
      id: created.id,
      deletion: { expectedVersion: 1, clientMutationId: 'd-1' },
    })
    expect(deleted.receipt).toEqual({ id: created.id, deletedVersion: 1, clientMutationId: 'd-1' })
    expect(deleted.audience).toMatchObject({ visibility: 'private', ownerUserId: owner.id })
    expect([...deleted.audience.grantedUserIds]).toEqual([viewer.id])
    expect(await repository.get(created.id)).toBeNull()
  })
})

test('源码锁：Workgroup 聚合没有 provider 命名的仓库 / 引用可用性 / 装配孪生，三个 bootstrap 走同一份装配', () => {
  const root = join(import.meta.dir, '..', 'src', 'modules', 'resource-catalog')
  for (const retired of [
    'infrastructure/sqliteWorkgroupRepository.ts',
    'infrastructure/postgresqlWorkgroupRepository.ts',
    'infrastructure/sqliteReferenceUsability.ts',
    'infrastructure/postgresqlReferenceUsability.ts',
  ]) {
    expect(existsSync(join(root, retired)), retired).toBe(false)
  }
  for (const neutral of [
    'infrastructure/workgroupRepository.ts',
    'infrastructure/referenceUsability.ts',
    'composition/workgroupOperations.ts',
  ]) {
    const source = readFileSync(join(root, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source, neutral).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bdbTxSync\b|DbTxSync/,
    )
    expect(source, neutral).not.toMatch(
      /composeSqlite|composePostgresql|createSqlite|createPostgresql/,
    )
  }
  for (const file of [
    'src/server.ts',
    'src/cli/start.ts',
    'src/cli/postgresqlDaemonApplication.ts',
  ]) {
    const source = readFileSync(join(import.meta.dir, '..', file), 'utf8')
    expect(source, file).toContain('composeWorkgroupCatalog({')
    expect(source, file).not.toMatch(
      /composePostgresqlWorkgroupCatalog|composeSqliteWorkgroupCatalog/,
    )
  }
})

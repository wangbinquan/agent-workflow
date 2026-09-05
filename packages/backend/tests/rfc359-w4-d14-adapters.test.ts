// RFC-359 W4-D14 —— resource-catalog 的 Agent 聚合：异步仓库 / 语义层 / portable-import 快照成为唯一实现，SQLite 装配
// 也切到这一份。同一段断言在两个引擎上各跑一遍：创建 / 读 / 列表、owner 级 name 唯一（唯一冲突经能力矩阵映射）、
// fence 过期、改名冲突、引用校验（依赖 / runtime）、删除受引用保护、引用标签、import 引用快照；附源码锁。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CreateAgentSchema, type CreateAgent } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { users } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeAgentImportQueries } from '@/modules/resource-catalog/composition/agentImportQueries'
import { composeDatabaseAgentResourceInventorySource } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { createAgentImportReferenceReadPort } from '@/modules/resource-catalog/infrastructure/agentImportQueries'
import { createAgentPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/agentPersistenceSemantics'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { staleConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

async function seedUser(
  db: ProviderNeutralDatabase,
  role: 'admin' | 'user' = 'user',
): Promise<DirectAuthenticatedAuthority> {
  const id = ulid()
  const username = `u-${id.slice(-8).toLowerCase()}`
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    role,
    createdAt: T0,
    updatedAt: T0,
  })
  return buildActor({
    source: 'pat',
    patId: `pat-${id}`,
    patScopes: [],
    user: { id, username, displayName: username, role, status: 'active' },
  }) as unknown as DirectAuthenticatedAuthority
}

function agentInput(name: string, overrides: Partial<CreateAgent> = {}): CreateAgent {
  return { ...CreateAgentSchema.parse({ name }), ...overrides }
}

function repositoryFor(db: ProviderNeutralDatabase) {
  const catalog = composeResourceCatalogFor({ db })
  const inventory = composeDatabaseAgentResourceInventorySource({
    db,
    authorization: catalog.authorization,
  })
  const semantics = createAgentPersistenceSemantics({
    db,
    authorization: catalog.authorization,
    resourceInventory: inventory,
    runtimeProfiles: {
      async get(name) {
        if (name === 'opencode') return { enabled: true }
        if (name === 'retired') return { enabled: false }
        return null
      },
    },
  })
  return createAgentRepository({ db, semantics })
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

describeEachProvider('RFC-359 W4-D14 —— Agent 仓库', (harness) => {
  test('创建 / 读 / 列表；同 owner 同名冲突经唯一索引映射成 agent-name-in-use，不同 owner 可同名', async () => {
    const repository = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    const other = await seedUser(harness.db)
    const name = `agent-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create(owner, agentInput(name, { runtime: 'opencode' }))
    expect(created).toMatchObject({ name, ownerUserId: owner.user.id, runtime: 'opencode' })
    expect(await repository.get(created.id)).toMatchObject({ id: created.id, name })
    expect((await repository.list()).map((row) => row.id)).toContain(created.id)
    expect(await codeOf(() => repository.create(owner, agentInput(name)))).toBe('agent-name-in-use')
    const twin = await repository.create(other, agentInput(name))
    expect(twin.id).not.toBe(created.id)
    expect(await repository.get('missing')).toBeNull()
  })

  test('引用校验：未知依赖 / 未知或已停用 runtime 拒绝；update 带 fence，过期 fence 报 stale', async () => {
    const repository = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    expect(
      await codeOf(() =>
        repository.create(
          owner,
          agentInput(`dep-${ulid().slice(-6).toLowerCase()}`, { dependsOn: ['no-such-agent'] }),
        ),
      ),
    ).toBe('agent-dependency-not-found')
    expect(
      await codeOf(() =>
        repository.create(
          owner,
          agentInput(`rt-${ulid().slice(-6).toLowerCase()}`, { runtime: 'ghost' }),
        ),
      ),
    ).toBe('runtime-not-found')
    expect(
      await codeOf(() =>
        repository.create(
          owner,
          agentInput(`rt2-${ulid().slice(-6).toLowerCase()}`, { runtime: 'retired' }),
        ),
      ),
    ).toBe('runtime-disabled')

    const base = await repository.create(
      owner,
      agentInput(`base-${ulid().slice(-6).toLowerCase()}`),
    )
    const child = await repository.create(
      owner,
      agentInput(`child-${ulid().slice(-6).toLowerCase()}`, { dependsOn: [base.id] }),
    )
    expect(child.dependsOn).toEqual([base.id])
    const fence = {
      expectedUpdatedAt: child.updatedAt,
      expectedAclRevision: child.aclRevision ?? 0,
    }
    const updated = await repository.update(owner, child.id, { description: 'v2' }, fence)
    expect(updated.description).toBe('v2')
    expect(updated.updatedAt).toBeGreaterThan(child.updatedAt)
    expect(
      await codeOf(() => repository.update(owner, child.id, { description: 'v3' }, fence)),
    ).toBe(staleConflictError('agent', 'x').code)
    expect(
      await codeOf(() =>
        repository.update(
          owner,
          child.id,
          { dependsOn: [child.id] },
          { expectedUpdatedAt: updated.updatedAt, expectedAclRevision: updated.aclRevision ?? 0 },
        ),
      ),
    ).toBe('agent-dependency-self')
  })

  test('改名：同名返回原行；撞上 owner 下另一个名字报 agent-name-in-use；删除受依赖保护，解除后可删', async () => {
    const repository = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    const a = await repository.create(owner, agentInput(`a-${ulid().slice(-6).toLowerCase()}`))
    const b = await repository.create(owner, agentInput(`b-${ulid().slice(-6).toLowerCase()}`))
    const fenceOf = (row: { updatedAt: number; aclRevision?: number | null }) => ({
      expectedUpdatedAt: row.updatedAt,
      expectedAclRevision: row.aclRevision ?? 0,
    })
    expect((await repository.rename(owner, a.id, { newName: a.name }, fenceOf(a))).updatedAt).toBe(
      a.updatedAt,
    )
    expect(
      await codeOf(() => repository.rename(owner, a.id, { newName: b.name }, fenceOf(a))),
    ).toBe('agent-name-in-use')
    const renamed = await repository.rename(owner, a.id, { newName: `${a.name}-2` }, fenceOf(a))
    expect(renamed.name).toBe(`${a.name}-2`)

    const dependent = await repository.create(
      owner,
      agentInput(`dep-${ulid().slice(-6).toLowerCase()}`, { dependsOn: [renamed.id] }),
    )
    expect(await codeOf(() => repository.delete(owner, renamed.id, fenceOf(renamed)))).toBe(
      'agent-in-use',
    )
    await repository.delete(owner, dependent.id, fenceOf(dependent))
    await repository.delete(owner, renamed.id, fenceOf(renamed))
    expect(await repository.get(renamed.id)).toBeNull()
    expect(await codeOf(() => repository.delete(owner, renamed.id, fenceOf(renamed)))).toBe(
      'agent-not-found',
    )
  })

  test('引用标签与 portable-import 快照两个引擎同形', async () => {
    const repository = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    const name = `imp-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create(owner, agentInput(name))
    expect(
      await repository.referenceLabels(owner, {
        agents: [created],
        visibleAgentIds: [created.id],
      }),
    ).toEqual({ skills: [], mcps: [], plugins: [] })
    const snapshot = await createAgentImportReferenceReadPort(harness.db).snapshot(
      owner,
      [{ type: 'agent', name }],
      [],
    )
    expect(snapshot.candidateSets).toHaveLength(1)
    expect(snapshot.candidateSets[0]?.candidates).toEqual([
      {
        id: created.id,
        ownerUserId: owner.user.id,
        ownerUsername: owner.user.username,
        visibility: 'private',
        aclRevision: 0,
      },
    ])
    expect(typeof composeAgentImportQueries(harness.db).resolve).toBe('function')
  })
})

test('源码锁：Agent 聚合没有 provider 命名的仓库 / 语义 / 快照孪生，SQLite 装配也走同一份', () => {
  const root = join(import.meta.dir, '..', 'src', 'modules', 'resource-catalog')
  for (const retired of [
    'infrastructure/sqliteAgentRepository.ts',
    'infrastructure/postgresqlAgentRepository.ts',
    'infrastructure/postgresqlAgentPersistenceSemantics.ts',
    'infrastructure/sqliteAgentImportQueries.ts',
    'infrastructure/postgresqlAgentImportQueries.ts',
  ]) {
    expect(existsSync(join(root, retired)), retired).toBe(false)
  }
  for (const neutral of [
    'infrastructure/agentRepository.ts',
    'infrastructure/agentPersistenceSemantics.ts',
    'infrastructure/agentImportQueries.ts',
    'composition/agentOperations.ts',
    'composition/agentImportQueries.ts',
    'composition/agentResourceIntegrity.ts',
    'composition/portableImportReferences.ts',
  ]) {
    const source = readFileSync(join(root, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source, neutral).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|DbTxSync/)
    expect(source, neutral).toContain('ProviderNeutralDatabase')
  }
  for (const file of ['src/server.ts', 'src/cli/start.ts']) {
    const source = readFileSync(join(import.meta.dir, '..', file), 'utf8')
    expect(source, file).toContain('composeDatabaseAgentCatalog({')
    expect(source, file).not.toContain('resource-catalog/infrastructure/')
    expect(source, file).not.toMatch(
      /composeSqliteAgentImportQueries|composeSqliteAgentResourceIntegrity/,
    )
  }
})

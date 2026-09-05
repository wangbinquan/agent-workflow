// RFC-359 W4-D17 —— resource-catalog 的 Plugin 聚合：异步仓库成为唯一实现（`sqlitePluginRepository` /
// `postgresqlPluginRepository` 退役），目录装配与代际清扫装配各一份。同一段断言在两个引擎上各跑一遍：创建 / 读 / 列表、
// owner 级 name 唯一（唯一冲突经能力矩阵映射）、`assertNameAvailable`、publish 的 configHash OCC、改名撞名、被 agent
// 引用时删除只回引用、无引用时删除；附源码锁。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CreateAgentSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, users } from '@/db/schema'
import type { PluginCreateRecord } from '@/modules/resource-catalog/application/plugins/ports'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { pluginConfigHash } from '@/modules/resource-catalog/infrastructure/pluginPersistence'
import { createPluginRepository } from '@/modules/resource-catalog/infrastructure/pluginRepository'
import { staleConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = ulid()
  await db.insert(users).values({
    id,
    username: `u-${id.slice(-8).toLowerCase()}`,
    displayName: id,
    role: 'user',
    createdAt: T0,
    updatedAt: T0,
  })
  return id
}

function record(ownerUserId: string, name: string): PluginCreateRecord {
  const id = ulid()
  return {
    id,
    name,
    spec: 'example-plugin@1.0.0',
    options: { flag: true },
    description: '',
    enabled: true,
    sourceKind: 'npm',
    cachedPath: `/plugins/${id}/1`,
    resolvedVersion: '1.0.0',
    ownerUserId,
    visibility: 'private',
    aclRevision: 0,
    now: T0,
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

describeEachProvider('RFC-359 W4-D17 —— Plugin 仓库', (harness) => {
  test('创建 / 读 / 列表；owner 级同名冲突映射成 plugin-name-in-use；assertNameAvailable 同判据', async () => {
    const { repository, projection } = createPluginRepository({ db: harness.db })
    const owner = await seedUser(harness.db)
    const other = await seedUser(harness.db)
    const name = `plugin-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create(record(owner, name))
    expect(created).toMatchObject({ name, ownerUserId: owner, enabled: true, sourceKind: 'npm' })
    expect(created.options).toEqual({ flag: true })
    expect((await repository.get(created.id))?.id).toBe(created.id)
    expect((await repository.list()).map((row) => row.id)).toContain(created.id)
    expect(projection.configHashOf(created)).toBe(pluginConfigHash(created))
    expect(await codeOf(() => repository.create(record(owner, name)))).toBe('plugin-name-in-use')
    // 另一位 owner 可以用同名（唯一键是 owner + name）。
    const twin = await repository.create(record(other, name))
    expect(twin.ownerUserId).toBe(other)
    expect(
      await codeOf(() =>
        repository.assertNameAvailable({ purpose: 'create', ownerUserId: owner, name }),
      ),
    ).toBe('plugin-name-in-use')
    await repository.assertNameAvailable({
      purpose: 'rename',
      ownerUserId: owner,
      name,
      excludeId: created.id,
    })
    expect(await repository.get('missing')).toBeNull()
  })

  test('publish 按 configHash 做 OCC；改名撞名冲突、成功改名返回新行', async () => {
    const { repository, projection } = createPluginRepository({ db: harness.db })
    const owner = await seedUser(harness.db)
    const name = `plugin-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create(record(owner, name))
    const sibling = await repository.create(record(owner, `${name}-b`))
    const set = {
      spec: 'example-plugin@2.0.0',
      options: { flag: false },
      description: 'v2',
      enabled: true,
      sourceKind: 'npm' as const,
      cachedPath: `/plugins/${created.id}/2`,
      resolvedVersion: '2.0.0',
      installedAt: T0 + 1,
      updatedAt: T0 + 1,
    }
    expect(
      await codeOf(() => repository.publish({ id: created.id, expectedConfigHash: 'stale', set })),
    ).toBe(staleConflictError('plugin', 'x').code)
    expect(
      await codeOf(() =>
        repository.publish({
          id: 'missing',
          expectedConfigHash: projection.configHashOf(created),
          set,
        }),
      ),
    ).toBe('plugin-not-found')
    const published = await repository.publish({
      id: created.id,
      expectedConfigHash: projection.configHashOf(created),
      set,
    })
    expect(published).toMatchObject({
      spec: 'example-plugin@2.0.0',
      description: 'v2',
      resolvedVersion: '2.0.0',
      installedAt: T0 + 1,
      updatedAt: T0 + 1,
    })
    expect(published.options).toEqual({ flag: false })
    expect(
      await codeOf(() =>
        repository.rename({
          id: created.id,
          newName: sibling.name,
          expectedConfigHash: projection.configHashOf(published),
          updatedAt: T0 + 2,
        }),
      ),
    ).toBe('plugin-name-in-use')
    const renamed = await repository.rename({
      id: created.id,
      newName: `${name}-renamed`,
      expectedConfigHash: projection.configHashOf(published),
      updatedAt: T0 + 2,
    })
    expect(renamed).toMatchObject({ name: `${name}-renamed`, updatedAt: T0 + 2 })
  })

  test('删除：被 agent 引用时只回引用、不删；无引用时删除；引用查询按 id 精确命中', async () => {
    const { repository, projection } = createPluginRepository({ db: harness.db })
    const owner = await seedUser(harness.db)
    const created = await repository.create(
      record(owner, `plugin-${ulid().slice(-6).toLowerCase()}`),
    )
    const agentId = ulid()
    await harness.db.insert(agents).values(
      createAgentPersistenceValues({
        id: agentId,
        agent: CreateAgentSchema.parse({
          name: `agent-${ulid().slice(-6).toLowerCase()}`,
          plugins: [created.id],
        }),
        ownerUserId: owner,
        now: T0,
      }),
    )
    expect((await repository.findAgentReferences(created.id)).map((ref) => ref.id)).toEqual([
      agentId,
    ])
    const blocked = await repository.delete({
      id: created.id,
      expectedConfigHash: projection.configHashOf(created),
    })
    expect(blocked.map((ref) => ref.id)).toEqual([agentId])
    expect(await repository.get(created.id)).not.toBeNull()
    await harness.db.delete(agents).where(eq(agents.id, agentId))
    expect(
      await codeOf(() => repository.delete({ id: created.id, expectedConfigHash: 'stale' })),
    ).toBe(staleConflictError('plugin', 'x').code)
    expect(
      await repository.delete({
        id: created.id,
        expectedConfigHash: projection.configHashOf(created),
      }),
    ).toEqual([])
    expect(await repository.get(created.id)).toBeNull()
    expect(await codeOf(() => repository.delete({ id: created.id, expectedConfigHash: 'x' }))).toBe(
      'plugin-not-found',
    )
  })
})

test('源码锁：Plugin 聚合没有 provider 命名的仓库 / 装配孪生，三个 bootstrap 与维护 worker 走同一份装配', () => {
  const root = join(import.meta.dir, '..', 'src', 'modules', 'resource-catalog')
  for (const retired of [
    'infrastructure/sqlitePluginRepository.ts',
    'infrastructure/postgresqlPluginRepository.ts',
  ]) {
    expect(existsSync(join(root, retired)), retired).toBe(false)
  }
  for (const neutral of [
    'infrastructure/pluginRepository.ts',
    'composition/pluginOperations.ts',
    'composition/pluginGenerationGc.ts',
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
    expect(source, file).toContain('composePluginCatalog({')
    expect(source, file).not.toMatch(/composePostgresqlPluginCatalog|composeSqlitePluginCatalog/)
  }
  const worker = readFileSync(
    join(import.meta.dir, '..', 'src', 'platform', 'background', 'maintenanceWorker.ts'),
    'utf8',
  )
  expect(worker).toContain('composePluginGenerationGcCommand(')
  expect(worker).not.toMatch(
    /composeSqlitePluginGenerationGcCommand|composePostgresqlPluginGenerationGcCommand/,
  )
})

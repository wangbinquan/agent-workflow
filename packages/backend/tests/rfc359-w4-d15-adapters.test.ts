// RFC-359 W4-D15 —— resource-catalog 的 Workflow 聚合：异步仓库 / 语义层 / 校验与 D15 准入成为唯一实现，SQLite 装配
// 也切到这一份。同一段断言在两个引擎上各跑一遍：创建 / 读 / 列表 / 复制命名、update 的 already-current 与 committed
// 与 stale、删除受工作流引用保护、校验端口装载库存、准入端口对不可见引用报 acl-missing-refs、managed skill 可用性判据；
// 附源码锁。

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateWorkflowSchema, type WorkflowDefinition } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { eq } from 'drizzle-orm'

import { users, workflows } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { skillVersionAbs } from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import { createSkillContentAvailability } from '@/modules/resource-catalog/infrastructure/skillContentAvailability'
import { createWorkflowPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/workflowPersistenceSemantics'
import { createWorkflowRepository } from '@/modules/resource-catalog/infrastructure/workflowRepository'
import {
  createWorkflowReferenceAdmissionPort,
  createWorkflowValidationPort,
} from '@/modules/resource-catalog/infrastructure/workflowValidation'
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

function definition(): WorkflowDefinition {
  return CreateWorkflowSchema.parse({
    name: 'x',
    definition: { $schema_version: 2, nodes: [], edges: [] },
  }).definition
}

function calling(workflowName: string): WorkflowDefinition {
  return CreateWorkflowSchema.parse({
    name: 'x',
    definition: {
      $schema_version: 2,
      nodes: [
        {
          id: 'call',
          kind: 'call-workflow',
          workflowName,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
  }).definition
}

function repositoryFor(db: ProviderNeutralDatabase, events: string[] = []) {
  const catalog = composeResourceCatalogFor({ db })
  const semantics = createWorkflowPersistenceSemantics({
    authorization: catalog.authorization,
    events: {
      created: (workflow) => {
        events.push(`created:${workflow.id}`)
      },
      updated: (receipt) => {
        events.push(`updated:${receipt.revision.version}`)
      },
      deleted: (id, version, _input, audience) => {
        events.push(
          `deleted:${id}:${version}:${audience.visibility}:${audience.ownerUserId}:${audience.grantedUserIds.size}`,
        )
      },
    },
  })
  return { repository: createWorkflowRepository({ db, semantics }), catalog }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

describeEachProvider('RFC-359 W4-D15 —— Workflow 仓库', (harness) => {
  test('创建 / 读 / 列表 / 复制；事件钩子按提交结果触发', async () => {
    const events: string[] = []
    const { repository } = repositoryFor(harness.db, events)
    const owner = await seedUser(harness.db)
    const name = `wf-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create(owner, {
      name,
      description: 'd',
      definition: definition(),
    })
    expect(created).toMatchObject({ name, version: 1, ownerUserId: owner.user.id })
    expect(events).toEqual([`created:${created.id}`])
    expect((await repository.get(created.id))?.id).toBe(created.id)
    expect((await repository.list()).map((row) => row.id)).toContain(created.id)
    expect(await repository.getAclIdentity(created.id)).toMatchObject({
      id: created.id,
      name,
      ownerUserId: owner.user.id,
    })
    const copy = await repository.copy(owner, created.id, {
      expectedVersion: created.version,
      expectedSnapshotHash: created.snapshotHash,
    })
    expect(copy.name).toBe(`${name}-copy`)
    const copyAgain = await repository.copy(owner, created.id, {
      expectedVersion: created.version,
      expectedSnapshotHash: created.snapshotHash,
    })
    expect(copyAgain.name).toBe(`${name}-copy-2`)
    expect(
      await codeOf(() =>
        repository.copy(owner, created.id, {
          expectedVersion: 99,
          expectedSnapshotHash: created.snapshotHash,
        }),
      ),
    ).toBe(staleConflictError('workflow', 'x').code)
    expect(await repository.get('missing')).toBeNull()
  })

  test('update：同版本无变化 already-current；有变化 committed 且版本 +1；旧版本上的真实变更 stale', async () => {
    const events: string[] = []
    const { repository } = repositoryFor(harness.db, events)
    const owner = await seedUser(harness.db)
    const name = `wf-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create(owner, {
      name,
      description: '',
      definition: definition(),
    })
    const unchanged = await repository.update(owner, created.id, {
      expectedVersion: 1,
      clientMutationId: ulid(),
      snapshot: { name, description: '', definition: definition() },
    })
    expect(unchanged.outcome).toBe('already-current')
    const committed = await repository.update(owner, created.id, {
      expectedVersion: 1,
      clientMutationId: ulid(),
      snapshot: { name, description: 'changed', definition: definition() },
    })
    expect(committed).toMatchObject({ outcome: 'committed', revision: { version: 2 } })
    expect(events.filter((event) => event.startsWith('updated:'))).toEqual(['updated:2'])
    expect(
      await codeOf(() =>
        repository.update(owner, created.id, {
          expectedVersion: 1,
          clientMutationId: ulid(),
          snapshot: { name, description: 'changed again', definition: definition() },
        }),
      ),
    ).toBe(staleConflictError('workflow', 'x').code)
    const replay = await repository.update(owner, created.id, {
      expectedVersion: 1,
      clientMutationId: ulid(),
      snapshot: { name, description: 'changed', definition: definition() },
    })
    expect(replay.outcome).toBe('already-current')
  })

  test('改名门：历史名字原样回存可保存；改成非法名报 workflow-name-invalid（RFC-264，两引擎同门）', async () => {
    const { repository } = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    const name = `wf-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create(owner, {
      name,
      description: '',
      definition: definition(),
    })
    // 模拟 slug 规则之前写入的历史名字：绕过命令直接改行。
    await harness.db
      .update(workflows)
      .set({ name: 'Legacy Name With Spaces' })
      .where(eq(workflows.id, created.id))
    const kept = await repository.update(owner, created.id, {
      expectedVersion: 1,
      clientMutationId: ulid(),
      snapshot: {
        name: 'Legacy Name With Spaces',
        description: 'touched',
        definition: definition(),
      },
    })
    expect(kept.outcome).toBe('committed')
    expect(
      await codeOf(() =>
        repository.update(owner, created.id, {
          expectedVersion: 2,
          clientMutationId: ulid(),
          snapshot: { name: '_reserved', description: 'touched', definition: definition() },
        }),
      ),
    ).toBe('workflow-name-invalid')
    const renamed = await repository.update(owner, created.id, {
      expectedVersion: 2,
      clientMutationId: ulid(),
      snapshot: { name: '代码审计流程', description: 'touched', definition: definition() },
    })
    expect(renamed).toMatchObject({ outcome: 'committed', snapshot: { name: '代码审计流程' } })
  })

  test('删除：被另一个工作流 call 时报 workflow-in-use；解除后按版本删除并触发事件', async () => {
    const events: string[] = []
    const { repository } = repositoryFor(harness.db, events)
    const owner = await seedUser(harness.db)
    const name = `wf-${ulid().slice(-6).toLowerCase()}`
    const callee = await repository.create(owner, {
      name,
      description: '',
      definition: definition(),
    })
    const caller = await repository.create(owner, {
      name: `${name}-caller`,
      description: '',
      definition: calling(name),
    })
    expect(
      await codeOf(() =>
        repository.delete(owner, callee.id, { expectedVersion: 1, clientMutationId: ulid() }),
      ),
    ).toBe('workflow-in-use')
    await repository.delete(owner, caller.id, { expectedVersion: 1, clientMutationId: ulid() })
    expect(
      await codeOf(() =>
        repository.delete(owner, callee.id, { expectedVersion: 7, clientMutationId: ulid() }),
      ),
    ).toBe(staleConflictError('workflow', 'x').code)
    await repository.delete(owner, callee.id, { expectedVersion: 1, clientMutationId: ulid() })
    expect(await repository.get(callee.id)).toBeNull()
    // 删除受众在事务里取出随事件带出：可见性 / owner / 授权用户数（冷缓存观众靠它收 delete 帧）。
    expect(events.filter((event) => event.startsWith('deleted:'))).toEqual([
      `deleted:${caller.id}:1:private:${owner.user.id}:0`,
      `deleted:${callee.id}:1:private:${owner.user.id}:0`,
    ])
    expect(
      await codeOf(() =>
        repository.delete(owner, callee.id, { expectedVersion: 1, clientMutationId: ulid() }),
      ),
    ).toBe('workflow-not-found')
  })

  test('校验端口装载库存并跑共享校验器；准入端口对他人私有引用报 acl-missing-refs', async () => {
    const { repository, catalog } = repositoryFor(harness.db)
    const owner = await seedUser(harness.db)
    const stranger = await seedUser(harness.db)
    const name = `wf-${ulid().slice(-6).toLowerCase()}`
    const created = await repository.create(owner, {
      name,
      description: '',
      definition: definition(),
    })
    const validation = createWorkflowValidationPort({
      db: harness.db,
      skillContent: { isAvailable: async () => true },
    })
    const validated = await validation.validate({
      definition: calling(name),
      currentWorkflow: { id: created.id, name: created.name },
    })
    expect(validated.validationContextHash).toMatch(/^[0-9a-f]{64}$/)
    expect(validated.result).toBeDefined()
    expect(validation.candidateHash(definition())).toMatch(/^[0-9a-f]{64}$/)

    const admission = createWorkflowReferenceAdmissionPort({
      db: harness.db,
      authorization: catalog.authorization,
    })
    await admission.assertUsable(owner, [
      { resourceType: 'workflow', references: [name], domain: 'name' },
    ])
    expect(
      await codeOf(() =>
        admission.assertUsable(stranger, [
          { resourceType: 'workflow', references: [name], domain: 'name' },
        ]),
      ),
    ).toBe('acl-missing-refs')
    // 不存在的名字不是准入的事（由存在性校验器负责）。
    await admission.assertUsable(stranger, [
      { resourceType: 'workflow', references: ['no-such-workflow'], domain: 'name' },
    ])
  })
})

test('managed skill 可用性判据：权威版本目录缺失即不可用，目录到位即可用', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-skill-availability-'))
  try {
    const availability = createSkillContentAvailability({ appHome })
    const skill = { id: `skill-${ulid()}`, contentVersion: 3 } as Parameters<
      typeof availability.isAvailable
    >[0]
    expect(await availability.isAvailable(skill)).toBe(false)
    mkdirSync(skillVersionAbs(appHome, skill.id, skill.contentVersion), { recursive: true })
    expect(await availability.isAvailable(skill)).toBe(true)
  } finally {
    rmSync(appHome, { recursive: true, force: true })
  }
})

test('源码锁：Workflow 聚合没有 provider 命名的仓库 / 语义 / 校验孪生，bootstrap 只经 composition 装配', () => {
  const root = join(import.meta.dir, '..', 'src', 'modules', 'resource-catalog')
  for (const retired of [
    'infrastructure/sqliteWorkflowRepository.ts',
    'infrastructure/sqliteWorkflowValidation.ts',
    'infrastructure/postgresqlWorkflowRepository.ts',
    'infrastructure/postgresqlWorkflowPersistenceSemantics.ts',
    'infrastructure/postgresqlWorkflowValidation.ts',
  ]) {
    expect(existsSync(join(root, retired)), retired).toBe(false)
  }
  for (const neutral of [
    'infrastructure/workflowRepository.ts',
    'infrastructure/workflowPersistenceSemantics.ts',
    'infrastructure/workflowValidation.ts',
    'infrastructure/skillContentAvailability.ts',
  ]) {
    const source = readFileSync(join(root, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source, neutral).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|DbTxSync/)
  }
  const composition = readFileSync(join(root, 'composition/workflowOperations.ts'), 'utf8')
  expect(composition).toContain('export function composeDatabaseWorkflowCatalog(')
  expect(composition).not.toMatch(/composePostgresqlWorkflowCatalog|createSqliteWorkflowRepository/)
  for (const file of ['src/server.ts', 'src/cli/start.ts']) {
    const source = readFileSync(join(import.meta.dir, '..', file), 'utf8')
    expect(source, file).toContain('composeDatabaseWorkflowCatalog({')
    expect(source, file).not.toContain('resource-catalog/infrastructure/')
  }
})

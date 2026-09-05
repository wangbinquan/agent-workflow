// RFC-359 W4 —— D14 / D15 把 Agent / Workflow 聚合切到 provider 形状的一份实现后，CI 在 94ce5351b 抓到两条只有
// 旧 SQLite 路径才有的行为被丢掉了（PG daemon 此前一直缺，也没有 e2e 盯着）。两条都补回一份实现里，这里两引擎各锁一遍：
//   ① 引用缺失先走 RFC-228 结构化预检（`agent-resources-invalid` + issues），不是逐类存在性围栏的 `skill-not-found`
//      （tests/rfc223-pr1-impl-gate.test.ts 走 HTTP 锁的是同一条，这里锁在仓库层，两引擎都跑）；
//   ② 目录自有类型的 ACL 写入提交后必须唤醒实时订阅（`resource-acl-changed`）——被升档 / 降档的观众不刷新页面也要
//      拿到新的控件（e2e/rfc324-graded-grants.spec.ts「升档后徽标必须自己消失」红的来源）。

import { expect, test } from 'bun:test'
import { CreateAgentSchema, CreateWorkflowSchema, type CreateAgent } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { users } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { WorkflowAccessRow } from '@/modules/resource-catalog/application/workflows/ports'
import { composeDatabaseAgentResourceInventorySource } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeProviderResourceAclOperationApplication } from '@/modules/resource-catalog/composition/resourceAcl'
import { createAgentPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/agentPersistenceSemantics'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { createWorkflowPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/workflowPersistenceSemantics'
import { createWorkflowRepository } from '@/modules/resource-catalog/infrastructure/workflowRepository'
import { registerRevalidationTrigger } from '@/ws/revalidationHook'
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

function agentInput(name: string, overrides: Partial<CreateAgent> = {}): CreateAgent {
  return { ...CreateAgentSchema.parse({ name }), ...overrides }
}

function agentRepositoryFor(db: ProviderNeutralDatabase) {
  const catalog = composeResourceCatalogFor({ db })
  const semantics = createAgentPersistenceSemantics({
    db,
    authorization: catalog.authorization,
    resourceInventory: composeDatabaseAgentResourceInventorySource({
      db,
      authorization: catalog.authorization,
    }),
    runtimeProfiles: {
      async get() {
        return null
      },
    },
  })
  return createAgentRepository({ db, semantics })
}

async function errorOf(fn: () => Promise<unknown>): Promise<{ code?: string; details?: unknown }> {
  try {
    await fn()
    return { code: '<no-throw>' }
  } catch (error) {
    return error as { code?: string; details?: unknown }
  }
}

describeEachProvider('RFC-359 W4 —— D14 / D15 回归', (harness) => {
  test('① 缺失的 managed skill 由 RFC-228 结构化预检报出（agent-resources-invalid + issues）；直接引用的未知 mcp 仍走逐类守卫', async () => {
    const repository = agentRepositoryFor(harness.db)
    const { authority: owner } = await seedUser(harness.db)
    const name = () => `agent-${ulid().slice(-6).toLowerCase()}`
    const ghostSkill = await errorOf(() =>
      repository.create(
        owner,
        agentInput(name(), { skills: [{ kind: 'managed', skillId: 'ghost-skill' }] }),
      ),
    )
    expect(ghostSkill.code).toBe('agent-resources-invalid')
    expect(ghostSkill.details).toMatchObject({
      issues: [{ code: 'skill-not-found', refKind: 'skill', direct: true }],
    })
    // 合一前的 SQLite 路径：依赖 / mcp / plugin / runtime 有逐类守卫（`*-not-found`），managed skill 没有——只由闭包预检报。
    const ghostMcp = await errorOf(() =>
      repository.create(owner, agentInput(name(), { mcp: ['nope'] })),
    )
    expect(ghostMcp.code).toBe('mcp-not-found')
  })

  test('② provider 路径的 ACL 写入提交后唤醒实时订阅（resource-acl-changed）', async () => {
    const catalog = composeResourceCatalogFor({ db: harness.db })
    const repository = createWorkflowRepository({
      db: harness.db,
      semantics: createWorkflowPersistenceSemantics({ authorization: catalog.authorization }),
    })
    const { authority: owner } = await seedUser(harness.db)
    const viewer = await seedUser(harness.db)
    const created = await repository.create(owner, {
      name: `wf-${ulid().slice(-6).toLowerCase()}`,
      description: 'd',
      definition: CreateWorkflowSchema.parse({
        name: 'x',
        definition: { $schema_version: 2, nodes: [], edges: [] },
      }).definition,
    })
    const acl = composeProviderResourceAclOperationApplication<
      DirectAuthenticatedAuthority,
      'workflow',
      WorkflowAccessRow
    >({
      authorization: catalog.authorization,
      acl: catalog.acl,
      type: 'workflow',
      load: (id) => repository.getAclIdentity(id),
    })
    const current = await acl.queries.get(owner, { id: created.id })
    const reasons: string[] = []
    registerRevalidationTrigger(async (reason) => {
      reasons.push(reason)
    })
    try {
      const updated = await acl.commands.update(owner, {
        id: created.id,
        submission: {
          kind: 'json-body',
          body: JSON.stringify({
            grants: [{ userId: viewer.id, level: 'write' }],
            expectedResourceId: created.id,
            expectedAclRevision: current.aclRevision,
          }),
        },
      })
      expect(updated.grants.map((grant) => grant.user.id)).toEqual([viewer.id])
      expect(reasons).toEqual(['resource-acl-changed'])
    } finally {
      registerRevalidationTrigger(async () => {})
    }
  })
})

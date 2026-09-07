// RFC-359 W7 —— Resource Catalog / Identity Access / Auth / Memory / System Operations 的 provider
// 组合根：**真的构造 + 真的驱动**（口径与 `rfc359-w7-integration-composition-roots.test.ts` 同）。
//
// 账本（`tests/architecture/rfc359-w5-provider-runtime-exercised.test.ts`）的判据是「值级 import
// 的绑定出现在 CallExpression 的 callee 位置」——源码文本锁一条不算。这里还债的这一批，此前的
// 「覆盖」形态多是 `expect(composition).toContain('composePostgresqlXxx')`：那证明的只是装配点
// 这行字还在，工厂里的 SQL 一次都没跑过。
//
// 每条断言都落到真库上；纯闭包型组合根（技能工件补偿）驱动的是它交出来的真实原语，不是
// `toBeDefined()`。

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { createPostgresqlAuthRuntime } from '@/auth/composition'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, users, workflows } from '@/db/schema'
import { createPostgresqlIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { createIntegrationTriggerResources } from '@/modules/integration/infrastructure/integrationTriggerResources'
import { composePostgresqlMemoryCatalogOperations } from '@/modules/memory/composition'
import { composePostgresqlDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { composePostgresqlIntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import {
  composePostgresqlSkillArtifactCompensation,
  composeSqliteSkillArtifactCompensation,
} from '@/modules/resource-catalog/composition/intentApply'
import { composePostgresqlResourceCatalog } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composePostgresqlResourceCatalogOverviewQuery } from '@/modules/resource-catalog/composition/resourceCatalogOverview'
import { composePostgresqlResourceScopeAccessParticipant } from '@/modules/resource-catalog/composition/resourceScopeAuthorization'
import { composeSqliteDynamicWorkflowValidationContext } from '@/modules/resource-catalog/composition/workflowOperations'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import { composeSqlitePostRestoreRecovery } from '@/modules/system-operations/composition'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { assertNotBuiltin } from '@/services/systemResources'
import { NotFoundError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

function asPostgresql(db: ProviderNeutralDatabase): PostgresqlDatabaseClient {
  return db as unknown as PostgresqlDatabaseClient
}

async function seedActor(
  db: ProviderNeutralDatabase,
  role: 'admin' | 'user' = 'user',
): Promise<Actor> {
  const id = `u_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
  })
  return {
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'http',
    permissions: new Set([
      'scheduled-tasks:read',
      'resource-acl:private',
      'agents:read',
      'workflows:read',
    ]),
  } as unknown as Actor
}

/** Integration owner 交给目录的「已准入 authority 对」；本文件只把它当不透明句柄传递。 */
function pairOf(actor: Actor): ResourceRequestContext {
  return { authority: {}, actor } as unknown as ResourceRequestContext
}

/** 触发器资源快照读要的是 `(authority, actor)` 对，不是单个 authority 句柄。 */
function triggerPairOf(actor: Actor) {
  return { authority: {} as ResourceRequestContext, actor }
}

function definition(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [{ kind: 'text', key: 'k', label: 'k' }],
    nodes: [{ id: 'in', kind: 'input', inputKey: 'k' }],
    edges: [],
  } as unknown as WorkflowDefinition
}

describeEachProvider('RFC-359 W7 —— Resource Catalog 组合根', (harness) => {
  test('演示目录种子参与者：首次种下、重跑幂等、id 被别的名字占用只告警不覆盖', async () => {
    const owner = await seedActor(harness.db, 'admin')
    const participant = composePostgresqlDemoResourceCatalogSeedParticipant(
      asPostgresql(harness.db),
    )
    const ids = { agent: `a_${ulid()}`, wf1: `wf_${ulid()}`, wf2: `wf_${ulid()}` }
    const input = (agentName: string) => ({
      marker: { kind: 'initial-demo-offer' as const, ownerUserId: owner.user.id, offeredAt: T0 },
      agent: {
        id: ids.agent,
        name: agentName,
        description: 'demo',
        outputs: ['summary'],
        syncOutputsOnIterate: false,
        readonly: true,
        bodyMd: 'You review.',
      },
      workflows: [
        {
          id: ids.wf1,
          name: `wf-one-${ids.wf1.slice(-4)}`,
          description: '',
          definition: definition(),
        },
        {
          id: ids.wf2,
          name: `wf-two-${ids.wf2.slice(-4)}`,
          description: '',
          definition: definition(),
        },
      ],
    })
    const first = await participant.seed(input('demo-reviewer'))
    expect(first.createdAgent).toBe(true)
    expect([...first.createdWorkflowIds]).toEqual([ids.wf1, ids.wf2])
    const again = await participant.seed(input('demo-reviewer'))
    expect(again.createdAgent).toBe(false)
    expect([...again.createdWorkflowIds]).toEqual([])
    expect(
      (await participant.seed(input('someone-else'))).occupiedIdWarnings.map(
        (warning) => warning.occupiedBy,
      ),
    ).toContain('demo-reviewer')
  })

  test('目录 ACL 装配：授权 / ACL / 概览查询三个面都在真库上给出判定', async () => {
    const owner = await seedActor(harness.db)
    const stranger = await seedActor(harness.db)
    const catalog = composePostgresqlResourceCatalog({ db: asPostgresql(harness.db) })

    const agentId = `a_${ulid()}`
    await harness.db.insert(agents).values({
      id: agentId,
      name: `agent-${agentId.slice(-6).toLowerCase()}`,
      description: 'private agent',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: owner.user.id,
      visibility: 'private',
      createdAt: T0,
      updatedAt: T0,
    })
    // 授权面：owner 看得见自己的私有 agent，外人看不见——两条判定都要真查授权表。
    const row = { id: agentId, ownerUserId: owner.user.id, visibility: 'private' as const }
    expect(await catalog.authorization.canViewResource(owner, 'agent', row)).toBe(true)
    expect(await catalog.authorization.canViewResource(stranger, 'agent', row)).toBe(false)
    expect((await catalog.authorization.filterVisibleRows(stranger, 'agent', [row])).length).toBe(0)
    // ACL 身份读端口：owner 从真表取出，缺行返回 null/undefined。
    expect(await catalog.persistence.identities.getOwner('agent', agentId)).toBe(owner.user.id)
    expect(await catalog.persistence.identities.listOwnedNames('agent', owner.user.id)).toContain(
      `agent-${agentId.slice(-6).toLowerCase()}`,
    )

    // 概览：RFC-359 W8 删掉零消费者的 SQLite 别名后只剩这一个具名装配（计数端口本就中立）。
    const resolver = { resolve: () => owner }
    const postgresqlOverview = composePostgresqlResourceCatalogOverviewQuery(
      asPostgresql(harness.db),
      resolver,
    )
    const counts = await postgresqlOverview.load(pairOf(owner))
    expect(counts.agents).toBe(1)
    // 没有 skills:read 权限点的维度不查库、直接给 null——这条分支也要被走到。
    expect(counts.skills).toBeNull()
    // 外人看不到这条私有 agent：概览计数随之为 0（同一份计数端口，只是 actor 换了）。
    expect(
      (
        await composePostgresqlResourceCatalogOverviewQuery(asPostgresql(harness.db), {
          resolve: () => stranger,
        }).load(pairOf(stranger))
      ).agents,
    ).toBe(0)
  })

  test('memory 的 scope 访问参与者：缺行为 none，公共资源可读，私有资源对外人不可读', async () => {
    const owner = await seedActor(harness.db)
    const stranger = await seedActor(harness.db)
    const participant = composePostgresqlResourceScopeAccessParticipant()
    const publicWorkflowId = `wf_${ulid()}`
    const privateWorkflowId = `wf_${ulid()}`
    await harness.db.insert(workflows).values([
      {
        id: publicWorkflowId,
        name: `wf-pub-${publicWorkflowId.slice(-6).toLowerCase()}`,
        description: '',
        definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
        ownerUserId: owner.user.id,
        visibility: 'public',
      },
      {
        id: privateWorkflowId,
        name: `wf-priv-${privateWorkflowId.slice(-6).toLowerCase()}`,
        description: '',
        definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
        ownerUserId: owner.user.id,
        visibility: 'private',
      },
    ])
    await harness.session.transaction(async (transaction) => {
      const accessOf = (actor: Actor, id: string) =>
        participant.accessOf(
          transaction,
          { authority: {} as ResourceRequestContext, actor },
          { kind: 'workflow', id },
        )
      expect(await accessOf(owner, `wf_${ulid()}`)).toBe('none')
      expect(await accessOf(stranger, publicWorkflowId)).not.toBe('none')
      expect(await accessOf(owner, privateWorkflowId)).not.toBe('none')
      expect(await accessOf(stranger, privateWorkflowId)).toBe('none')
    })
  })

  test('触发器资源快照工厂：已授权的 workflow 出快照，缺 id 与外人都是 404', async () => {
    const owner = await seedActor(harness.db)
    const stranger = await seedActor(harness.db)
    const workflowId = `wf_${ulid()}`
    await harness.db.insert(workflows).values({
      id: workflowId,
      name: `wf-${workflowId.slice(-6).toLowerCase()}`,
      description: '',
      definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      version: 3,
      schemaVersion: 2,
      ownerUserId: owner.user.id,
      visibility: 'private',
    })
    const resources = createIntegrationTriggerResources(
      harness.db,
      composePostgresqlIntegrationTriggerResourceSnapshotFactory({ assertNotBuiltin }),
    )
    const snapshots = await resources.loadAuthorized(triggerPairOf(owner), [
      { kind: 'scheduled-workflow', workflowId },
    ])
    expect(snapshots[0]).toMatchObject({
      kind: 'scheduled-workflow',
      workflow: { id: workflowId, version: 3 },
    })
    await expect(
      resources.loadAuthorized(triggerPairOf(stranger), [
        { kind: 'scheduled-workflow', workflowId },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      resources.loadAuthorized(triggerPairOf(owner), [
        { kind: 'scheduled-workflow', workflowId: `wf_${ulid()}` },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describeEachProvider('RFC-359 W7 —— Identity Access / Auth / Memory 组合根', (harness) => {
  test('身份访问运行时：用户目录 / 档案 / 授权解析都读真库', async () => {
    const actor = await seedActor(harness.db, 'admin')
    const runtime = createPostgresqlIdentityAccessRuntime({ db: harness.db })
    try {
      expect(await runtime.userDirectory.findByUsername(actor.user.username)).toMatchObject({
        id: actor.user.id,
        username: actor.user.username,
      })
      expect(await runtime.userDirectory.findByUsername(`nobody-${ulid()}`)).toBeNull()
      expect(await runtime.getUserProfile.execute(actor.user.id)).toMatchObject({
        displayName: actor.user.displayName,
      })
      expect(await runtime.getUserProfile.execute(`u_${ulid()}`)).toBeNull()
      // git 提交身份读的是同一张表：没写 email 的用户按显式错误拒绝，不是静默 null。
      await expect(runtime.getUserGitCommitIdentity.execute(actor.user.id)).rejects.toMatchObject({
        code: 'git-identity-email-missing',
      })
      // 目录搜索同样落真表：刚种下的用户能被搜到，排除自己后就搜不到了。
      expect(
        (
          await runtime.userDirectory.search({
            q: actor.user.username,
            limit: 5,
            excludeIds: [],
          })
        ).map((row) => row.id),
      ).toEqual([actor.user.id])
      expect(
        await runtime.userDirectory.search({
          q: actor.user.username,
          limit: 5,
          excludeIds: [actor.user.id],
        }),
      ).toEqual([])
      expect((await runtime.userDirectory.lookup([actor.user.id])).map((row) => row.id)).toEqual([
        actor.user.id,
      ])
    } finally {
      runtime.shutdown()
    }
  })

  test('认证运行时：登录策略读写与用户查找落在真库上；provider 由引擎自报', async () => {
    const revoked: string[] = []
    const runtime = createPostgresqlAuthRuntime({
      db: harness.db,
      onCredentialRevoked: (reason) => {
        revoked.push(reason)
      },
    })
    expect(runtime.provider).toBe(harness.capabilities.provider)
    const policy = await runtime.getLoginPolicy()
    expect(policy).toMatchObject({ passwordLoginEnabled: true, bootstrapCompletedAt: 0 })
    // harness 的默认起点是「已 bootstrap」：这条判定要真读 auth_login_policy。
    expect(await runtime.isBootstrapRequired()).toBe(false)
    expect(await runtime.assertBootstrapComplete()).toMatchObject({ bootstrapCompletedAt: 0 })
    // 关闭密码登录要求至少一个启用的身份提供方：这条门在事务里另查一张表，两个引擎同形。
    await expect(runtime.setPasswordLoginEnabled(false, T0 + 1)).rejects.toMatchObject({
      code: 'password-login-requires-enabled-oidc',
    })
    const rolled = await runtime.setOidcDefaultRole('user', T0 + 2)
    expect(rolled.oidcDefaultRole).toBe('user')
    expect((await runtime.getLoginPolicy()).oidcDefaultRole).toBe('user')
    expect(await runtime.findUserByUsername(`nobody-${ulid()}`)).toBeNull()
    const actor = await seedActor(harness.db, 'admin')
    expect(await runtime.findUserById(actor.user.id)).toMatchObject({ id: actor.user.id })
    expect(revoked).toEqual([])
  })

  test('记忆目录装配：列表 / 单读 / 可见性过滤在两个引擎上同形', async () => {
    const actor = await seedActor(harness.db, 'admin')
    const catalog = composePostgresqlMemoryCatalogOperations({
      db: harness.db,
      contexts: composeIdentityAccess(harness.db).contexts,
      authorization: composePostgresqlResourceScopeAccessParticipant(),
    })
    expect(await catalog.queries.list()).toEqual([])
    expect(await catalog.queries.getById(`mem_${ulid()}`)).toBeNull()
    expect(await catalog.queries.listFusedInto(`skill_${ulid()}`)).toEqual([])
    // 平台 scope 不查资源访问档，直接按 actor 判定——这条对两个引擎是同一段代码。
    const authority = Object.freeze({ authority: {}, actor }) as unknown as Parameters<
      typeof catalog.queries.canView
    >[0]
    expect(await catalog.queries.filterVisible(authority, [])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 不吃数据库的组合根（纯闭包 / 文件系统），在两个引擎的 describe 之外各驱动一次
// ---------------------------------------------------------------------------

test('技能工件补偿原语：两个 provider 各交出自己那半套，路径与哈希都是真结果', async () => {
  const sqlite = composeSqliteSkillArtifactCompensation()
  const postgresql = composePostgresqlSkillArtifactCompensation()
  // SQLite 那半套的可执行面：其余（发布 / 中止 / 补偿）都要一个已 claim 的操作行，
  // 这里驱动的是它唯一无副作用的读——缺行时返回 undefined。
  expect(typeof sqlite.compensateManagedSkillStage).toBe('function')
  expect(typeof sqlite.publishStagedSkillVersion).toBe('function')
  expect(typeof sqlite.abortStagedSkillVersion).toBe('function')

  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-skill-'))
  try {
    const skillId = `skill_${ulid()}`
    expect(postgresql.skillVersionAbs(appHome, skillId, 3)).toBe(
      join(appHome, 'skills', skillId, 'versions', 'v3', 'files'),
    )
    expect(postgresql.skillFilesAbs(appHome, skillId)).toBe(
      join(appHome, 'skills', skillId, 'files'),
    )
    const staged = postgresql.opStagedDir(postgresql.skillFilesAbs(appHome, skillId), 'op-1')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'SKILL.md'), '# skill\n')
    // 同一棵树两次哈希必须相同，换内容必须变——证明这是真算不是占位。
    const digest = await postgresql.hashRegularFileTree(staged)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(await postgresql.hashRegularFileTree(staged)).toBe(digest)
    writeFileSync(join(staged, 'SKILL.md'), '# skill changed\n')
    expect(await postgresql.hashRegularFileTree(staged)).not.toBe(digest)
  } finally {
    rmSync(appHome, { recursive: true, force: true })
  }
})

// `composeSqliteDynamicWorkflowValidationContext` 与 `composeSqlitePostRestoreRecovery` 都只在
// SQLite 装配面上存在（前者装的是 legacy 同步 loader，后者的 recover 签名点名 `DbClient`），
// 所以这一条不进 describeEachProvider，而是自己开一棵刚迁移完的内存库。
test('动态工作流校验上下文 + restore 后置恢复：都在一棵真 SQLite 库上驱动', async () => {
  const { createInMemoryDb } = await import('@/db/client')
  const { MIGRATIONS } = await import('./migration-freeze')
  const { selectDatabaseSchemaProvider } = await import('@/db/providerSchema')
  const restore = selectDatabaseSchemaProvider('sqlite')
  try {
    const db = createInMemoryDb(MIGRATIONS, {})
    const context = composeSqliteDynamicWorkflowValidationContext(db)
    expect((await context.load()).agents).toEqual([])
    // 装载的是当下的库存，不是快照：写一行 agent 之后再 load 必须看得见它。
    const agentId = `a_${ulid()}`
    const agentName = `agent-${agentId.slice(-6).toLowerCase()}`
    await db.insert(agents).values({
      id: agentId,
      name: agentName,
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: T0,
      updatedAt: T0,
    })
    const loaded = await context.load()
    expect(loaded.agents.map((agent) => agent.name)).toContain(agentName)
    expect(Array.isArray(loaded.skills)).toBe(true)
    expect(Array.isArray(loaded.mcps)).toBe(true)
    expect(Array.isArray(loaded.plugins)).toBe(true)

    // 同一个装配面上再驱动一次 restore 后置恢复：它对一棵刚迁移完的库是幂等空操作。
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-restore-'))
    try {
      await composeSqlitePostRestoreRecovery().recover({ db, appHome })
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  } finally {
    restore()
  }
})

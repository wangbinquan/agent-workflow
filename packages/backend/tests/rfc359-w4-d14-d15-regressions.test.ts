// RFC-359 W4 —— D14 / D15 把 Agent / Workflow 聚合切到 provider 形状的一份实现后，CI 在 94ce5351b 抓到两条只有
// 旧 SQLite 路径才有的行为被丢掉了（PG daemon 此前一直缺，也没有 e2e 盯着）。两条都补回一份实现里，这里两引擎各锁一遍：
//   ① 引用缺失先走 RFC-228 结构化预检（`agent-resources-invalid` + issues），不是逐类存在性围栏的 `skill-not-found`
//      （tests/rfc223-pr1-impl-gate.test.ts 走 HTTP 锁的是同一条，这里锁在仓库层，两引擎都跑）；
//   ② 目录自有类型的 ACL 写入提交后必须唤醒实时订阅（`resource-acl-changed`）——被升档 / 降档的观众不刷新页面也要
//      拿到新的控件（e2e/rfc324-graded-grants.spec.ts「升档后徽标必须自己消失」红的来源）。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { CreateAgentSchema, CreateWorkflowSchema, type CreateAgent } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { plugins, scheduledTasks, tasks, users, workflows } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { WorkflowAccessRow } from '@/modules/resource-catalog/application/workflows/ports'
import { composeDatabaseAgentResourceInventorySource } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeProviderResourceAclOperationApplication } from '@/modules/resource-catalog/composition/resourceAcl'
import { createAgentPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/agentPersistenceSemantics'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { createWorkflowPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/workflowPersistenceSemantics'
import { createWorkflowRepository } from '@/modules/resource-catalog/infrastructure/workflowRepository'
import { acquireAgentLaunch, releaseAgentLaunch } from '@/services/agentLaunchReservation'
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

/** delete 的 OCC 围栏：拒删不改代理行，所以创建时拿到的那一份一直有效。 */
function fenceOf(agent: { readonly updatedAt: number; readonly aclRevision?: number | null }): {
  expectedUpdatedAt: number
  expectedAclRevision: number
} {
  return { expectedUpdatedAt: agent.updatedAt, expectedAclRevision: agent.aclRevision ?? 0 }
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
  // ③ 2026-09-19 补：D14 把删除前的引用闸也合成了**弱的那一半**——四条各自不同的拒绝退化成
  // 一条不带 details 的 `agent-in-use`，非终态任务 / 定时任务 / 启动占用三条闸整个消失。
  // 用户可见后果：跑着任务的代理能被删（任务当场失去定义）、被定时任务引用的代理能被删（到点
  // 在无人值守下失败）、拒绝理由不点名拦路者（详情页只剩一条笼统红条）。
  // 覆盖它的 e2e（AGENT-09~12）全带 `@nightly`，推送档不跑，于是 e2e-full / e2e-webkit 从
  // 2026-09-06 起连红十三晚。这一条把四档拒绝**连 details 一起**锁在推送档里，两引擎各跑一遍。
  test('③ 删除前的四档引用拒绝各自回到自己的 code，并带上能让用户下手的 details', async () => {
    const db = harness.db
    const repository = agentRepositoryFor(db)
    const name = () => `agent-${ulid().slice(-6).toLowerCase()}`
    const { id: ownerId, authority: owner } = await seedUser(db)

    // 负向对照：零引用的代理必须删得掉，否则下面每一条 409 都可能只是「删除整个坏了」。
    const loner = await repository.create(owner, agentInput(name()))
    await repository.delete(owner, loner.id, fenceOf(loner))

    // (0) 启动占用中 ⇒ agent-launching。RFC-175 §2e 的 ABA 闸：启动按**名字**从冻结快照
    // 里解析代理，删了再同名重建会让任务跑上另一个代理。引用计数由最后一个持有者释放。
    const launching = await repository.create(owner, agentInput(name()))
    acquireAgentLaunch(launching.id)
    try {
      const refused = await errorOf(() =>
        repository.delete(owner, launching.id, fenceOf(launching)),
      )
      expect(refused.code).toBe('agent-launching')
    } finally {
      releaseAgentLaunch(launching.id)
    }
    // 放开之后同一笔删除必须放行，否则这条闸等于永久锁死。
    await repository.delete(owner, launching.id, fenceOf(launching))

    // (a) 被工作流定义引用 ⇒ agent-in-use，并点名那个工作流。
    const byWorkflow = await repository.create(owner, agentInput(name()))
    const workflowId = ulid()
    const workflowName = `wf-${workflowId.slice(-6).toLowerCase()}`
    await db.insert(workflows).values({
      id: workflowId,
      name: workflowName,
      definition: JSON.stringify({
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'agent_main',
            kind: 'agent-single',
            agentId: byWorkflow.id,
            agentName: byWorkflow.name,
            promptTemplate: 'x',
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      }),
      ownerUserId: ownerId,
      visibility: 'private',
    })
    const inUse = await errorOf(() => repository.delete(owner, byWorkflow.id, fenceOf(byWorkflow)))
    expect(inUse.code).toBe('agent-in-use')
    expect(inUse.details).toMatchObject({
      visible: [{ id: workflowId, name: workflowName }],
      hiddenCount: 0,
    })

    // (b) 被别的代理 dependsOn 引用 ⇒ 专属 code，不是笼统的 agent-in-use。
    const byDependency = await repository.create(owner, agentInput(name()))
    const dependent = await repository.create(
      owner,
      agentInput(name(), { dependsOn: [byDependency.id] }),
    )
    const stillReferenced = await errorOf(() =>
      repository.delete(owner, byDependency.id, fenceOf(byDependency)),
    )
    expect(stillReferenced.code).toBe('agent-dependency-still-referenced')
    expect(stillReferenced.details).toMatchObject({
      visible: [{ id: dependent.id, name: dependent.name }],
      hiddenCount: 0,
    })

    // (c) 还有非终态单代理任务 ⇒ agent-tasks-active，details 带裸 task id 数组
    // （未经可见性过滤，展示层只渲染计数——这里锁的是后端确实把它交出来了）。
    const byTask = await repository.create(owner, agentInput(name()))
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'live',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x',
      baseBranch: 'main',
      branch: `aw/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: T0,
      sourceAgentName: byTask.name,
      sourceAgentId: byTask.id,
      ownerUserId: ownerId,
    })
    const tasksActive = await errorOf(() => repository.delete(owner, byTask.id, fenceOf(byTask)))
    expect(tasksActive.code).toBe('agent-tasks-active')
    expect(tasksActive.details).toMatchObject({ taskIds: [taskId] })
    // 终态任务不拦（RFC-165 §4 接受的限制），否则代理会被永久锁死。
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId))
    await repository.delete(owner, byTask.id, fenceOf(byTask))

    // (d) 被定时任务引用 ⇒ agent-scheduled-referenced，并点名那条定时任务。
    const bySchedule = await repository.create(owner, agentInput(name()))
    const scheduleId = ulid()
    const scheduleName = `sched-${scheduleId.slice(-6).toLowerCase()}`
    await db.insert(scheduledTasks).values({
      id: scheduleId,
      name: scheduleName,
      ownerUserId: ownerId,
      launchKind: 'agent',
      launchPayload: JSON.stringify({ kind: 'agent', agentId: bySchedule.id }),
      scheduleSpec: JSON.stringify({ kind: 'interval', everyMs: 60_000, tz: 'UTC' }),
      createdAt: T0,
      updatedAt: T0,
    })
    const scheduled = await errorOf(() =>
      repository.delete(owner, bySchedule.id, fenceOf(bySchedule)),
    )
    expect(scheduled.code).toBe('agent-scheduled-referenced')
    expect(scheduled.details).toMatchObject({
      visible: [{ id: scheduleId, name: scheduleName }],
      hiddenCount: 0,
    })

    // 解引用后必须放行——否则「引用拒删」等于永久锁死。
    await db.delete(scheduledTasks).where(eq(scheduledTasks.id, scheduleId))
    await repository.delete(owner, bySchedule.id, fenceOf(bySchedule))
    await repository.delete(owner, dependent.id, fenceOf(dependent))
    await repository.delete(owner, byDependency.id, fenceOf(byDependency))
    await db.delete(workflows).where(eq(workflows.id, workflowId))
    await repository.delete(owner, byWorkflow.id, fenceOf(byWorkflow))
  })
  // ④ 2026-09-19 补：同一刀还把「引用了**已停用**插件」这一档拒绝的顶层 code 丢了。
  // 合一前 SQLite 侧每次保存都对**全量** plugin 引用查 `enabled`，停用的报
  // `plugin-disabled` + 「agent references disabled plugin(s): …」；合一后逐类守卫只查
  // `onlyNew`（新增引用），于是「插件事后被停用」这一档落到 RFC-228 闭包预检手里，顶层 code
  // 变成笼统的 `agent-resources-invalid`（`plugin-disabled` 只作为 issues 里的一条）。
  // 保存两种情况下都会被拒，差别在**用户读到的是哪一句**：e2e RES-X3 断言的是
  // 「拒了却不说是插件被停用 ⇒ 用户对着一条读不懂的报错，不知道该去开哪个开关」。
  // 只新增引用才查存在性 / ACL 的规则不动；`enabled` 是**被引用资源的状态变化**，与「这条引用
  // 是不是新的」无关，所以按全量查。
  test('④ 引用的插件事后被停用：保存报 plugin-disabled 而不是笼统的 agent-resources-invalid', async () => {
    const db = harness.db
    const repository = agentRepositoryFor(db)
    const name = () => `agent-${ulid().slice(-6).toLowerCase()}`
    const { id: ownerId, authority: owner } = await seedUser(db)

    const pluginId = ulid()
    const pluginName = `plugin-${pluginId.slice(-6).toLowerCase()}`
    await db.insert(plugins).values({
      id: pluginId,
      name: pluginName,
      spec: pluginName,
      sourceKind: 'npm',
      cachedPath: '/tmp/plugin',
      installedAt: T0,
      enabled: true,
      ownerUserId: ownerId,
      visibility: 'private',
    })

    const agent = await repository.create(owner, agentInput(name(), { plugins: [pluginId] }))
    // 负向对照：插件还开着的时候，同一笔无关改动存得下——否则下面那条 422 可能只是
    // 「这个代理根本存不了」。
    const enabledSave = await repository.update(
      owner,
      agent.id,
      { ...agent, description: 'while enabled' },
      fenceOf(agent),
    )
    expect(enabledSave.description).toBe('while enabled')

    await db.update(plugins).set({ enabled: false }).where(eq(plugins.id, pluginId))
    const refused = await errorOf(() =>
      repository.update(
        owner,
        agent.id,
        { ...enabledSave, description: 'while disabled' },
        fenceOf(enabledSave),
      ),
    )
    expect(refused.code).toBe('plugin-disabled')
    expect(refused.details).toMatchObject({ disabled: [pluginId] })
    expect(String((refused as { message?: string }).message)).toContain(
      'references disabled plugin',
    )
    // 「拒绝」必须是真拒绝：改动一个字都不许落库。
    expect((await repository.get(agent.id))?.description).toBe('while enabled')
  })
})

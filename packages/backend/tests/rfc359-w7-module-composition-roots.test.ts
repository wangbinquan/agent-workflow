// RFC-359 W7 —— code-capability / development-automation / source-control / task-execution 的
// provider 组合根：**真的构造 + 真的驱动**（口径同本批另外两个文件）。
//
// 账本（`tests/architecture/rfc359-w5-provider-runtime-exercised.test.ts`）只认「值级 import 的
// 绑定出现在 CallExpression 的 callee 位置」。这里补的这一批此前的形态是零引用或源码文本锁——
// 装配点那行字在、工厂一次没跑。每条断言都落在真库上，跨两个引擎各跑一遍。

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialDwState } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  capabilityTemplates,
  nodeRuns,
  repoCapabilityConfig,
  taskRepos,
  tasks,
  users,
  workflows,
  workgroupTaskState,
} from '@/db/schema'
import { composePostgresqlCapabilityTemplateOperations } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import {
  composePostgresqlLegacyCodeReadProviders,
  composeSqliteLegacyCodeReadProviders,
} from '@/modules/code-capability/composition/legacyCodeReads'
import { composePostgresqlReviewerResolutionRead } from '@/modules/code-capability/composition/reviewerResolution'
import { composePostgresqlDevelopmentConfigOperations } from '@/modules/development-automation/composition/configOperations'
import { composeDevelopmentAdapterConfigOperationsFor } from '@/modules/integration/composition/developmentAdapterConfigOperations'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composePostgresqlWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { composePostgresqlDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import { composePostgresqlNodeRunLifecycleParticipantFactory } from '@/modules/task-execution/composition/nodeRunLifecycle'
import { createSqliteTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { NotFoundError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

function asSqlite(db: ProviderNeutralDatabase): DbClient {
  return db as unknown as DbClient
}

function asPostgresql(db: ProviderNeutralDatabase): PostgresqlDatabaseClient {
  return db as unknown as PostgresqlDatabaseClient
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-mod-'))
}

async function seedActor(
  db: ProviderNeutralDatabase,
  role: 'admin' | 'user' = 'admin',
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
      'resource-acl:private',
      'scripts:author',
      'capability-templates:read',
      'capability-templates:write',
    ]),
  } as unknown as Actor
}

/** 一条 running 任务 + 它的单仓工作区；code-capability 的工作区读与工作区维护都要它。 */
async function seedTask(
  db: ProviderNeutralDatabase,
  taskId: string,
  overrides: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: `wf-${workflowId.slice(-6).toLowerCase()}`,
    definition: JSON.stringify({ $schema_version: 2, nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/srv/repos/x',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: T0,
    repoCount: 1,
    ...overrides,
  })
  return workflowId
}

describeEachProvider('RFC-359 W7 —— code-capability 组合根', (harness) => {
  test('legacy 代码读端口：两个别名各构造一次，任务 / 节点运行 / 能力参数都读真库', async () => {
    const taskId = `t_${ulid()}`
    await seedTask(harness.db, taskId, { spaceKind: 'local', baseCommit: 'abc123' })
    await harness.db.insert(taskRepos).values({
      taskId,
      repoIndex: 0,
      repoPath: '/srv/repos/x',
      branch: `agent-workflow/${taskId}`,
      mountPath: 'main',
      worktreeDirName: 'main',
      worktreePath: '/tmp/wt/main',
      baseCommit: 'abc123',
    })
    const nodeRunId = `nr_${ulid()}`
    await harness.db.insert(nodeRuns).values({
      id: nodeRunId,
      taskId,
      nodeId: 'n1',
      status: 'running',
      retryIndex: 0,
      startedAt: T0,
      preSnapshot: 'stash-hash',
    })

    const sqlite = composeSqliteLegacyCodeReadProviders(asSqlite(harness.db))
    const postgresql = composePostgresqlLegacyCodeReadProviders(asPostgresql(harness.db))

    const task = await sqlite.workspace.findTask(taskId)
    expect(task).toMatchObject({ id: taskId, status: 'running', repoCount: 1 })
    expect(task?.repos.map((repo) => repo.mountPath)).toEqual(['main'])
    expect(await postgresql.workspace.findTask(`t_${ulid()}`)).toBeNull()
    expect((await postgresql.workspace.listNodeRuns(taskId)).map((run) => run.id)).toEqual([
      nodeRunId,
    ])
    expect(await sqlite.workspace.findNodeRun(nodeRunId)).toMatchObject({
      id: nodeRunId,
      preSnapshot: 'stash-hash',
    })
    expect(await sqlite.workspace.findNodeRun(`nr_${ulid()}`)).toBeNull()
    // 能力参数：没有 repo_capability_config 行时是 null（一跳 join 真的跑过）。
    expect(
      await postgresql.capabilityParams.find({ repoId: `r_${ulid()}`, capability: 'code-review' }),
    ).toBeNull()
  })

  test('评审人槽位解析读：仓库能力 → 模板 → agent 三跳都在真库上', async () => {
    const repoId = `r_${ulid()}`
    const templateId = `ct_${ulid()}`
    const agentId = `a_${ulid()}`
    const agentName = `reviewer-${agentId.slice(-6).toLowerCase()}`
    await harness.db.insert(agents).values({
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
    await harness.db.insert(capabilityTemplates).values({
      id: templateId,
      name: `tpl-${templateId.slice(-6).toLowerCase()}`,
      description: '',
      capability: 'code-review',
      paramSchemaJson: '[]',
      paramDefaultsJson: '{}',
      agentBySlotJson: JSON.stringify({ reviewer: agentId }),
      promptBySlotJson: '{}',
      paramsJson: '{}',
      createdAt: T0,
      updatedAt: T0,
    })
    await harness.db.insert(repoCapabilityConfig).values({
      id: `rcc_${ulid()}`,
      repoId,
      capability: 'code-review',
      templateId,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    })

    const read = composePostgresqlReviewerResolutionRead(asPostgresql(harness.db))
    expect(
      await read.loadRepositoryCapability({ repositoryId: repoId, capability: 'code-review' }),
    ).toEqual({ templateId })
    expect(
      await read.loadRepositoryCapability({ repositoryId: repoId, capability: 'no-such' }),
    ).toBeNull()
    expect(JSON.parse((await read.loadTemplate(templateId))?.agentBySlotJson ?? '{}')).toEqual({
      reviewer: agentId,
    })
    expect(await read.loadTemplate(`ct_${ulid()}`)).toBeNull()
    expect((await read.loadAgent(agentId))?.name).toBe(agentName)
    expect(await read.loadAgent(`a_${ulid()}`)).toBeNull()
  })

  test('能力模板操作：列表 / 创建 / 读取 / 删除经 Resource Catalog 的授权面落真库', async () => {
    const actor = await seedActor(harness.db)
    const catalog = composeResourceCatalogFor({ db: harness.db })
    const operations = composePostgresqlCapabilityTemplateOperations({
      db: asPostgresql(harness.db),
      access: {
        filterVisible: (subject, rows) =>
          catalog.authorization.filterVisibleRows(subject, 'capability_template', rows),
        canView: (subject, row) =>
          catalog.authorization.canViewResource(subject, 'capability_template', row),
        requireEdit: (subject, row) =>
          catalog.authorization.requireResourceEdit(subject, 'capability_template', row),
        requireGovern: (subject, row) =>
          catalog.authorization.requireResourceGovern(subject, 'capability_template', row),
        assertNameUnchangedForEditor: catalog.authorization.assertNameUnchangedForEditor,
      },
      now: () => T0,
    })
    expect(await operations.list(actor)).toEqual([])
    const name = `tpl-${ulid().slice(-6).toLowerCase()}`
    const created = await operations.create(actor, {
      name,
      description: 'created by rfc359 w7',
      capability: 'code-review',
      paramSchema: [],
      paramDefaults: {},
      agentBySlot: {},
      promptBySlot: {},
      params: {},
    })
    expect(created).toMatchObject({ name, capability: 'code-review' })
    expect((await operations.list(actor)).map((row) => row.id)).toEqual([created.id])
    expect((await operations.get(actor, created.id)).name).toBe(name)
    await operations.requireVisible(actor, created.id)
    await operations.requireEditable(actor, created.id)
    await operations.delete(actor, created.id)
    expect(await operations.list(actor)).toEqual([])
    // 删掉之后再读是 404，而不是空壳。
    await expect(operations.get(actor, created.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describeEachProvider('RFC-359 W7 —— development-automation / source-control 组合根', (harness) => {
  test('研发配置操作：资源清单五类都在，指派读写落真库', async () => {
    const actor = await seedActor(harness.db)
    // 研发配置面收的是 identity-access 铸的 authority（带 userId 投影），不是裸 Actor；
    // 本文件只把它当不透明句柄传递，装配根内部会把它降解成上面这个 actor。
    const authority = Object.freeze({
      ...actor,
      userId: actor.user.id,
    }) as unknown as Parameters<
      ReturnType<typeof composePostgresqlDevelopmentConfigOperations>['upsertAssignment']
    >[0]
    const catalog = composeResourceCatalogFor({ db: harness.db })
    const access = {
      filterVisible: (
        subject: Actor,
        type: Parameters<typeof catalog.authorization.filterVisibleRows>[1],
        rows: readonly never[],
      ) => catalog.authorization.filterVisibleRows(subject, type, rows),
      canView: (
        subject: Actor,
        type: Parameters<typeof catalog.authorization.canViewResource>[1],
        row: never,
      ) => catalog.authorization.canViewResource(subject, type, row),
      requireEdit: (
        subject: Actor,
        type: Parameters<typeof catalog.authorization.requireResourceEdit>[1],
        row: never,
      ) => catalog.authorization.requireResourceEdit(subject, type, row),
      requireGovern: (
        subject: Actor,
        type: Parameters<typeof catalog.authorization.requireResourceGovern>[1],
        row: never,
      ) => catalog.authorization.requireResourceGovern(subject, type, row),
      assertNameUnchangedForEditor: catalog.authorization.assertNameUnchangedForEditor,
    } as unknown as Parameters<typeof composePostgresqlDevelopmentConfigOperations>[0]['access']
    const operations = composePostgresqlDevelopmentConfigOperations({
      db: harness.db,
      developmentAdapter: composeDevelopmentAdapterConfigOperationsFor({
        db: harness.db,
        access: access as never,
        grants: catalog.persistence.grants,
      }) as never,
      access,
      now: () => T0,
    })
    // 资源面：五类研发配置资源都装上了，且每一类的 list 都真的查库（空库回空表）。
    expect(Object.keys(operations.resources).sort()).toEqual([
      'action-template',
      'automation-policy',
      'development-adapter',
      'digital-employee',
      'verification-profile',
    ])
    for (const kind of [
      'action-template',
      'verification-profile',
      'development-adapter',
    ] as const) {
      expect(await operations.resources[kind].list(authority)).toEqual([])
    }
    expect(await operations.listAssignments()).toEqual([])
    // 指派写入 → 再读能看到 → 删除后回空：一条真实的读—写—删闭环。
    // scopeKind 与 scopeRef 的配对是真校验：repository 必须带 scopeRef，global-default 不能带。
    const emptyRefs = {
      employee: null,
      selectionPolicy: null,
      executionPolicy: null,
      defaultRequirementSourceKey: null,
    } as const
    await expect(
      operations.upsertAssignment(authority, {
        scopeKind: 'repository',
        scopeRef: null,
        ...emptyRefs,
      }),
    ).rejects.toMatchObject({ code: 'assignment-scope-invalid' })
    // 全空的 assignment 也没有意义：这条同样是事务里的真判定。
    await expect(
      operations.upsertAssignment(authority, {
        scopeKind: 'global-default',
        scopeRef: null,
        ...emptyRefs,
      }),
    ).rejects.toMatchObject({ code: 'assignment-empty' })
    await operations.upsertAssignment(authority, {
      scopeKind: 'global-default',
      scopeRef: null,
      ...emptyRefs,
      defaultRequirementSourceKey: 'jira',
    })
    expect((await operations.listAssignments()).length).toBe(1)
    await operations.deleteAssignment('global-default', null)
    expect(await operations.listAssignments()).toEqual([])
  })

  test('工作区维护命令：GC 阶段与恢复扫描都在真库上给出可解释的收据', async () => {
    const appHome = tmpRoot()
    try {
      const taskId = `t_${ulid()}`
      const workspace = join(appHome, 'scratch', taskId)
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'note.txt'), 'x', 'utf-8')
      await seedTask(harness.db, taskId, {
        status: 'done',
        spaceKind: 'scratch',
        repoPath: workspace,
        worktreePath: workspace,
        finishedAt: T0,
        eventSubscriptionId: `sub_${taskId}`,
        workspacePruningAt: T0,
        workspacePruneCause: 'webhook-terminal',
      })
      const command = composePostgresqlWorkspaceMaintenanceCommand({
        db: harness.db,
        appHome,
        terminalMaintenance: createSqliteTaskExecutionPersistence(asSqlite(harness.db))
          .terminalMaintenance,
        isMaterializingTask: () => false,
        invalidateWorkspacePath() {},
      })
      // ticker 语义：租约刚盖章，不接管。
      expect(await command.recover({ activeTaskIds: [], now: T0 + 1_000 })).toEqual({
        completed: 0,
        failed: 0,
        skipped: 0,
        healed: 0,
      })
      expect(existsSync(workspace)).toBe(true)
      // boot 语义：接管全部认领，删目录并盖 workspace_pruned_at。
      expect(
        await command.recover({ activeTaskIds: [], webhookClaims: 'all', now: T0 + 2_000 }),
      ).toMatchObject({ completed: 1, failed: 0 })
      expect(existsSync(workspace)).toBe(false)
      expect(
        (
          await harness.db
            .select({ prunedAt: tasks.workspacePrunedAt })
            .from(tasks)
            .where(eq(tasks.id, taskId))
        )[0]?.prunedAt,
      ).toBe(T0 + 2_000)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})

describeEachProvider(
  'RFC-359 W7 —— task-execution 组合根（无需 daemon 装配的那几个）',
  (harness) => {
    test('动态工作流持久化：任务快照 / 节点运行计数 / 状态写回都落真库', async () => {
      const persistence = composePostgresqlDynamicWorkflowPersistence(harness.db)
      const taskId = `t_${ulid()}`
      await seedTask(harness.db, taskId)
      expect(await persistence.loadTask(`t_${ulid()}`)).toBeNull()
      expect(await persistence.loadTask(taskId)).toEqual({
        workgroupConfigJson: null,
        triggerContextJson: null,
        dwStateJson: null,
      })
      expect(await persistence.loadAgent(`a_${ulid()}`)).toBeNull()
      expect(await persistence.countNodeRuns(taskId, 'n1')).toBe(0)
      expect(await persistence.hasAwaitingConfirmationRun(taskId, 'dw-plan')).toBe(false)
      // 写回状态后 loadTask 必须看得见——证明这不是只读的空壳装配。
      await harness.db
        .insert(workgroupTaskState)
        .values({ taskId, dwStateJson: null, updatedAt: T0 })
      await persistence.saveState(taskId, initialDwState(), T0 + 1)
      expect(JSON.parse((await persistence.loadTask(taskId))?.dwStateJson ?? 'null')).toMatchObject(
        {
          phase: 'generating',
          generateAttempts: 0,
        },
      )
    })

    test('节点运行生命周期参与者工厂：在真事务里绑出的参与者可以读节点运行行', async () => {
      const taskId = `t_${ulid()}`
      await seedTask(harness.db, taskId)
      const nodeRunId = `nr_${ulid()}`
      await harness.db.insert(nodeRuns).values({
        id: nodeRunId,
        taskId,
        nodeId: 'n1',
        status: 'running',
        retryIndex: 0,
        startedAt: T0,
      })
      const factory = composePostgresqlNodeRunLifecycleParticipantFactory()
      await harness.session.transaction(async (transaction) => {
        const participant = factory.inTransaction(
          transaction as unknown as Parameters<typeof factory.inTransaction>[0],
        )
        expect(typeof participant).toBe('object')
        // 参与者绑的是这一个事务句柄：在事务里读回刚写的节点运行行。
        const rows = await transaction
          .select({ id: nodeRuns.id })
          .from(nodeRuns)
          .where(eq(nodeRuns.taskId, taskId))
        expect(rows.map((row) => row.id)).toEqual([nodeRunId])
      })
    })
  },
)

import { composeNodeRunRuntimePersistence } from './helpers/nodeRunRuntime'
// RFC-359 —— `TaskExecutionRuntimeParticipants` 的双引擎对拍。
//
// # 现状：这一对**已合一**（AC-1 第 12 刀）
//
// W8 当年判「不合」，理由写的是「两台 children 引擎 + 两个 registry」。那条理由今天只剩半句：
//   · children 的两台引擎在第 10 / 11 刀合成了 `resumeTaskProjection` / `cancelTaskProjection`；
//   · 子任务铸造机在批次二 ⑤ 合成了 `createChildExecutionLaunchOperations`；
//   · drive 的内核本来就是同一个 `driveTaskEngineApplication`。
// 剩下的「两个 registry」为真，但那是**部署形态**不是引擎实现：单进程装进程内注册表，
// 持久化租约装执行模块的注册表。按 plan §5fq 的判据（只有三种差异算「源于引擎本身」：
// 单引擎原语 / 单引擎资源形态 / 驱动强加的线上差异），这一条一条都不命中 ⇒ 必须合，
// 处方是**端口 + 两个绑定**。
//
// 于是两份 provider 前缀的参与者文件（`sqlite…` 189 行 / `postgresql…` 160 行）退役，
// 换成一份中立的 `taskExecutionRuntimeParticipants.ts`；认领策略 / 活跃度 / 停机票据三格
// 收成 `ChildTaskLifecycleRuntimePorts`，由各自的组合根（`composition/providerRuntime.ts`）交。
// 此前看着「两侧不同」的其余十来格（持久化 / 会话租约 / 记忆注入 / 运行时档案 / 协作 /
// 并发域 / 日志）只是**谁来构造**的差别——SQLite 由装配方交、PG 在工厂里现造；
// 合并后一律由装配方交，连返回形状都不再有差（PG 那侧原本还额外回 `persistence` /
// `executionModule`）。
//
// # 这份对拍覆盖什么
//
// 两个绑定各自在自己的引擎上真实构造，然后：
//   ① `activity` 的行为在两个引擎上对拍（未知任务 `isActive === false`；`awaitReleasedSettled`
//      在没有 driver 时立即 settle）——这是唯一一个两侧都能在同一段断言里驱动的参与者；
//   ② 端口面（`drive` / `children` / `activity` 的方法名与形参个数）与**返回形状**两侧逐字相同；
//   ③ 源码文本断言从「见证分叉」翻成「锁住合一」：两份 provider 前缀文件不得复活、
//      共用实现自己不许拼认领策略或读进程全局、两条绑定各在组合根里。
// W12 AC-12 补充：完整 provider 的动态工作流恢复必须收到真实持久化与目录端口；
// 下方用持久化 awaiting_confirm 状态驱动同一内核，保留原确认 run，不启动外部运行时。
// children 的完整行为仍由 `rfc349-*` / `rfc339-*` 等既有套件承担。

import {
  initialDwState,
  WORKFLOW_SCHEMA_VERSION,
  WorkgroupRuntimeConfigSchema,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createWorkerIdentity } from '@/modules/task-execution/domain/ownership'
import {
  agents,
  mcps,
  nodeRunOutputs,
  nodeRuns,
  plugins,
  skills,
  tasks,
  users,
  workflows,
  workgroupTaskState,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskExecutionRuntimeParticipants } from '@/modules/task-execution/application/ports/taskExecutionRuntimeParticipants'
import {
  createTaskExecutionRuntimeParticipants,
  type TaskExecutionRuntimeParticipantsInput,
} from '@/modules/task-execution/infrastructure/taskExecutionRuntimeParticipants'
import {
  composeTestChildLaunchWorkgroup,
  singleProcessDeploymentPorts,
} from './helpers/taskExecutionTestTopology'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import type { ChildTaskLifecycleRuntimePorts } from '@/modules/task-execution/infrastructure/childTaskLifecycleParticipant'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { createTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { describeEachProvider } from './helpers/eachProvider'
import { sqliteMemoryInjectionQueries } from './helpers/memoryInjection'
import { createTestRepositoryPublicationTransport } from './helpers/taskExecutionTestTopology'
import {
  createEachProviderTaskExecution,
  createTestDynamicWorkflowOperations,
} from './helpers/eachProviderTaskExecution'
import { DW_ORCHESTRATOR_NODE_ID } from '@/services/orchestratorAgent'

const INFRASTRUCTURE = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'task-execution',
  'infrastructure',
)

const read = (name: string): string => readFileSync(resolve(INFRASTRUCTURE, name), 'utf8')

/**
 * RFC-359 AC-1（第 11 刀勘察）—— **去注释**之后再做源码断言。
 *
 * 为什么加这个：下面那条「`cancel` 两侧不能互换」的机械证据原本是
 * `expect(cancelStatements.slice(0, 600)).toContain('.all()[0]')`——它要证的是
 * `cancelTask` 的准入预检是 bun:sqlite 的**同步读**。而 RFC-359 自己在更早的某一刀里
 * 把那句同步读改成了 `await db.select(...)`，同时**在原地留下一段解释这件事的注释**，
 * 注释里带着 `` `.all()[0]` `` 这几个字。于是判据继续绿——**绿在注释上**。
 *
 * 「零与合规同形」的近亲：**「证据」与「解释证据为什么已经不在了的那段话」同形**。
 * 源码文本判据一律先过这一层。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * 只被工厂**存下来、不被本文件驱动**的依赖。两个工厂都只在构造时把它们收进闭包，
 * `activity` 一条也用不到；写成占位是为了让「构造这一步」本身也在两个引擎上跑一遍。
 */
function passthrough<T>(label: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`本对拍不驱动 '${label}'：它只是工厂闭包里的直传依赖`)
      },
    },
  ) as T
}

/**
 * 两侧共用的那一份输入。**没有任何一格按引擎分叉**——差异全在
 * {@link ChildTaskLifecycleRuntimePorts} 那三格里，由下面两个绑定分别交。
 */
function sharedInput(
  db: ProviderNeutralDatabase,
): Omit<
  TaskExecutionRuntimeParticipantsInput,
  'taskDagCollaboration' | 'processConcurrencyScope' | 'log'
> {
  return {
    db,
    persistence: createTaskExecutionPersistence(db),
    runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
    memoryInjectionQueries: sqliteMemoryInjectionQueries(db as unknown as DbClient),
    runtimeRegistry: composeRuntimeRegistryOperations(db),
    nodeRunRuntime: composeNodeRunRuntimePersistence(db),
    collaborationRuntime: createCollaborationRuntimeMechanics(db),
    childLaunchWorkgroup: composeTestChildLaunchWorkgroup(db as unknown as DbClient),
    workgroupTurns: passthrough('workgroupTurns'),
    dynamicWorkflow: createTestDynamicWorkflowOperations(db),
    identityAccess: passthrough('identityAccess'),
    repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
  }
}

/** 单进程部署形态的绑定：进程级单例的同步认领 + 进程内注册表。 */
function sqliteParticipants(db: ProviderNeutralDatabase): TaskExecutionRuntimeParticipants {
  const client = db as unknown as DbClient
  return createTaskExecutionRuntimeParticipants({
    ...sharedInput(db),
    ...singleProcessDeploymentPorts(client),
  })
}

/** 持久化租约部署形态的绑定：`claimPersisted` + 注入的执行模块注册表。 */
function postgresqlParticipants(db: ProviderNeutralDatabase): TaskExecutionRuntimeParticipants {
  const client = db as unknown as PostgresqlDatabaseClient
  const input = sharedInput(db)
  const executionModule = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence: input.persistence,
  })
  const ports: ChildTaskLifecycleRuntimePorts = {
    lifecycle: createTaskDriverLifecyclePort({
      db: client,
      module: executionModule,
      claim: (intentId) => executionModule.claimPersisted({ intentId }),
      persistence: input.persistence,
      log: passthrough('log'),
      finalizeWorkspace: async () => {},
    }),
    activity: Object.freeze({
      isActive: (taskId: string) => executionModule.runtimeRegistry.hasTask(taskId),
      awaitReleasedSettled: (taskId: string) =>
        executionModule.runtimeRegistry.awaitReleasedSettled(taskId),
    }),
    stop: executionModule.runtimeRegistry,
  }
  return createTaskExecutionRuntimeParticipants({
    ...input,
    taskDagCollaboration: createTaskDagCollaborationOperations(db),
    processConcurrencyScope: {},
    log: passthrough('log'),
    ...ports,
  })
}

/** 按引擎取本引擎的那份适配器。`describeEachProvider` 有意不给 provider 名，只给能力矩阵。 */
function participantsFor(
  db: ProviderNeutralDatabase,
  isolation: 'exclusive' | 'read-committed',
): TaskExecutionRuntimeParticipants {
  return isolation === 'exclusive' ? sqliteParticipants(db) : postgresqlParticipants(db)
}

describeEachProvider('RFC-359 W8 —— runtime 参与者双引擎对拍', (harness) => {
  test('端口面两侧逐字相同：drive / children / activity 的方法名与形参个数', () => {
    const participants = participantsFor(harness.db, harness.capabilities.isolation)
    // RFC-359 AC-1（第 12 刀）：**返回形状两侧逐字相同**。合一之前 PostgreSQL 的工厂还额外回
    // `persistence` / `executionModule`（`PostgresqlTaskExecutionRuntimeAggregate`）——那不是
    // 引擎差异，是「谁来造」漏出来的形状；装配回到组合根之后两侧都只回三个端口。
    const keys = Object.keys(participants).sort()
    expect(keys).toEqual(['activity', 'children', 'drive'])
    expect(Object.isFrozen(participants)).toBe(true)
    expect(Object.keys(participants.drive)).toEqual(['drive'])
    expect(participants.drive.drive.length).toBe(2)
    expect(Object.keys(participants.children).sort()).toEqual(['cancel', 'resume'])
    expect(participants.children.cancel.length).toBe(1)
    expect(participants.children.resume.length).toBe(2)
    expect(Object.keys(participants.activity).sort()).toEqual(['awaitReleasedSettled', 'isActive'])
    expect(participants.activity.isActive.length).toBe(1)
    expect(participants.activity.awaitReleasedSettled.length).toBe(1)
  })

  test('activity：没有 driver 的任务 isActive 为 false，awaitReleasedSettled 立即 settle', async () => {
    const participants = participantsFor(harness.db, harness.capabilities.isolation)
    const unknown = `w8_runtime_${ulid()}`
    expect(participants.activity.isActive(unknown)).toBe(false)
    // 两个引擎上都不许挂住：没有在跑的 driver 时这条 await 必须立刻回来。
    await participants.activity.awaitReleasedSettled(unknown)
    expect(participants.activity.isActive(unknown)).toBe(false)
  })

  test('dynamic-workflow construction reads the live catalog from the selected DB', async () => {
    const db = harness.db
    const operations = createTestDynamicWorkflowOperations(db)
    const agentId = ulid()
    const skillId = ulid()
    const mcpId = ulid()
    const pluginId = ulid()
    await db.insert(agents).values({
      id: agentId,
      name: `dynamic-${agentId}`,
      outputs: '["result"]',
      bodyMd: 'Read the selected catalog.',
    })
    await db.insert(skills).values({ id: skillId, name: `dynamic-${skillId}` })
    await db.insert(mcps).values({
      id: mcpId,
      name: `dynamic-${mcpId.toLowerCase()}`,
      type: 'local',
      config: JSON.stringify({ command: ['catalog-fixture', '--read'] }),
    })
    await db.insert(plugins).values({
      id: pluginId,
      name: `dynamic-${pluginId.toLowerCase()}`,
      spec: 'file:/catalog-fixture',
      sourceKind: 'file',
      cachedPath: '/catalog-fixture/index.js',
      installedAt: 1,
      optionsJson: JSON.stringify({ label: 'selected database' }),
    })

    const inventory = await operations.validationContext.load()
    expect(inventory.agents.find((row) => row.id === agentId)).toMatchObject({
      id: agentId,
      bodyMd: 'Read the selected catalog.',
    })
    expect(inventory.skills.map((row) => row.id)).toContain(skillId)
    expect(inventory.mcps?.find((row) => row.id === mcpId)).toMatchObject({
      id: mcpId,
      config: { command: ['catalog-fixture', '--read'] },
    })
    expect(inventory.plugins?.find((row) => row.id === pluginId)).toMatchObject({
      id: pluginId,
      options: { label: 'selected database' },
    })
    expect((await operations.persistence.loadAgent(agentId))?.id).toBe(agentId)
    await db
      .update(agents)
      .set({ bodyMd: 'A later catalog revision.' })
      .where(eq(agents.id, agentId))
    expect(
      (await operations.validationContext.load()).agents.find((row) => row.id === agentId),
    ).toMatchObject({ bodyMd: 'A later catalog revision.' })
  })

  test('the complete provider drives dynamic-workflow re-entry without regenerating', async () => {
    const db = harness.db
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-dynamic-runtime-'))
    const userId = ulid()
    const agentId = ulid()
    const taskId = ulid()
    const workflowId = ulid()
    const workgroupId = ulid()
    let execution: Awaited<ReturnType<typeof createEachProviderTaskExecution>> | undefined
    try {
      await db.insert(users).values({
        id: userId,
        username: `dynamic-${userId}`,
        displayName: 'Dynamic Runtime Fixture',
        role: 'admin',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      await db.insert(agents).values({
        id: agentId,
        name: `dynamic-${agentId}`,
        outputs: '["result"]',
        bodyMd: 'This confirmed proposal does not need another generation.',
      })
      const snapshot: WorkflowDefinition = {
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [
          {
            id: DW_ORCHESTRATOR_NODE_ID,
            kind: 'agent-single',
            agentId,
            agentName: `dynamic-${agentId}`,
          },
        ],
        edges: [],
      }
      const config = WorkgroupRuntimeConfigSchema.parse({
        workgroupId,
        workgroupName: `dynamic-${workgroupId}`,
        mode: 'dynamic_workflow',
        leaderMemberId: null,
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 10,
        completionGate: false,
        instructions: 'Preserve the proposal awaiting confirmation.',
        goal: 'Resume the durable dynamic-workflow phase.',
        members: [
          {
            id: ulid(),
            memberType: 'agent',
            agentId,
            agentName: `dynamic-${agentId}`,
            userId: null,
            displayName: 'Generator',
            roleDesc: 'Generate a proposal.',
          },
        ],
      })
      const dw = { ...initialDwState(), phase: 'awaiting_confirm', generatedDef: snapshot }
      await db.insert(workflows).values({
        id: workflowId,
        name: `dynamic-${workflowId}`,
        definition: JSON.stringify(snapshot),
      })
      await db.insert(tasks).values({
        id: taskId,
        executionLineageId: taskId,
        lineageSlotPathJson: JSON.stringify([
          { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
        ]),
        name: 'Dynamic workflow re-entry',
        ownerUserId: userId,
        workflowId,
        workflowSnapshot: JSON.stringify(snapshot),
        repoPath: appHome,
        worktreePath: appHome,
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        status: 'pending',
        startedAt: Date.now(),
        inputs: '{}',
        workgroupId,
        workgroupConfigJson: JSON.stringify(config),
      })
      await db.insert(workgroupTaskState).values({
        taskId,
        dwStateJson: JSON.stringify(dw),
        updatedAt: 1,
      })
      execution = await createEachProviderTaskExecution(harness, { appHome }, userId)
      const intentId = ulid()
      const now = Date.now()
      await execution.persistence.intents.submitContinuation({
        taskId,
        intentId,
        kind: 'launch',
        source: 'rest',
        actorUserId: userId,
        payload: { v: 1 },
        now,
        advanceOperationGeneration: false,
      })
      const token = await execution.persistence.ownership.claimPendingIntent({
        intentId,
        identity: createWorkerIdentity({
          ownerId: ulid(),
          daemonGeneration: `dynamic-workflow-${ulid()}`,
        }),
        now,
        leaseMs: 30_000,
      })
      const executionContext = createTaskExecutionContext({
        intentId,
        token,
        persistence: execution.persistence,
      })
      const signal = new AbortController().signal
      await execution.provider.runtime.schedulerDriver.drive({
        taskId,
        appHome,
        executionContext,
        signal,
      })

      const [parked] = await db.select().from(tasks).where(eq(tasks.id, taskId))
      expect(parked).toMatchObject({ status: 'awaiting_review', errorSummary: null })
      const firstRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      expect(firstRuns).toHaveLength(1)
      expect(firstRuns[0]).toMatchObject({
        nodeId: DW_ORCHESTRATOR_NODE_ID,
        status: 'awaiting_review',
        rerunCause: 'dw-gate',
      })
      expect(
        await execution.persistence.runtimeLifecycle.trySet({
          taskId,
          to: 'pending',
          allowedFrom: ['awaiting_review'],
          now: Date.now(),
          reason: 'test-dynamic-workflow-re-entry',
          executionContext,
        }),
      ).toBe(true)
      await execution.provider.runtime.schedulerDriver.drive({
        taskId,
        appHome,
        executionContext,
        signal,
      })
      const resumedRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      expect(resumedRuns.map((run) => run.id)).toEqual(firstRuns.map((run) => run.id))
      expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
        'awaiting_review',
      )
      expect(
        (await createTestDynamicWorkflowOperations(db).persistence.loadTask(taskId))?.dwStateJson,
      ).toBe(JSON.stringify(dw))
      expect(await db.select().from(nodeRunOutputs)).toEqual([])
    } finally {
      await execution?.shutdown()
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 不合一判定的源码锚点（不进 describeEachProvider：与引擎无关，跑一遍就够）
// ---------------------------------------------------------------------------

// RFC-359 AC-1（第 10 / 11 刀）**把这条判据整条销掉**：`children` 这一对已经合一。
//
// 原判据钉的是「children 这一对是两台引擎」。两半现在都不成立：
//   · `resume`（第 10 刀）——两侧都跑 `resumeTaskProjection`，等价性由
//     `rfc359-w10-resume-admission-parity` 的九格对拍作证；
//   · `cancel`（第 11 刀）——两侧都跑 `cancelTaskProjection`，等价性由
//     `rfc359-w11-cancel-parity` 的十一格对拍作证。
// 两个引擎唯一的真差异（resume 的认领策略）收进了 `lifecycle` 端口：SQLite 走进程级单例的
// 同步认领，PostgreSQL 走持久化租约。
//
// **记一条判据教训**（第 11 刀勘察时撞出来的，留着别删）：这条判据当年的机械证据是
// 「`cancelTask` 的准入预检是 bun:sqlite 的同步读」，写成 `toContain('.all()[0]')`。
// RFC-359 在更早的一刀里把那句同步读改成了 `await db.select(...)`，判据却一直绿——因为改动
// **在原地留下了一段解释这件事的注释**，注释里带着 `` `.all()[0]` `` 这几个字，而判据是纯文本
// `toContain`。源码文本判据不过滤注释，就可能绿在「解释证据为什么已经不在了的那段话」上
//（「零与合规同形」的近亲）。`codeOnly()` 就是为这个加的，下面这条继续用它。
//
// 这条现在钉的是**合一之后的当前事实**：两侧都转给同一份实现，且那份实现的准入预检是
// provider 中立的（同步取号 + `await db.select(...)`），不许为了「更快一点」改回同步读——
// 那会重新把顺序正确性挂在一个引擎的特性上。
test('第 12 刀 · 参与者已合一：仓里只剩一份实现，两个组合根各绑各的端口', () => {
  const participants = read('taskExecutionRuntimeParticipants.ts')
  const provider = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'task-execution',
      'composition',
      'providerRuntime.ts',
    ),
    'utf8',
  )

  // 两份 provider 前缀的参与者文件都不许再长回来。
  for (const name of [
    'sqliteTaskExecutionRuntimeParticipants.ts',
    'postgresqlTaskExecutionRuntimeParticipants.ts',
  ]) {
    expect(existsSync(resolve(INFRASTRUCTURE, name)), `${name} 不得复活：参与者只有一份实现`).toBe(
      false,
    )
  }

  // 两个组合根调的是**同一个**工厂。
  expect(provider.match(/createTaskExecutionRuntimeParticipants\(\{/g)?.length).toBe(2)

  // resume / cancel 都转给共用实现，且不再经过退役的 legacy 入口。
  expect(participants).toContain('createChildTaskLifecycleParticipant({')
  // 共用工厂体内不得直呼进程全局的活跃度——那是 `composeLegacyTaskActivityParticipant`
  // 这个**装配点**的事，参与者自己只认注入进来的 `activity` 端口。
  const factoryBody = codeOnly(participants).slice(
    codeOnly(participants).indexOf('export function createTaskExecutionRuntimeParticipants('),
    codeOnly(participants).indexOf('export function composeLegacyTaskActivityParticipant('),
  )
  expect(factoryBody).not.toContain('isTaskActive')
  expect(factoryBody).not.toContain('awaitTaskDriverReleasedSettled')
  const merged = codeOnly(
    readFileSync(resolve(INFRASTRUCTURE, 'childTaskLifecycleParticipant.ts'), 'utf8'),
  )
  expect(merged).toContain('await cancelTaskProjection(')
  expect(merged).toContain('await resumeTaskProjection(')

  // `services/task.ts` 不得再长出任何一份取消实现——`cancelTask` 整个导出已删除。
  const legacyTaskService = codeOnly(
    readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8'),
  )
  expect(legacyTaskService, 'legacy Task service 不得再导出 cancelTask').not.toContain(
    'export async function cancelTask(',
  )
  expect(legacyTaskService, 'legacy Task service 不得再自己调取消实现').not.toContain(
    'cancelTaskProjection(',
  )

  // 共用实现的准入预检是 provider 中立的：进门第一件事是同步取号
  //（`reserveTaskReviewMutationSlot`，排队位置在函数入口就定死），随后那条状态预检是
  // `await`ed 的 select——不再是 bun:sqlite 的同步读。
  const cancelBody = merged.slice(merged.indexOf('export async function cancelTaskProjection('))
  expect(cancelBody).toContain('reserveTaskReviewMutationSlot(taskId)')
  expect(cancelBody, '准入预检不得退回 bun:sqlite 的同步读').not.toContain('.all()[0]')
})

// RFC-359 AC-1（第 12 刀）—— 这三格**就是**两个引擎剩下的全部差异，而且它们是端口不是分支。
//
// W8 当年判「不合」写的理由是「两台 children 引擎 + 两个 registry」。前半句已经不成立
//（children 的两台引擎在第 10 / 11 刀合掉了）；后半句仍然为真，但那是**部署形态**：
// 单进程装了进程内注册表，持久化租约装了执行模块的注册表。按 plan §5fq，这种差异的处方是
// 端口 + 两个绑定，不是两份实现。下面这条锁的正是「差异只在端口上」。
test('第 12 刀 · 引擎差异只剩三个端口：认领策略 / 活跃度 / 停机票据', () => {
  const participants = codeOnly(read('taskExecutionRuntimeParticipants.ts'))
  const provider = codeOnly(
    readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'providerRuntime.ts',
      ),
      'utf8',
    ),
  )

  // 共用实现自己不许拼认领策略，也不许读任何进程全局注册表——三格全是收进来的。
  expect(participants).not.toContain('createTaskDriverLifecyclePort(')
  expect(participants).not.toContain('claimPersisted')
  expect(participants).toContain('lifecycle: input.lifecycle')
  expect(participants).toContain('activity: input.activity')
  expect(participants).toContain('stop: input.stop')

  // 两条绑定都在组合根里，且各绑各的。
  expect(provider).toContain('lifecycle: createDatabaseTaskDriverLifecyclePort({')
  expect(provider).toContain('claim: (intentId) => executionModule.claimPersisted({ intentId })')
  expect(provider).toContain('activity: composeLegacyTaskActivityParticipant()')
  expect(provider).toContain('stop: composeLegacyTaskStopRegistry()')
  expect(provider).toContain('stop: executionModule.runtimeRegistry')
})

test('第 12 刀 · drive 的内核是同一份：一处 driveTaskEngineApplication、一台子任务铸造机', () => {
  const participants = read('taskExecutionRuntimeParticipants.ts')
  expect(participants).toContain(
    "import { driveTaskEngineApplication } from '../composition/taskEngineApplication'",
  )
  expect(participants).toContain('await driveTaskEngineApplication(')
  expect(participants).toContain('wrapperRuntimeFactory: composeWrapperRuntime')
  expect(participants).toContain('mergeRecoveryFactory: composeExecutionMergeRecovery')
  expect(participants).toContain('createChildExecutionLaunchOperations({')
  expect(participants).not.toContain('createSqliteChildExecutionLaunchOperations')
})

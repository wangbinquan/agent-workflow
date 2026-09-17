// RFC-359 AC-1（第 8 刀第 3 步的前置基线）—— **两份修复实现的准入门给同一个错误码**。
//
// 这是第 8 刀三条基线里的最后一条，比的是 `applyRepair` 的**拒绝面**：
//
//   · 第 1 步 `rfc359-w8b-repair-option-registry-parity` 比两张元数据表（纯静态）；
//   · 第 2 步 `rfc359-w8b-repair-preflight-parity` 比同一条告警下的**选项判据与预览文案**；
//   · 本条比**门**：同一个非法请求，两份实现是否拒在同一个位置、给同一个 code。
//
// 为什么拒绝面值得单独立一条
// ------------------------
// 错误码是**用户可见**的：前端按 code 出文案，运维按 code 判断「这个修复为什么点不动」。
// 两份实现各自有测试、各自都绿，但没有任何东西比较它们——同一个失效场景在两个部署上
// 可以给出不同的 code（甚至不同的 HTTP 状态：`NotFoundError` 404 / `ConflictError` 409 /
// `ValidationError` 400），而两侧的测试一条都不会红。
//
// 能在同一个库上并排跑，靠的仍是第 8 刀第 2 步解锁的那件事：那份「SQLite 的」实现没有任何
// SQLite 专有原语，放宽到中立句柄之后两份实现能吃同一个 harness 库，于是比的是
// **两份实现**，不是两种数据库。
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { lifecycleAlerts, tasks } from '@/db/schema'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createPostgresqlTaskRouteRepairOperations } from '@/modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations'
import { applyRepairOption } from '@/platform/persistence/sqlite/taskLifecycleRepair'
import type { StartTaskDeps } from '@/services/task'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_788_400_000_000

function unused<T extends object>(methods: Partial<T> = {}): T {
  return new Proxy(methods, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key)
      throw new Error(`本对拍不驱动这个修复依赖：${String(key)}`)
    },
  }) as T
}

/** 拒绝面全部发生在**跑任何修复之前**，所以这些用例一次真修复都不需要驱动。 */
function actor(): Actor {
  return {
    user: { id: 'repair-admin', username: 'repair-admin', role: 'admin', status: 'active' },
    source: 'session',
    permissions: new Set(['tasks:read', 'tasks:write'] as const),
    authorityRevision: 1,
  } as unknown as Actor
}

interface Seeded {
  readonly taskId: string
  readonly alertId: string
}

async function seed(
  db: ProviderNeutralDatabase,
  overrides: {
    readonly status?: string
    readonly rule?: string
    readonly resolved?: boolean
    readonly workgroup?: boolean
  } = {},
): Promise<Seeded> {
  const taskId = `task-${ulid()}`
  const alertId = `alert-${ulid()}`
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'workflow-w8b-admission',
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: mkdtempSync(join(tmpdir(), 'aw-rfc359-w8b-adm-')),
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: (overrides.status ?? 'pending') as 'pending',
    inputs: '{}',
    startedAt: NOW - 600_000,
    runningMs: 0,
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
    ]),
    // `workgroupConfigJson` 留空 = 配置读不出模式 ⇒ `isTurnEngineWorkgroupTask` fail-closed 判真
    //（`shared/src/dynamicWorkflow.ts` 的注释写明「corrupt or unknown config counts as turn-engine」）。
    ...(overrides.workgroup === true ? { workgroupId: `wg-${ulid()}` } : {}),
  })
  await db.insert(lifecycleAlerts).values({
    id: alertId,
    taskId,
    rule: (overrides.rule ?? 'S4') as 'S4',
    severity: 'warning',
    detail: JSON.stringify({}),
    detectedAt: NOW - 60_000,
    resolvedAt: overrides.resolved === true ? NOW - 30_000 : null,
  })
  return { taskId, alertId }
}

/** 两份实现各自的 apply 入口，参数面归一成同一个四元组。 */
function bothEngines(harness: ProviderHarness) {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w8b-adm-home-'))
  const persistence = createTaskExecutionPersistence(harness.db)
  const deps = {
    db: harness.db,
    appHome,
    schedulerDriver: { drive: async () => {} },
    taskRecoveryOperations: persistence.recoveryAdministration,
    awaitScheduler: true,
  } as unknown as StartTaskDeps
  const postgresql = createPostgresqlTaskRouteRepairOperations({
    db: harness.db as unknown as PostgresqlDatabaseClient,
    persistence,
    activity: { isActive: () => false, awaitReleasedSettled: async () => {} },
    children: unused({ resume: async () => {} }),
    topology: unused(),
    resumeRuntimeFor: () => unused(),
    collaborationRuntime: unused(),
    clarify: unused(),
    review: unused(),
    appHome,
    now: () => NOW,
  } as unknown as Parameters<typeof createPostgresqlTaskRouteRepairOperations>[0])
  return {
    async classic(taskId: string, alertId: string, optionId: string) {
      return await applyRepairOption({
        db: harness.db,
        taskId,
        alertId,
        optionId,
        actorUserId: null,
        appHome,
        deps,
        operations: persistence.recoveryAdministration,
        now: () => NOW,
      } as unknown as Parameters<typeof applyRepairOption>[0])
    },
    async shared(taskId: string, alertId: string, optionId: string) {
      return await postgresql.applyRepair({
        actor: actor(),
        taskId,
        alertId,
        optionId,
        onAlert: () => {},
        onResolved: () => {},
      })
    },
  }
}

/** 只取 code 与 HTTP 状态——文案允许不同，**分类不许不同**。 */
async function refusal(run: () => Promise<unknown>): Promise<{ code: unknown; status: unknown }> {
  try {
    await run()
  } catch (error) {
    const e = error as { code?: unknown; status?: unknown; constructor: { name: string } }
    return { code: e.code ?? e.constructor.name, status: e.status ?? null }
  }
  throw new Error('这个场景本该被拒，两份实现里有一份放行了')
}

describeEachProvider('RFC-359 第 8 刀 —— 两份修复实现的准入门给同一个答案', (harness) => {
  const scenarios = [
    {
      what: '告警不存在',
      expected: 'alert-not-found',
      async setup(db: ProviderNeutralDatabase) {
        const { taskId } = await seed(db)
        return { taskId, alertId: `alert-${ulid()}`, optionId: 'S4.kick-task' }
      },
    },
    {
      what: '告警挂在别的任务上',
      expected: 'alert-not-on-task',
      async setup(db: ProviderNeutralDatabase) {
        const mine = await seed(db)
        const other = await seed(db)
        return { taskId: other.taskId, alertId: mine.alertId, optionId: 'S4.kick-task' }
      },
    },
    {
      what: '告警已被解决',
      expected: 'alert-already-resolved',
      async setup(db: ProviderNeutralDatabase) {
        const { taskId, alertId } = await seed(db, { resolved: true })
        return { taskId, alertId, optionId: 'S4.kick-task' }
      },
    },
    {
      what: '选项 id 压根不在注册表里',
      expected: 'unknown-repair-option',
      async setup(db: ProviderNeutralDatabase) {
        const { taskId, alertId } = await seed(db)
        return { taskId, alertId, optionId: 'S4.does-not-exist' }
      },
    },
    {
      what: '选项属于另一条规则（陈旧对话框直接打 API）',
      expected: 'repair-option-rule-mismatch',
      async setup(db: ProviderNeutralDatabase) {
        const { taskId, alertId } = await seed(db, { rule: 'S5' })
        return { taskId, alertId, optionId: 'S4.kick-task' }
      },
    },
    {
      what: 'TURN-ENGINE 工作组任务不能被通用修复复活',
      expected: 'workgroup-repair-unsupported',
      async setup(db: ProviderNeutralDatabase) {
        const { taskId, alertId } = await seed(db, { workgroup: true })
        return { taskId, alertId, optionId: 'S4.kick-task' }
      },
    },
  ] as const

  for (const scenario of scenarios) {
    test(`${scenario.what}：两份实现拒在同一个 code`, async () => {
      const engines = bothEngines(harness)
      const [classicCase, sharedCase] = await Promise.all([
        scenario.setup(harness.db),
        scenario.setup(harness.db),
      ])

      // 先钉住这一侧本身拒对了——两份同样地拒错也会让相等断言绿掉。
      const classic = await refusal(() =>
        engines.classic(classicCase.taskId, classicCase.alertId, classicCase.optionId),
      )
      expect(classic.code, `classic 侧这个场景该拒在 ${scenario.expected}`).toBe(scenario.expected)

      const shared = await refusal(() =>
        engines.shared(sharedCase.taskId, sharedCase.alertId, sharedCase.optionId),
      )
      expect(
        shared,
        '两份修复实现对同一个非法请求给了不同的分类——前端按 code 出文案、按状态码判重试，' +
          '于是同一个失效在两个部署上表现不同，而两侧各自的测试都不会因此变红。',
      ).toEqual(classic)
    })
  }
})

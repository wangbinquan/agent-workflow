// RFC-359 AC-1（plan §5hn 之后的盘点，第 8 刀第 2 步）—— **两份修复实现在同一个库上给同一个答案**。
//
// 为什么这条测试存在
// ------------------
// 第 1 步（`rfc359-w8b-repair-option-registry-parity`）比的是两张**元数据表**，纯静态。
// 这一条比的是**运行结果**：同一条告警、同一个库，两份实现跑出来的
// `available` / `unavailableReasonKey` / 选项顺序是否一致。
//
// 合并前这是没人验过的一格：SQLite 路由用
// `platform/persistence/sqlite/taskLifecycleRepair.ts`，PostgreSQL 路由用
// `postgresqlTaskRouteRepairOperations.ts`，两份各自都有测试、都绿，**谁也不知道它们同不同答案**。
// 用户看到的后果是「同一个卡住的任务，在两个部署上被告知的可修复选项不一样」。
//
// **能这么比是第 8 刀第 2 步刚解锁的**：那份「SQLite 的」实现其实没有任何 SQLite 专有原语
//（零同步终结符、无 `dbTxSync`、不 import bun:sqlite），把它绑死的只有一行 `db: DbClient`
// 类型标注；放宽到中立句柄之后，两份实现就能在**同一个** harness 库上并排跑——
// 于是这条对拍在**两个引擎的 lane 上都成立**，比的是「两份实现」而不是「两种数据库」。
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { lifecycleAlerts, tasks } from '@/db/schema'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createPostgresqlTaskRouteRepairOperations } from '@/modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations'
import { listRepairOptionsForAlert } from '@/platform/persistence/sqlite/taskLifecycleRepair'
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

/**
 * 判据 + **预览文案**全进比较面。
 *
 * `previewSteps` 是本条第一跑就照出来的真分叉，已在下面销账：
 * `CR-1/S5/S6.acknowledge` 三条在 PostgreSQL 那份里共用一句 `Resolve alert <id>.`，
 * 而 classic 那份对每条规则各给两步——第二步是「这一步不改任何数据，你接下来该做什么」。
 * 丢掉它的后果是用户点完「确认告警」以为问题解决了，而 acknowledge 本身什么都没修。
 * 取 classic 那份逐字（它包含另一份的信息还更多），并按规则分开。
 */
function comparable(
  options: ReadonlyArray<Record<string, unknown>>,
  includePreview: boolean,
): unknown {
  return options.map((option) => ({
    id: option['id'],
    rule: option['rule'],
    available: option['available'],
    unavailableReasonKey: option['unavailableReasonKey'] ?? null,
    ...(includePreview ? { previewSteps: option['previewSteps'] ?? [] } : {}),
  }))
}

async function seedAlert(
  db: ProviderNeutralDatabase,
  overrides: { readonly status?: string; readonly rule?: string } = {},
): Promise<{ taskId: string; alertId: string }> {
  const taskId = `task-${ulid()}`
  const alertId = `alert-${ulid()}`
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'workflow-w8b',
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: mkdtempSync(join(tmpdir(), 'aw-rfc359-w8b-')),
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
  })
  await db.insert(lifecycleAlerts).values({
    id: alertId,
    taskId,
    rule: (overrides.rule ?? 'S4') as 'S4',
    severity: 'warning',
    detail: JSON.stringify({}),
    detectedAt: NOW - 60_000,
    resolvedAt: null,
  })
  return { taskId, alertId }
}

function bothEngines(harness: ProviderHarness) {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w8b-home-'))
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
    async classic(taskId: string, alertId: string) {
      return await listRepairOptionsForAlert({
        db: harness.db,
        taskId,
        alertId,
        actorUserId: null,
        appHome,
        deps,
        now: () => NOW,
      })
    },
    async shared(taskId: string, alertId: string) {
      return await postgresql.repairOptions({
        actor: unused(),
        taskId,
        alertId,
      } as unknown as Parameters<(typeof postgresql)['repairOptions']>[0])
    },
  }
}

describeEachProvider('RFC-359 第 8 刀 —— 两份修复实现在同一个库上给同一个答案', (harness) => {
  const scenarios = [
    // `preview: false` = 这条规则的预览文案仍是**登记在案的分叉**，见文件末尾那条锁。
    {
      what: 'S4 卡在 pending（最常见的可修复形态）',
      rule: 'S4',
      status: 'pending',
      preview: false,
    },
    {
      what: 'S4 但任务已经不在 pending（选项应当不可用）',
      rule: 'S4',
      status: 'running',
      preview: true,
    },
    { what: 'S5 告警（只有一个 acknowledge 选项）', rule: 'S5', status: 'pending', preview: true },
    { what: 'S6 告警', rule: 'S6', status: 'done', preview: true },
  ] as const
  for (const scenario of scenarios) {
    test(`${scenario.what}：两份实现的选项判据逐格相等`, async () => {
      const engines = bothEngines(harness)
      const { taskId, alertId } = await seedAlert(harness.db, {
        rule: scenario.rule,
        status: scenario.status,
      })
      const classic = await engines.classic(taskId, alertId)
      const shared = await engines.shared(taskId, alertId)

      // 先钉住这一侧本身的正确性——两份同样地错也会让相等断言绿掉。
      expect(classic.alertRule, '告警规则原样回显').toBe(scenario.rule)
      expect(classic.options.length, '每条规则至少有一个选项（shared 分类保证）').toBeGreaterThan(0)

      expect(
        comparable(
          shared.options as unknown as ReadonlyArray<Record<string, unknown>>,
          scenario.preview,
        ),
        '两份修复实现对同一条告警给出了不同的可用选项——用户在两个部署上会被告知不同的修复办法，' +
          '而两侧各自的测试都不会因此变红（它们只验各自那一份）。',
      ).toEqual(
        comparable(
          classic.options as unknown as ReadonlyArray<Record<string, unknown>>,
          scenario.preview,
        ),
      )
    })
  }

  // **账已销**：上面那条分叉钉在这里过——`CR-1/S5/S6.acknowledge` 在 PostgreSQL 那份里
  // 曾经共用一句 `Resolve alert <id>.`，把 classic 那份的第二步（「这一步不改任何数据，
  // 你接下来该做什么」）整句丢了。现在两份逐字相同，`previewSteps` 已进上面的比较面。
  // 留这一条是「不许再丢」的锁：它只断言那句关键提示在**两份实现里都在**。
  // **登记在案的分叉（不销，留给合并那一步定）**：`S4.kick-task` 的预览文案两份写法不同——
  // classic 那份把**字面 SQL** 与内部函数名露给运维界面
  //（`UPDATE tasks SET status='interrupted'…` / `resumeTask('…')`），
  // shared 那份给一句人话摘要（`Kick pending task … through interrupted and resume it.`）。
  //
  // 与 acknowledge 那格不同，**这里没有信息丢失**：摘要说的正是 SQL 做的事。所以这是一次
  // 面向用户的**文案风格**选择（实现细节该不该进修复对话框），改哪一边都会动某个部署已经
  // 在显示的东西——不该在一条基线里单方面定，留给合并那一步连同产品判断一起处理。
  // 在那之前先钉住现状，免得它在无人注意时又漂第三种写法。
  test('登记分叉：S4.kick-task 的预览文案两份实现不同（风格之争，留给合并定）', async () => {
    const engines = bothEngines(harness)
    const { taskId, alertId } = await seedAlert(harness.db, { rule: 'S4', status: 'pending' })
    const classicSteps = ((await engines.classic(taskId, alertId)).options.find(
      (option) => option.id === 'S4.kick-task',
    )?.previewSteps ?? []) as readonly string[]
    const sharedSteps = ((await engines.shared(taskId, alertId)).options.find(
      (option) => option.id === 'S4.kick-task',
    )?.previewSteps ?? []) as readonly string[]

    expect(
      classicSteps.some((step) => step.startsWith('UPDATE tasks SET')),
      'classic 那份露的是字面 SQL',
    ).toBe(true)
    expect(
      sharedSteps.some((step) => step.startsWith('UPDATE tasks SET')),
      'shared 那份给的是人话摘要——这就是登记在案的那处分叉',
    ).toBe(false)
    expect(sharedSteps.length, 'shared 那份一步说完').toBe(1)
  })

  test('acknowledge 的关键提示两份实现都在（不许再丢）', async () => {
    const engines = bothEngines(harness)
    const { taskId, alertId } = await seedAlert(harness.db, { rule: 'S5', status: 'pending' })
    for (const [name, result] of [
      ['classic', await engines.classic(taskId, alertId)],
      ['shared', await engines.shared(taskId, alertId)],
    ] as const) {
      const steps = (result.options[0]?.previewSteps ?? []) as readonly string[]
      expect(steps.length, `${name}：确认告警要说清「做了什么」和「你还得做什么」`).toBe(2)
      expect(
        steps.some((step) => step.includes('No data mutations')),
        `${name}：丢了「这一步不改任何数据」⇒ 用户会以为问题解决了`,
      ).toBe(true)
    }
  })
})

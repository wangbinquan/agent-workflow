// RFC-359 W8 —— 冻结任务溯源预检的**逐分支双引擎对拍**。
//
// # 这条测试为什么存在
//
// `assertFrozenTaskTriggerPreflight` 此前在仓里有**两份逐字相同**的文件私有副本，两条 provider
// 路由路径各揣一份，差别只有 `db` 的类型标注。W8 把它们合成
// `modules/task-execution/infrastructure/frozenTaskTriggerPreflight.ts` 的一份；合一前后的落位
// 与代价记在 `architecture/commons-debt.json` 的对应条目里。
//
// 合一之前，它的五条分支里只有一条（`trigger-context-invalid`，经 retry 端点）有双引擎覆盖
// ——`rfc359-w8-task-route-capability-parity.test.ts` 的那条。另外四条**两个引擎都没有直测**：
// 任务行不存在的静默返回、损坏快照的容忍、合法快照的权威拒绝、候选快照换定义但不换 trigger 源。
// 这四条恰恰是「改一份、漂另一份」最容易漏掉的地方：漂了之后两条路径各自的用例还都绿着。
//
// 所以这里直接对**唯一那份实现**下手，在两个真实引擎上逐条钉死语义。它同时是合一的回归防护：
// 任何人把这段再 fork 回两份、或改动其中一条分支的判据，这里会红。
// 定义点唯一性另有 `tests/architecture/rfc359-converged-twins.test.ts` 双向棘轮把守。
//
// 头注释刻意**不点名**任一 provider 适配器的文件：`rfc359-w5-t19d-coverage-parity` 按「测试文件
// 提到该侧模块名」计注意力，一句讲历史的散文就能把「PG 侧被更多测试盯着」的倒挂推深一格——
// 而这条测试恰恰是喂两侧的。
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '../src/db/query'
import { tasks, workflows } from '../src/db/schema'
import { assertFrozenTaskTriggerPreflight } from '../src/modules/task-execution/infrastructure/frozenTaskTriggerPreflight'
import { ValidationError } from '../src/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_278_400_000

/** 带一个 `{{trigger.webhook.comment_text}}` 依赖的定义——预检必须为它找到 trigger 源。 */
const NEEDS_TRIGGER = {
  $schema_version: 5,
  inputs: [],
  nodes: [
    {
      id: 'agent',
      kind: 'agent-single',
      agentName: 'fixture',
      promptTemplate: 'Review {{trigger.webhook.comment_text}}',
    },
  ],
  edges: [],
} as const

/** 同形状但不引用任何 trigger 变量——无论有没有 trigger 上下文都该通过。 */
const NEEDS_NOTHING = {
  $schema_version: 5,
  inputs: [],
  nodes: [{ id: 'agent', kind: 'agent-single', agentName: 'fixture', promptTemplate: 'Review.' }],
  edges: [],
} as const

const VALID_CONTEXT = JSON.stringify({
  trigger: { webhook: { event_type: 'note', comment_text: 'ship it' } },
})

async function seedTask(
  db: ProviderNeutralDatabase,
  row: {
    readonly snapshot: string
    readonly triggerContextJson?: string | null
    readonly refClosureJson?: string | null
  },
): Promise<string> {
  const taskId = ulid()
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: `wf-${workflowId}`,
    description: '',
    definition: JSON.stringify(NEEDS_NOTHING),
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: `task-${taskId}`,
    workflowId,
    workflowSnapshot: row.snapshot,
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'failed',
    inputs: '{}',
    startedAt: NOW,
    ...(row.triggerContextJson === undefined ? {} : { triggerContextJson: row.triggerContextJson }),
    ...(row.refClosureJson === undefined ? {} : { refClosureJson: row.refClosureJson }),
  })
  return taskId
}

/** 抛出的 ValidationError 码；没抛就是 `null`。 */
async function codeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (error) {
    if (error instanceof ValidationError) return error.code
    throw error
  }
}

describeEachProvider('RFC-359 W8 —— 冻结任务溯源预检（一份实现，两个引擎）', (harness) => {
  test('任务行不存在 → 静默返回，不抛', async () => {
    expect(await codeOf(assertFrozenTaskTriggerPreflight(harness.db, ulid()))).toBeNull()
  })

  test('冻结的 trigger 上下文损坏 → 权威拒绝 trigger-context-invalid', async () => {
    const taskId = await seedTask(harness.db, {
      snapshot: JSON.stringify(NEEDS_NOTHING),
      triggerContextJson: 'not-json',
    })
    expect(await codeOf(assertFrozenTaskTriggerPreflight(harness.db, taskId))).toBe(
      'trigger-context-invalid',
    )
  })

  test('trigger 上下文损坏的判据先于快照——快照也坏时仍报 trigger-context-invalid', async () => {
    const taskId = await seedTask(harness.db, {
      snapshot: 'not-json-either',
      triggerContextJson: 'not-json',
    })
    expect(await codeOf(assertFrozenTaskTriggerPreflight(harness.db, taskId))).toBe(
      'trigger-context-invalid',
    )
  })

  test('工作流快照本身损坏 → 吞掉，保留历史恢复姿势（不是权威拒绝理由）', async () => {
    const taskId = await seedTask(harness.db, { snapshot: 'not-json' })
    expect(await codeOf(assertFrozenTaskTriggerPreflight(harness.db, taskId))).toBeNull()
  })

  test('合法快照 + 需要 trigger 变量 + 任务不是事件起的 → trigger-context-missing', async () => {
    const taskId = await seedTask(harness.db, { snapshot: JSON.stringify(NEEDS_TRIGGER) })
    expect(await codeOf(assertFrozenTaskTriggerPreflight(harness.db, taskId))).toBe(
      'trigger-context-missing',
    )
  })

  test('合法快照 + 需要 trigger 变量 + 冻结行带合法 webhook 上下文 → 通过', async () => {
    const taskId = await seedTask(harness.db, {
      snapshot: JSON.stringify(NEEDS_TRIGGER),
      triggerContextJson: VALID_CONTEXT,
    })
    expect(await codeOf(assertFrozenTaskTriggerPreflight(harness.db, taskId))).toBeNull()
  })

  test('候选快照换掉定义：durable 行干净、候选要 trigger 变量 → 按候选判，拒绝', async () => {
    const taskId = await seedTask(harness.db, { snapshot: JSON.stringify(NEEDS_NOTHING) })
    const code = await codeOf(
      assertFrozenTaskTriggerPreflight(harness.db, taskId, {
        workflowSnapshot: JSON.stringify(NEEDS_TRIGGER),
        refClosureJson: null,
      }),
    )
    expect(code).toBe('trigger-context-missing')
  })

  test('候选**不能**替换 trigger 源：源永远从 durable 行重读，于是候选照样通过', async () => {
    const taskId = await seedTask(harness.db, {
      snapshot: JSON.stringify(NEEDS_NOTHING),
      triggerContextJson: VALID_CONTEXT,
    })
    const code = await codeOf(
      assertFrozenTaskTriggerPreflight(harness.db, taskId, {
        workflowSnapshot: JSON.stringify(NEEDS_TRIGGER),
        refClosureJson: null,
      }),
    )
    expect(code).toBeNull()
  })

  test('durable 行的 trigger 上下文损坏时，候选也救不回来', async () => {
    const taskId = await seedTask(harness.db, {
      snapshot: JSON.stringify(NEEDS_NOTHING),
      triggerContextJson: 'not-json',
    })
    const code = await codeOf(
      assertFrozenTaskTriggerPreflight(harness.db, taskId, {
        workflowSnapshot: JSON.stringify(NEEDS_NOTHING),
        refClosureJson: null,
      }),
    )
    expect(code).toBe('trigger-context-invalid')
  })

  test('读点只花一次往返（两个引擎同一条语句预算）', async () => {
    const taskId = await seedTask(harness.db, { snapshot: JSON.stringify(NEEDS_NOTHING) })
    const recording = harness.recordStatements()
    try {
      await assertFrozenTaskTriggerPreflight(harness.db, taskId)
    } finally {
      recording.stop()
    }
    expect(recording.statements.length).toBe(1)
  })
})

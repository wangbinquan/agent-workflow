// RFC-359 W57 —— 「每任务至多一个 pending intent」的唯一索引冲突必须翻成**领域错误**。
//
// 为什么这条测试存在（2026-09-10 CI 实撞）
// ---------------------------------------
// 续跑准入是「先读活跃 intent、再插一行 pending」，整笔在 SERIALIZABLE 里。两个并发续跑都读到
// 「没有活跃 intent」时，输家的收场有**两种**，谁先冒是随机的
// （`rfc359-w8-t29-unique-insert-conflict` 的头注就写着这件事）：
//
//   · SSI 先判 —— 40001，`databaseSessionFor(db).serializable` 会重试；重放时读到赢家那行，
//     走 `task-continuation-conflict`。✓
//   · 部分唯一索引先抛 —— **23505**，既不是序列化失败（重试不接）、此前**也没有映射**，
//     于是驱动错误原样漏给调用方——用户看到 500，而不是 409 冲突。✗
//
// 第二条路少见但真实：CI run 上 ubuntu 分片 1/8 的那条 40 轮对拍就这样红过一次，
// 报的是 `Error:Failed query: insert into "agent_workflow"."task_execution_intents" …`。
//
// 判据分两层，两层都在**两个引擎**上各跑一遍：
//   ① 冲突目标的**真实写法**——由真驱动抛出的错误取回，钉住 PG 的约束名与 SQLite 的列清单
//      两种形状。这是最容易悄悄烂掉的一格：索引改名、驱动换版本都会让判据静默失配，
//      而失配的表现正是「偶发 500」，不会有任何测试变红。
//   ② 映射本身——同一个真错误经 `admitWithPendingIntentConflict` 之后必须是
//      `TaskExecutionError('task-continuation-conflict')`。
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { taskExecutionIntents, tasks, users, workflows } from '../src/db/schema'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
import { TaskExecutionError } from '../src/modules/task-execution/application/taskExecutionError'
import {
  admitWithPendingIntentConflict,
  isPendingIntentUniqueConflict,
} from '../src/modules/task-execution/infrastructure/taskContinuationAdmission'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_278_400_000
const TASK_ID = 'task-pending-intent'

async function seed(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: 'owner',
    username: 'owner',
    displayName: 'owner',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(workflows).values({
    id: 'wf',
    name: 'wf',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
  await db.insert(tasks).values({
    id: TASK_ID,
    name: TASK_ID,
    workflowId: 'wf',
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${TASK_ID}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW,
    ownerUserId: 'owner',
  })
}

/** 直插一行 pending intent；第二次调用必然撞上那条部分唯一索引。 */
async function insertPending(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(taskExecutionIntents).values({
    id: `intent_${ulid()}`,
    taskId: TASK_ID,
    kind: 'resume',
    state: 'pending',
    source: 'rest',
    requestHash: ulid(),
    payloadJson: '{}',
    executionLineageId: TASK_ID,
    continuationSlotKey: `${TASK_ID}:root`,
    slotPathJson: JSON.stringify([{ taskId: TASK_ID }]),
    expectedTaskRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describeEachProvider('RFC-359 W57 —— pending intent 唯一冲突的领域映射', (h) => {
  test('真驱动错误的冲突目标被判据认出来（两个引擎各自的写法）', async () => {
    await seed(h.db)
    await insertPending(h.db)
    let raised: unknown
    try {
      await insertPending(h.db)
    } catch (error) {
      raised = error
    }
    expect(raised, '第二行 pending intent 必须被那条部分唯一索引拒绝').toBeDefined()

    const engine = databaseSessionFor(h.db).engine
    expect(
      engine.classifyError(raised),
      '这条驱动错误必须被分类成唯一冲突——分不出来，下面的映射就无从谈起',
    ).toBe('unique-violation')
    const target = engine.uniqueViolationTarget(raised)
    expect(
      isPendingIntentUniqueConflict(target),
      '判据必须认得出本引擎报的冲突目标写法（PG 给约束名、SQLite 给列清单）。' +
        `实际收到：${String(target)}。它一旦失配，表现是**偶发 500**——没有任何别的测试会因此变红。`,
    ).toBe(true)
  })

  test('映射：同一个真错误出来是 task-continuation-conflict，不是驱动错误', async () => {
    await seed(h.db)
    await insertPending(h.db)
    const engine = databaseSessionFor(h.db).engine
    const mapped = await admitWithPendingIntentConflict(
      engine.uniqueViolationTarget,
      TASK_ID,
      async () => {
        await insertPending(h.db)
        return 'unreachable'
      },
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(mapped).toBeInstanceOf(TaskExecutionError)
    expect((mapped as TaskExecutionError).code).toBe('task-continuation-conflict')
  })

  test('不相干的唯一冲突原样抛出，不被误翻成续跑冲突', async () => {
    await seed(h.db)
    const engine = databaseSessionFor(h.db).engine
    const raised = await admitWithPendingIntentConflict(
      engine.uniqueViolationTarget,
      TASK_ID,
      async () => {
        // 同一个 users.id 再插一次：唯一冲突，但撞的是别的约束。
        await h.db.insert(users).values({
          id: 'owner',
          username: 'owner2',
          displayName: 'owner2',
          role: 'admin',
          createdAt: NOW,
          updatedAt: NOW,
        })
        return 'unreachable'
      },
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(raised).toBeDefined()
    expect(
      raised instanceof TaskExecutionError,
      '别的唯一冲突不得被翻成 task-continuation-conflict——那会把无关失败伪装成续跑冲突',
    ).toBe(false)
  })
})

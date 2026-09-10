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
// 第二条路少见但真实：CI run 上 ubuntu 分片的那条 40 轮对拍两次红在这里，报的都是
// `Error:Failed query: insert into "agent_workflow"."task_execution_intents" …`。
//
// 2026-09-10 第二次红之后的修正（这轮改了判据的形状）
// ---------------------------------------------------
// 初版映射按**约束名正则**判（`idx_task_execution_intents_pending_task` / SQLite 的列清单），
// 挂在整笔事务外面。它漏掉了第三档：两个引擎的 `uniqueViolationTarget` 都是三态回答——
// `undefined` = 不是唯一冲突；`''` = **是**唯一冲突但驱动没说是哪条；非空串 = 名字。
// `''` 被正则判成 false ⇒ 驱动错误照样漏成 500。本机 200 轮并发复现不出来，说明是窄路径。
//
// 判据因此改成「**这条 insert 上**的任何唯一冲突」，并从事务外挪到贴着那条 insert：
// 只有贴着语句才知道撞的必然是 intents 自己那条部分唯一索引（同事务还 UPDATE
// `taskExecutionLineageOperationRecords`，它也带唯一索引——那正是初版被迫认名字的原因）。
//
// 判据分三层，都在**两个引擎**上各跑一遍：
//   ① 冲突目标的**真实写法**——由真驱动抛出的错误取回，钉住 PG 的约束名与 SQLite 的列清单
//      两种形状。索引改名 / 驱动换版本会让它变化，而变化本身不该再影响映射（②），
//      所以这一条现在是**观测**而不是判据的前提。
//   ② 映射本身——真错误经 `pendingIntentInsertConflict` 出来必须是
//      `TaskExecutionError('task-continuation-conflict')`。
//   ③ **没有名字的那一档**（`''`）同样被映射；不是唯一冲突的错误原样抛。这两条正是这次修的洞。
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { taskExecutionIntents, tasks, users, workflows } from '../src/db/schema'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
import { TaskExecutionError } from '../src/modules/task-execution/application/taskExecutionError'
import { pendingIntentInsertConflict } from '../src/modules/task-execution/infrastructure/taskContinuationAdmission'
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
    // 观测（不是判据的前提）：两个引擎都能报出一个**非 undefined** 的冲突目标。
    // 映射只看「是不是 undefined」，所以这里即使将来变成 `''` 也不影响 ② 的结论。
    const target = engine.uniqueViolationTarget(raised)
    expect(
      target,
      '本引擎必须把这条错误认成唯一冲突（undefined 表示「不是唯一冲突」，那样映射无从谈起）',
    ).not.toBeUndefined()
  })

  test('映射：同一个真错误出来是 task-continuation-conflict，不是驱动错误', async () => {
    await seed(h.db)
    await insertPending(h.db)
    const engine = databaseSessionFor(h.db).engine
    let raised: unknown
    try {
      await insertPending(h.db)
    } catch (error) {
      raised = error
    }
    const mapped = ((): unknown => {
      try {
        pendingIntentInsertConflict(engine.uniqueViolationTarget, TASK_ID, raised)
      } catch (error) {
        return error
      }
    })()
    expect(mapped).toBeInstanceOf(TaskExecutionError)
    expect((mapped as TaskExecutionError).code).toBe('task-continuation-conflict')
  })

  test("没有名字的那一档（`''`）同样被映射——这次红的就是它", () => {
    // 驱动报了 23505 / UNIQUE 但**没说是哪条**约束时，能力矩阵返回空串。初版按约束名正则判，
    // 于是这一档被当成「不是冲突」，驱动错误原样漏成 500。判据现在只看「是不是 undefined」。
    const mapped = ((): unknown => {
      try {
        pendingIntentInsertConflict(() => '', TASK_ID, new Error('unique violation, unnamed'))
      } catch (error) {
        return error
      }
    })()
    expect(mapped).toBeInstanceOf(TaskExecutionError)
    expect((mapped as TaskExecutionError).code).toBe('task-continuation-conflict')
  })

  test('不是唯一冲突的错误原样抛出，不被伪装成续跑冲突', () => {
    const original = new Error('connection reset')
    const mapped = ((): unknown => {
      try {
        pendingIntentInsertConflict(() => undefined, TASK_ID, original)
      } catch (error) {
        return error
      }
    })()
    expect(mapped).toBe(original)
  })

  test('作用域：映射只包住那条 insert，同事务的其余写不在里面', () => {
    // 判据放宽成「任何唯一冲突」的**唯一**安全依据就是作用域。同事务还 UPDATE
    // `taskExecutionLineageOperationRecords`（它自己带两条唯一索引）；那条 UPDATE 一旦落进
    // 同一个 try，一处无关的唯一冲突就会被伪装成「续跑冲突」——用户看到 409，真 bug 被藏起来。
    const source = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src/modules/task-execution/infrastructure/taskContinuationAdmission.ts',
      ),
      'utf8',
    )
    const guarded = source.slice(
      source.indexOf('  try {'),
      source.indexOf('pendingIntentInsertConflict(engineOf(tx)'),
    )
    expect(guarded).toContain('.insert(taskExecutionIntents)')
    expect(guarded).not.toContain('.update(')
    expect(guarded).not.toContain('taskExecutionLineageOperationRecords')
  })
})

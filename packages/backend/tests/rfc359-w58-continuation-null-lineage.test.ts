// RFC-359 W58 —— continuation 准入的 lineage 判据：派生与复核必须是同一个函数。
//
// 为什么这条测试存在（红 → 绿的那个 bug）：`tasks.execution_lineage_id` /
// `lineage_slot_path_json` 两列允许为 NULL。派生请求的一侧
// （`submitTaskContinuation`）遇到 NULL 会**以任务自身为根派生**一份作用域；而准入那一侧
// （`submitCanonicalTaskExecutionIntent`）的 lineage 判据直接拿派生后的请求去比**原始列**：
//
//     request.scope.executionLineageId !== task.executionLineageId   // 'task-x' !== null
//
// 于是任何 lineage 列为空的任务，它的每一次 continuation —— sync-workflow / resume / retry ——
// 在准入这一步必然 409 `task-continuation-stale`，没有任何推进办法。这条路径只在 PostgreSQL
// 上跑（SQLite 的 route operations 不走 intent 准入），所以它属于「一个库好、另一个库不好」
// 的那类分叉：`rfc109-sync-route` 迁成双引擎的当天就撞上了。
//
// 判据现在只有一个来源：`canonicalTaskLineageScope`，两侧都从它取。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { tasks, taskExecutionIntents, workflows } from '@/db/schema'
import {
  canonicalTaskLineageScope,
  decodeLineageSlotPath,
  encodeLineageSlotPath,
} from '@/modules/task-execution/domain/executionIntent'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import type { ProviderNeutralDatabase } from '@/db/query'
import { eq } from 'drizzle-orm'

import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = JSON.stringify({ $schema_version: 2, nodes: [], edges: [] })

describe('RFC-359 W58 —— lineage 作用域的派生（纯函数）', () => {
  test('两列皆空 ⇒ 以任务自身为根：lineage id 是任务 id，slot path 是单段 task-root', () => {
    const scope = canonicalTaskLineageScope('task-x', {
      executionLineageId: null,
      lineageSlotPathJson: null,
    })
    expect(scope.executionLineageId).toBe('task-x')
    expect(scope.slotPath).toEqual([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: 'task-x', workflowRevision: null },
    ])
  })

  test('列有值 ⇒ 原样取用（slot path 走解码，键序归一化由 encode 负责）', () => {
    const stored = encodeLineageSlotPath([
      { stableNodeKey: 'n1', frozenOccurrenceKey: 'occ-1', workflowRevision: 7 },
    ])
    const scope = canonicalTaskLineageScope('task-x', {
      executionLineageId: 'lineage-9',
      lineageSlotPathJson: stored,
    })
    expect(scope.executionLineageId).toBe('lineage-9')
    expect(encodeLineageSlotPath(scope.slotPath)).toBe(stored)
    expect(scope.slotPath).toEqual(decodeLineageSlotPath(stored))
  })

  test('lineage id 为空但 slot path 有值 ⇒ 只回退 id，路径照解码（两列各自独立）', () => {
    const stored = encodeLineageSlotPath([
      { stableNodeKey: 'n1', frozenOccurrenceKey: 'occ-1', workflowRevision: null },
    ])
    const scope = canonicalTaskLineageScope('task-x', {
      executionLineageId: null,
      lineageSlotPathJson: stored,
    })
    expect(scope.executionLineageId).toBe('task-x')
    expect(encodeLineageSlotPath(scope.slotPath)).toBe(stored)
  })
})

describe('RFC-359 W58 —— 准入与派生共用同一个函数（源代码层兜底）', () => {
  const source = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src/modules/task-execution/infrastructure/taskContinuationAdmission.ts',
    ),
    'utf8',
  )

  test('lineage 复核不得再拿请求去比原始列（那正是 NULL 两侧解释分叉的形态）', () => {
    expect(
      source,
      'continuation 准入又直接比 `task.executionLineageId` 了：lineage 列为空的任务会被这一比' +
        '判成 stale，全部 continuation 死锁。复核与派生都要走 `canonicalTaskLineageScope`。',
    ).not.toMatch(/request\.scope\.executionLineageId\s*!==\s*task\.executionLineageId/)
  })

  test('两个调用点都取自 canonicalTaskLineageScope', () => {
    expect((source.match(/canonicalTaskLineageScope\(/g) ?? []).length).toBe(2)
  })
})

async function seedTaskWithoutLineage(db: ProviderNeutralDatabase): Promise<string> {
  const id = `t_${ulid()}`
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/repo',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'failed',
    inputs: '{}',
    startedAt: 1,
    executionLineageId: null,
    lineageSlotPathJson: null,
  })
  // 插入时给 null **还不够**：SQLite 上迁移 0210 的 `rfc328_tasks_lineage_after_insert`
  // 会把这两列补齐，而 PostgreSQL 的 DDL 由 `db/schema.ts` 投影而来、一行触发器都没有
  //（同一条推理见迁移 0224 对 `node_runs` 同名触发器的退役说明）。于是同一条 INSERT
  // 在两个引擎上落出的行不同：SQLite 有值、PostgreSQL 是 null。这里显式 UPDATE 回 null
  //（触发器只挂 AFTER INSERT），让两个引擎都真的处在「lineage 列为空」这个被测状态。
  await db
    .update(tasks)
    .set({ executionLineageId: null, lineageSlotPathJson: null })
    .where(eq(tasks.id, id))
  return id
}

describeEachProvider('RFC-359 W58 —— lineage 列为空的任务仍可被 continuation 准入', (harness) => {
  test('submitContinuation 落一行 pending intent，而不是 task-continuation-stale', async () => {
    const db = harness.db
    const taskId = await seedTaskWithoutLineage(db)
    const intents = new DrizzleTaskExecutionIntentPersistence(db)

    const submitted = await intents.submitContinuation({
      taskId,
      intentId: `intent_${ulid()}`,
      kind: 'sync-workflow',
      source: 'rest',
      actorUserId: null,
      payload: {},
      now: Date.now(),
      advanceOperationGeneration: false,
    })
    expect(submitted.state).toBe('pending')

    const [row] = await db
      .select({
        executionLineageId: taskExecutionIntents.executionLineageId,
        slotPathJson: taskExecutionIntents.slotPathJson,
      })
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.id, submitted.intentId))
    // 落下去的作用域就是派生出来的那份：任务自身作根。
    expect(row?.executionLineageId).toBe(taskId)
    expect(decodeLineageSlotPath(row?.slotPathJson ?? '[]')).toEqual([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ])
  })
})

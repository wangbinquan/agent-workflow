// RFC-120 — route test for /api/tasks/:id/questions (list + confirm / reassign /
// stage). The daemon TOKEN actor is the '__system__' user; seeding the task with
// ownerUserId='__system__' makes it the owner so the member/visibility gates pass
// (member-vs-non-member ACL itself is covered by the RFC-099 taskCollab tests).
// Locks: list shape, write happy paths, cross-task entry → 404, missing task →
// 404, missing targetNodeId → 422.

import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  clarifyRounds,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { listTaskQuestions } from '../src/services/taskQuestions'
import type { ProviderNeutralDatabase } from '../src/db/query'
import type { ProviderHarness } from './helpers/eachProvider'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const TOKEN = 'a'.repeat(64)
const AUTH = { Authorization: `Bearer ${TOKEN}` }

const SNAPSHOT = JSON.stringify({
  $schema_version: 3,
  inputs: [],
  nodes: [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' },
    { id: 'fixer', kind: 'agent-single', agentName: 'fixer' },
    { id: 'auditor', kind: 'agent-single', agentName: 'auditor' },
    { id: 'coder', kind: 'agent-single', agentName: 'coder' },
  ],
  edges: [],
  outputs: [],
})

async function seedTask(
  db: ProviderNeutralDatabase,
  taskId: string,
  lineage?: typeof providerTaskLineage,
) {
  await db.insert(workflows).values({
    id: `wf-${taskId}`,
    name: 'wf',
    definition: '{}',
    description: '',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    ownerUserId: '__system__',
    workflowId: `wf-${taskId}`,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/r',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'b',
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),

    ...(lineage?.(taskId) ?? {}),
  })
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  id: string,
  nodeId: string,
  cause?: string,
) {
  await db
    .insert(nodeRuns)
    .values({ id, taskId, nodeId, status: 'done', rerunCause: cause ?? null, iteration: 0 })
  if (cause)
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'result', content: 'x' })
}

async function seedSelfAnswered(db: ProviderNeutralDatabase, taskId: string) {
  await seedRun(db, taskId, `${taskId}-ask`, 'designer')
  await seedRun(db, taskId, `${taskId}-int`, 'clar')
  await seedRun(db, taskId, `${taskId}-h`, 'designer', 'clarify-answer')
  await db.insert(clarifyRounds).values({
    id: `${taskId}-r`,
    taskId,
    kind: 'self',
    askingNodeId: 'designer',
    askingNodeRunId: `${taskId}-ask`,
    intermediaryNodeId: 'clar',
    intermediaryNodeRunId: `${taskId}-int`,
    questionsJson: JSON.stringify([
      {
        id: 'q1',
        title: 't',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'A', description: '', recommended: false, recommendationReason: '' },
          { label: 'B', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ]),
    status: 'answered',
  })
  // RFC-132: dispatch+bind 取代 consumption-stamp seed(相位读 entry 自身 dispatch 状态)。
  const [pre] = await listTaskQuestions(db, taskId)
  await db
    .update(taskQuestions)
    .set({ dispatchedAt: Date.now(), triggerRunId: `${taskId}-h` })
    .where(eq(taskQuestions.id, pre!.id))
}

describe('RFC-120 /api/tasks/:id/questions routes', () => {
  registerProviderApplication((harness, makeApp, seedTask) => {
    test('GET list returns entries; confirm flips to done', async () => {
      const db = harness.db
      const app = await makeApp(db)
      await seedTask(db, 'task-a')
      await seedSelfAnswered(db, 'task-a')

      const listRes = await app.request('/api/tasks/task-a/questions', { headers: AUTH })
      expect(listRes.status).toBe(200)
      const list = (await listRes.json()) as Array<{ id: string; phase: string }>
      expect(list).toHaveLength(1)
      expect(list[0]!.phase).toBe('awaiting_confirm')

      const confirmRes = await app.request(`/api/tasks/task-a/questions/${list[0]!.id}/confirm`, {
        method: 'POST',
        headers: AUTH,
      })
      expect(confirmRes.status).toBe(200)
      const after = (await (
        await app.request('/api/tasks/task-a/questions', { headers: AUTH })
      ).json()) as Array<{ phase: string }>
      expect(after[0]!.phase).toBe('done')
    })
  })

  // RFC-162: a cross round reconciles to ONE questioner entry (designer-by-default deleted).
  // Reassigning the asker UPSTREAM ADDS a `designer` handler row (route returns action
  // 'added-designer'); reassigning it again re-targets that handler. The 422 (missing targetNodeId)
  // is checked before the service runs, so it fires on any entry.
  registerProviderApplication((harness, makeApp, seedTask) => {
    test('reassign requires targetNodeId (422); reassign-to-upstream adds + re-targets a designer handler', async () => {
      const db = harness.db
      const app = await makeApp(db)
      await seedTask(db, 'task-b')
      await seedRun(db, 'task-b', 'task-b-ask', 'auditor')
      await seedRun(db, 'task-b', 'task-b-int', 'clar')
      await db.insert(clarifyRounds).values({
        id: 'task-b-r',
        taskId: 'task-b',
        kind: 'cross',
        askingNodeId: 'auditor',
        askingNodeRunId: 'task-b-ask',
        targetConsumerNodeId: 'coder',
        intermediaryNodeId: 'clar',
        intermediaryNodeRunId: 'task-b-int',
        questionsJson: JSON.stringify([
          {
            id: 'q1',
            title: 't',
            kind: 'single',
            recommended: false,
            options: [
              { label: 'A', description: '', recommended: false, recommendationReason: '' },
              { label: 'B', description: '', recommended: false, recommendationReason: '' },
            ],
          },
        ]),
        status: 'answered',
      })
      const list = (await (
        await app.request('/api/tasks/task-b/questions', { headers: AUTH })
      ).json()) as Array<{ id: string; roleKind: string }>
      const questioner = list.find((e) => e.roleKind === 'questioner')!

      const bad = await app.request(`/api/tasks/task-b/questions/${questioner.id}/reassign`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(bad.status).toBe(422)

      // reassign the asker UPSTREAM to 'coder' → ADDS a designer handler; the route returns the action.
      const ok = await app.request(`/api/tasks/task-b/questions/${questioner.id}/reassign`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ targetNodeId: 'coder' }),
      })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { action: string }).action).toBe('added-designer')
      const after = (await (
        await app.request('/api/tasks/task-b/questions', { headers: AUTH })
      ).json()) as Array<{ roleKind: string; effectiveTargetNodeId: string }>
      expect(after.find((e) => e.roleKind === 'designer')!.effectiveTargetNodeId).toBe('coder')

      // reassign the asker again → re-targets the SAME (undispatched) designer handler to 'fixer'.
      const move = await app.request(`/api/tasks/task-b/questions/${questioner.id}/reassign`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ targetNodeId: 'fixer' }),
      })
      expect(move.status).toBe(200)
      const moved = (await (
        await app.request('/api/tasks/task-b/questions', { headers: AUTH })
      ).json()) as Array<{ roleKind: string; effectiveTargetNodeId: string }>
      expect(moved.filter((e) => e.roleKind === 'designer')).toHaveLength(1)
      expect(moved.find((e) => e.roleKind === 'designer')!.effectiveTargetNodeId).toBe('fixer')
    })

    // RFC-359 AC-6：本文件最后一处单引擎残留。它原来自建 `createInMemoryDb` + 模块级的
    // **同步** `makeApp`，紧挨着已迁的那一批——同名 `makeApp`（模块级同步 / 注入的异步）
    // 让它看起来像已经在作用域里了。现在改吃注入的那三个。
    test('stage toggles; cross-task entry → 404; missing task → 404', async () => {
      const db = harness.db
      const app = await makeApp(db)
      await seedTask(db, 'task-c')
      await seedSelfAnswered(db, 'task-c')
      await seedTask(db, 'task-d')

      const list = (await (
        await app.request('/api/tasks/task-c/questions', { headers: AUTH })
      ).json()) as Array<{ id: string }>
      const entryId = list[0]!.id

      // RFC-134 D10（Codex R2-F4/R3-F7）：fixture 条目已 dispatched —— stage 一个已下发行
      // 现在被服务端原子 CAS 拒（409），不再留下脏 staged 戳（此前这里的 200 正是被堵上的缺口）。
      const stagedDispatched = await app.request(`/api/tasks/task-c/questions/${entryId}/stage`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ staged: true }),
      })
      expect(stagedDispatched.status).toBe(409)
      // 未下发行照常可 stage（正路径接线保留）：解除 fixture 的 dispatch 戳后再 stage。
      await db
        .update(taskQuestions)
        .set({ dispatchedAt: null, dispatchedBy: null, triggerRunId: null })
        .where(eq(taskQuestions.id, entryId))
      const stageRes = await app.request(`/api/tasks/task-c/questions/${entryId}/stage`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ staged: true }),
      })
      expect(stageRes.status).toBe(200)

      // entry belongs to task-c, not task-d → 404
      const crossTask = await app.request(`/api/tasks/task-d/questions/${entryId}/confirm`, {
        method: 'POST',
        headers: AUTH,
      })
      expect(crossTask.status).toBe(404)

      const missingTask = await app.request('/api/tasks/nope/questions', { headers: AUTH })
      expect(missingTask.status).toBe(404)
    })
  })
})

// RFC-359 W50: keep native registrations while the selected calls use the complete provider application.
// RFC-359 AC-6：生命周期走共用的 `describeEachProviderHttpApplication`（`tests/helpers/`）。
// 合并前这一份把 `config.json` 放在**另一个**临时目录里；共用作用域统一放进本次的 app home——
// 两者都是用完即删的临时目录，本文件没有任何判据读它，形态差别对用例不可见。
function registerProviderApplication(
  register: (
    harness: ProviderHarness,
    makeApp: (db: ProviderNeutralDatabase) => Promise<Hono>,
    seedTaskFixture: typeof seedTask,
  ) => void,
): void {
  describeEachProviderHttpApplication(
    'provider',
    { token: TOKEN, opencodeVersion: '1.14.25', dbVersion: 1, tempPrefix: 'aw-tq-home-' },
    (scope) =>
      register(
        scope.harness,
        async (db) => {
          if (db !== scope.harness.db) throw new Error('provider fixture database mismatch')
          return (await scope.open()).app
        },
        (db, taskId) => seedTask(db, taskId, providerTaskLineage),
      ),
  )
}

function providerTaskLineage(id: string) {
  return {
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
  }
}

import { epoch2ReviewReader } from './helpers/epoch2RuntimePorts'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
// RFC-319 TASK-27 / DE-28 —— 两条被 RFC-359 AC-1 合一顺手丢掉的装配步骤。
//
// 两条都只有 `@nightly` 的 e2e 覆盖，推送档看不见，所以红了几天没人认领；这里把它们锁进推送档。
//
// ① TASK-27：「重试准备」从界面上永远重试不了。
//    重试仓库准备要提交一条 `retry-repository-preparation` 续跑，而 `taskContinuationAdmission`
//    对「血缘上留着 `requires-actor` 重放决定」的任务只接受**演员命令**（`mayAuthorizeReplay`：
//    `source ∈ {rest, mcp}` + 带 actorUserId + kind 在 `ACTOR_REPLAY_COMMANDS` 里）。
//    而两个组合根把发起人写死成 `SYSTEM_USER_ID`，`continuationSource` 于是返回 `'auto'`——
//    用户点「重试准备」拿到的是
//    `task-execution-outcome-unknown: … use a manual resume/retry/sync command`，
//    而他用的**就是**那条手动命令。本机复现：卡在仓库准备的任务点一百次也不会铸出第二条准备行。
//
// ② DE-28：数字员工的人工评审页只剩一句「Review not found.」。
//    `DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID` 是合成 id，只有那行 builtin 锚存在，执行任务的
//    `workflow_id` 才指得到东西。合一（`c932bc8e8`）把 `ensureDigitalEmployeeHostWorkflow`
//    整个删掉了（合一前在 `digitalEmployeeExecution.ts:512`），于是执行任务落在一个**不存在的
//    工作流**上；`getReviewDetail` 拿 `task.workflowId` 查 workflows 查不到就抛
//    `review-not-found`——案例一直等着人工评审，评审人点进去打不开。

// RFC-395 II-a A2 update (the original rationale above is retained as history):
// ② DE-28：历史上缺宿主行会让评审 404。RFC-395 II-a A2 保留这个反例，
//    改由 taskSubjectProjection 保证列表、角标与详情不依赖 catalog 锚行。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  listReviewSummaries,
  countPendingReviews,
  getReviewDetail,
} from '@/modules/collaboration/infrastructure/review'
import { TASK_DEFINITION_HOSTS } from '@/modules/task-execution/public/queries'
import { taskFixture, nodeRunFixture, readWorkflowFixtures } from './helpers/model'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { composeDatabaseDigitalEmployeeExecutionPorts } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import {
  ACTOR_REPLAY_COMMANDS,
  mayAuthorizeReplay,
} from '@/modules/task-execution/domain/executionIntent'
import { SYSTEM_USER_ID } from '@/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
// RFC-387 moves the retry command into the neutral session implementation.
const RETRY_WIRING_ROOTS = [
  'packages/backend/src/modules/task-execution/infrastructure/repositoryPreparationRetryCommand.ts',
] as const

describe('RFC-319 TASK-27 —— 演员发起的仓库准备重试必须带着发起人', () => {
  test('前提：这条 kind 本来就在演员重放命令集里，只差 source / actor', () => {
    expect([...ACTOR_REPLAY_COMMANDS]).toContain('retry-repository-preparation')
    // 写死 SYSTEM_USER_ID 的那条路（continuationSource → 'auto'）授权不了重放。
    expect(
      mayAuthorizeReplay({
        kind: 'retry-repository-preparation',
        source: 'auto',
        actorUserId: SYSTEM_USER_ID,
      }),
    ).toBe(false)
    // 带真实发起人走 rest 才授权得了。
    expect(
      mayAuthorizeReplay({
        kind: 'retry-repository-preparation',
        source: 'rest',
        actorUserId: 'u-real-actor',
      }),
    ).toBe(true)
  })

  test('两个组合根共用的适配器把 authorization.actorUserId 原样传下去（写死 SYSTEM 就红）', () => {
    for (const path of ['bootstrap/daemonStart.ts']) {
      const root = /(?:^|\/)bootstrap\/daemonStart\.ts$/.test(path)
        ? readDaemonGraphSource()
        : readFileSync(resolve(ROOT, 'packages/backend/src', path), 'utf8')
      expect(root).toContain('composeDaemonTaskExecutionModules({')
      expect(root).toContain('DAEMON_TASK_EXECUTION_ADAPTERS.sqlite({')
      expect(root).not.toContain('async retry(taskId: string')
    }
    for (const relative of RETRY_WIRING_ROOTS) {
      const source = readFileSync(resolve(ROOT, relative), 'utf-8')
      // 端口签名收下授权。
      expect(`${relative}: retry signature`).toBe(
        source.includes('authorization?: RepositoryPreparationRetryAuthorization')
          ? `${relative}: retry signature`
          : `${relative}: MISSING retry authorization parameter`,
      )
      // The same rest/actor branch is retained; boot recovery still uses auto with no actor.
      expect(`${relative}: forwards actor`).toBe(
        source.includes("{ source: 'rest' as const, actorUserId: authorization.actorUserId }") &&
          source.includes("{ source: 'auto' as const, actorUserId: null }")
          ? `${relative}: forwards actor`
          : `${relative}: MISSING actor forwarding`,
      )
    }
  })

  test('路由把请求的 actor 交进去（不交就等于把发起人丢在门口）', () => {
    const route = readFileSync(
      resolve(
        ROOT,
        'packages/backend/src/modules/task-execution/infrastructure/taskRouteOperations.ts',
      ),
      'utf-8',
    )
    expect(route).toContain('repositoryPreparationRetry.retry(input.taskId, {')
    expect(route).toContain('actorUserId: input.actor.user.id,')
  })
})

describeEachProvider('RFC-319 DE-28 / RFC-395 II-a A2 — hostless employee reviews', (harness) => {
  test('list, badge and detail remain reachable with no builtin anchor row', async () => {
    const db = harness.db
    const host = TASK_DEFINITION_HOSTS['digital-employee']
    const taskId = 'employee-review',
      runId = 'employee-review-run'
    const ports = composeDatabaseDigitalEmployeeExecutionPorts(
      db,
      epoch2RuntimeTestPorts(db).historyRestrictions,
    )
    expect(ports).not.toHaveProperty('hostWorkflow')
    await taskFixture(db, {
      id: taskId,
      name: taskId,
      workflowId: host.id,
      workflowSnapshot: '{"nodes":[],"edges":[]}',
      repoPath: '/tmp/r',
      worktreePath: '/tmp/r',
      baseBranch: 'main',
      branch: taskId,
      inputs: '{}',
      startedAt: 1,
      status: 'awaiting_review',
    })
    await nodeRunFixture(db, { id: runId, taskId, nodeId: 'review', status: 'awaiting_review' })
    const { docVersions } = tablesOf(db)
    await insertOne(db, docVersions, {
      id: 'employee-document',
      taskId,
      reviewNodeId: 'review',
      reviewNodeRunId: runId,
      sourceNodeId: 'source',
      sourcePortName: 'doc',
      versionIndex: 1,
      reviewIteration: 0,
      ...contentRowColumns(legacyContentRef('review-body-path', 'local-file', 'missing.md')),
      decision: 'pending',
    })
    expect(await listReviewSummaries(db, { status: 'pending' })).toMatchObject([
      { workflowId: host.id, workflowName: host.name },
    ])
    expect(await countPendingReviews(db)).toBe(1)
    expect(
      await getReviewDetail(
        db,
        '/tmp/aw-no-artifacts',
        runId,
        epoch2ReviewReader(db, '/tmp/aw-no-artifacts'),
      ),
    ).toMatchObject({
      summary: { workflowId: host.id, workflowName: host.name },
    })
    expect(await readWorkflowFixtures(db, { id: host.id })).toEqual([])
  })
})

describe('RFC-319 DE-28 —— 主体投影替代播种，中立应用图与 SQLite 测试根共用', () => {
  test('执行合一的那份实现传入数字员工主体，禁止恢复播种', () => {
    const composer = readFileSync(
      resolve(
        ROOT,
        'packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts',
      ),
      'utf-8',
    )
    expect(composer).not.toContain('hostWorkflow')
    expect(composer).toContain("subject: { kind: 'digital-employee', sourceId: null }")
    const review = readFileSync(
      resolve(ROOT, 'packages/backend/src/modules/collaboration/infrastructure/review.ts'),
      'utf-8',
    )
    expect(review).toContain('taskSubjectProjection(')
    expect(review).not.toContain('.from(workflows)')
    expect(review).not.toContain('.innerJoin(workflows')
  })

  test('中立应用图为 HTTP 与守护进程绑定同一个端口', () => {
    // RFC-383: all three roots select the employee bundle; RFC-395 keeps its subject-owned launch wiring.
    for (const relative of ['packages/backend/src/bootstrap/daemonApplication.ts']) {
      const source = readFileSync(resolve(ROOT, relative), 'utf-8')
      expect(source).toContain('composeDaemonDigitalEmployeeModules({')
      expect(source).not.toContain('composeDatabaseDigitalEmployeeExecutionPorts(')
    }
    const bundle = readFileSync(
      resolve(ROOT, 'packages/backend/src/bootstrap/daemonModules/digitalEmployee.ts'),
      'utf-8',
    )
    expect(bundle).toContain('composeReactionExecutionProvider({')
    expect(bundle).not.toContain('hostWorkflow:')
    // 共享执行工厂确实经启动内核提交数字员工主体，不再播种宿主目录行。
    const composer = readFileSync(
      resolve(
        ROOT,
        'packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts',
      ),
      'utf-8',
    )
    expect(composer).not.toContain('hostWorkflow:')
    expect(composer).toContain('const launched = await deps.launch.launch({')
    expect(composer).toContain('      subject,')
    expect(composer).toContain('return { executionRef: launched.id }')
  })
})

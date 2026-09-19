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

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { workflows } from '@/db/schema'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_NAME,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import { composeDatabaseDigitalEmployeeExecutionPorts } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import {
  ACTOR_REPLAY_COMMANDS,
  mayAuthorizeReplay,
} from '@/modules/task-execution/domain/executionIntent'
import { SYSTEM_USER_ID } from '@/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const RETRY_WIRING_ROOTS = [
  'packages/backend/src/server.ts',
  'packages/backend/src/cli/start.ts',
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

  test('两个组合根都把 authorization.actorUserId 原样传下去（写死 SYSTEM 就红）', () => {
    for (const relative of RETRY_WIRING_ROOTS) {
      const source = readFileSync(resolve(ROOT, relative), 'utf-8')
      // 端口签名收下授权。
      expect(`${relative}: retry signature`).toBe(
        source.includes('authorization?: { readonly actorUserId: string }')
          ? `${relative}: retry signature`
          : `${relative}: MISSING retry authorization parameter`,
      )
      // 并且真的用它——缺席时才回落 SYSTEM（boot 自动恢复那条路）。
      expect(`${relative}: forwards actor`).toBe(
        source.includes('authorization?.actorUserId ?? SYSTEM_USER_ID')
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

describeEachProvider('RFC-319 DE-28 —— 数字员工宿主工作流的锚行', (harness) => {
  test('库内缺省端口里的 hostWorkflow.ensure() 真的把 builtin 锚行写进去，且幂等', async () => {
    const db = harness.db
    const before = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID))
    expect(before.length).toBe(0)

    const ports = composeDatabaseDigitalEmployeeExecutionPorts(db)
    await ports.hostWorkflow.ensure()
    const seeded = await db
      .select({ id: workflows.id, name: workflows.name, builtin: workflows.builtin })
      .from(workflows)
      .where(eq(workflows.id, DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID))
    expect(seeded).toEqual([
      {
        id: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
        name: DIGITAL_EMPLOYEE_HOST_WORKFLOW_NAME,
        builtin: true,
      },
    ])

    // 幂等：执行链上每一轮都会调它。
    await ports.hostWorkflow.ensure()
    const again = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID))
    expect(again.length).toBe(1)
  })
})

describe('RFC-319 DE-28 —— 启动前必须播种，三个组合根一个都不许漏', () => {
  test('执行合一的那份实现在 launch 之前调 hostWorkflow.ensure()', () => {
    const composer = readFileSync(
      resolve(
        ROOT,
        'packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts',
      ),
      'utf-8',
    )
    const ensureAt = composer.indexOf('await deps.hostWorkflow.ensure()')
    const launchAt = composer.indexOf('await deps.launch.launch({')
    expect(ensureAt).toBeGreaterThan(0)
    expect(launchAt).toBeGreaterThan(0)
    // 次序是承重的：launch 那一笔就要写 task 行。
    expect(ensureAt).toBeLessThan(launchAt)
  })

  test('三个组合根都绑上了这个端口（漏一个 = 那条路的评审页打不开）', () => {
    // SQLite 的两个根经共享的 `composeDatabaseDigitalEmployeeExecutionPorts` 拿到它。
    for (const relative of [
      'packages/backend/src/server.ts',
      'packages/backend/src/cli/start.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, relative), 'utf-8')
      expect(`${relative}: shared ports`).toBe(
        source.includes('composeDatabaseDigitalEmployeeExecutionPorts(')
          ? `${relative}: shared ports`
          : `${relative}: MISSING shared digital-employee ports`,
      )
    }
    // PostgreSQL daemon 自己绑。
    const postgresql = readFileSync(
      resolve(ROOT, 'packages/backend/src/cli/postgresqlDaemonApplication.ts'),
      'utf-8',
    )
    expect(postgresql).toContain(
      'hostWorkflow: { ensure: () => ensureDigitalEmployeeHostWorkflow(input.db) }',
    )
    // 共享端口工厂确实绑到了那份幂等 upsert。
    const composer = readFileSync(
      resolve(
        ROOT,
        'packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts',
      ),
      'utf-8',
    )
    expect(composer).toContain(
      'hostWorkflow: { ensure: () => ensureDigitalEmployeeHostWorkflow(db) }',
    )
  })
})

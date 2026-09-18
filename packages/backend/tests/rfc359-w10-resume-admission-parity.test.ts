// RFC-359 AC-1（第 9 刀第 2 步）—— **`resume` 的准入面，两个引擎给同一个答案吗**。
//
// 为什么这条测试存在
// ------------------
// `resume` 这一对适配器是本 RFC 剩下最大的一组，而它**至今没有任何双引擎行为对拍**：
//   · `rfc359-w7` / `rfc359-w8` 两份对拍里 PG 侧的 `children.resume` 是**记录型空实现**
//     （见 w8 文件头的口径说明）——它们验的是「交棒有没有发生」，不是交棒之后那一段；
//   · SQLite 侧的 `resumeTask` 从来只在单引擎内存库上被验过。
// 于是两侧各自的准入门（状态、活跃度、子任务父行、冻结触发、工作区相位、来源栅栏）
// 有没有、错误码一不一样、事后任务落在哪个状态——**一个字都没人说过**。
//
// 这正是本轮反复记下的那类盲区：A/B 结构的对拍里，「一侧有、另一侧没有」的门
// 两个 section 都不在（A 段是共有行为，B 段是钉住的分叉），于是可以长期零覆盖。
// 第 6 / 7 / 8 / 9 刀各咬到一处以上。
//
// 判据形态（沿用第 9 刀 retry 那一份的配方）
// ----------------------------------------
// 每一格都走**生产装配**（`createEachProviderTaskExecution` 交出的
// `provider.routes.tasks.resume`），两条 lane 上跑的正是各自部署里真正会执行的那份实现；
// 断言的是 `(错误码, 事后任务状态)` 这一对——**同一个常量喂给两条 lane**。
// 任一侧不同 ⇒ 那条 lane 当场红，逼出一次显式的产品判断（而不是被一个 `if (provider) return`
// 悄悄盖过去）。合并之后这些常量一个字都不用改，它们本来就是「合并后应有的答案」。
//
// 工作树是**真的**（`git init` + 一次提交）：`rfc359-w9` 已经证明过，没有真工作树时
// 回滚那一段整体跑不到，对拍拿到的是假答案。
//
// 实测结论与变异实证
// ------------------
// 第 10 刀**之前**：九格里八格两侧逐字相同，唯一一格分叉（G，工作区回收中）是归因差异。
// 第 10 刀合并 `resume` **之后**：九格全部相等——G 那一格随合并销账（见该用例的注释）。
//
// 变异实证两次（一侧一条，落在不同的格上，证明它确实有预言力而不是「都没跑到所以都绿」）：
//   · 把 PG 的来源栅栏判据（`assertResumeAdmission` 里的 `task.sourceTerminationFence !== null`）
//     短路掉 ⇒ **只有 postgresql lane 的 H 红**，sqlite lane 全绿
//     ——顺带证明 SQLite 侧独立地有这道门、而且报同一个码。
//   · 把 SQLite 的 `resumeKick` 里那句 `await assertChildTaskDrivable(...)` 拿掉
//     ⇒ **只有 sqlite lane 的 C 红**，postgresql lane 全绿。
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, users, workflows } from '@/db/schema'
import { runGit } from '@/util/git'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'

const USER_ID = 'u_rfc359_w10'
const REPO_PREP_NODE_ID = '__repo_prep__'

const DEFINITION: WorkflowDefinition = {
  $schema_version: 2,
  inputs: [],
  nodes: [
    { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
  ],
  edges: [],
}

interface Fixture {
  readonly appHome: string
  readonly repoPath: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly cleanup: () => void
}

interface SeedOptions {
  readonly status?: string
  /** 空串 = 「没有工作树」；缺省是那棵真工作树。 */
  readonly worktreePath?: string
  readonly triggerContextJson?: string
  readonly sourceTerminationFence?: 'closed' | 'merged'
  readonly workspacePruningAt?: number
  readonly workspacePrunedAt?: number
  /** 铸一条 `__repo_prep__` 行（「准备还没跑完」的判据靠它）。 */
  readonly repoPrepRun?: boolean
  /** 让这个任务成为子任务，并给它一条处于该状态的父调用行。 */
  readonly parentCallRowStatus?: string
}

async function seedFixture(
  db: ProviderNeutralDatabase,
  options: SeedOptions = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc359-w10-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'w10@test.invalid'])
  await runGit(repoPath, ['config', 'user.name', 'w10'])
  writeFileSync(join(repoPath, 'README.md'), '# w10\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, USER_ID))
    .limit(1)
  if (existing.length === 0) {
    await db.insert(users).values({
      id: USER_ID,
      username: USER_ID,
      displayName: USER_ID,
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
  }
  const workflowId = ulid()
  await db
    .insert(workflows)
    .values({ id: workflowId, name: `w10-${workflowId}`, definition: JSON.stringify(DEFINITION) })

  // 子任务那格要先有一个父任务 + 一条父调用行。
  let parentTaskId: string | null = null
  let parentNodeRunId: string | null = null
  if (options.parentCallRowStatus !== undefined) {
    parentTaskId = ulid()
    await db.insert(tasks).values({
      id: parentTaskId,
      name: 'w10-parent',
      workflowId,
      workflowSnapshot: JSON.stringify(DEFINITION),
      repoPath,
      worktreePath: repoPath,
      baseBranch: 'main',
      branch: `agent-workflow/${parentTaskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now() - 2000,
      ownerUserId: USER_ID,
      executionLineageId: parentTaskId,
    })
    parentNodeRunId = ulid()
    await db.insert(nodeRuns).values({
      id: parentNodeRunId,
      taskId: parentTaskId,
      nodeId: 'call1',
      status: options.parentCallRowStatus as 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1800,
      finishedAt: Date.now() - 1700,
    })
  }

  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'w10',
    workflowId,
    workflowSnapshot: JSON.stringify(DEFINITION),
    repoPath,
    worktreePath: options.worktreePath ?? repoPath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: (options.status ?? 'failed') as 'failed',
    inputs: '{}',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 500,
    errorSummary: 'boom',
    ownerUserId: USER_ID,
    executionLineageId: taskId,
    ...(options.triggerContextJson === undefined
      ? {}
      : { triggerContextJson: options.triggerContextJson }),
    ...(options.sourceTerminationFence === undefined
      ? {}
      : { sourceTerminationFence: options.sourceTerminationFence }),
    ...(options.workspacePruningAt === undefined
      ? {}
      : { workspacePruningAt: options.workspacePruningAt }),
    ...(options.workspacePrunedAt === undefined
      ? {}
      : { workspacePrunedAt: options.workspacePrunedAt }),
    ...(parentTaskId === null ? {} : { parentTaskId, parentNodeRunId, invocationDepth: 1 }),
  })
  const nodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'doc',
    status: 'failed',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 900,
    finishedAt: Date.now() - 600,
    errorMessage: 'boom',
  })
  if (options.repoPrepRun === true) {
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: REPO_PREP_NODE_ID,
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 950,
      finishedAt: Date.now() - 940,
    })
  }
  return {
    appHome,
    repoPath,
    taskId,
    nodeRunId,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

/** 生产装配：两条 lane 各自跑自己部署里真正会执行的那份实现。 */
async function executionFor(
  harness: Parameters<Parameters<typeof describeEachProvider>[1]>[0],
  fixture: Fixture,
) {
  return await createEachProviderTaskExecution(
    harness,
    { appHome: fixture.appHome, defaultNodeRetries: 0 },
    USER_ID,
    {
      // SQLite 的路由壳在进 `resumeTask` **之前**就展开这个对象，缺省那个「一调用就炸」的桩
      // 会让 resume 在 SQLite lane 上根本驱动不起来（同 `rfc359-w9` 记的那条）。
      // 二进制指向 `/usr/bin/env true`：本文件只验准入面与落库形状，没有 agent 需要真跑。
      routeStartDepsFor: () => ({
        db: harness.db as unknown as DbClient,
        appHome: fixture.appHome,
        schedulerDriver: createTaskExecutionTestTopology({
          db: harness.db as unknown as DbClient,
          driver: 'real',
        }).schedulerDriver,
        taskRecoveryOperations: createTaskExecutionPersistence(harness.db).recoveryAdministration,
        binaryOverride: ['/usr/bin/env', 'true'],
      }),
    },
  )
}

function codeOf(error: unknown): string {
  const value =
    error !== null && typeof error === 'object' && 'code' in error
      ? Reflect.get(error, 'code')
      : null
  return typeof value === 'string' ? value : `no-code:${String(error)}`
}

/** 调一次 resume，返回 `(错误码, 事后任务状态)`——两条 lane 对拍的就是这一对。 */
async function resumeOutcome(
  harness: Parameters<Parameters<typeof describeEachProvider>[1]>[0],
  fixture: Fixture,
  taskId?: string,
): Promise<{ code: string; status: string }> {
  const execution = await executionFor(harness, fixture)
  const target = taskId ?? fixture.taskId
  let code = 'no-throw'
  try {
    await execution.provider.routes.tasks.resume({ actor: execution.actor, taskId: target })
  } catch (error) {
    code = codeOf(error)
  }
  const after = (await harness.db.select().from(tasks).where(eq(tasks.id, target)).limit(1))[0]
  return { code, status: after?.status ?? 'absent' }
}

describeEachProvider('RFC-359 W10 —— resume 的准入面对拍', (harness) => {
  let fixture: Fixture | undefined
  afterEach(() => {
    fixture?.cleanup()
    fixture = undefined
  })

  test('A 不存在的任务 → 404 task-not-found', async () => {
    fixture = await seedFixture(harness.db)
    const outcome = await resumeOutcome(harness, fixture, ulid())
    expect(outcome).toEqual({ code: 'task-not-found', status: 'absent' })
  })

  test('B 非可恢复状态（done）→ 拒，且任务原样不动', async () => {
    fixture = await seedFixture(harness.db, { status: 'done' })
    const outcome = await resumeOutcome(harness, fixture)
    expect(outcome).toEqual({ code: 'task-not-resumable', status: 'done' })
  })

  test('C 子任务的父调用行已收场 → 拒，且任务原样不动', async () => {
    fixture = await seedFixture(harness.db, { parentCallRowStatus: 'done' })
    const outcome = await resumeOutcome(harness, fixture)
    expect(outcome).toEqual({ code: 'call-row-finalized', status: 'failed' })
  })

  test('D 冻结的触发上下文损坏 → 拒，且任务原样不动', async () => {
    fixture = await seedFixture(harness.db, { triggerContextJson: 'not-json' })
    const outcome = await resumeOutcome(harness, fixture)
    expect(outcome).toEqual({ code: 'trigger-context-invalid', status: 'failed' })
  })

  test('E 工作树已经不在磁盘上 → 410，且任务原样不动', async () => {
    fixture = await seedFixture(harness.db)
    // macOS CI 上 `rmSync` 可能留下残骸（刚跑完的 git 子进程还攥着句柄），
    // 于是**前置条件**这一行随机红——本机总是绿。实撞一次（`afd4ac8e9` 的 macos shard 5/6）。
    // 判据不变（工作树必须真的不在磁盘上），只是删到确认为止。
    for (let attempt = 0; attempt < 50 && existsSync(fixture.repoPath); attempt++) {
      rmSync(fixture.repoPath, { recursive: true, force: true })
      if (existsSync(fixture.repoPath)) await Bun.sleep(20)
    }
    expect(existsSync(fixture.repoPath)).toBe(false)
    const outcome = await resumeOutcome(harness, fixture)
    expect(outcome).toEqual({ code: 'task-worktree-missing', status: 'failed' })
  })

  test('F 准备还没跑完（无工作树 + 有 __repo_prep__ 行）→ 让用户去重试准备', async () => {
    fixture = await seedFixture(harness.db, { worktreePath: '', repoPrepRun: true })
    const outcome = await resumeOutcome(harness, fixture)
    expect(outcome).toEqual({ code: 'task-repo-prep-incomplete', status: 'failed' })
  })

  // ✅ **销账**（RFC-359 AC-1 第 10 刀）。这一格原本是本文件唯一钉住的分叉：
  // 两侧都拒、都不动任务，差的是**用户看到的原因**——PG 报 `workspace-pruning`
  //（文案说「工作区正在被 GC 回收」，**可操作**：瞬态，过会儿再来），SQLite 的准入 CAS
  // 被 `setTaskStatus` 的复活门挡下后统一映射成 `task-not-resumable`，听起来像**永久性**的
  // 「这个任务不能恢复」。`resume` 两份实现合一之后两侧走同一道门，归因收敛到更全的那一侧，
  // 于是这条从「按 provider 分叉的断言」变回**相等断言**。
  test('G 工作区正在被 GC 回收 → 拒，且任务原样不动', async () => {
    fixture = await seedFixture(harness.db, { workspacePruningAt: Date.now() - 100 })
    const outcome = await resumeOutcome(harness, fixture)
    expect(outcome).toEqual({ code: 'workspace-pruning', status: 'failed' })
  })

  test('H 来源已被 MR/PR 关闭事件栅栏 → 拒，且任务原样不动', async () => {
    fixture = await seedFixture(harness.db, { sourceTerminationFence: 'closed' })
    const outcome = await resumeOutcome(harness, fixture)
    expect(outcome).toEqual({ code: 'task-source-terminal-closed', status: 'failed' })
  })

  test('I 正常恢复：failed + 真工作树 → 放行', async () => {
    fixture = await seedFixture(harness.db)
    const outcome = await resumeOutcome(harness, fixture)
    expect(outcome.code).toBe('no-throw')
    expect(outcome.status).not.toBe('failed')
  })
})

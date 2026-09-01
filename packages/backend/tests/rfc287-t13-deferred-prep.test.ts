// RFC-287 T13（G7 核心）—— 仓库准备推迟到任务行落库之后。
//
// 用户可见的问题：今天物化发生在落行**之前**，于是「克隆超时 / 远端不可达 / 认证
// 失败」这类问题**不留任何记录**——点了启动，转半天圈，最后一个 HTTP 错误，任务
// 列表里什么都没有，没法看原因、没法重试。G7 的修法是：同步段只留「填错了立刻
// 告诉你」的校验，任务先落 `pending`（**不新增状态**），准备在后台推进，失败转
// `failed` 且 git 原文留在行上。
//
// 只有 JSON-body 启动走这条：multipart 要把上传物写进工作树、preCreated 是调用方
// 已建好的树，两者必须保持预物化语义（proposal §G7）。
//
// 这里测的是**真行为**：真起一个指向不可达地址的启动，看任务行是否留下来、状态
// 是否转 failed、错误里有没有 git 的原话，以及**墓碑有没有被误打**（AC-15：打了
// 就再也重试不了准备）。

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows, users, nodeRuns, taskRepos, cachedRepos } from '../src/db/schema'
import { startTask as startTaskProduction, type StartTaskDeps } from '@/services/task'
import { runGit } from '@/util/git'
import { ulid } from 'ulid'
import { REPO_PREP_NODE_ID } from '@agent-workflow/shared'
import { startGitHttpRemote } from './helpers/gitHttpRemote'
import { seedRepoGroup } from './helpers/repoGroupFixture'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'
import { createIdentityAccessRuntime } from '../src/modules/identity-access/composition'
import {
  integrationTriggerOptions,
  scheduledTaskRuntime,
  withIntegrationTriggerResources,
} from './helpers/integrationTriggerResourceBinding'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'
import { composeSqliteAgentLaunchResourceOperations } from '../src/modules/task-execution/composition/agentLaunchResources'
import { composeSqliteAgentResourceIntegrity } from '../src/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeSqliteResourceCatalog } from '../src/modules/resource-catalog/composition/providerResourceCatalog'

function withRealSchedulerDriver<T extends { readonly db: DbClient }>(
  deps: T,
): T & Pick<StartTaskDeps, 'schedulerDriver'> {
  return {
    ...deps,
    schedulerDriver: createTaskExecutionTestTopology({ db: deps.db, driver: 'real' })
      .schedulerDriver,
  }
}

/** Every start fixture in this file explicitly selects the real test topology. */
function startTask(
  input: Parameters<typeof startTaskProduction>[0],
  deps: Omit<StartTaskDeps, 'schedulerDriver'>,
): ReturnType<typeof startTaskProduction> {
  return startTaskProduction(input, withRealSchedulerDriver(deps))
}

/**
 * 等任务落到终态。
 *
 * G7 之后仓库准备在**后台**推进（proposal §2：任务行先落 pending，克隆/物化在后台
 * 进行），所以 `await startTask(...)` 返回时准备通常还没开始跑完——本文件里凡是断言
 * 「准备后的状态」的用例都必须先等它落定，否则读到的是占位态。
 */
async function settle(db: DbClient, taskId: string, budgetMs = 60_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const st = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status
    if (st === 'failed' || st === 'done' || st === 'canceled') return
    if (Date.now() - t0 > budgetMs) throw new Error(`task ${taskId} never settled (status=${st})`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

/**
 * 本文件所有启动共用的**临时** app home。
 *
 * 为什么必须显式给：`deps.appHome` 缺省会回落到 `Paths.root`，而它只认
 * `AGENT_WORKFLOW_HOME` —— 只有 `scripts/test-backend-sharded.ts` 会设它。于是
 * `bun test <file>` 与 `bun run test:backend:serial`（CLAUDE.md 记的诊断入口）
 * 下，这些用例会往**用户真实的 `~/.agent-workflow`** 里克隆、留下
 * `repos/<hash>-nope.partial-<ulid>/` 和 `scratch/<ulid>/`，且无人清理。
 * 三轮门测试有效性自查实测：真实 home 里已攒了 13 个残留目录。
 * `setup.ts` 的泄漏守卫盯的是 cwd，看不到这里。
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc287-t13-home-'))

// 最小合法定义——本用例测的是「准备阶段」，节点跑不跑无关紧要（准备失败时压根
// 到不了调度）。形状照 gettask-multi-repo 的现成夹具。
const WF_DEF = { $schema_version: 1, inputs: [], nodes: [], edges: [] } as const

async function seed(db: DbClient): Promise<{ workflowId: string; userId: string }> {
  const userId = 'u_' + ulid()
  const workflowId = ulid()
  await db.insert(users).values({
    id: userId,
    username: userId,
    email: `${userId}@example.test`,
    displayName: 'tester',
    gitName: 'tester',
    role: 'admin',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(WF_DEF),
    ownerUserId: userId,
  })
  return { workflowId, userId }
}

describe('RFC-287 T13 — 延后准备（G7 核心）', () => {
  let db: DbClient
  let workflowId: string
  let userId: string

  beforeAll(async () => {
    await startGitHttpRemote()
    db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    workflowId = s.workflowId
    userId = s.userId
  })

  test('准备失败时**任务行仍然留下来**，状态 failed 且 git 原文可见', async () => {
    const task = await startTask(
      {
        workflowId,
        name: 'deferred-fail',
        // 不可路由地址：克隆必然失败，且失败发生在「落行之后」。
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db,
        actorUserId: userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 3_000,
        // 本用例验「失败留痕」而非重试——关掉 G6 窗口，否则会先退避重试满 60s。
        gitBaselineSyncWindowMs: 0,
      } as never,
    )

    await settle(db, task.id)
    const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
    // ① 行必须存在——这正是 G7 相对现状的核心差别（现状：什么都不留）。
    expect(row).toBeDefined()
    expect(row?.status).toBe('failed')
    // ② 失败原因要能看到 git 说了什么，而不是一句「启动失败」。
    expect(String(row?.errorMessage ?? '') + String(row?.errorSummary ?? '')).toMatch(
      /repo preparation failed|clone|fatal|unable|timed out/i,
    )
    // ③ AC-15：**不得**打墓碑——打了 retryNode 就再也 CAS 不回 pending，
    //    「重试准备仓库」这条 G7 核心语义直接失效。
    expect(row?.workspacePrunedAt ?? null).toBeNull()

    // ④ 合成 `__repo_prep__` 行必须在，且失败原因落在它身上——没有这一行，
    //    用户看到的就是一个「pending 很久然后 failed」的任务，不知道卡在哪、
    //    也没有可点重试的对象（重试复用 retryNode，作用在这一行上）。
    const prepRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
    const prep = prepRuns.find((r) => r.nodeId === REPO_PREP_NODE_ID)
    expect(prep, '缺少 __repo_prep__ 合成行').toBeDefined()
    expect(prep?.status).toBe('failed')
    expect(String(prep?.errorMessage ?? '')).toMatch(/timed out|clone|fatal|unable/i)
  }, 60_000)

  test('准备成功后原子回填双仓行与 tasks 首仓兼容投影', async () => {
    const db2 = createInMemoryDb(MIGRATIONS)
    const s = await seed(db2)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc287-deferred-home-'))
    const sourceRepos = [
      mkdtempSync(join(tmpdir(), 'aw-rfc287-deferred-repo-a-')),
      mkdtempSync(join(tmpdir(), 'aw-rfc287-deferred-repo-b-')),
    ]

    try {
      for (const [index, repoPath] of sourceRepos.entries()) {
        await runGit(repoPath, ['init', '-q', '-b', 'main'])
        await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
        await runGit(repoPath, ['config', 'user.name', 'Test'])
        writeFileSync(join(repoPath, 'README.md'), `# repo ${index}\n`)
        await runGit(repoPath, ['add', '.'])
        await runGit(repoPath, ['commit', '-q', '-m', 'init'])
      }

      const repoGroupId = await seedRepoGroup(db2, appHome, sourceRepos, {
        mountPaths: ['', 'vendor/sdk'],
        name: `deferred-group-${ulid()}`,
      })
      const task = await startTask(
        {
          workflowId: s.workflowId,
          name: 'deferred-success',
          repoGroupId,
          inputs: {},
        } as never,
        {
          db: db2,
          appHome,
          actorUserId: s.userId,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          deferRepoPreparation: true,
          gitBaselineSyncWindowMs: 0,
          awaitScheduler: true,
        } as never,
      )

      expect(task.status).toBe('done')
      const taskRow = (await db2.select().from(tasks).where(eq(tasks.id, task.id)))[0]!
      const repoRows = await db2
        .select()
        .from(taskRepos)
        .where(eq(taskRepos.taskId, task.id))
        .orderBy(asc(taskRepos.repoIndex))

      expect(repoRows).toHaveLength(2)
      expect(taskRow.repoCount).toBe(2)
      expect(taskRow.spaceKind).toBe('remote')
      expect(taskRow.worktreePath).not.toBe('')

      // RFC-066：tasks 的兼容列必须逐字镜像 task_repos[0]。这组断言同时锁住
      // RFC-024 详情页的远端 URL 与 RFC-248 列表/详情的双仓计数。
      const head = repoRows[0]!
      expect(taskRow.repoPath).toBe(head.repoPath)
      expect(taskRow.repoUrl).toBe(head.repoUrl)
      expect(taskRow.repoUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect(taskRow.cachedRepoId).toBe(head.cachedRepoId)
      expect(taskRow.cachedRepoId).not.toBeNull()
      expect(taskRow.baseBranch).toBe(head.baseBranch)
      expect(taskRow.branch).toBe(head.branch)
      expect(taskRow.baseCommit).toBe(head.baseCommit)
      expect(taskRow.worktreePath).toBe(head.worktreePath)

      const prepRuns = await db2.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
      const prep = prepRuns.find((run) => run.nodeId === REPO_PREP_NODE_ID)
      expect(prep?.status).toBe('done')
    } finally {
      rmSync(appHome, { recursive: true, force: true })
      for (const repoPath of sourceRepos) rmSync(repoPath, { recursive: true, force: true })
    }
  }, 60_000)

  test('默认（不开开关）逐字维持旧行为：预物化，失败不落行', async () => {
    let threw = false
    try {
      await startTask(
        {
          workflowId,
          name: 'eager',
          repoUrl: 'http://10.255.255.1:9/nope.git',
          inputs: {},
        } as never,
        {
          db,
          actorUserId: userId,
          appHome: TEST_HOME,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 3_000,
          gitBaselineSyncWindowMs: 0,
        } as never,
      )
    } catch {
      threw = true
    }
    // 旧路径：物化在落行之前，失败直接抛给 HTTP（或落一条 failed 行）——
    // 无论哪种，都**不是**本 RFC 要改的对象；这里只锁「开关默认关闭时不变」。
    const rows = await db.select().from(tasks)
    const eager = rows.find((r) => r.name === 'eager')
    // ⚠️ 原断言是 `expect(threw || eager !== undefined).toBe(true)` —— **恒真**：
    // 抛了为真，没抛就必然有行，二者必居其一。把 `deps.deferRepoPreparation === true`
    // 改成 `!== false`（即延后准备变成默认，正是本用例声称要防的回归）它照样全绿。
    //
    // 真正有判别力的是：**不开开关的启动不得产生 `__repo_prep__` 合成行**。那条行
    // 是延后准备独有的产物，走老路径的任务身上根本不该出现。
    if (eager !== undefined) {
      const prepRuns = (
        await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, eager.id))
      ).filter((r) => r.nodeId === REPO_PREP_NODE_ID)
      expect(prepRuns.length, '不开开关时不得走延后准备（不该有 __repo_prep__ 行）').toBe(0)
    } else {
      // 老路径的另一种收场：物化在落行之前失败，直接抛给调用方、不留任务行。
      expect(threw, '既没抛也没落行 —— 两条老路径都不成立').toBe(true)
    }
  }, 60_000)
})

// RFC-287 T13（G7）—— 准备期间的**孤儿回收豁免**。
//
// 这条不是「顺手加的」，是实测查出来的一个真风险：`__repo_prep__` 行没有 pid
// （准备由 startTask 协程驱动、不 spawn 子进程）、没有子行、也不是 wrapper。而
// 周期孤儿回收器在 Codex 设计门 P1-1 之后**不再保守判活**——「无驱动」直接判死。
// 若无豁免，一个跑几分钟的大仓克隆会被中途回收，随后撞终态守卫、失败整个任务。
//
// 豁免来自 `activeTasks`：回收器最外层就 `if (hasDriver(taskId)) continue`，而
// G7 把 AbortController 的注册挪到了**准备开始之前**（同一刀里做的，理由是用户
// 在「正在准备仓库」阶段点取消要取消得到东西）。两件事因此共用同一个前提。
//
// 本测试锁的就是这个前提：注册时机一旦被挪回准备之后，长克隆会被误收。
import { readFileSync as readSrc } from 'node:fs'

describe('RFC-287 T13 — 准备期间不被孤儿回收器误收', () => {
  test('TaskDriveCoordinator 在准备开始之前完成 attach（回收器据此判活）', () => {
    const src = readSrc(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'application',
        'drive',
        'taskDriveCoordinator.ts',
      ),
      'utf8',
    )
    const attach = src.indexOf('const attached = await this.options.lifecycle.attach({')
    const startDrive = src.indexOf('const completion = this.driveAttached(')
    const prepare = src.indexOf('await this.options.repositoryPreparation.run(context)')
    const engine = src.indexOf('await this.options.engineOrchestrator.drive(context)')
    expect(attach, 'coordinator 必须 attach driver').toBeGreaterThan(-1)
    expect(startDrive, 'attach 后必须进入受控 drive').toBeGreaterThan(attach)
    expect(prepare, '受控 drive 必须执行 repository preparation').toBeGreaterThan(startDrive)
    expect(engine, 'engine 必须在 preparation ready 后执行').toBeGreaterThan(prepare)
  })

  test('回收器确实以 activeTasks 为豁免依据（判活单点未被绕过）', () => {
    const src = readSrc(
      resolve(import.meta.dir, '..', 'src', 'services', 'orphanReconcile.ts'),
      'utf8',
    )
    // 三处清扫各有一道豁免，存在性断言只要活一处就算过（五轮门自查实测：只反转第一处
    // 或只删掉第一处，用例照样绿——而任何一路丢掉豁免，准备窗口里的任务就会被误收）。
    // 按**基数**锁。
    expect(
      [...src.matchAll(/if \(hasDriver\(taskId\)\) continue/g)],
      'orphanReconcile 的三处清扫都必须有驱动豁免',
    ).toHaveLength(3)
  })
})

// RFC-287 T13（G7 / AC-11）—— 重试 `__repo_prep__` = 重跑准备，复用既有 retryNode。
//
// 用户拍板过的语义：「重试就是重试当前状态，当前状态就是在准备仓库，那就重试准备
// 仓库」。做法上刻意**不造第二套重试**：合成行就是一条普通 node_run，点它的重试
// 走的还是 retryNode。本测试验的是这条路真的通——而不是「看起来应该通」。
describe('RFC-287 T13 — 重试准备（AC-11）', () => {
  test('准备失败后，__repo_prep__ 行可被 retryNode 接受（不被前置门挡掉）', async () => {
    const db2 = createInMemoryDb(MIGRATIONS)
    const s = await seed(db2)
    const task = await startTask(
      {
        workflowId: s.workflowId,
        name: 'retry-prep',
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db: db2,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 3_000,
        // 本用例验「失败留痕」而非重试——关掉 G6 窗口，否则会先退避重试满 60s。
        gitBaselineSyncWindowMs: 0,
      } as never,
    )
    const runs = await db2.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
    const prep = runs.find((r) => r.nodeId === REPO_PREP_NODE_ID)
    expect(prep).toBeDefined()

    // 前置门必须放行：任务已 failed（非 pending/running）、调度器已解绑
    // （准备失败那条路径 activeTasks.delete 过）。这两条是 retryNode 的硬门，
    // 任一不满足都会 409——那样「重试准备」就成了一句空话。
    const { retryNode } = await import('@/services/task')
    let rejected: string | null = null
    try {
      await retryNode(db2, task.id, prep!.id, {
        cascade: false,
        deps: withRealSchedulerDriver({
          db: db2,
          actorUserId: s.userId,
          appHome: TEST_HOME,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 3_000,
          gitBaselineSyncWindowMs: 0,
        }),
      })
    } catch (err) {
      rejected = err instanceof Error ? err.message : String(err)
    }
    // 不要求重试**成功**（远端仍然不可达，注定再失败一次）——要求的是它
    // **没有被前置门拒之门外**：拒绝信息里不得出现 still-running 一类。
    expect(rejected ?? '').not.toMatch(/still-running|not found/i)
  }, 90_000)
})

// RFC-287 G6 —— 基线同步的窗口化重试。
//
// 交付的是「抖动不再直接打挂启动」：网络类失败在总容忍窗口内退避重试；鉴权 /
// 仓库不存在 / 无权限**不占窗口**，立刻失败。用总窗口而非固定次数，因为用户关心
// 的是「最多等多久」，不是「重试几次」。
describe('RFC-287 G6 — 基线同步窗口化重试', () => {
  // T14 改测法：原版测的是 `await startTask(...)` 的**阻塞时长**——那恰恰是 G7 要
  // 消灭的行为（proposal §2 G7：任务行先落 pending，克隆/物化在后台推进）。启动
  // 异步化之后 startTask 立刻返回，原断言必然失效；更要命的是，只要它还在，就等于
  // 把「启动接口同步阻塞」这个缺陷锁成了契约。
  //
  // 改成测**准备本身**耗多久：窗口大 ⇒ 任务更晚落 failed。这才是 G6 的语义，且与
  // 启动是同步还是异步无关。
  async function msUntilTerminal(db: DbClient, taskId: string): Promise<number> {
    const t0 = Date.now()
    for (;;) {
      const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      const st = row?.status
      if (st === 'failed' || st === 'done' || st === 'canceled') return Date.now() - t0
      if (Date.now() - t0 > 60_000) throw new Error(`task ${taskId} never settled`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  test('网络类失败会占用窗口（窗口越大，准备越晚收场）', async () => {
    const db3 = createInMemoryDb(MIGRATIONS)
    const s = await seed(db3)
    const launch = async (windowMs: number, name: string): Promise<number> => {
      const task = await startTask(
        {
          workflowId: s.workflowId,
          name,
          // 不可路由 ⇒ 连接超时 ⇒ 分类为 retryable-network。
          repoUrl: 'http://10.255.255.1:9/nope.git',
          inputs: {},
        } as never,
        {
          db: db3,
          actorUserId: s.userId,
          appHome: TEST_HOME,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          deferRepoPreparation: true,
          cloneTimeoutMs: 1_000,
          gitBaselineSyncWindowMs: windowMs,
        } as never,
      )
      return await msUntilTerminal(db3, task.id)
    }
    const noWindow = await launch(0, 'g6-nowindow')
    const withWindow = await launch(4_000, 'g6-window')
    expect(withWindow).toBeGreaterThan(noWindow + 1_500)
  }, 90_000)

  // G7 的核心可观察行为：启动接口**不再**等工作树。
  test('G7：延后准备的启动立刻返回 pending 行，不等克隆完成', async () => {
    const dbA = createInMemoryDb(MIGRATIONS)
    const s = await seed(dbA)
    const t0 = Date.now()
    const task = await startTask(
      {
        workflowId: s.workflowId,
        name: 'g7-async',
        // 不可路由：真去连要耗满 cloneTimeoutMs（3s）+ 窗口（4s）。
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db: dbA,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 3_000,
        gitBaselineSyncWindowMs: 4_000,
      } as never,
    )
    const elapsed = Date.now() - t0
    // 返回必须**远快于**准备本身。给 1.5s 余量：真同步的话至少 3s 起步。
    expect(elapsed).toBeLessThan(1_500)
    // 返回的是尚未准备的占位态——AC-10 把不变量从「有任务行就有工作树」改成
    // 「`__repo_prep__` 行 done 之后才有工作树」，正是为了这一刻。
    expect(task.status).toBe('pending')
    expect(task.worktreePath).toBe('')
    // 而准备确实在后台推进，并最终把任务落到 failed（远端不可达）。
    await msUntilTerminal(dbA, task.id)
    const after = (await dbA.select().from(tasks).where(eq(tasks.id, task.id)))[0]
    expect(after?.status).toBe('failed')
    const prep = (await dbA.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))).find(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    expect(prep?.status).toBe('failed')
  }, 90_000)

  test('窗口耗尽后仍按失败收场，且原因不被重试吞掉', async () => {
    const db4 = createInMemoryDb(MIGRATIONS)
    const s = await seed(db4)
    const task = await startTask(
      {
        workflowId: s.workflowId,
        name: 'g6-exhaust',
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db: db4,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 1_000,
        gitBaselineSyncWindowMs: 2_000,
      } as never,
    )
    await settle(db4, task.id)
    const row = (await db4.select().from(tasks).where(eq(tasks.id, task.id)))[0]
    expect(row?.status).toBe('failed')
    expect(String(row?.errorMessage ?? '')).toMatch(/timed out|connect|clone|fatal/i)
  }, 90_000)
})

// 「鉴权不占窗口」在真行为层不好造（需要一个会拒绝鉴权的真实远端），故在**接线层**
// 锁：准备段必须以 `isRetryableGitFailure` 为唯一放行判据，且判在窗口检查之前。
// 删掉它 = 所有失败都进窗口，鉴权失败要白等满 60 秒才报「你没权限」。
describe('RFC-287 G6 — 只有网络类占窗口（接线锁）', () => {
  test('重试判据是 isRetryableGitFailure，且在窗口检查之前', () => {
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    // T14 改锚：准备段已从 startTaskImpl 的函数体提成模块级
    // `runDeferredRepoPreparation`——AC-11 的「重试准备」要走**同一份**实现，抄第二套
    // 的话这段里的窗口重试、两种失败形态、回填同事务、租约换真会各自走散。锁的语义
    // 不变（判据先于窗口），只是射程跟着结构挪到新函数体内。
    const fnStart = src.indexOf('async function runDeferredRepoPreparation(')
    expect(fnStart, '准备段应已收敛为单一实现').toBeGreaterThan(-1)
    const body = src.slice(fnStart, src.indexOf('\n}\n', fnStart))
    const guard = body.indexOf('isRetryableGitFailure(prepared.earlyError)')
    const window = body.indexOf('windowDeadline - Date.now()')
    expect(guard, '准备段必须以 isRetryableGitFailure 决定是否重试').toBeGreaterThan(-1)
    expect(window).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(window)
  })

  test('git 输出被强制 C locale（否则分类器在中文环境全灭）', () => {
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'util', 'git.ts'), 'utf8')
    expect(src).toMatch(/LC_ALL: 'C'/)
    expect(src).toMatch(/LANG: 'C'/)
  })
})

// RFC-287 实现门自审补 —— scratch 启动**不走**延后准备。
//
// 为什么：临时空间没有远端要克隆，G7 要解决的「拉不动远端时什么都不留」在它身上
// 根本不存在，延后零收益。而占位行必须先认领一个 spaceKind，写 'remote' 对 scratch
// 就是错的，直到回填才纠正。今天下游恰好不敏感（gc 只处理终态任务、taskDelete 的
// 分支不涉及），但那是运气不是保证——任何将来按 spaceKind 分流的非终态读点都会
// 踩中这段窗口。
describe('RFC-287 — scratch 启动排除在延后准备之外', () => {
  test('开着 deferRepoPreparation 时，scratch 任务仍立刻拿到正确的 spaceKind', async () => {
    const db5 = createInMemoryDb(MIGRATIONS)
    const s = await seed(db5)
    const task = await startTask(
      {
        workflowId: s.workflowId,
        name: 'scratch-not-deferred',
        scratch: true,
        inputs: {},
      } as never,
      {
        db: db5,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        // 开关开着——但 scratch 必须绕开它。
        deferRepoPreparation: true,
      } as never,
    )
    const row = (await db5.select().from(tasks).where(eq(tasks.id, task.id)))[0]
    // 关键断言：spaceKind 必须是 'scratch'，绝不能是占位的 'remote'。
    expect(row?.spaceKind).toBe('scratch')
    // 且工作区立刻可用（预物化语义保住）。
    expect(row?.worktreePath ?? '').not.toBe('')
    // 不该有 __repo_prep__ 合成行——它压根没走延后那条路。
    const runs = await db5.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
    expect(runs.find((r) => r.nodeId === REPO_PREP_NODE_ID)).toBeUndefined()
  }, 60_000)
})

// RFC-287 G7 / AC-11 + AC-16 —— 重试「准备仓库」。
//
// 修复前 `retryNode` 完全不认识合成的 `__repo_prep__` 行：它被当成普通工作流节点，
// 铸个 placeholder 就交给 `runTask`，而 runTask 只驱动快照内的节点——空 scope 直接
// 收尾，**把任务标成 done**。于是「重试准备」的实际效果是：一个没有工作树、没有
// task_repos 的任务变成成功。那不是功能缺失，是会造出坏数据。（T14 实现门实测。）
//
// AC-11 要求重试作用于任务**当前所处阶段**，所以准备行走自己的路径：重建来源 →
// CAS 回 pending → 重跑同一份准备实现。来源能重建的前提是 `cachedRepoId` 在占位
// **之前**就已落定（tasks.repo_url 按设计脱敏、不可驱动 relaunch）。
describe('RFC-287 AC-11/AC-16 — 重试准备仓库', () => {
  async function launchFailingPrep(
    db: DbClient,
    s: { workflowId: string; userId: string },
    name: string,
  ): Promise<string> {
    const task = await startTask(
      {
        workflowId: s.workflowId,
        name,
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 1_000,
        gitBaselineSyncWindowMs: 0,
      } as never,
    )
    await settle(db, task.id)
    return task.id
  }

  // exact-SHA CI（git-protocols e2e）抓到的：占位行没存 repoUrl，于是 201 响应里
  // `task.repoUrl` 为空。这不只是测试问题——准备窗口内以及准备失败之后，任务详情
  // 完全看不到仓库地址：用户既不知道自己在等哪个仓，失败后也无从判断是不是地址
  // 填错了。请求里本来就有 URL，落库前按既有规则脱敏即可（RFC-054 W3-4：repo_url
  // 存脱敏形，只用于显示、不能驱动 relaunch）。
  test('占位行必须带上（脱敏的）repoUrl，否则准备期间看不到自己在等哪个仓', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const task = await startTask(
      {
        workflowId: s.workflowId,
        name: 'ac10-repourl',
        repoUrl: 'http://u:secret@10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 1_000,
        gitBaselineSyncWindowMs: 0,
      } as never,
    )
    // 201 那一刻就要有——不能等准备完成才出现。
    expect(task.repoUrl ?? '').not.toBe('')
    // 且必须是脱敏形：凭据绝不能出现在这一列上。
    expect(task.repoUrl ?? '').not.toContain('secret')
    expect(task.repoUrl ?? '').toContain('***')
    // 准备失败之后依然留着（失败任务同样要能看出是哪个仓）。
    await settle(db, task.id)
    const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
    expect(row?.status).toBe('failed')
    expect(row?.repoUrl ?? '').not.toBe('')
    expect(row?.repoUrl ?? '').not.toContain('secret')
  }, 90_000)

  test('占位行必须已带 cachedRepoId（否则重试无从重建来源）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep(db, s, 'ac11-identity')
    const row = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
    // 这一条是 AC-11 的地基：身份在**克隆之前**就落定了，所以哪怕克隆从未成功，
    // 来源依然找得回来。
    expect(row?.cachedRepoId ?? '').not.toBe('')
    // 而且它指向一个真实存在的 cached_repos 行。
    const cached = await db.select().from(cachedRepos).where(eq(cachedRepos.id, row!.cachedRepoId!))
    expect(cached.length).toBe(1)
    // 该行以 last_fetched_at=0 标记「尚未取回内容」——这个哨兵同时让它不被后台保鲜
    // 选中、并让冷路径领养而不是删掉重建。
    expect(cached[0]?.lastFetchedAt).toBe(0)
  }, 90_000)

  test('重试准备行 = 重跑准备，绝不把任务静默标成 done', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep(db, s, 'ac11-retry')
    const prep = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))).find(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    expect(prep?.status).toBe('failed')

    const { retryNode } = await import('@/services/task')
    await retryNode(db, id, prep!.id, {
      cascade: false,
      deps: withRealSchedulerDriver({
        db,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        cloneTimeoutMs: 1_000,
        gitBaselineSyncWindowMs: 0,
      }),
    })
    await settle(db, id)
    const after = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
    // 远端仍不可达 ⇒ 必然再失败一次。**关键是它不能是 done**：那正是修复前的坏行为。
    expect(after?.status).not.toBe('done')
    expect(after?.status).toBe('failed')
    // 而且确实重跑过准备——工作树仍然没有（不是「假装成功」）。
    expect(after?.worktreePath ?? '').toBe('')

    // ⚠️ 上面三条**在重试之前就已经全部成立**（launchFailingPrep 已经 settle 成
    // failed 且无工作树），所以它们区分不了「重跑了准备又失败一次」与「retryNode
    // 什么都没做」——把 retryRepoPreparation 换成裸 return 时它们照样全绿（二轮
    // 门自查实测）。真正有判别力的是**准备行的条数**：每跑一次准备都会
    // `mintNodeRun(REPO_PREP_NODE_ID)`，所以重跑过就必然从 1 变 2。
    const prepRunsAfter = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))).filter(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    expect(prepRunsAfter.length, '重试必须真的重跑准备（应铸出第二条准备行）').toBe(2)
  }, 120_000)

  test('AC-16：对 done 的准备行重试被拒（不得对已有工作树的任务再物化）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep(db, s, 'ac16-done')
    const prep = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))).find(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    // 把准备行改成 done 模拟「已准备好的任务」。
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, prep!.id))
    const { retryNode } = await import('@/services/task')
    let msg = ''
    try {
      await retryNode(db, id, prep!.id, {
        cascade: false,
        deps: withRealSchedulerDriver({
          db,
          actorUserId: s.userId,
          appHome: TEST_HOME,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        }),
      })
    } catch (err) {
      // ⚠️ 判据必须是 `.code`：DomainError / ValidationError 把错误码放在 `.code`，
      // **message 里一个字都没有**。三轮门测试有效性自查实证：按 message 写的
      // `not.toMatch(/repo-prep-source-unavailable/i)` 是**空断言**——把
      // retryRepoPreparation 改成无条件抛该码，用例照样全绿；而按 message 写的
      // 正面断言只能匹配到英文散文那一支，改个措辞就误红。
      msg = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
    }
    expect(msg).toBe('repo-prep-not-retryable')
  }, 90_000)

  // daemon 在准备窗口内重启时，boot reap 把任务翻 interrupted、把 running 的准备行
  // mark-interrupted。判据若只认 `failed`，这类任务会**永久不可恢复**：resume 撞
  // `existsSync('')` 得 410（且文案错误归因成「工作区已被 GC 回收」）、本重试撞 409、
  // 前端仍劝「另起任务」；开了 autoResumeOnBoot 还会每次 boot 吃一个 410 直到熔断。
  // 唯一出路变成删任务重开。（T14 第二轮门实测。）
  // 二轮实现门 B-F3：以 `cachedRepoId` 启动是**公开支持**的路径（RFC-204 之后公开面
  // 传的就是它而不是 URL）。占位时若不把它落进 tasks.cached_repo_id，准备失败后点
  // 「重试准备」会撞 `repo-prep-source-unavailable`——AC-11 对这条路完全失效。
  test('以 cachedRepoId 启动时，占位行同样带上来源（否则 AC-11 对这条路失效）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s2 = await seed(db)
    const cachedId = ulid()
    const now = Date.now()
    db.insert(cachedRepos)
      .values({
        id: cachedId,
        urlHash: 'bf3hash',
        urlRedacted: 'http://10.255.255.1:9/nope.git',
        urlEnc: null,
        localPath: '/tmp/aw-bf3-mirror',
        lastFetchedAt: 0,
        createdAt: now,
      })
      .run()
    const task = await startTask(
      { workflowId: s2.workflowId, name: 'bf3', cachedRepoId: cachedId, inputs: {} } as never,
      {
        db,
        actorUserId: s2.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 1_000,
        gitBaselineSyncWindowMs: 0,
      } as never,
    )
    expect(task.cachedRepoId, '占位行必须带上 cachedRepoId').toBe(cachedId)
    await settle(db, task.id)
    // 重试不得因「无可重建来源」被拒。
    const prep = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))).find(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    const { retryNode } = await import('@/services/task')
    let msg = ''
    try {
      await retryNode(db, task.id, prep!.id, {
        cascade: false,
        deps: withRealSchedulerDriver({
          db,
          actorUserId: s2.userId,
          appHome: TEST_HOME,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 1_000,
          gitBaselineSyncWindowMs: 0,
        }),
      })
    } catch (err) {
      // ⚠️ 判据必须是 `.code`：DomainError / ValidationError 把错误码放在 `.code`，
      // **message 里一个字都没有**。三轮门测试有效性自查实证：按 message 写的
      // `not.toMatch(/repo-prep-source-unavailable/i)` 是**空断言**——把
      // retryRepoPreparation 改成无条件抛该码，用例照样全绿；而按 message 写的
      // 正面断言只能匹配到英文散文那一支，改个措辞就误红。
      msg = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
    }
    expect(msg).not.toBe('repo-prep-source-unavailable')
  }, 120_000)

  test('AC-16 反面：interrupted 的准备行必须可重试（否则 daemon 重启 = 任务报废）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s2 = await seed(db)
    const id = await launchFailingPrep(db, s2, 'ac16-interrupted')
    const prep = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))).find(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    // 模拟 boot reap 的处置：任务与准备行都落 interrupted。
    await db.update(nodeRuns).set({ status: 'interrupted' }).where(eq(nodeRuns.id, prep!.id))
    await db.update(tasks).set({ status: 'interrupted' }).where(eq(tasks.id, id))

    const { retryNode } = await import('@/services/task')
    let msg = ''
    try {
      await retryNode(db, id, prep!.id, {
        cascade: false,
        deps: withRealSchedulerDriver({
          db,
          actorUserId: s2.userId,
          appHome: TEST_HOME,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 1_000,
          gitBaselineSyncWindowMs: 0,
        }),
      })
    } catch (err) {
      // ⚠️ 判据必须是 `.code`：DomainError / ValidationError 把错误码放在 `.code`，
      // **message 里一个字都没有**。三轮门测试有效性自查实证：按 message 写的
      // `not.toMatch(/repo-prep-source-unavailable/i)` 是**空断言**——把
      // retryRepoPreparation 改成无条件抛该码，用例照样全绿；而按 message 写的
      // 正面断言只能匹配到英文散文那一支，改个措辞就误红。
      msg = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
    }
    // 关键：**不得**被 AC-16 的守卫拒掉。远端仍不可达所以最终还会失败，但那是
    // 重跑之后的结果，不是「不让你重试」。
    expect(msg).not.toBe('repo-prep-not-retryable')
    await settle(db, id)
    const after = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
    expect(after?.status).toBe('failed')
  }, 120_000)

  test('任务只在 tasks.cached_repo_id 上引用时，删除仍须被拒', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep(db, s, 'refcount-blindspot')
    const row = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
    const repoId = row!.cachedRepoId!
    expect(repoId).not.toBe('')
    // 前提复核：该任务确实**没有** task_repos 行（守卫的旧判据在此为 0）。
    expect((await db.select().from(taskRepos).where(eq(taskRepos.taskId, id))).length).toBe(0)

    const { deleteCachedRepo } = await import('@/services/gitRepoCache')
    let code = ''
    try {
      await deleteCachedRepo({ store: composeSqliteRepositoryWorkspaceStore(db) }, repoId)
    } catch (err) {
      code = (err as { code?: string }).code ?? (err as Error).message
    }
    expect(code, '在用镜像必须拒删（否则任务的 cached_repo_id 悬空）').toMatch(
      /reference|in-use|has-references/i,
    )
    expect((await db.select().from(cachedRepos).where(eq(cachedRepos.id, repoId))).length).toBe(1)
  }, 90_000)
})

// RFC-287 G6 —— **warm 路径**的失败也必须能进窗口（三轮门 AC 对账挖出的真缺口）。
//
// design §9.2 写的 G6 位置就是「gitRepoCache.ts **warm path** 的 fetch 失败分支」，
// 也就是「镜像已经在了、这次 fetch 更新失败」——那才是稳态生产路径。可 warm 路径抛的
// 是 `DomainError('repo-fetch-failed', '…refusing to launch from a stale cache', 502,
// { url, stderr })`：**git 的原话在 details 里，message 里一个字都没有**。而窗口重试
// 的判据只看 message ⇒ 判 unknown ⇒ 不可重试 ⇒ 窗口一秒不用。
//
// 现有 G6 用例全绿只是因为它们用**全新 URL**，走的是 cold clone 那条（它的 message
// 自带 stderr）。本用例直接按分类器的输入面锁：warm 那句的完整诊断必须可判为网络类。
describe('RFC-287 G6 —— warm 路径失败同样进窗口', () => {
  test('warm 的 repo-fetch-failed 带上 details.stderr 后可判为可重试', async () => {
    const { classifyGitFailure } = await import('@agent-workflow/shared')
    // warm 路径的 message —— 单看它永远是 unknown（这正是缺口）。
    const msg =
      'repository fetch failed for https://e.com/x.git; refusing to launch from a stale cache'
    expect(classifyGitFailure(msg)).toBe('unknown')
    // 但把 details.stderr 拼进去之后，就该按 git 的原话判。
    const stderr = 'fatal: unable to access: Could not resolve host: e.com'
    expect(classifyGitFailure(`${msg}\n${stderr}`)).toBe('retryable-network')
    // 反向：鉴权类仍不占窗口。
    const authErr = 'remote: Invalid username or password.\nfatal: Authentication failed'
    expect(classifyGitFailure(`${msg}\n${authErr}`)).toBe('permanent')
  })

  test('准备段确实把 details.stderr 折进了 earlyError（否则上一条锁的是空气）', () => {
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    // 折叠函数存在，且准备段用的是它而不是裸 message。
    expect(src).toMatch(/function diagnosticTextOf\(err: unknown\): string/)
    const i = src.indexOf('async function runDeferredRepoPreparation')
    const j = src.indexOf('\n}\n', i)
    const body = src.slice(i, j)
    expect(body, '准备段必须用完整诊断').toContain('earlyError: diagnosticTextOf(err)')
    expect(body, '不得退回裸 message').not.toMatch(
      /earlyError: err instanceof Error \? err\.message/,
    )
  })
})

// RFC-287 G7 的**覆盖面**：proposal §G7 最后一句是「定时任务与 webhook 触发同一套
// 语义」，可实现只在 `POST /api/tasks` 那一条路由上把 `deferRepoPreparation` 打开
// （三轮门 AC 对账实测）。于是一次拉不动远端的**定时**触发压根不铸任务行：用户在
// 任务列表里什么都看不到，只能去翻触发历史里的一句错误，也没有任何可重试的对象
// ——AC-11「重试作用于任务当前所处阶段」在这条路径上作用面为空。
//
// 这条按**行为**判（不是源码文本锁）：真起一次 fireSchedule，断言它不再抛、并且
// 留下了带 `__repo_prep__` 失败行的任务。变异实证：拿掉 scheduleLaunch 里那一行，
// fireSchedule 直接抛、taskId 无从取得 ⇒ 本条红。
describe('RFC-287 G7 —— 定时触发与手动启动同一套语义', () => {
  test('定时触发的准备失败也留下任务行 + __repo_prep__ 失败行（而不是什么都不留）', async () => {
    const { createScheduledTask, fireSchedule, getScheduledTaskRow } =
      await import('@/services/scheduledTasks')
    const { buildScheduleLaunch } = await import('@/services/scheduleLaunch')
    const { buildActor } = await import('../src/auth/actor')

    const db2 = createInMemoryDb(MIGRATIONS)
    const s = await seed(db2)
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc287-sched-'))
    process.env.AGENT_WORKFLOW_HOME = home
    const cfgPath = join(home, 'config.json')
    // 走配置面把两个窗口按到最短：本条验「失败留痕」而非重试，不然要白等 60s 退避。
    writeFileSync(
      cfgPath,
      JSON.stringify({ $schema_version: 1, gitBaselineSyncWindowMs: 0, gitCloneTimeoutMs: 3000 }),
    )
    const actor = buildActor({
      user: {
        id: s.userId,
        username: `u-${s.userId.slice(-4)}`,
        displayName: 'U',
        role: 'admin',
        status: 'active',
      },
      source: 'daemon',
    } as never)

    const created = await createScheduledTask(
      scheduledTaskRuntime(db2).operations,
      {
        name: 'nightly',
        launchKind: 'workflow',
        launchPayload: {
          workflowId: s.workflowId,
          name: 'sched-prep-fail',
          inputs: {},
          // 不可路由地址：克隆必然失败，且（接线正确时）失败发生在落行**之后**。
          repoUrl: 'http://10.255.255.1:9/nope.git',
        },
        scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
        enabled: true,
      } as never,
      integrationTriggerOptions(db2, actor),
    )
    const row = (await getScheduledTaskRow(scheduledTaskRuntime(db2).operations, created.id))!

    // ① 不再抛：接线前，准备在落行之前跑，克隆一失败 fireSchedule 就整个抛出去。
    const resourceCatalog = composeSqliteResourceCatalog({ db: db2 })
    const agentIntegrity = composeSqliteAgentResourceIntegrity({
      db: db2,
      authorization: resourceCatalog.authorization,
    })
    const { taskId } = await fireSchedule(
      scheduledTaskRuntime(db2).operations,
      row,
      buildScheduleLaunch(
        db2,
        createTaskExecutionTestTopology({ db: db2, driver: 'real' }).schedulerDriver,
        cfgPath,
        createIdentityAccessRuntime({ db: db2 }),
        {
          resources: composeSqliteAgentLaunchResourceOperations(db2),
          integrity: agentIntegrity.launch,
        },
      ),
      Date.now(),
      withIntegrationTriggerResources(db2, createIdentityAccessRuntime({ db: db2 })),
      { kind: 'manual' },
    )
    expect(taskId).toBeTruthy()

    await settle(db2, taskId)
    // ② 任务行留下来了，且是 failed（G7 明确不新增状态）。
    const task = (await db2.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(task).toBeDefined()
    expect(task?.status).toBe('failed')
    // ③ AC-15：不得打墓碑，否则重试准备这条语义直接失效。
    expect(task?.workspacePrunedAt ?? null).toBeNull()
    // ④ 卡在哪一步要看得见 —— 合成准备行在，且带着 git 原话。
    const runs = await db2.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const prep = runs.find((r) => r.nodeId === REPO_PREP_NODE_ID)
    expect(prep, '定时触发同样要铸 __repo_prep__ 行').toBeDefined()
    expect(prep?.status).toBe('failed')
    expect(String(prep?.errorMessage ?? '')).toMatch(
      /clone|fatal|unable|timed out|repo preparation failed/i,
    )
    // ⑤ AC-11 的前提：重试要能找回来源 —— cached_repo_id 已先行落定。
    expect(task?.cachedRepoId ?? null).not.toBeNull()

    rmSync(home, { recursive: true, force: true })
  }, 120_000)

  test('webhook 派发也把延后准备打开（与定时同源的接线）', () => {
    // webhook 那条要造一整个 provider 签名 + 渲染链才跑得起来，成本远高于它锁到的
    // 东西；而两条路径的接线完全同形（都在自己的 launchDeps 里加同一个 flag），
    // 上面那条已经把「打开之后行为对不对」验完了。这里只锁「webhook 也打开了」。
    const src = readSrc(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'integration',
        'infrastructure',
        'webhookExecutionRuntime.ts',
      ),
      'utf8',
    )
    expect(src).toContain('readonly taskExecutions: WebhookTaskExecutionParticipant<')
    expect(src).toContain('await dependencies.taskExecutions.launch({')
  })
})

// 三轮门（Codex 契约面）P1：G7 把 G5 的权威拒绝点推进了后台，于是以 `cachedRepoId`
// 启动一个指向 `file://` 的**存量镜像**时，调用方拿到的是 201 Created，稳定错误码
// 只出现在几秒后的任务失败里。proposal §G7 明确把「地址格式」留在同步段
// （「填错了立刻告诉你」），§7 也写明这是「明确的参数校验失败」——延后与之相反。
describe('RFC-287 G5×G7 —— 延后准备不得把地址格式拒绝也一起延后', () => {
  async function seedFileMirror(db: DbClient): Promise<string> {
    const id = ulid()
    await db.insert(cachedRepos).values({
      id,
      urlHash: 'h_' + id,
      urlRedacted: 'file:///srv/private/repo',
      localPath: '/tmp/mirror-' + id,
      lastFetchedAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)
    return id
  }

  test('cachedRepoId 指向 file:// 镜像：同步拒，不铸任务行', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const cachedRepoId = await seedFileMirror(db)
    let code = ''
    try {
      await startTask(
        { workflowId: s.workflowId, name: 'x', cachedRepoId, inputs: {} } as never,
        {
          db,
          actorUserId: s.userId,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          deferRepoPreparation: true,
          appHome: TEST_HOME,
        } as never,
      )
    } catch (err) {
      code = (err as { code?: string }).code ?? String(err)
    }
    expect(code, '必须同步给出稳定错误码，而不是 201 之后后台失败').toBe(
      'repo-url-file-scheme-unsupported',
    )
    // 关键差别：同步拒绝**不留任务行**（延后失败才留）。
    expect((await db.select().from(tasks)).length).toBe(0)
  })

  test('url_redacted 为 NULL 时预筛放行（不解密、交给唯一权威拒绝点）', async () => {
    // 密钥轮换等原因导致脱敏列缺失时，预筛拿不到 scheme。此时**不得**乱报
    // file 错误（那会把用户引向错误的修复方向），而是放行给后台解封后再判。
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = ulid()
    await db.insert(cachedRepos).values({
      id,
      urlHash: 'h_' + id,
      urlRedacted: null,
      localPath: '/tmp/mirror-' + id,
      lastFetchedAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)
    let code = ''
    try {
      await startTask(
        { workflowId: s.workflowId, name: 'y', cachedRepoId: id, inputs: {} } as never,
        {
          db,
          actorUserId: s.userId,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          deferRepoPreparation: true,
          appHome: TEST_HOME,
        } as never,
      )
    } catch (err) {
      code = (err as { code?: string }).code ?? String(err)
    }
    expect(code, '预筛不得对未知 scheme 报 file 错误').not.toBe('repo-url-file-scheme-unsupported')
  })
})

/** 与 AC-11 那组同款，但提到顶层供后加的用例复用。 */
async function launchFailingPrep2(
  db: DbClient,
  s: { workflowId: string; userId: string },
  name: string,
): Promise<string> {
  const task = await startTask(
    {
      workflowId: s.workflowId,
      name,
      repoUrl: 'http://10.255.255.1:9/nope.git',
      inputs: {},
    } as never,
    {
      db,
      actorUserId: s.userId,
      appHome: TEST_HOME,
      launchProvenance: { kind: 'direct-json', initiator: 'manual' },
      deferRepoPreparation: true,
      cloneTimeoutMs: 1_000,
      gitBaselineSyncWindowMs: 0,
    } as never,
  )
  await settle(db, task.id)
  return task.id
}

// 三轮门（Codex 契约面）P1：AC-11 的重试原本 `await` 整个准备。单次 clone 默认可跑
// 30 分钟，而 Bun 的入站连接 **255 秒**无响应就关闭——一次 270 秒的 clone 会让客户端
// 收到断连，而 clone 与任务其实还在后台跑并可能成功，制造「客户端认为失败、任务仍在
// 推进」的未知态。首启早就是后台推进了，重试必须同语义。
describe('RFC-287 AC-11 —— 重试立刻返回，准备在后台推进', () => {
  test('retryNode 不等准备跑完（否则长克隆必然撞连接超时）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep2(db, s, 'ac11-async')
    const prep = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))).find(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    const { retryNode } = await import('@/services/task')
    const t0 = Date.now()
    const returned = await retryNode(db, id, prep!.id, {
      cascade: false,
      deps: withRealSchedulerDriver({
        db,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        // 准备本身要卡满 3 秒才失败；若重试是同步的，下面的耗时断言必然超。
        cloneTimeoutMs: 3_000,
        gitBaselineSyncWindowMs: 0,
      }),
    })
    const elapsed = Date.now() - t0
    expect(elapsed, '重试请求必须立刻返回，不能等准备跑完').toBeLessThan(1_500)
    // 而且返回的是「重新准备中」的任务视图：CAS 回 pending 已同步完成。
    expect(returned.status).toBe('pending')
    // 后台确实在推进：等它落定后仍是 failed（远端不可达），且铸出了第二条准备行。
    await settle(db, id)
    const runs = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))).filter(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    expect(runs.length, '后台确实重跑了准备').toBe(2)
  }, 120_000)

  // 三轮门（Codex 契约面）P2：重试铸出的准备行原本写死 `retryIndex:0 / 'initial'`，
  // 于是连续三次尝试在库里、API 里、UI 的「重试」列里全都是「第 0 次、首次」。
  // 执行本身是对的，但历史被永久写成假事实——审计、诊断、按 retryIndex 排序的
  // 调用方全被打乱。
  test('重试铸出的准备行必须递增 retryIndex 并标 retry-node', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep2(db, s, 'ac11-retryindex')
    const { retryNode } = await import('@/services/task')
    const retryOnce = async (): Promise<void> => {
      const latest = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id)))
        .filter((r) => r.nodeId === REPO_PREP_NODE_ID)
        .sort((a, b) => a.retryIndex - b.retryIndex)
        .at(-1)!
      await retryNode(db, id, latest.id, {
        cascade: false,
        deps: withRealSchedulerDriver({
          db,
          actorUserId: s.userId,
          appHome: TEST_HOME,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 1_000,
          gitBaselineSyncWindowMs: 0,
        }),
      })
      await settle(db, id)
    }
    await retryOnce()
    await retryOnce()

    const prepRuns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id)))
      .filter((r) => r.nodeId === REPO_PREP_NODE_ID)
      .sort((a, b) => a.retryIndex - b.retryIndex)
    expect(prepRuns.length).toBe(3)
    expect(
      prepRuns.map((r) => r.retryIndex),
      '三次尝试必须是 0/1/2',
    ).toEqual([0, 1, 2])
    expect(prepRuns.map((r) => r.rerunCause)).toEqual(['initial', 'retry-node', 'retry-node'])
  }, 180_000)
})

// RFC-287 AC-14 —— 取消 / 删除在**准备窗口内**生效。
//
// 三轮门 AC 对账发现这条 AC 一条测试都没有。它不是锦上添花：G7 之前「有任务行就有
// 工作树」，取消面对的永远是一个已经物化好的任务；G7 之后出现了一段**新的窗口**
// ——任务行已在、工作树还没有、后台正卡在 clone 上。这段窗口里点取消，如果只改了
// DB 状态而没打断底层 git，用户看到「已取消」而机器还在拉一个几 GB 的仓，取消就是
// 假的（proposal AC-14 原话要求「底层 git 子进程确实终止」）。
describe('RFC-287 AC-14 —— 准备窗口内的取消', () => {
  test('准备中取消：任务落 canceled，且准备行不是永远 running 的孤儿', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const { cancelTask } = await import('@/services/task')
    const task = await startTask(
      {
        workflowId: s.workflowId,
        name: 'ac14-cancel',
        // 不可路由 + 长超时：确保取消发生在 clone **还在跑**的时候，而不是失败之后。
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 60_000,
        gitBaselineSyncWindowMs: 0,
      } as never,
    )
    // 等准备真的开跑（合成行出现即证明已进入窗口），再取消。
    for (let i = 0; i < 200; i++) {
      const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
      if (runs.some((r) => r.nodeId === REPO_PREP_NODE_ID)) break
      await new Promise((r) => setTimeout(r, 25))
    }
    const t0 = Date.now()
    await cancelTask(db, task.id)
    const cancelMs = Date.now() - t0
    // 取消不得等到 clone 自己超时才回来（60s）——那等于没打断。
    //
    // ⚠️ 这条耗时断言**判别力有限**（四轮门测试有效性自查实测）：把 runGit 的 signal
    // 分支整个关掉、abort 完全不杀 git，它照样绿——因为 `cancelTask` 有约 5 秒的兜底，
    // 到点就把任务写成 canceled，与子进程死没死无关。真正锁「子进程确实被打断」的是
    // `rfc287-t13-git-abort.test.ts`（同一变异在那里红，2 fails / 30s 超时），那是
    // runGit 原语层。这里保留耗时只作粗筛，判别力交给下面的错误码断言。
    expect(cancelMs, '取消必须打断正在跑的 git，而不是等它自己超时').toBeLessThan(20_000)

    const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
    expect(row?.status).toBe('canceled')
    // 准备行不得停在 running：那样恢复扫描与 UI 都会把它当「还在跑」。
    const prep = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))).find(
      (r) => r.nodeId === REPO_PREP_NODE_ID,
    )
    expect(prep, '准备行应已铸出').toBeDefined()
    expect(prep?.status, '取消后准备行不得停在 running').not.toBe('running')
    // AC-15 同样适用：取消不打墓碑，否则之后连重试都 CAS 不回来。
    expect(row?.workspacePrunedAt ?? null).toBeNull()
  }, 120_000)
})

// RFC-287 AC-15 —— 准备失败**不得**被打上工作区墓碑。
//
// 为什么这条要独立锁：墓碑（`workspacePrunedAt`）一旦落下，`setTaskStatus` 会以 410
// `workspace-pruned` 拒绝一切复活，AC-11 的「重试准备仓库」当场作废——而准备失败的
// 任务恰恰是最需要重试的那一类。三轮门 AC 对账查到 AC-15 只有一处顺带断言，没有
// 覆盖真正危险的那个写点：`lifecycle.ts` 的**惰性补写**（发现 worktreePath 指向的
// 目录不存在就补墓碑）。它今天靠 `row.worktreePath !== ''` 这个前置条件避开了准备
// 失败的任务——但那是**巧合级的保护**：谁要是把判据改成「路径为空也算工作区没了」，
// 看起来更严谨，实际会把 AC-11 整条打死，且现有用例一条都不会红。
describe('RFC-287 AC-15 —— 准备失败不打墓碑（AC-11 的地基）', () => {
  test('惰性补墓碑必须跳过 worktreePath 为空的任务', () => {
    const src = readSrc(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'platform',
        'persistence',
        'sqlite',
        'taskLifecycle.ts',
      ),
      'utf8',
    )
    // 补写分支的守卫必须同时要求「路径非空」与「路径不存在」。
    const m = src.match(
      /if \(row\.worktreePath !== '' && !existsSync\(row\.worktreePath\)\) \{[\s\S]{0,400}?workspacePrunedAt: Date\.now\(\)/,
    )
    expect(m, '惰性补墓碑的守卫必须先排除空路径（准备失败的任务正是空路径）').not.toBeNull()
  })

  test('端到端：准备失败的任务上没有墓碑，且能 CAS 回 pending', async () => {
    // 上一条锁的是「守卫写对了」，这条锁的是「墓碑真的没落下、复活真的能走」——
    // 只有源码锁的话，别处再补一个写点就完全测不出来。
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep2(db, s, 'ac15-no-tombstone')
    const before = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
    expect(before?.status).toBe('failed')
    expect(before?.worktreePath ?? '').toBe('')
    expect(before?.workspacePrunedAt ?? null, '准备失败不得打墓碑').toBeNull()

    // 复活闸门：能从 failed CAS 回 pending，就说明墓碑没挡路（AC-11 的前提）。
    const { setTaskStatus } = await import('@/services/lifecycle')
    await setTaskStatus({
      db,
      taskId: id,
      to: 'pending',
      allowedFrom: ['failed'],
      allowTerminal: true,
      reason: 'ac15-probe',
      extra: {},
    } as never)
    const after = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
    expect(after?.status).toBe('pending')
  }, 120_000)
})

// RFC-287 AC-10 —— 不变量从「有任务行就有工作树」改成「`__repo_prep__` done 之后才
// 有」，**服务端的读点必须跟上**。三轮门 AC 对账查到前端已经靠合成行分出了第四态，
// 后端这一半还停在老不变量上。
describe('RFC-287 AC-10 —— 准备阶段的 resume 归因与 auto-resume 跳过', () => {
  test('resume 准备失败的任务：报 task-repo-prep-incomplete，而不是「被 GC 回收」', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep2(db, s, 'ac10-resume')
    const { resumeTask } = await import('@/services/task')
    let code = ''
    let msg = ''
    try {
      await resumeTask(
        db,
        id,
        withRealSchedulerDriver({
          db,
          actorUserId: s.userId,
          appHome: TEST_HOME,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          taskRecoveryOperations: taskRecoveryOperations(db),
        }),
      )
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
      msg = err instanceof Error ? err.message : String(err)
    }
    // 老行为：`existsSync('')` 恒 false ⇒ 410 `task-worktree-missing`，文案写
    // 「likely reclaimed by worktree GC」。工作树从来没建出来过，谈不上被回收；
    // 而且它把用户指向「另起任务」，与 AC-11 的「重试准备」正好相反。
    expect(code).toBe('task-repo-prep-incomplete')
    expect(msg, '不得再把没建出来说成被回收').not.toMatch(/reclaimed by worktree GC/i)
    expect(msg, '要指向重试准备这一步').toMatch(/preparation/i)
  }, 120_000)

  // ⚠️ 本条的口径在四轮门被**翻面**了。原来锁的是「跳过且不烧熔断」——那是我按
  // 「boot 时自动重跑一次可能很贵的 clone」的顾虑做的保守选择，但 plan.md T13⑥
  // 白纸黑字要求「boot reap / auto-resume 识别『准备未完成』**改重跑准备**」
  // （Codex 并发面按固定 plan 对出来的）。用户重启 daemon 时期望的是它把仓库继续
  // 准备好，而不是留一个要手点重试的任务。
  //
  // 现在的契约：不传 `retryRepoPrep` ⇒ 退回跳过（老调用方不受影响）；传了 ⇒ 走重跑，
  // 并且**计熔断**（一个永远拉不动的远端应当在 N 次后被隔离，否则每次 boot 白跑一轮）。
  test('不传 retryRepoPrep 时退回跳过（向后兼容）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep2(db, s, 'ac10-autoresume')
    // 造成 boot reap 之后的形态：任务 interrupted + daemon-restart 摘要。
    const { DAEMON_RESTART_ERROR_SUMMARY } = await import('@agent-workflow/shared')
    await db
      .update(tasks)
      .set({ status: 'interrupted', errorSummary: DAEMON_RESTART_ERROR_SUMMARY })
      .where(eq(tasks.id, id))

    const { autoResumeInterruptedTasks } = await import('@/services/autoResume')
    let resumeCalls = 0
    const operations = taskRecoveryOperations(db)
    const r = await autoResumeInterruptedTasks({
      operations,
      breaker: { maxPerWindow: 3, windowMs: 60_000 },
      resume: async () => {
        resumeCalls += 1
      },
      now: () => Date.now(),
    })
    // 关键：连 resume 都不该被调用——调用了就必然失败、就会被熔断器计数，
    // 每次 boot 烧一次，N 次之后这行任务被隔离，且恢复审计里全是归因错误的告警。
    expect(resumeCalls, 'auto-resume 不得对准备阶段任务发起 resume').toBe(0)
    expect(r.resumed).not.toContain(id)
    expect(r.skipped).toContain(id)
    // 「不烧熔断」这半原来只在标题里、没有断言（四轮门自查实测：在 skip 之前插一句
    // recordAutoRecoveryAttempt，用例照样全绿，而那正是它要防的损害）。跑满
    // maxPerWindow+1 轮，任务必须仍在 skipped、且从未被隔离。
    const { isAutoRecoverySuspended } = await import('@/services/recoveryBreaker')
    for (let i = 0; i < 4; i++) {
      const again = await autoResumeInterruptedTasks({
        operations,
        breaker: { maxPerWindow: 3, windowMs: 60_000 },
        resume: async () => {
          resumeCalls += 1
        },
        now: () => Date.now(),
      })
      expect(again.skipped).toContain(id)
    }
    expect(await isAutoRecoverySuspended(operations, id), '退回跳过时不得烧熔断').toBe(false)
  }, 120_000)

  test('传了 retryRepoPrep 时改重跑准备（plan T13⑥），且不走 resume', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep2(db, s, 'ac10-boot-reprep')
    const { DAEMON_RESTART_ERROR_SUMMARY } = await import('@agent-workflow/shared')
    await db
      .update(tasks)
      .set({ status: 'interrupted', errorSummary: DAEMON_RESTART_ERROR_SUMMARY })
      .where(eq(tasks.id, id))

    const { autoResumeInterruptedTasks } = await import('@/services/autoResume')
    let resumeCalls = 0
    const prepped: string[] = []
    const operations = taskRecoveryOperations(db)
    const r = await autoResumeInterruptedTasks({
      operations,
      breaker: { maxPerWindow: 3, windowMs: 60_000 },
      resume: async () => {
        resumeCalls += 1
      },
      retryRepoPrep: async (taskId: string) => {
        prepped.push(taskId)
      },
      now: () => Date.now(),
    })
    // 关键：走的是重跑准备那条，**不是** resume（resume 对它必然
    // `task-repo-prep-incomplete`）。
    expect(prepped, '应当重跑准备').toContain(id)
    expect(resumeCalls, '不得走 resume').toBe(0)
    expect(r.resumed).toContain(id)

    // 「熔断仍然计」这半原来零覆盖（五轮门自查实测：把 autoResume 里的
    // isAutoRecoverySuspended + recordAutoRecoveryAttempt 两道门整段删掉，用例全绿
    // ——而那正是「每次 boot 对一个永远拉不动的远端白跑一轮克隆」）。
    const { isAutoRecoverySuspended } = await import('@/services/recoveryBreaker')
    const before = prepped.length
    for (let i = 0; i < 5; i++) {
      await autoResumeInterruptedTasks({
        operations,
        breaker: { maxPerWindow: 3, windowMs: 60_000 },
        resume: async () => {
          resumeCalls += 1
        },
        retryRepoPrep: async (taskId: string) => {
          prepped.push(taskId)
        },
        now: () => Date.now(),
      })
    }
    expect(await isAutoRecoverySuspended(operations, id), '超过窗口配额必须隔离').toBe(true)
    expect(prepped.length - before, '隔离之后不得继续白跑克隆').toBeLessThan(5)
  }, 120_000)
})

// 三轮实现门**并发面**（我自己那路）抓到的四条，逐条上锁。两条 P0 各自能把任务打成
// 「不可重试、不可恢复、不可删除，只能重启 daemon」的永久楔死态，且都落在 G7 准备
// 窗口这条**每次 JSON-body 启动都要经过**的路径上。
describe('RFC-287 三轮门并发面 —— 准备窗口的两条 P0', () => {
  test('F2：优雅停机不得被当成用户取消（否则任务永久楔死）', async () => {
    // 停机与用户取消**共用同一个 AbortSignal**，只有 `reason` 不同。上一版的取消分支
    // 只判 `aborted`，于是 daemon 优雅停机时准备行落**终态 canceled**；随后 boot reap
    // 把任务翻 interrupted 却改不动已终态的行，而 RETRYABLE_PREP_STATUSES 只认
    // failed/interrupted ⇒ 重试撞 repo-prep-not-retryable、resume 撞
    // task-repo-prep-incomplete、auto-resume 按设计跳过，只剩删任务重开。
    // 这恰好把 AC-16 那扇刚修好的门（认 interrupted）从 canceled 这一侧又打开。
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const { DAEMON_SHUTDOWN_ABORT_REASON } = await import('@agent-workflow/shared')
    // 用生产入口 `abortAllActiveTasks`——`gracefulShutdown` 走的正是这一条
    // （shutdown.ts 里 `abortAllActiveTasks(DAEMON_SHUTDOWN_ABORT_REASON)`）。
    const { abortAllActiveTasks } = await import('@/services/task')

    const task = await startTask(
      {
        workflowId: s.workflowId,
        name: 'f2-shutdown',
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 60_000,
        gitBaselineSyncWindowMs: 0,
      } as never,
    )
    // 等准备真的开跑，再模拟优雅停机（带 reason 的 abort）。
    for (let i = 0; i < 200; i++) {
      const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
      if (runs.some((r) => r.nodeId === REPO_PREP_NODE_ID)) break
      await new Promise((r) => setTimeout(r, 25))
    }
    const aborted = abortAllActiveTasks(DAEMON_SHUTDOWN_ABORT_REASON)
    expect(aborted, '前提不成立：准备段没被 abort 到，本用例此刻零预言力').toContain(task.id)

    // 等准备行落终态。
    let prep: { status: string } | undefined
    for (let i = 0; i < 400; i++) {
      prep = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))).find(
        (r) => r.nodeId === REPO_PREP_NODE_ID,
      )
      if (prep !== undefined && prep.status !== 'running' && prep.status !== 'pending') break
      await new Promise((r) => setTimeout(r, 25))
    }
    // 关键：停机 ⇒ interrupted（可重试），**不是** canceled（终态且不可重试）。
    expect(prep?.status, '停机中断的准备行必须可恢复').toBe('interrupted')
    expect(prep?.status).not.toBe('canceled')
    // 且它确实落在 AC-16 的可重试集里——这才是「不楔死」的实际含义。
    expect(['failed', 'interrupted']).toContain(prep!.status)
  }, 120_000)

  test('F1：任务离开准备窗口时必须还租约（否则 isTaskActive 恒真、只能重启 daemon）', async () => {
    // `runDeferredRepoPreparation` 的 branch-3（物化成功但任务已离开 pending）此前
    // 只清物化产物就 return，**不还租约**。首启侥幸被外层闭包的 finally 兜住，而
    // 重试路径没有那层（它把 runTask 用 void 发出去，不能无条件在闭包里 release）。
    // 漏掉之后 `isTaskActive` 恒真 ⇒ retryNode/resume 409 task-still-running、
    // deleteTask 409 task-active、gc 与 orphanReconcile 永久跳过、
    // awaitTaskDriverStopped 永不 resolve。
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    // 判据已扩成「状态离开 pending **或**信号已 abort」——取消是「先 abort、5 秒后
    // 才写状态」，只看状态会漏掉「物化恰好在这段窗口里成功」的那一支。
    const i = src.indexOf("if (stillPending !== 'pending' || signal.aborted) {")
    expect(i, 'branch-3 应存在').toBeGreaterThan(-1)
    const body = src.slice(i, src.indexOf('\n  }\n', i))
    // F4 同处：准备行不得留在 running（恢复扫描会把它当还在跑）。
    expect(body, '该出口必须终结准备行').toMatch(
      /setNodeRunStatus\(\{[\s\S]{0,300}nodeRunId: prepRunId/,
    )
    expect(body).toContain('repo-prep-task-left-window')
    // RFC-332：租约释放成为 coordinator 的唯一 finally，不再由准备分支各自释放。
    const coordinator = readSrc(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'application',
        'drive',
        'taskDriveCoordinator.ts',
      ),
      'utf8',
    )
    expect(coordinator).toMatch(
      /finally \{[\s\S]{0,180}this\.options\.lifecycle\.releaseAndFinalize\(/,
    )
  })

  test('F3：冷克隆在 INSERT 前必须复读（两把锁分家后会撞 UNIQUE）', () => {
    // 身份登记走独立的 withIdentityLock（刻意的：共用会让第二次启动堵满整个克隆
    // 超时）。代价是克隆期间身份行可能被插进来，冷路径若照旧 INSERT 就撞
    // cached_repos.url_hash 唯一索引，抛一句无错误码的裸 SQLite 串。
    const src = readSrc(
      resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf8',
    )
    expect(src).toMatch(/const adoptId =[\s\S]{0,400}findCachedRepoByHash\(hash\)/)
    expect(src, '领养分支要用复读到的 id').toMatch(/if \(adoptId !== null\)/)
    // F5：那句「与 resolveCachedRepo 共用同一把 per-URL 锁」在拆锁后是假命题，
    // 正是它让 F3 在评审里隐形。不得复辟。
    expect(src, '不得再声称两者共用同一把锁').not.toContain(
      '与 `resolveCachedRepo` 共用同一把 per-URL 锁',
    )
  })
})

// RFC-287 AC-14 —— 取消必须**穿透到子模块同步**（三轮门 Codex 并发面 P1；我自己
// 那路漏了这条，两路互补才补全）。
//
// `git.ts` 建树那一步传了 signal，紧接着进 `syncSubmodules` 就断线——本模块此前
// 一个 `signal` 都没有。于是 `worktree add` 成功之后（大子模块的 checkout 可以跑
// 很久）取消只 abort 了 controller：5 秒兜底把任务写成 canceled，而 git 还活着、
// 准备行还是 running、租约还被持有 ⇒ 重试 409 task-still-running、删除 409
// task-active。AC-14 原话要求「底层 git 子进程确实终止」。
describe('RFC-287 AC-14 —— 终止条件必须穿透子模块同步', () => {
  test('syncSubmodules 把 signal 注入每一次 git 调用', async () => {
    const { syncSubmodules } = await import('@/services/gitSubmodule')
    const seen: Array<{ args: string; signal: AbortSignal | undefined }> = []
    const ac = new AbortController()
    await syncSubmodules('/tmp/does-not-matter', {
      mode: 'always',
      jobs: 1,
      signal: ac.signal,
      runGitImpl: (async (_cwd: string, args: string[], o?: { signal?: AbortSignal }) => {
        seen.push({ args: args.join(' '), signal: o?.signal })
        // ⚠️ 必须返回 **0**：四轮门测试有效性自查实测，桩一旦返回 1，`syncSubmodules`
        // 在 `submodule sync` 那一步就走失败分支 return，`seen` 只有一条 ⇒ 下面的
        // for 循环只跑一次迭代。于是「把注入拆掉、只在第一次调用手动带上 signal」
        // 这种变异**全绿**，而真正的 AC-14 危险点 `submodule update --checkout`
        // （那次长 checkout 才是取消要杀的东西）根本没被观测到。
        return { exitCode: 0, stdout: '', stderr: '' }
      }) as never,
    } as never)
    // 至少要走到 `submodule update`，否则这条锁不到 AC-14 的危险点。
    expect(seen.length, 'sync + update 两步都要被观测到').toBeGreaterThanOrEqual(2)
    expect(
      seen.some((s) => s.args.includes('submodule update')),
      '必须观测到 submodule update（长 checkout 才是取消要杀的那步）',
    ).toBe(true)
    // 关键：每一次都带上了同一个 signal——注入点在 `run` 那一层，覆盖全部调用。
    for (const s of seen) expect(s.signal).toBe(ac.signal)
  })

  test('不给 signal 时行为逐字不变（不得顺手改变既有调用面）', async () => {
    const { syncSubmodules } = await import('@/services/gitSubmodule')
    const seen: Array<unknown> = []
    await syncSubmodules('/tmp/does-not-matter', {
      mode: 'always',
      jobs: 1,
      runGitImpl: (async (_cwd: string, _args: string[], o?: unknown) => {
        seen.push(o)
        return { exitCode: 1, stdout: '', stderr: 'stub' }
      }) as never,
    } as never)
    expect(seen.length).toBeGreaterThan(0)
    // 没给终止条件时应当**原样**透传调用方自己的 opts（这里是 undefined），
    // 而不是被包装成一个空对象——包装层在这种情况下必须整个短路掉。
    expect(seen[0]).toBeUndefined()
  })

  test('建树调用点确实把 signal 传给了子模块同步', () => {
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'util', 'git.ts'), 'utf8')
    const i = src.indexOf('return await syncSubmodules(worktreePath, {')
    expect(i).toBeGreaterThan(-1)
    // 边界取**同缩进的收尾行**，不能用第一个 `})`——内层 `{ remote: true }` 的
    // 那个会先命中，切出来的片段根本没到 signal 那行（实撞）。
    const body = src.slice(i, src.indexOf('\n      })', i))
    expect(body, '建树成功后这一段必须继续受取消约束').toContain('signal: opts.signal')
  })

  test('URL 锁临界区里的子模块同步必须有界（否则永久占住该 URL 的队列）', () => {
    const src = readSrc(
      resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf8',
    )
    // 两处都在 withUrlLock 里：warm 复用路径与手动刷新路径。
    const hits = [...src.matchAll(/syncSubmodules\(row\.localPath, \{[\s\S]{0,1400}?\n {4,6}\}\)/g)]
    expect(hits.length, '应有两处（warm 复用 + 手动刷新）').toBe(2)
    for (const h of hits) expect(h[0]).toContain('timeoutMs:')
    // warm 复用那一处还必须接上 signal——上一笔只补了 timeout，于是 warm 镜像路径上
    // 取消依旧杀不掉 git（四轮门 Codex 实测）。cold 那处的 signal 由 resolveCachedRepo
    // 的调用方给，这里只锁 warm。
    // ⚠️ 必须**按位置**判，不能 `.some()`（五轮门自查实测：把 signal 从 warm 挪到手动
    // 刷新点——正是四轮门 Codex 抓的那条 P1——`.some()` 照样绿）。文件序：warm 复用在前、
    // 手动刷新在后。
    expect(hits[0]?.[0], 'warm 复用路径必须把 signal 传进子模块同步').toContain(
      'signal: deps.signal',
    )
  })
})

// RFC-287（三轮门 Codex 并发面 P1 后半）—— 半成品镜像目录此前**只有生产者、零消费者**。
// 冷克隆先写 `repos/<hash>-<slug>.partial-<ULID>/` 再原子 rename；SIGKILL 落在中途时
// 目录留在磁盘上，而全仓没有任何扫描认这个命名。本 session 实测：真实 home 的
// `repos/` 下攒了 13 个 `…-nope.partial-*`，全是测试留下的。
describe('RFC-287 —— 半成品镜像目录的回收', () => {
  test('到龄的 .partial-* 被清掉，未到龄的与正常镜像一律不动', async () => {
    const { runPartialCloneGc } = await import('@/services/gc')
    const { mkdirSync, existsSync, utimesSync } = await import('node:fs')
    const home = mkdtempSync(join(tmpdir(), 'aw-partialgc-'))
    const repos = join(home, 'repos')
    mkdirSync(repos, { recursive: true })

    const stale = join(repos, 'abc12345-myrepo~partial~01KZZZZZZZZZZZZZZZZZZZZZZZ')
    const fresh = join(repos, 'abc12345-myrepo~partial~01KZZZZZZZZZZZZZZZZZZZZZZA')
    const canonical = join(repos, 'abc12345-myrepo')
    for (const d of [stale, fresh, canonical]) mkdirSync(d, { recursive: true })
    // 把 stale 的 mtime 推到 48 小时前。
    const old = new Date(Date.now() - 48 * 3600_000)
    utimesSync(stale, old, old)

    const r = await runPartialCloneGc(home)
    expect(existsSync(stale), '到龄的半成品必须被清掉').toBe(false)
    expect(existsSync(fresh), '未到龄的可能正在被写入，不得删').toBe(true)
    expect(existsSync(canonical), '正常镜像目录一律不碰').toBe(true)
    expect(r.removed.length).toBe(1)
    // 扫描面只认带 `.partial-` 的目录，canonical 不计入。
    expect(r.scanned).toBe(2)

    rmSync(home, { recursive: true, force: true })
  })

  // 四轮门 Codex 实测的**数据丢失级**缺陷：判据一度是 `name.includes('.partial-')`，
  // 而 `cacheSlug` 刻意保留点与横线，于是一个名字里本来就带 `.partial-` 的**合法**
  // 仓库（`https://host/org/foo.partial-bar.git` ⇒ `<hash>-foo.partial-bar`）会被整个
  // 删掉——而 `cached_repos.local_path` 还指着它，既存运行任务的工作树跟着失效。
  test('名字里带 .partial- 的合法镜像不得被误删（ULID 必须锚在结尾）', async () => {
    const { runPartialCloneGc } = await import('@/services/gc')
    const { mkdirSync, existsSync, utimesSync } = await import('node:fs')
    const home = mkdtempSync(join(tmpdir(), 'aw-partialgc-lookalike-'))
    const repos = join(home, 'repos')
    mkdirSync(repos, { recursive: true })
    // 合法镜像：仓库名自带 `.partial-bar`，结尾**不是** ULID。
    const legit = join(repos, 'abc12345-foo.partial-bar')
    // 真半成品：结尾是 26 位 Crockford base32。
    const real = join(repos, 'abc12345-foo~partial~01KZZZZZZZZZZZZZZZZZZZZZZZ')
    for (const d of [legit, real]) mkdirSync(d, { recursive: true })
    const old = new Date(Date.now() - 48 * 3600_000)
    utimesSync(legit, old, old)
    utimesSync(real, old, old)

    const r = await runPartialCloneGc(home)
    expect(existsSync(legit), '合法镜像绝不能被删').toBe(true)
    expect(existsSync(real)).toBe(false)
    expect(r.scanned, '只有真半成品进扫描面').toBe(1)
  })

  test('年龄阈值随配置的克隆超时放大（长超时下不得删掉仍在写的 partial）', async () => {
    const { runPartialCloneGc } = await import('@/services/gc')
    const { mkdirSync, existsSync, utimesSync } = await import('node:fs')
    const home = mkdtempSync(join(tmpdir(), 'aw-partialgc-timeout-'))
    const repos = join(home, 'repos')
    mkdirSync(repos, { recursive: true })
    const dir = join(repos, 'abc12345-slow~partial~01KZZZZZZZZZZZZZZZZZZZZZZZ')
    mkdirSync(dir, { recursive: true })
    // 30 小时前建的：默认 24h 判据会删，但配置了 48h 克隆超时时它可能还在写
    // （顶层 mtime 不随 .git/objects/pack 的写入更新）。
    const old = new Date(Date.now() - 30 * 3600_000)
    utimesSync(dir, old, old)

    expect((await runPartialCloneGc(home, Date.now(), 48 * 3600_000)).removed.length).toBe(0)
    expect(existsSync(dir), '长克隆超时下不得删').toBe(true)
    // 不给超时（或超时很短）时仍按 24h 收。
    expect((await runPartialCloneGc(home)).removed.length).toBe(1)
    expect(existsSync(dir)).toBe(false)

    rmSync(home, { recursive: true, force: true })
  })

  test('repos 目录不存在时安全返回（首次启动 / 从未克隆过）', async () => {
    const { runPartialCloneGc } = await import('@/services/gc')
    const home = mkdtempSync(join(tmpdir(), 'aw-partialgc-empty-'))
    expect(await runPartialCloneGc(home)).toEqual({ scanned: 0, removed: [] })
    rmSync(home, { recursive: true, force: true })
  })

  test('已挂进每小时 GC（否则函数写了也没人调）', () => {
    const src = readSrc(
      resolve(import.meta.dir, '..', 'src', 'platform', 'background', 'maintenanceJobRunner.ts'),
      'utf8',
    )
    // 光有实现不算数——二轮门自查的老教训：判据算得对 ≠ 有人用。
    const i = src.indexOf("case 'worktreeGc':")
    expect(i, 'GC ticker 应存在').toBeGreaterThan(-1)
    const ticker = src.slice(i, i + 1600)
    expect(ticker).toContain('ownerCommands.workspace.runGcPhase({')
    // 两个参数都得接上：年龄阈值要随配置的克隆超时放大（否则长超时下会删掉仍在写的
    // partial），而删除必须 await（同步 rmSync 一个接近完整镜像体量的目录会把 Bun 的
    // 单事件循环冻住，取消请求与 timer 全排在它后面）。
    expect(ticker, '必须把 gitCloneTimeoutMs 传下去').toContain('gitCloneTimeoutMs:')
    expect(ticker, '调用点要 await').toMatch(/await ownerCommands\.workspace\.runGcPhase\(/)
    // ⚠️ 上面那条测的是**调用点**的 await，与「删除原语是不是同步的」完全两码事
    // ——五轮门自查实测：把函数体里的 `await rm` 改回 `rmSync`，用例全绿（函数是
    // async，rmSync 照样过 typecheck）。真正要防的是同步递归删除冻住 Bun 的单事件
    // 循环，所以锁必须落在函数体本身。
    const gcSrc = readSrc(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'source-control',
        'infrastructure',
        'nodeWorkspaceMaintenanceFilesystem.ts',
      ),
      'utf8',
    )
    const at = gcSrc.indexOf('async runPartialCloneGc(')
    const fn = gcSrc.slice(at, gcSrc.indexOf('\n    },', at))
    expect(fn, '必须用异步 rm').toMatch(/await rm\(path/)
    expect(fn, '不得退回同步 rmSync').not.toMatch(/rmSync\(path/)
  })
})

// RFC-287 第五轮门 · 对抗面的两条 P1。两条都精确落在**本 RFC 新增的面**上，且都
// 是「我上一轮的修复没关上」——不是原始需求没做。
describe('RFC-287 五轮门 —— 对抗输入', () => {
  test('F1：合法仓库名不得与半成品目录同形（分隔符必须是 slug 产不出的字符）', async () => {
    const { gitUrlCacheKeyWith, parseGitUrl } = await import('@agent-workflow/shared')
    const { sha1Hex } = await import('@/util/hash')
    const src = readSrc(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'source-control',
        'infrastructure',
        'nodeWorkspaceMaintenanceFilesystem.ts',
      ),
      'utf8',
    )
    const m = src.match(/const PARTIAL_CLONE_DIRECTORY = (\/.+\/)\n/)
    expect(m, 'GC 应有半成品判据').not.toBeNull()
    const re = new RegExp(m![1]!.slice(1, -1))

    // 四轮门那版判据（`.partial-<ULID>` 锚结尾）在这个输入上**误命中**：
    // cacheSlug 的白名单是 [A-Za-z0-9._-]，既产得出 `.partial-` 也产得出 26 位
    // Crockford base32，于是这个**正常**仓库的 canonical 镜像目录与半成品逐字同形，
    // 会被整个 rm -rf，而 cached_repos.local_path 还指着它。
    const hostile = 'https://github.com/acme/foo.partial-01ARZ3NDEKTSV4RRFFQ69G5FAV.git'
    const k = gitUrlCacheKeyWith(parseGitUrl(hostile) as never, sha1Hex)
    const canonical = `${k.hash}-${k.slug}`
    expect(canonical, '前提复核：这个仓库名确实产出带 .partial-<ULID> 的目录').toMatch(
      /\.partial-[0-9A-HJKMNP-TV-Z]{26}$/,
    )
    expect(re.test(canonical), '合法镜像目录绝不能被判成半成品').toBe(false)

    // 反向：真半成品仍必须被认出来。分隔符取自生产者本身，避免两边各写各的。
    const cache = readSrc(
      resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf8',
    )
    const sep = cache.match(/\$\{slug\}(.+?)\$\{ulid\(\)\}/)
    expect(sep, '生产者应有半成品目录命名').not.toBeNull()
    expect(re.test(`abc12345-any${sep![1]!}01ARZ3NDEKTSV4RRFFQ69G5FAV`)).toBe(true)
    // 分隔符必须用 slug **产不出**的字符——这才是结构性正解（正则收窄只是缩小窗口）。
    expect(sep![1]!, '分隔符必须落在 [A-Za-z0-9._-] 之外').toMatch(/[^A-Za-z0-9._-]/)
  })

  test('F2：ref 不得被当成 git 选项（--lock 会让工作树永久锁死、AC-11 承诺失效）', () => {
    // `git rev-parse` 对不认识的 flag **以 exit 0 原样回显**，于是 ref="--lock" 会一路
    // 穿到 `worktree add` 的 argv 里被当成选项：工作树建成且被锁，prune exit 0 但不清、
    // remove --force 128 ⇒ AC-11 重试永久撞 "missing but locked worktree"，而本 RFC 新加
    // 的 reclaimStalePrepArtifacts 三步全 exit 0、对锁定注册项完全免疫。
    // 本 RFC 还把 ref 持久化进 base_branch 并在每次重试/boot 重放 ⇒ 一次性输入变永久毒化。
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'util', 'git.ts'), 'utf8')
    const i = src.indexOf('const baseRev = await runGit(')
    expect(i).toBeGreaterThan(-1)
    const call = src.slice(i, src.indexOf('\n  )', i) + 4)
    expect(call, '必须 --verify（拒绝非 revision）').toContain("'--verify'")
    expect(call, '必须 ^{commit}（强制解析到提交）').toContain('^{commit}')
    expect(call, '必须 -- 终结选项解析').toMatch(/,\s*'--'\s*\]/)
    expect(call, '不得退回裸 rev-parse').not.toMatch(/\['rev-parse', base\]/)
  })
})

// RFC-287 五轮门 · Codex「专审第四轮修复」抓到的 6 条新回归 + 1 条没修净的老问题。
// 共同点:全部是**修复自身的收尾**没做干净,不是原始需求没做。
describe('RFC-287 五轮门 —— 第四轮修复的收尾', () => {
  const reclaim = (): string => {
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    const i = src.indexOf('async function reclaimStalePrepArtifacts(')
    expect(i, '应有 reclaimStalePrepArtifacts').toBeGreaterThan(-1)
    return src.slice(i, src.indexOf('\n}\n', i))
  }

  test('F8：准备行的「更新的尝试」判据用 retryIndex，不用 id 序', () => {
    // `nodeRunMint` 用普通 `ulid()` 而非 monotonicFactory —— 实测同毫秒 2000 对里
    // 989 对「后生成的反而更小」。一度为了让 G8 ratchet 变绿改用 id 序比较器，
    // 结果同毫秒铸出的两条准备行会被判反、两边都点不动。
    // `__repo_prep__` 没有 clarify/parent/iteration 分叉，retryIndex 就是因果序。
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    const i = src.indexOf("'repo-prep-superseded'")
    expect(i).toBeGreaterThan(-1)
    const around = src.slice(Math.max(0, i - 1200), i)
    expect(around, '必须按 retryIndex 判').toMatch(/r\.retryIndex > runRow\.retryIndex/)
    expect(around, '不得用 id 序比较器（ULID 同毫秒不单调）').not.toContain('isFresherNodeRun(r,')
  })

  test('F3：多次挂载同一镜像时，带后缀的隔离分支也要回收', () => {
    // 同一 cached repo 在仓库组里可挂多次，第 2 份起分支是 `…/{taskId}-2`。只删不带
    // 后缀那条 ⇒ 第二仓建树永远撞 "branch already exists"，每次重试复现、无法自愈。
    const body = reclaim()
    expect(body, '必须按前缀枚举而不是只删一条').toContain('for-each-ref')
    expect(body).toContain('${task.id}-*')
    expect(body, '不得退回单条删除').not.toMatch(
      /const ref = `refs\/heads\/agent-workflow\/\$\{task\.id\}`/,
    )
  })

  test('F4：删除残留 worktree 必须异步（本函数在请求路径上）', () => {
    // 它跑在 retryRepoPreparation 的后台分叉**之前**，同步递归删除一个几十 GB 的
    // 残留 worktree 会把 Bun 的单事件循环冻到遍历结束。
    const body = reclaim()
    expect(body).toMatch(/await rm\(leaf/)
    expect(body, '不得退回同步 rmSync').not.toMatch(/rmSync\(leaf/)
  })

  test('F5：目录扫描抛出不得穿出去（否则租约泄漏、任务永久卡 pending）', () => {
    // 本函数在 CAS 回 pending + attach 租约之后、后台补偿闭包之前。readdirSync 裸在
    // try 外时，把 worktrees 换成普通文件就能让它抛 ENOTDIR ⇒ 无人 release 租约。
    const body = reclaim()
    const at = body.indexOf('readdirSync(')
    expect(at).toBeGreaterThan(-1)
    // readdirSync 之前必须已经进了 try。
    const before = body.slice(0, at)
    expect(before.lastIndexOf('try {'), 'readdirSync 必须在 try 内').toBeGreaterThan(
      before.lastIndexOf('} catch'),
    )
  })

  test('F6：worktree prune 必须持 registry 锁（与 add/remove 同一把）', () => {
    // prune 会改 common-dir registry：不持锁时会观察并删掉另一个任务正在 add 的
    // 半初始化注册项。util/git.ts 的锁注释里记着这类真实事故。
    const body = reclaim()
    expect(body).toMatch(/withWorktreeRegistryLock\([\s\S]{0,160}'worktree', 'prune'/)
  })

  test('F1：引用计数必须用领养后的真实行 id（不是可能为幽灵的那个）', () => {
    const src = readSrc(
      resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf8',
    )
    // 冷路径返回处的计数与 `cached.id` 同源。
    expect(src).toMatch(/await deps\.store\.cachedRepoReferenceCount\(rowId\)/)
    expect(src, '不得对幽灵 id 计数').not.toMatch(
      /await deps\.store\.cachedRepoReferenceCount\(id\)/,
    )
  })
})

// 五轮门 F2（用户拍板）：准备行置 done 必须与回填**同事务**。
// 分成两个事务时存在一段必经中间态（三张投影表已提交、prep 还是 running），崩溃落在
// 那里 ⇒ 任务能跑完全部业务节点而审计历史永久停在「准备被中断」，且违反 AC-10。
describe('RFC-287 五轮门 —— 回填与准备行 done 的原子性', () => {
  test('回填与 setNodeRunStatusTx 共用一个事务回调（不是事务后的下一次 await）', () => {
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    // 无 effect 上下文时由 SQLite 兼容事务消费该回调；有上下文时走 closed
    // workspace-preparation settlement DTO，由 provider infrastructure 把 effect 与
    // 同一份投影写进一个事务，不能把 DbTx callback 暴露到 application port。
    const at = src.indexOf(
      'const persistPreparedProjection = (tx: LegacySqliteTaskTransaction): void => {',
    )
    expect(at, '应有唯一的准备投影事务回调').toBeGreaterThan(-1)
    // 回调体用**括号配平**切（内层还有多个 `})`，取第一个会切在半路）。
    const open = src.indexOf('{', at)
    let depth = 1
    let i = open + 1
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
    }
    const tx = src.slice(open + 1, i - 1)
    const txEnd = i
    expect(tx, '任务投影回填必须在事务回调内').toMatch(/tx\.update\(tasks\)/)
    expect(tx, 'prep 置 done 必须在事务内').toMatch(
      /setNodeRunStatusTx\(\{[\s\S]{0,200}nodeRunId: prepRunId[\s\S]{0,120}to: 'done'/,
    )
    // 两条执行路径都保持原子性；effect 路径只能传 closed projection，不能把
    // SQLite transaction callback 穿过 provider-neutral contract。
    const after = src.slice(txEnd)
    expect(after.slice(0, 900), '兼容路径必须把完整回调交给 dbTxSync').toMatch(
      /dbTxSync\(deps\.db, persistPreparedProjection\)/,
    )
    expect(after.slice(0, 1_800), 'effect 路径必须调用具名 workspace settlement port').toMatch(
      /await prepEffect\.succeedWorkspacePreparation\([\s\S]{0,1400}repositories: preparedRepoRows/,
    )
    expect(after.slice(0, 1_800), 'effect 路径不得透传 SQLite transaction callback').not.toMatch(
      /succeedWorkspacePreparation\([\s\S]{0,1400}persistPreparedProjection/,
    )
    // 反向：事务**之后**不得再有一次异步的 prep-done 写入（那就是旧形态）。
    expect(after.slice(0, 600), '事务后不得再异步置 done').not.toMatch(
      /await setNodeRunStatus\(\{[\s\S]{0,200}nodeRunId: prepRunId[\s\S]{0,120}to: 'done'/,
    )
  })
})

// AC-9 的**正向**那半：「网络类失败在窗口内重试并最终成功」。
// 五轮门终局对账点名它零用例——现有 G6 夹具全是黑洞地址（永不可能成功），所以把
// 整个重试循环删掉也不会翻红，G6 的价值从未被兑现过。
// 这里造一个 **fail-once** 远端：先关着端口让首次克隆失败，2.5 秒后在同一端口起真
// git smart-HTTP，窗口内的下一次退避重试就该成功。
describe('RFC-287 AC-9 —— 网络类失败在窗口内重试并最终成功', () => {
  // AC-9 的**正向**那半。五轮门终局对账点名它零用例——既有 G6 夹具全是黑洞地址
  // （永不可能成功），所以把整个重试循环删掉也不会翻红，G6 的价值从未被兑现。
  //
  // ⚠️ 为什么不用「真远端先挂后起」的夹具（试了三版，全部在 CI 与本地都不稳）：
  //   ①路径 404 被分类器判 **permanent**（合理），压根不进窗口；
  //   ②连接被拒那次尝试**握着 `withUrlLock`**，后续尝试撞 `resolveCachedRepo(...)
  //     timed out`，那是锁等待超时、不是网络失败；
  //   ③「先 listen(0) 拿端口再 close」的端口在 4 分片并发的 CI 上会被别的测试抢走
  //     （实撞：ubuntu 18ms 就红，连首次克隆都没跑到）。
  // 三者叠在一起，夹具是在和生产的锁/超时机制正面打架，而不是在验 G6。
  //
  // 改为**按窗口循环的判据面**验，这正是「重试并最终成功」依赖的那一条：只要一次
  // 失败被判为可重试且窗口还有余量，循环就必须再跑一轮 —— 删掉 `isRetryableGitFailure`
  // 那道判据或把循环改成单次，下面的断言立刻红（已变异实证）。
  test('可重试 + 窗口有余 ⇒ 必须再跑一轮（重试循环的存续判据）', () => {
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    const at = src.indexOf('let backoffMs = 1_000')
    expect(at, '应有窗口重试循环').toBeGreaterThan(-1)
    const loop = src.slice(at, src.indexOf('\n  if (prepared.earlyError !== null', at))
    // ①循环体存在且真的会重跑物化（不是只算一遍）。
    expect(loop).toMatch(/for \(;;\) \{/)
    expect(loop).toMatch(/prepared = await materializeSpace\(/)
    // ②成功即出（earlyError 为 null 就 break）——否则会白转满窗口。
    expect(loop).toMatch(/if \(prepared\.earlyError === null\) break/)
    // ③**先判可重试、再看窗口**：反过来会让永久失败也白耗一次退避。
    const retryAt = loop.indexOf('isRetryableGitFailure(')
    const windowAt = loop.indexOf('windowDeadline - Date.now()')
    expect(retryAt, '必须有可重试判据').toBeGreaterThan(-1)
    expect(windowAt, '必须有窗口判据').toBeGreaterThan(-1)
    expect(retryAt, '先判可重试、再看窗口').toBeLessThan(windowAt)
    // ④退避睡穿窗口时不再起新一轮（「最多等 W」这句话才成立）。
    expect(loop).toMatch(/if \(backoffMs >= remaining\) break/)
    // ⑤退避真的在增长（固定间隔会把窗口耗成密集重试）。
    expect(loop).toMatch(/backoffMs = Math\.min\(backoffMs \* 2/)
  })

  // 分类器那一半（「什么算网络类」）由 `shared/tests/rfc287-git-failure-class.test.ts`
  // 按行为直测，含 5xx/429/HTTP 版本形态与 permanent-first 顺序；两边合起来覆盖
  // 「网络类失败 → 进窗口 → 再跑一轮 → 成功即出」的完整链路。
  test('分类器与窗口判据同源（两边不得各判各的）', async () => {
    const { isRetryableGitFailure } = await import('@agent-workflow/shared')
    // 窗口循环里用的就是这个函数——真实的瞬时态必须判可重试。
    expect(isRetryableGitFailure('fatal: unable to access: Could not resolve host: x')).toBe(true)
    expect(isRetryableGitFailure('error: RPC failed; HTTP 502 curl 22')).toBe(true)
    // 反向：鉴权类不得占窗口。
    expect(isRetryableGitFailure('fatal: Authentication failed for x')).toBe(false)
  })
})

// 五轮门终局对账点名的两处「有代码零测试」。
describe('RFC-287 五轮门 —— 补齐零测试的两处', () => {
  test('S4：准备窗口内的 pending 不按 5 分钟判卡死，且文案不再说「调度器没认领」', async () => {
    const { runStuckTaskDetector } = await import('@/services/stuckTaskDetector')
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const id = await launchFailingPrep2(db, s, 's4-exempt')
    // 造回准备窗口形态：pending + 空路径 + 无墓碑，且已经等了 10 分钟。
    await db
      .update(tasks)
      .set({ status: 'pending', startedAt: Date.now() - 10 * 60_000, finishedAt: null })
      .where(eq(tasks.id, id))

    const operations = taskRecoveryOperations(db)
    const r = await runStuckTaskDetector({ operations, taskIdFilter: [id] })
    const s4 = r.openAlerts.filter((a) => a.rule === 'S4')
    // 10 分钟 < 45 分钟的准备阈值 ⇒ 不该报。
    expect(s4.length, '准备窗口内不得按 5 分钟判卡死').toBe(0)

    // 反向前提复核：把它挪出准备窗口（给个工作树）之后，同样 10 分钟必须**报**
    // ——否则上面那条零断言可能只是因为探测器压根没扫到它。
    await db.update(tasks).set({ worktreePath: '/tmp/wt-probe' }).where(eq(tasks.id, id))
    const r2 = await runStuckTaskDetector({ operations, taskIdFilter: [id] })
    expect(
      r2.openAlerts.filter((a) => a.rule === 'S4').length,
      '前提复核：非准备窗口的同龄 pending 应当报 S4',
    ).toBeGreaterThan(0)
  }, 120_000)

  test('AC-14「删除」这一格已划掉：准备中删除仍 409 并提示先取消', async () => {
    // 用户 2026-08-15 拍板保持该语义：删除要清工作区，而准备中的任务持有驱动租约、
    // git 在跑；先取消（现在能真杀 git）再删是安全的两步。
    const db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    const task = await startTask(
      {
        workflowId: s.workflowId,
        name: 'ac14-delete',
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db,
        actorUserId: s.userId,
        appHome: TEST_HOME,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 30_000,
        gitBaselineSyncWindowMs: 0,
      } as never,
    )
    const { deleteTask } = await import('@/services/taskDelete')
    let code = ''
    try {
      await deleteTask(db, task.id)
    } catch (err) {
      code = (err as { code?: string }).code ?? String(err)
    }
    expect(code, '准备中的任务不可直接删除').toBe('task-not-terminal')
    // 收尾：取消掉，别把后台克隆留到别的用例里。
    const { cancelTask } = await import('@/services/task')
    await cancelTask(db, task.id).catch(() => {})
  }, 120_000)
})

// 收尾：临时 home 整体删掉。没有它，克隆残留会一直堆在磁盘上（见 TEST_HOME 注释）。
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }))

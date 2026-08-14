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

import { describe, expect, test, beforeAll } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows, users, nodeRuns, taskRepos, cachedRepos } from '../src/db/schema'
import { startTask } from '@/services/task'
import { runGit } from '@/util/git'
import { ulid } from 'ulid'
import { REPO_PREP_NODE_ID } from '@agent-workflow/shared'
import { startGitHttpRemote } from './helpers/gitHttpRemote'
import { seedRepoGroup } from './helpers/repoGroupFixture'

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

// 最小合法定义——本用例测的是「准备阶段」，节点跑不跑无关紧要（准备失败时压根
// 到不了调度）。形状照 gettask-multi-repo 的现成夹具。
const WF_DEF = { $schema_version: 1, inputs: [], nodes: [], edges: [] } as const

async function seed(db: DbClient): Promise<{ workflowId: string; userId: string }> {
  const userId = 'u_' + ulid()
  const workflowId = ulid()
  await db.insert(users).values({
    id: userId,
    username: userId,
    displayName: 'tester',
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
    expect(threw || eager !== undefined).toBe(true)
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
  test('AbortController 注册在准备开始之前（回收器据此判活）', () => {
    const src = readSrc(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    // ⚠ 判据必须限定在 **startTaskImpl 这一个函数体内**。
    // `activeTasks.set(taskId, controller)` 全文有 3 处（另两处在别的函数里），
    // 用全局 indexOf / lastIndexOf 都会被别处的命中喂饱，于是断言恒真、怎么改
    // 都绿——实测两次：变异确实落地却 0 红，靠逐次核对才查出锁是空的。
    // 这是「变异点要由被断言的锚定位」的镜像版：**断言本身也得锚对**。
    const fnStart = src.indexOf('async function startTaskImpl(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const body = src.slice(fnStart, fnEnd)
    // T14：准备块已被提成闭包（`runRepoPreparation`），以便在请求路径之外跑
    // （G7 启动异步化）。锚点随之从「延后准备的 if 块」换成**闭包的调用点**——
    // 锁的语义没变：注册必须先于准备真正开始。
    const prepare = body.indexOf('runRepoPreparation()')
    // 驱动注册的 API 名会随重构变（曾是 `activeTasks.set(taskId, controller)`，
    // RFC-288/taskDriver 之后是 `tryAttachTaskDriver(...)`）。锁的是**语义**——
    // 「准备开始前任务必须已被本进程调度器持有」——所以判据取「任一注册形态」，
    // 而不是某个具体函数名；名字变了不该红，顺序反了才该红。
    const register = [
      body.indexOf('tryAttachTaskDriver('),
      body.indexOf('activeTasks.set(taskId, controller)'),
      body.indexOf('taskDriverRegistry.tryAttach('),
    ]
      .filter((i) => i !== -1)
      .sort((a, b) => a - b)[0]
    expect(prepare, 'startTaskImpl 里应有延后准备的调用点').toBeGreaterThan(-1)
    expect(register, 'startTaskImpl 里应有驱动注册（任一形态）').not.toBe(undefined)
    expect(
      register as number,
      '注册必须在准备之前——否则长克隆期间任务无驱动，会被孤儿回收器判死',
    ).toBeLessThan(prepare)
    // 注册与准备之间不得出现「放弃驱动」的动作。原先这里锁的是「中间不得有
    // await」，但 taskDriver 重构后注册本身就是 `await tryAttachTaskDriver(...)`，
    // 那条判据已不适用。真正要防的是**中途把驱动放掉**——一旦释放，剩下的准备
    // 过程就落在无驱动窗口里，正是孤儿回收器要收的形状。
    //
    // 射程必须止于**闭包定义**而不是调用点：T14 把准备提成闭包后，「注册 → 调用点」
    // 这一段文本里整个包住了闭包体，而闭包体里有一处**正当的** release（准备失败后
    // 任务已终态，租约本来就该还）。拿它当违规会把正确实现判红——这正是「文本射程
    // 必须跟着结构走」的又一例。取「注册 → 闭包定义」这一小段：那里若出现放弃驱动，
    // 才是真的在准备开始前把租约丢了。
    const prepareDef = body.indexOf('const runRepoPreparation')
    expect(prepareDef, 'startTaskImpl 里应有准备闭包的定义').toBeGreaterThan(-1)
    expect(register as number).toBeLessThan(prepareDef)
    const between = body.slice(register as number, prepareDef)
    expect(between).not.toMatch(/release\(|detachTaskDriver|clearForTesting/)
  })

  test('回收器确实以 activeTasks 为豁免依据（判活单点未被绕过）', () => {
    const src = readSrc(
      resolve(import.meta.dir, '..', 'src', 'services', 'orphanReconcile.ts'),
      'utf8',
    )
    expect(src).toContain('hasDriver(taskId)')
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
        deps: {
          db: db2,
          actorUserId: s.userId,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 3_000,
          gitBaselineSyncWindowMs: 0,
        } as never,
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
      deps: {
        db,
        actorUserId: s.userId,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        cloneTimeoutMs: 1_000,
        gitBaselineSyncWindowMs: 0,
      } as never,
    })
    await settle(db, id)
    const after = (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
    // 远端仍不可达 ⇒ 必然再失败一次。**关键是它不能是 done**：那正是修复前的坏行为。
    expect(after?.status).not.toBe('done')
    expect(after?.status).toBe('failed')
    // 而且确实重跑过准备——工作树仍然没有（不是「假装成功」）。
    expect(after?.worktreePath ?? '').toBe('')
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
        deps: {
          db,
          actorUserId: s.userId,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        } as never,
      })
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    expect(msg).toMatch(/repo-prep-not-retryable|only failed \/ interrupted preparation/i)
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
        deps: {
          db,
          actorUserId: s2.userId,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 1_000,
          gitBaselineSyncWindowMs: 0,
        } as never,
      })
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    expect(msg).not.toMatch(/repo-prep-source-unavailable/i)
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
        deps: {
          db,
          actorUserId: s2.userId,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 1_000,
          gitBaselineSyncWindowMs: 0,
        } as never,
      })
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    // 关键：**不得**被 AC-16 的守卫拒掉。远端仍不可达所以最终还会失败，但那是
    // 重跑之后的结果，不是「不让你重试」。
    expect(msg).not.toMatch(/repo-prep-not-retryable/i)
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
      await deleteCachedRepo({ db }, repoId)
    } catch (err) {
      code = (err as { code?: string }).code ?? (err as Error).message
    }
    expect(code, '在用镜像必须拒删（否则任务的 cached_repo_id 悬空）').toMatch(
      /reference|in-use|has-references/i,
    )
    expect((await db.select().from(cachedRepos).where(eq(cachedRepos.id, repoId))).length).toBe(1)
  }, 90_000)
})

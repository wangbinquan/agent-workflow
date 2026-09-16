// RFC-359 AC-1（plan §5hn 批次二 ①）—— RFC-287 G7「延后仓库准备」在两个引擎上的落差。
//
// **已销账**（plan §5hn 批次二 ①）：这条用例上一版按 provider 分叉钉住的是缺陷形状，
// 它在修好那一刻按剧本自己红了——现在改成**两侧相等**的正向判据。
//
// RFC-287 G7 是**已定的产品行为**：JSON body 启动（以及沿用同一套语义的定时 / webhook 触发）
// 把仓库准备推迟到任务行落库之后——「今天物化在落行之前，于是『克隆超时 / 远端不可达』
// 这类失败**不留任何记录**——用户点了启动，转半天圈，最后得到一个 HTTP 错误，
// 任务列表里什么都没有」（`services/task.ts` 该分支原文）。
//
// 修之前实测（2026-09-17，两条启动路各一次）：
//
// | | JSON `POST /api/tasks` | `POST /api/scheduled-tasks/:id/run-now` |
// | --- | --- | --- |
// | SQLite     | **201**，`tasks` 一行 `pending`（可重试） | **201**，`tasks` 一行 `pending` |
// | PostgreSQL | **400 `repo-clone-failed`**，`tasks` **零行** | **400 `repo-clone-failed`**，零行 |
//
// 成因：`deferRepoPreparation` 这条路**整个只存在于 SQLite 那一侧**
//（`grep -rln deferRepoPreparation src` → `services/task.ts` 与它的三个调用方），
// PostgreSQL 的根启动内核在插入任务行**之前**无条件 `workspace.prepare(...)` 全量物化。
// 也就是说 **G7 在 PostgreSQL 上根本没实现**：同一个「远端拉不动」的场景，
// SQLite 用户看到一行可重试的任务，PostgreSQL 用户什么都看不到。
//
// 修法：延后准备接进根启动内核（占位工作区）+ PostgreSQL 的根把
// `skipRepositoryPreparation` 换成真正的准备步骤（两个引擎共用
// `composeDeferredRepositoryPreparation`）。判据因此**不只看落行**，还要看完整的 G7 闭环：
// 任务先 `pending`、第 0 步跑完转 `failed`、git 原文留在行上、并且留下一条可重试的
// `__repo_prep__` 合成节点行——缺任何一环，AC-11 的「重试准备仓库」就是个死按钮。
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { remoteUrlFor, startGitHttpRemote, stopGitHttpRemote } from './helpers/gitHttpRemote'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { and, eq } from 'drizzle-orm'
import { REPO_PREP_NODE_ID } from '@agent-workflow/shared'

import { nodeRuns, tasks } from '@/db/schema'

const TOKEN = 'i'.repeat(64)
/**
 * 立刻 connection-refused 的本机地址——**刻意不走公网**：用例要的是「克隆失败」这个
 * 分支，不是 DNS / TLS 的某种超时，更不该让判据依赖 CI runner 的出网能力
 *（本仓有 `RUN_GIT_NETWORK` 门控的用例，正是为了把真出网的那些隔离出去）。
 * 端口 1 上不会有监听者，git 秒失败，两个引擎观察到的是同一个确定分支。
 */
const UNREACHABLE_REPO = 'http://127.0.0.1:1/nope.git'
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const

function git(...args: string[]): void {
  execFileSync('git', args, { stdio: 'pipe' })
}

/** 一个真的、可克隆的裸仓——延后准备的**成功**那半必须打到真物化上。 */
function makeBareRepo(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc359-defer-repo-'))
  const working = join(tmp, 'src')
  mkdirSync(working, { recursive: true })
  git('init', '-b', 'main', working)
  git('-C', working, 'config', 'user.email', 't@t.test')
  git('-C', working, 'config', 'user.name', 't')
  writeFileSync(join(working, 'README.md'), '# rfc359 deferred prep\n')
  git('-C', working, 'add', '.')
  git('-C', working, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')
  const bare = join(tmp, 'remote.git')
  git('clone', '--bare', working, bare)
  return bare
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— RFC-287 G7 延后仓库准备两个引擎同一套语义',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-deferred-prep-parity-',
    // RFC-287 G6 的「基线同步总容忍窗口」默认 60s：connection-refused 属于可重试的网络类
    // 失败，开着窗口这条用例就要退避重试整整一分钟。判据要的是**失败之后的归宿**，
    // 不是退避策略本身（那条有自己的用例），所以显式关窗（0 = 关闭）。
    config: { gitBaselineSyncWindowMs: 0 },
  },
  (scope) => {
    let app: Hono
    let bareRepo = ''

    beforeAll(async () => {
      // 真实 git smart-HTTP 远端（`file://` 已是本仓非法参数）。
      await startGitHttpRemote()
      bareRepo = makeBareRepo()
    })
    afterAll(() => {
      stopGitHttpRemote()
    })

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    async function createWorkflow(): Promise<string> {
      const suffix = ulid().slice(-8).toLowerCase()
      const res = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `defer-wf-${suffix}`,
          description: '',
          definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
        }),
      })
      expect(res.status, await res.clone().text()).toBe(201)
      return ((await res.json()) as { id: string }).id
    }

    /** 等任务走完第 0 步（准备必然失败）落到终态。 */
    async function waitForTerminal(taskId: string): Promise<Record<string, unknown>> {
      const deadline = Date.now() + 12_000
      for (;;) {
        const rows = await scope.harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
        const row = rows[0]
        if (row !== undefined && row.status !== 'pending' && row.status !== 'running') {
          return row as unknown as Record<string, unknown>
        }
        if (Date.now() > deadline) {
          throw new Error(`task ${taskId} never left the preparation window: ${row?.status}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    /** 等第 0 步把工作树建出来（成功那半）。 */
    async function waitForPrepared(taskId: string): Promise<Record<string, unknown>> {
      const deadline = Date.now() + 40_000
      for (;;) {
        const rows = await scope.harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
        const row = rows[0] as unknown as Record<string, unknown> | undefined
        if (row !== undefined && String(row['worktreePath'] ?? '') !== '') return row
        if (row !== undefined && row['status'] === 'failed') {
          throw new Error(`repository preparation failed: ${String(row['errorMessage'])}`)
        }
        if (Date.now() > deadline) {
          throw new Error(`task ${taskId} never got a worktree: ${String(row?.['status'])}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    /** G7 的完整闭环，两个引擎逐条相同。 */
    async function assertDeferredPreparationContract(taskId: string): Promise<void> {
      const terminal = await waitForTerminal(taskId)
      expect(terminal['status'], '准备失败必须把任务落成 failed（G7 不新增状态）').toBe('failed')
      expect(
        String(terminal['errorMessage'] ?? ''),
        '行上必须留着 git 原文——点开就知道卡在哪，而不是一句无从下手的「启动失败」',
      ).toMatch(/fatal|could not|unable|Connection refused|refused/i)
      const prepRuns = await scope.harness.db
        .select({ id: nodeRuns.id, status: nodeRuns.status })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
      expect(
        prepRuns.map((run) => run.status),
        '必须留下一条 __repo_prep__ 合成节点行且落 failed——AC-11 的「重试准备仓库」复用的就是它',
      ).toEqual(['failed'])
    }

    test('JSON POST /api/tasks：远端拉不动时先落一行 pending，再由第 0 步转 failed 并留下 git 原文', async () => {
      const workflowId = await createWorkflow()
      const res = await req(app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId,
          name: 'rfc359 deferred prep',
          repoUrl: UNREACHABLE_REPO,
        }),
      })
      // G7 的正向行为：先落行、后准备——**两个引擎相同**。
      expect(res.status, await res.clone().text()).toBe(201)
      const task = (await res.json()) as { id: string; status: string }
      expect(task.status, 'G7 明确不新增状态：占位行就是 pending').toBe('pending')
      await assertDeferredPreparationContract(task.id)
    }, 30_000)

    test('成功那半：占位行落地后第 0 步真把仓库物化出来，两个引擎同样', async () => {
      const workflowId = await createWorkflow()
      const res = await req(app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId,
          name: 'rfc359 deferred prep ok',
          repoUrl: remoteUrlFor(bareRepo),
        }),
      })
      expect(res.status, await res.clone().text()).toBe(201)
      const created = (await res.json()) as Record<string, unknown>
      // **先证明它真的走了占位那条路**——否则这条用例只是又测了一遍同步物化。
      expect(created['status'], '占位行就是 pending').toBe('pending')
      expect(created['worktreePath'], '占位期还没有工作树').toBe('')
      expect(created['cachedRepoId'], 'AC-11 的前提：身份必须在占位时就落定').not.toBeNull()

      const row = await waitForPrepared(String(created['id']))
      expect(String(row['worktreePath'] ?? ''), '第 0 步必须把工作树建出来').not.toBe('')
      expect(String(row['branch'] ?? ''), '第 0 步必须把分支落定').not.toBe('')
      const prepRuns = await scope.harness.db
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(
          and(eq(nodeRuns.taskId, String(created['id'])), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)),
        )
      expect(
        prepRuns.map((run) => run.status),
        '成功那半同样留下一条 __repo_prep__ 合成行，且落 done',
      ).toEqual(['done'])
    }, 60_000)

    test('定时 run-now：同一套语义在定时触发上也成立', async () => {
      const workflowId = await createWorkflow()
      const created = await req(app, '/api/scheduled-tasks', {
        method: 'POST',
        body: JSON.stringify({
          name: 'defer-sched',
          launchKind: 'workflow',
          launchPayload: {
            workflowId,
            name: 'rfc359 deferred prep sched',
            repoUrl: UNREACHABLE_REPO,
          },
          scheduleSpec: SPEC,
          enabled: false,
        }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const schedule = (await created.json()) as { id: string }

      const fired = await req(app, `/api/scheduled-tasks/${schedule.id}/run-now`, {
        method: 'POST',
      })
      expect(fired.status, await fired.clone().text()).toBe(201)
      const { taskId } = (await fired.json()) as { taskId: string }
      await assertDeferredPreparationContract(taskId)
    }, 30_000)
  },
)

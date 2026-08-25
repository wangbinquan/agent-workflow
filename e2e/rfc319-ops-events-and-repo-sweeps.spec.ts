// RFC-319 —— 运维热旋钮 / 事件自动化 / 仓库后台清扫的用户面验收
// （OPS-X4 / OPS-X10 / EVENT-08 / EVENT-16 / EVENT-23 / EVENT-36 / EVENT-48 /
//   EVENT-X2 / REPO-39 / REPO-40）。
//
// 这一批锁的全是**没有人在场**的那一半产品：一个运维在设置页上拨了个开关、
// 一个代码平台在半夜投了一条 webhook、一个定时任务到点自己跑了、一台机器上
// 的后台清扫拍了一次。它们失效的共同形态是**安静**——界面上什么都不会变，
// 日志里也不会红，只有一个月后磁盘满了 / 自动化再也没启动过 / 改了配置却
// 「要重启才生效」这些间接症状。所以本文件里每一条断言都必须落在
// **系统状态真的变了**上，而不是「接口回了 200」。
//
// 三条纪律贯穿全文：
//
//   ① **每条「什么都没发生」的断言都必须先有一条会发生的对照腿。**
//      「等了 70 秒那一行还挂在 running」单独看是恒真的（也许根本没人在扫），
//      所以它后面必须紧跟「把旋钮打开、同一个进程、同一行，60 多秒后被收掉」。
//      反过来「收掉了」单独看也不成立——boot 的 reapOrphanRuns 本来就会收，
//      所以夹具一律在 daemon **起来之后**才种。
//   ② **判据取产品自己的可观察面**：fires 表的 outcome、tasks 表的归属列、
//      盘上的目录在不在、observers 的 state。不看「日志里有没有那行字」。
//   ③ **跨进程的证据要跨进程地取**：EVENT-16 的重启修复必须真的停一次
//      daemon 再起一次（同一个 home），进程内调用函数证明不了发行二进制的
//      启动序列里到底跑没跑那一步。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链，见 CLAUDE.md）：
//
//   * 周期孤儿对账与它的热重配：
//     packages/backend/src/services/orphanReconcile.ts:341-383（loop + config 监听）、
//     :128-141（候选 = status='running' 且 startedAt < now-graceMs）、
//     :78-87（进程探针：pid 活着**且**命令行仍含当初 spawn 的二进制）、
//     :239-262（CAS 翻 interrupted + periodic-reap 审计）、:270-289（任务行翻 interrupted）。
//   * 「0 = 关」「正值下限 60s」：packages/shared/src/settingsNumericBounds.ts:72-78
//     与 packages/backend/src/services/managedPeriodicJob.ts:75-92。
//   * PUT /api/config 的热应用点：packages/backend/src/routes/config.ts:108-110
//     （持久化成功之后才 notifyConfigApplied）与
//     packages/backend/src/services/configAppliedListeners.ts:21-32。
//   * GitHub 验签：packages/backend/src/services/webhook/githubAdapter.ts:109-128
//     （`sha256=` + HMAC-SHA256(secret, 原始字节)，常量时间比较）、
//     :143-166（repository.full_name / clone_url / ssh_url 三者缺一即 parse-failed）、
//     :271-297（push 事件 → push / tag_push）、:573-576（头白名单与事件头）。
//   * 入口三段式与 401：packages/backend/src/routes/webhooks.ts:156-166。
//   * 仓库自动注册：packages/backend/src/services/webhook/webhookDispatch.ts:298-358
//     （先按双协议族 key 找既有镜像；没有且 autoRegister=false ⇒ unregistered）、
//     fire outcome 闭集见 packages/backend/src/db/schema.ts:1421-1436。
//   * 重启修复投递：packages/backend/src/services/webhook/deliveryStore.ts:120-147
//     与调用点 packages/backend/src/cli/start.ts:770-777。
//   * 按需观察器：packages/backend/src/modules/event-center/infrastructure/sqliteEventStore.ts:389-462
//     （订阅把 activation 起成 active，observerTransition='started'）、:492-533（最后一个订阅撤走 ⇒ stopped）、
//     :1053-1092（claimDueObserver 只认 active/draining 且 nextScanAt 到期）、
//     路由 packages/backend/src/routes/eventCenter.ts:282-292。
//   * 定时任务实时推送：packages/backend/src/services/scheduledTasks.ts:1251-1258
//     （run-now 广播 scheduled.fired）、订阅面
//     packages/frontend/src/hooks/useScheduledTaskWs.ts:14-25、
//     通道鉴权 packages/backend/src/ws/registry.ts:884-887。
//   * 定时任务改频率 / 全量重编辑：packages/frontend/src/routes/scheduled.$id.tsx:105-130、
//     packages/frontend/src/routes/tasks.new.tsx:622-661（editScheduled 回填）、
//     :1690-1702（保存 = 整份 launchPayload 替换）。
//   * 孤儿工作树回收：packages/backend/src/services/gc.ts:622-660（无任务行锚定 + 24h 年龄地板）、
//     半成品镜像目录 :583-620，装配与相位 :803-841 与
//     packages/backend/src/services/daemonCadence.ts:95-96。
//   * 子模块递归模式落到克隆：packages/backend/src/services/gitRepoCache.ts:461-472
//     与 :473-495（显式参数 > 设置 > 内置默认）。
//
// 与既有 spec 的分工（刻意不重叠）：
//   * e2e/rfc319-ops-boot-gates-and-sweepers.spec.ts OPS-040 已经锁了「**终态任务**
//     的工作区被小时级 GC 清掉」，它的夹具刻意放在 home 之外。本文件的 REPO-39 只补
//     它明确避开的那一半：`<home>/worktrees` 下**没有任何任务行锚定**的孤儿目录，
//     以及 `<home>/repos` 下的半成品镜像目录。两条用例踩的是同一拍、断言的对象无交集。
//   * e2e/rfc319-settings-sections.spec.ts CFG-23 已经锁了并发/配额六项「保存后
//     uptime 不回零、不提示重启」。它证明的是**没有重启**，没有证明**行为真的变了**。
//     本文件的 OPS-X10 补的正是后者：同一个进程、同一行数据，旋钮拨动前后结局相反。
//   * e2e/webhook-trigger-matching.spec.ts EVENT-18/19 与
//     e2e/rfc319-webhook-endpoints.spec.ts EVENT-01…13 全程走 GitLab 的共享 token
//     验签。本文件的 EVENT-08 是全仓**唯一**一条走 GitHub HMAC 原始字节验签的浏览器层
//     e2e，且把链路一直断言到「真的有一个任务行、并且归属回这条规则」。
//   * e2e/scheduled-task-firing.spec.ts EVENT-42 锁的是「到点自己跑」。本文件的
//     EVENT-48 只借它建规则的姿势，断言的是**推送到每一个打开的标签页**；
//     EVENT-X2 断言的是**改配置**，两者都不重复触发语义。

import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import {
  cloneBareGitRepo,
  initGitRepo,
  querySqlite,
  repoRemoteUrl,
  runGit,
  runSqlite,
} from './command'
import { startDaemon, type DaemonHandle, type SpawnOptions } from './harness'

// 每条用例自己起 daemon（配置各不相同），墙钟主要花在两处真实节拍上：
// 周期孤儿对账的 60s 下限、worktree GC 的 4 分钟相位。文件级预算按最坏的那条给，
// 单条另有更紧的 `test.setTimeout`。
test.setTimeout(240_000)

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// 进程与目录的生命周期
// ---------------------------------------------------------------------------

const liveDaemons: DaemonHandle[] = []
const scratchDirs: string[] = []

async function launch(opts: SpawnOptions = {}): Promise<DaemonHandle> {
  const daemon = await startDaemon(opts)
  liveDaemons.push(daemon)
  return daemon
}

function scratchDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aw-rfc319-oer-${tag}-`))
  scratchDirs.push(dir)
  return dir
}

/**
 * 删一个临时目录。**尽力而为且带重试**：这些目录里躺着刚退出的子进程留下的
 * git worktree，macOS 上一个刚死的进程仍可能短暂握着目录项，`rmSync` 于是以
 * ENOTEMPTY 抛出。那是清理的噪音，不是被测行为（同款处置见
 * e2e/crash-recovery.spec.ts 与 e2e/rfc319-ops-boot-gates-and-sweepers.spec.ts）。
 */
function bestEffortRemove(dir: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      /* 下一轮重试；三次都失败就留给系统临时目录清理 */
    }
  }
}

test.afterEach(async () => {
  while (liveDaemons.length > 0) {
    const daemon = liveDaemons.pop()
    if (daemon !== undefined) await daemon.stop()
  }
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) bestEffortRemove(dir)
  }
})

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

async function req(daemon: DaemonHandle, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

function databasePath(daemon: DaemonHandle): string {
  return join(daemon.home, 'db.sqlite')
}

async function uptimeSeconds(daemon: DaemonHandle): Promise<number> {
  const res = await fetch(`${daemon.baseUrl}/health`)
  expect(res.ok, `health: ${res.status}`).toBe(true)
  return ((await res.json()) as { uptime: number }).uptime
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** 浏览器侧的登录态：路由与 API 客户端都从 localStorage 取（同 e2e 其它 spec）。 */
async function primeAuth(page: Page, daemon: DaemonHandle, token?: string): Promise<void> {
  await page.addInitScript(
    ([baseUrl, sessionToken]) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', sessionToken)
        // 固定英文：下面所有文案选择器对的都是 en-US。
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore — chromium 下不会失败 */
      }
    },
    [daemon.baseUrl, token ?? daemon.token] as const,
  )
}

/** 一个「回声」工作流：不 spawn 任何子进程，用来当启动目标而不牵扯 runtime。 */
async function seedEchoWorkflow(daemon: DaemonHandle, name: string): Promise<string> {
  const created = await jsonOf<{ id: string }>(
    await req(daemon, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 ops/events fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'echo', bind: { nodeId: 'in_1', portName: 'topic' } }],
              position: { x: 320, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_out',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'out_1', portName: 'echo' },
            },
          ],
        },
      }),
    }),
    `seed workflow ${name}`,
  )
  return created.id
}

// ---------------------------------------------------------------------------
// OPS-X4 / OPS-X10 —— 周期孤儿对账 + PUT /api/config 的热生效
// ---------------------------------------------------------------------------

/**
 * 种一条「进程已经不在了，但 run 还挂在 running」的现场。
 *
 * `spawn_binary_path` 指向一个**从来不存在**的可执行文件是刻意的：
 * `probeRunProcessAlive`（orphanReconcile.ts:78-87）先看 pid 活不活，再看那个 pid 的
 * 命令行里还有没有当初 spawn 的二进制。写一个不可能命中的路径之后，无论这个 pid 号
 * 在本机是空的还是恰好被别的进程回收了，判定都恒为「已消失」——用例因此不依赖
 * 「某个 pid 号一定是死的」这种在 CI 上不成立的假设。
 *
 * `started_at` 取 5 分钟前，越过 60 秒的 grace（那道 grace 是防「刚 spawn 还没写 pid」
 * 的竞态，不是本条用例要测的东西）。
 */
function seedOrphanRunningTask(daemon: DaemonHandle, taskId: string, runId: string): void {
  const db = databasePath(daemon)
  const now = Date.now()
  runSqlite(
    db,
    'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,' +
      ' base_branch, branch, status, inputs, started_at, running_ms, space_kind, repo_count)' +
      ` VALUES (${sqlText(taskId)}, ${sqlText('RFC-319 orphan reconcile fixture')},` +
      ` ${sqlText('rfc319-orphan-wf')},` +
      ` ${sqlText('{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}')},` +
      ` ${sqlText(join(daemon.home, 'fixture-repo'))}, ${sqlText('')}, ${sqlText('main')},` +
      ` ${sqlText(`agent-workflow/${taskId}`)}, ${sqlText('running')}, ${sqlText('{}')},` +
      ` ${String(now - 5 * 60_000)}, 0, ${sqlText('scratch')}, 1);`,
  )
  runSqlite(
    db,
    'INSERT INTO node_runs (id, task_id, node_id, status, pid, spawn_binary_path, started_at)' +
      ` VALUES (${sqlText(runId)}, ${sqlText(taskId)}, ${sqlText('rfc319-orphan-node')},` +
      ` ${sqlText('running')}, 424242,` +
      ` ${sqlText('/nonexistent/rfc319-never-spawned-binary')}, ${String(now - 5 * 60_000)});`,
  )
}

interface RowState {
  readonly taskStatus: string
  readonly runStatus: string
}

function readOrphanState(daemon: DaemonHandle, taskId: string, runId: string): RowState {
  const task = querySqlite<{ status: string }>(
    databasePath(daemon),
    'SELECT status FROM tasks WHERE id = ?;',
    [taskId],
  )
  const run = querySqlite<{ status: string }>(
    databasePath(daemon),
    'SELECT status FROM node_runs WHERE id = ?;',
    [runId],
  )
  return { taskStatus: task[0]?.status ?? '(missing)', runStatus: run[0]?.status ?? '(missing)' }
}

test('RFC-319 OPS-X4/OPS-X10: 周期孤儿对账关着时一行都不动，PUT /api/config 打开之后同一个进程就把它收掉了，中途没有重启 @nightly', async () => {
  test.setTimeout(360_000)
  // 出厂默认是 10 分钟一拍，用例要的是「关着」这个起点，所以显式写 0
  // （settingsNumericBounds.ts:72-78：0 = 关，正值下限 60s）。
  const daemon = await launch({ configOverrides: { periodicOrphanReconcileMs: 0 } })
  const taskId = '01RFC319ORPHANTASK00000'
  const runId = '01RFC319ORPHANRUN000000'

  // 夹具必须在 daemon **起来之后**才种：boot 的 reapOrphanRuns 会乐观地把每一条
  // running 行都翻掉，种在启动前的话「被收掉」这件事根本不能归因给周期对账。
  seedOrphanRunningTask(daemon, taskId, runId)
  // `bun:sqlite` 的多语句执行对约束错误不抛异常（docs/dev-gotchas.md）——回读自证，
  // 否则下面「它还在 running」会因为压根没有这一行而恒真。
  expect(
    readOrphanState(daemon, taskId, runId),
    '夹具没落库 ⇒ 后面两条断言都跑在一个不存在的行上，红绿都没有意义',
  ).toEqual({ taskStatus: 'running', runStatus: 'running' })

  const uptimeBefore = await uptimeSeconds(daemon)

  // --- 对照腿：关着的时候，越过一个完整的最小周期也不许有人动它 -----------------
  // 70 秒 > 生产允许的最小周期 60 秒。这一腿存在的理由是让下面那腿可归因：
  // 没有它，「后来被收掉了」可以被任何一个别的后台扫描解释。
  const quietUntil = Date.now() + 70_000
  while (Date.now() < quietUntil) {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    expect(
      readOrphanState(daemon, taskId, runId),
      'periodicOrphanReconcileMs=0（出厂即「关」）时仍然有人把 running 行收掉了 ⇒ ' +
        '这个开关是假的：运维以为自己关掉了自动回收，实际任务照样会被判成 interrupted',
    ).toEqual({ taskStatus: 'running', runStatus: 'running' })
  }

  // --- 热生效腿：只改配置，不碰进程 -------------------------------------------
  const applied = await req(daemon, '/api/config', {
    method: 'PUT',
    body: JSON.stringify({ periodicOrphanReconcileMs: 60_000 }),
  })
  expect(
    applied.status,
    `打开周期孤儿对账被拒（${await applied.clone().text()}）⇒ 这个旋钮在接口上就不可达`,
  ).toBe(200)

  await expect
    .poll(() => readOrphanState(daemon, taskId, runId).runStatus, {
      timeout: 150_000,
      intervals: [3_000],
      message:
        '把 periodicOrphanReconcileMs 从 0 改成 60s 之后，进程已死的那条 run 仍挂在 running ⇒ ' +
        '要么周期对账压根没跑，要么这个旋钮要重启才生效。两种都意味着：一台 daemon 上' +
        '任何一次子进程猝死都会留下一条永远 running 的任务，占着并发额度、也永远不会被 resume',
    })
    .toBe('interrupted')

  expect(
    readOrphanState(daemon, taskId, runId).taskStatus,
    '子 run 被收了，任务行却还挂在 running ⇒ 任务列表上它永远转着圈，' +
      '而 resume / 重试这些入口只对终态开放，用户拿它没有任何办法',
  ).toBe('interrupted')

  // 审计必须点名是谁收的。少了这条，运维在任务详情页只看到一个凭空变成
  // interrupted 的任务，无从判断是自己人干的还是崩溃留下的。
  const recovery = await jsonOf<{ events: Array<{ kind: string; reason: string | null }> }>(
    await req(daemon, `/api/tasks/${taskId}/recovery-events`),
    'recovery events',
  )
  const kinds = recovery.events.map((event) => event.kind)
  expect(
    kinds,
    `周期回收没有留下 periodic-reap 审计（拿到的是 ${JSON.stringify(kinds)}）⇒ ` +
      '任务凭空变成 interrupted，事后无人能解释是谁、为什么',
  ).toContain('periodic-reap')
  const reasons = recovery.events
    .filter((event) => event.kind === 'periodic-reap')
    .map((event) => event.reason ?? '')
  expect(
    reasons.some((reason) => reason.includes('process-gone')),
    `periodic-reap 没说清判据（拿到的是 ${JSON.stringify(reasons)}）⇒ ` +
      '「进程真的没了」与「容器行的下层都终态了」是完全不同的两个故事，处置也不同',
  ).toBe(true)

  // 全程同一个进程：uptime 只会往前走。它一旦回零，上面那条「热生效」就退化成
  // 「重启之后生效」——而那正是这条能力要否证的说法。
  const uptimeAfter = await uptimeSeconds(daemon)
  expect(
    uptimeAfter,
    '保存配置之后 daemon 重启了 ⇒ 这不是热生效；而且正在跑的任务会被这次重启打断',
  ).toBeGreaterThanOrEqual(uptimeBefore)
})

// ---------------------------------------------------------------------------
// EVENT-08 / EVENT-23 —— GitHub HMAC 投递 → 规则命中 → 真任务；仓库自动注册
// ---------------------------------------------------------------------------

interface GithubEndpoint {
  id: string
  urlToken: string
  secret: string
}

async function seedGithubEndpoint(daemon: DaemonHandle, name: string): Promise<GithubEndpoint> {
  return jsonOf<GithubEndpoint>(
    await req(daemon, '/api/webhook-endpoints', {
      method: 'POST',
      body: JSON.stringify({ name, provider: 'github' }),
    }),
    'create github endpoint',
  )
}

/**
 * 一条完整的 GitHub Push Hook body。
 *
 * `repository` 里的 full_name / clone_url / ssh_url 三个字段缺一不可
 * （githubAdapter.ts:143-151，缺了就是 parse-failed，用例会停在一个与被测语义
 * 无关的地方）。`clone_url` 由调用方给，因为 EVENT-23 要让它指向一个**真的能
 * 克隆**的 mock 远端。
 */
function githubPushBody(input: {
  repoPath: string
  cloneUrl: string
  branch?: string
  sender?: string
  sha: string
}): string {
  return JSON.stringify({
    ref: `refs/heads/${input.branch ?? 'main'}`,
    before: '0000000000000000000000000000000000000000',
    after: input.sha,
    repository: {
      id: 319,
      name: input.repoPath.split('/')[1] ?? 'repo',
      full_name: input.repoPath,
      html_url: `https://github.com/${input.repoPath}`,
      clone_url: input.cloneUrl,
      ssh_url: `git@github.com:${input.repoPath}.git`,
      default_branch: 'main',
      owner: { login: input.repoPath.split('/')[0] ?? 'owner' },
    },
    sender: { login: input.sender ?? 'rfc319-github-bot', id: 4242 },
  })
}

/** GitHub 的签名头：`sha256=` + HMAC-SHA256(secret, **原始字节**) 的小写 hex。 */
function githubSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`
}

async function deliverGithub(
  daemon: DaemonHandle,
  endpoint: GithubEndpoint,
  body: string,
  options: { signature?: string; deliveryId?: string; event?: string } = {},
): Promise<Response> {
  return fetch(`${daemon.baseUrl}/webhooks/github/${endpoint.urlToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': options.event ?? 'push',
      'x-github-delivery': options.deliveryId ?? `rfc319-${Math.random().toString(36).slice(2)}`,
      'x-hub-signature-256': options.signature ?? githubSignature(endpoint.secret, body),
    },
    body,
  })
}

interface FireRow {
  outcome: string
  taskId: string | null
  error: string | null
}

async function firesOf(daemon: DaemonHandle, triggerId: string): Promise<FireRow[]> {
  const res = await req(daemon, `/api/webhook-triggers/${triggerId}/fires`)
  const body = (await jsonOf<FireRow[] | { items?: FireRow[] }>(res, 'fires')) as
    | FireRow[]
    | { items?: FireRow[] }
  return Array.isArray(body) ? body : (body.items ?? [])
}

test('RFC-319 EVENT-08: 带正确 HMAC 签名的 GitHub 投递一路走到「真的开了一个任务」，签名改一个字节就是 401 且一次都不点火 @nightly', async () => {
  test.setTimeout(180_000)
  const daemon = await launch()
  const endpoint = await seedGithubEndpoint(daemon, 'rfc319-github-hmac')
  const workflowId = await seedEchoWorkflow(daemon, `rfc319-github-wf-${Date.now().toString(36)}`)
  const repoPath = 'rfc319/github-hmac-fixture'

  const trigger = await jsonOf<{ id: string }>(
    await req(daemon, '/api/webhook-triggers', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-github-trigger-${Date.now().toString(36)}`,
        endpointId: endpoint.id,
        enabled: true,
        repoScope: { kind: 'exact', paths: [repoPath] },
        eventTypes: ['push'],
        maxConsecutiveFires: 50,
        // 事件里的仓库并没有注册进平台，所以这条规则走临时工作区。这条用例问的是
        // 「验签过了之后到底有没有开工」，不是开出来的工作跑成什么样。
        autoRegisterRepos: false,
        launchKind: 'workflow',
        launchRefId: workflowId,
        launchPayload: {
          scratch: true,
          inputs: { topic: { kind: 'template', template: 'pushed {{trigger.webhook.repo_path}}' } },
        },
      }),
    }),
    'create github trigger',
  )

  // --- ① 拒绝腿先跑：签名不对时既不能点火，也不能落成一条「收下了」的投递 --------
  // 放在正向腿**之前**是刻意的：先证明「错签名一条 fire 都不产生」，正向腿之后的
  // 计数增量才能被归因给那次正确签名的投递。
  const forgedBody = githubPushBody({
    repoPath,
    cloneUrl: 'https://github.invalid/x.git',
    sha: 'a1',
  })
  const forged = await deliverGithub(daemon, endpoint, forgedBody, {
    // 用**另一个** secret 去签同一份 body：长度与形状完全合法，只有密钥不对。
    // 这正是「secret 泄漏后被换掉」与「有人伪造投递」两种真实场景的形状。
    signature: githubSignature(`${endpoint.secret}-wrong`, forgedBody),
  })
  expect(
    forged.status,
    'HMAC 对不上的投递没有被 401 挡住 ⇒ 任何知道那条 URL 的人都能让平台在你的仓库上开工',
  ).toBe(401)
  expect(
    (await forged.json()) as unknown,
    '验签失败的回包不是结构化的拒绝 ⇒ 运维在 GitHub 的 Recent Deliveries 里看不出是签名问题',
  ).toEqual({ error: 'signature-rejected' })

  const rejected = querySqlite<{ status: string; reason: string | null }>(
    databasePath(daemon),
    'SELECT status, status_reason AS reason FROM webhook_deliveries ORDER BY id;',
  )
  expect(
    rejected.map((row) => `${row.status}/${row.reason ?? ''}`),
    '验签失败没有留下 rejected 审计行 ⇒ 「有人在拿错 secret 打我们」这件事完全不可见',
  ).toEqual(['rejected/invalid-token'])
  expect(
    (await firesOf(daemon, trigger.id)).length,
    '验签失败的投递居然进了匹配 ⇒ 验签这道门形同虚设',
  ).toBe(0)

  // --- ② 正向腿：正确签名 → 规则命中 → 真的有一个任务行 ------------------------
  const body = githubPushBody({
    repoPath,
    cloneUrl: 'https://github.invalid/rfc319/github-hmac-fixture.git',
    sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
  })
  const accepted = await deliverGithub(daemon, endpoint, body)
  expect(
    accepted.status,
    `正确签名的 GitHub 投递被拒（${await accepted.clone().text()}）⇒ ` +
      'HMAC 验签或 push 事件归一化坏了，整个 GitHub 侧的自动化直接失效',
  ).toBe(200)

  await expect
    .poll(async () => (await firesOf(daemon, trigger.id)).length, {
      timeout: 60_000,
      intervals: [250],
      message:
        '验签通过的 push 事件没有触发任何一次匹配 ⇒ 规则在界面上还写着「已启用」，' +
        '但代码平台上再怎么推分支它都不会动',
    })
    .toBe(1)

  const fire = (await firesOf(daemon, trigger.id))[0]!
  expect(
    fire.outcome,
    `这次点火的结局是 ${fire.outcome}（error=${fire.error ?? 'null'}）⇒ ` +
      '匹配到了却没能开工，而 GitHub 侧只会看到一个 200，没有人会知道',
  ).toBe('launched')
  expect(
    fire.taskId,
    'fire 记成了 launched 却没有任务 id ⇒ 「启动了」这三个字没有任何实物支撑',
  ).not.toBeNull()

  const task = await jsonOf<{ id: string }>(
    await req(daemon, `/api/tasks/${fire.taskId!}`),
    'read the launched task',
  )
  expect(task.id, '点火记的任务 id 在任务接口上取不到 ⇒ 那是一条悬空的引用').toBe(fire.taskId)

  // 归属列是「这个任务为什么会存在」的唯一凭据。丢了它，任务列表里会凭空多出
  // 一批没人认领的任务，而事故复盘时无从回到那条规则与那次投递。
  // 归属列按**现行**入站链路读：RFC-300 之后 webhook 投递统一经事件中心分发
  // （webhookDispatch.ts:1049-1064 的 invoker 分流），任务上写的是
  // `launch_origin='event'` + `event_subscription_id='route:<触发规则 id>:<摘要>'`
  // + `event_delivery_id`，而**不是** `webhook_trigger_id` / `webhook_fire_id`
  // （那两列在这条路径上恒为 NULL —— 见报告 §5 的记录）。
  const attribution = querySqlite<{
    origin: string
    subscription: string | null
    delivery: string | null
  }>(
    databasePath(daemon),
    'SELECT launch_origin AS origin, event_subscription_id AS subscription,' +
      ' event_delivery_id AS delivery FROM tasks WHERE id = ?;',
    [fire.taskId!],
  )
  expect(
    attribution[0]?.origin,
    '事件开出来的任务没有被记成 event 来源 ⇒ 任务列表上的「来源」筛选把它混进手工任务里，' +
      '「哪些任务是自动化开的」这个问题在界面上再也答不上来',
  ).toBe('event')
  expect(
    attribution[0]?.subscription ?? '',
    'webhook 开出来的任务没有记回是哪条触发规则开的 ⇒ 任务列表里多出一批无主任务，' +
      '出事时没人知道该去关掉哪条规则',
  ).toContain(`route:${trigger.id}:`)
  expect(
    attribution[0]?.delivery,
    '任务没有记回是哪一次投递开的 ⇒ 同一条规则的多次触发之间无法对账',
  ).not.toBeNull()

  // 投递审计必须把归一化结果写下来：状态是 matched、事件类型是 push、仓库是那一个。
  const delivered = querySqlite<{ status: string; eventType: string | null; repo: string | null }>(
    databasePath(daemon),
    "SELECT status, event_type AS eventType, repo_path AS repo FROM webhook_deliveries WHERE status <> 'rejected' ORDER BY id;",
  )
  expect(
    delivered.map((row) => `${row.status}|${row.eventType ?? ''}|${row.repo ?? ''}`),
    'GitHub push 投递没有被归一成 matched/push/<仓库> ⇒ 投递审计页上这一条要么缺、' +
      '要么写着别的事件，运维照它排查会走到完全错误的方向',
  ).toEqual([`matched|push|${repoPath}`])
})

test('RFC-319 EVENT-23: autoRegisterRepos 打开时事件里的仓库被真的注册进镜像库并开出任务，关着时只留一条 skipped-repo-unregistered 且盘上不多一份镜像 @nightly', async () => {
  test.setTimeout(240_000)
  const daemon = await launch()

  // 一个**真的能克隆**的远端：自动注册那条路会拿 clone_url 去做一次真克隆，
  // 指向 github.invalid 的话失败原因会落在网络上，而不是落在被测的判据上。
  const remoteRoot = scratchDir('autoregister')
  const working = join(remoteRoot, 'src')
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'README.md'), '# rfc-319 auto register\n', 'utf-8')
  initGitRepo(working, { message: 'rfc-319 auto register' })
  const bare = join(remoteRoot, 'auto-register.git')
  cloneBareGitRepo(working, bare)
  const cloneUrl = repoRemoteUrl(bare)

  const endpoint = await seedGithubEndpoint(daemon, 'rfc319-auto-register')
  const workflowId = await seedEchoWorkflow(daemon, `rfc319-autoreg-wf-${Date.now().toString(36)}`)

  const makeTrigger = async (name: string, autoRegisterRepos: boolean, repoPath: string) =>
    jsonOf<{ id: string }>(
      await req(daemon, '/api/webhook-triggers', {
        method: 'POST',
        body: JSON.stringify({
          name,
          endpointId: endpoint.id,
          enabled: true,
          repoScope: { kind: 'exact', paths: [repoPath] },
          eventTypes: ['push'],
          maxConsecutiveFires: 50,
          autoRegisterRepos,
          launchKind: 'workflow',
          launchRefId: workflowId,
          launchPayload: {
            inputs: {
              topic: { kind: 'template', template: 'auto register {{trigger.webhook.repo_path}}' },
            },
          },
        }),
      }),
      `create trigger ${name}`,
    )

  const mirrorCount = async (): Promise<number> => {
    const body = await jsonOf<{ items: Array<{ id: string; urlRedacted: string }> }>(
      await req(daemon, '/api/cached-repos'),
      'list cached repos',
    )
    return body.items.length
  }
  expect(
    await mirrorCount(),
    '这个 daemon 一开始就有镜像 ⇒ 下面「多出了一份 / 没多出一份」的判据不可归因',
  ).toBe(0)

  // --- ① 关着：既不注册、也不开工，而且要说清楚为什么 --------------------------
  const offRepo = 'rfc319/auto-register-off'
  const off = await makeTrigger('rfc319-autoreg-off', false, offRepo)
  const offBody = githubPushBody({ repoPath: offRepo, cloneUrl, sha: 'c3'.repeat(20) })
  expect((await deliverGithub(daemon, endpoint, offBody)).status).toBe(200)

  await expect
    .poll(async () => (await firesOf(daemon, off.id)).map((row) => row.outcome), {
      timeout: 60_000,
      intervals: [250],
      message:
        'autoRegisterRepos 关着时，一条指向未注册仓库的事件既没开工也没留下任何记录 ⇒ ' +
        '规则作者只会看到「什么都没发生」，无从知道是被规则挡了还是链路断了',
    })
    .toEqual(['skipped-repo-unregistered'])
  expect(
    await mirrorCount(),
    'autoRegisterRepos 关着却仍然把事件里的仓库克隆进了镜像库 ⇒ ' +
      '任何人只要往 webhook 端点投一条事件，就能让这台机器去克隆任意一个远端',
  ).toBe(0)

  // --- ② 打开：同一形状的事件，这次要真的注册 + 真的开工 -----------------------
  const onRepo = 'rfc319/auto-register-on'
  const on = await makeTrigger('rfc319-autoreg-on', true, onRepo)
  const onBody = githubPushBody({ repoPath: onRepo, cloneUrl, sha: 'd4'.repeat(20) })
  expect((await deliverGithub(daemon, endpoint, onBody)).status).toBe(200)

  await expect
    .poll(async () => (await firesOf(daemon, on.id)).map((row) => row.outcome), {
      timeout: 180_000,
      intervals: [500],
      message:
        'autoRegisterRepos 打开之后，指向同一个仓库的同一形状事件仍然被判成「仓库没注册」⇒ ' +
        '「不必先手工导入仓库」这条产品承诺是空的，用户配好规则却永远等不到第一次运行',
    })
    .toEqual(['launched'])

  await expect
    .poll(mirrorCount, {
      timeout: 180_000,
      intervals: [1_000],
      message:
        '事件里的仓库没有出现在镜像库里 ⇒ 「自动注册」只是把 URL 塞进了一次性任务，' +
        '下一条同仓事件还要再克隆一遍，镜像列表上也永远看不见它',
    })
    .toBe(1)

  const onFire = (await firesOf(daemon, on.id))[0]!
  expect(
    onFire.taskId,
    '自动注册路径记成 launched 却没有任务 id ⇒ 「开工了」没有实物支撑',
  ).not.toBeNull()
})

// ---------------------------------------------------------------------------
// EVENT-16 —— daemon 重启把在途投递判成 failed(interrupted)
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-16: daemon 重启把停在 received / processing 的投递判成 failed(interrupted)，已经终态的那些一个字节都不动 @nightly', async () => {
  test.setTimeout(180_000)
  const home = scratchDir('restart-repair')
  const first = await launch({ home })
  const db = databasePath(first)
  const endpoint = await seedGithubEndpoint(first, 'rfc319-restart-repair')

  // 四行语料，覆盖「要修的两种」与「不许动的两种」。直接落 SQL 是刻意的：
  // 「上一个进程死在分发中途」这个现场没有任何公共接口能造出来，而它恰恰是
  // 这条能力唯一存在的理由。
  const rows: Array<{ id: string; status: string; reason: string | null }> = [
    { id: '01RFC319DELIVERYRECV000', status: 'received', reason: null },
    { id: '01RFC319DELIVERYPROC000', status: 'processing', reason: null },
    { id: '01RFC319DELIVERYMATCH00', status: 'matched', reason: null },
    { id: '01RFC319DELIVERYIGNOR00', status: 'ignored', reason: 'unsupported-event' },
  ]
  const now = Date.now()
  for (const row of rows) {
    runSqlite(
      db,
      'INSERT INTO webhook_deliveries (id, endpoint_id, event_uuid, attempt_count,' +
        ' gitlab_event_header, object_kind, event_type, repo_path, status, status_reason,' +
        ' received_at, body_json)' +
        ` VALUES (${sqlText(row.id)}, ${sqlText(endpoint.id)}, ${sqlText(row.id)}, 1,` +
        ` ${sqlText('push')}, ${sqlText('push')}, ${sqlText('push')},` +
        ` ${sqlText('rfc319/restart-repair')}, ${sqlText(row.status)},` +
        ` ${row.reason === null ? 'NULL' : sqlText(row.reason)}, ${String(now)},` +
        ` ${sqlText('{"rfc319":"restart-repair"}')});`,
    )
  }

  const readAll = (): string[] =>
    querySqlite<{ id: string; status: string; reason: string | null }>(
      db,
      "SELECT id, status, status_reason AS reason FROM webhook_deliveries WHERE id LIKE '01RFC319DELIVERY%' ORDER BY id;",
    ).map((row) => `${row.id}=${row.status}/${row.reason ?? ''}`)

  expect(readAll(), '语料没落库 ⇒ 重启之后的断言会跑在空集上，怎么改产品都不会红').toEqual([
    '01RFC319DELIVERYIGNOR00=ignored/unsupported-event',
    '01RFC319DELIVERYMATCH00=matched/',
    '01RFC319DELIVERYPROC000=processing/',
    '01RFC319DELIVERYRECV000=received/',
  ])

  // 真的停一次、真的起一次，同一个 home。进程内调用那个函数只能证明函数存在，
  // 证明不了发行二进制的启动序列里排着它。
  await first.stop()
  liveDaemons.length = 0
  const second = await launch({ home })
  expect(second.baseUrl.length, '第二代 daemon 没起来 ⇒ 这条用例什么都没验').toBeGreaterThan(0)

  expect(
    readAll(),
    '重启之后，上一代死在分发中途的投递仍然挂在 received / processing ⇒ ' +
      '它们永远不会被任何人推进：审计页上是一排「处理中」的僵尸，' +
      '而「重放」这个唯一的补救入口只对终态行开放；反过来，如果已经终态的行也被' +
      '改写了，那就是把一次成功的匹配改成了失败，事后对账全乱',
  ).toEqual([
    '01RFC319DELIVERYIGNOR00=ignored/unsupported-event',
    '01RFC319DELIVERYMATCH00=matched/',
    '01RFC319DELIVERYPROC000=failed/interrupted',
    '01RFC319DELIVERYRECV000=failed/interrupted',
  ])
})

// ---------------------------------------------------------------------------
// EVENT-36 —— 按需观察器：有订阅才轮询、最后一个订阅撤走就停
// ---------------------------------------------------------------------------

interface ObserverHealth {
  sourceRef: { id: string; revision: number }
  subscriberCount: number
  state: string
}

test('RFC-319 EVENT-36: 没人关注时按需观察器一拍都不跑，来一个订阅就起、最后一个订阅撤走就停 @nightly', async () => {
  test.setTimeout(180_000)
  const daemon = await launch()

  // 目标来源必须是 observationMode 里带观察器的那一类。从目录里挑，而不是把 id
  // 写死：写死的话内置来源改名会让用例红在一个与被测语义无关的地方。
  const catalog = await jsonOf<{
    eventTypes: Array<{
      eventTypeRef: { id: string; revision: number }
      sourceRef: { id: string; revision: number }
      subjectTypeId: string
    }>
  }>(await req(daemon, '/api/event-center/catalog'), 'event catalog')
  const eventType = catalog.eventTypes.find(
    (row) => row.sourceRef.id === 'development.approval-state',
  )
  expect(
    eventType,
    '事件目录里没有「外部审批状态观察」这个按需来源 ⇒ 这条能力的载体不存在了，' +
      '用例应当随产品一起改，而不是继续绿着',
  ).toBeTruthy()
  const sourceId = eventType!.sourceRef.id

  const observersOf = async (): Promise<ObserverHealth | undefined> => {
    const body = await jsonOf<{ items: ObserverHealth[] }>(
      await req(daemon, '/api/event-center/observers'),
      'observer health',
    )
    return body.items.find((row) => row.sourceRef.id === sourceId)
  }
  const runDue = async (): Promise<string> =>
    (
      await jsonOf<{ state: string }>(
        await req(daemon, '/api/event-center/observers/run-due', { method: 'POST' }),
        'run one due observer',
      )
    ).state

  // --- ① 没人关注：既没有活着的观察器，也没有任何一拍可跑 ---------------------
  const before = await observersOf()
  expect(
    before?.state ?? 'idle',
    '一条订阅都没有的时候观察器就已经是 active 了 ⇒ 平台在无人关注时也照样按周期' +
      '去打外部审批系统，那是纯粹的白烧配额（「按需」两个字的全部意义就在这里）',
  ).not.toBe('active')
  expect(
    await runDue(),
    '没有任何订阅时 run-due 仍然认领并跑了一拍 ⇒ 同上：轮询与「有没有人在等」脱钩了',
  ).toBe('idle')

  // --- ② 来一个订阅：观察器必须起来 ------------------------------------------
  const subscribed = await jsonOf<{ subscriptionId: string; observerTransition: string }>(
    await req(daemon, '/api/event-center/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        eventTypeRef: eventType!.eventTypeRef,
        subject: { typeId: eventType!.subjectTypeId, subjectRef: 'rfc319-approval-subject' },
        subscriber: { kind: 'system', subscriberRef: 'rfc319-event36' },
      }),
    }),
    'subscribe',
  )
  expect(
    subscribed.observerTransition,
    '第一个订阅进来时没有把观察器起起来 ⇒ 有人明确在等这条事件，平台却一次都不去看，' +
      '这条订阅永远等不到任何东西',
  ).toBe('started')

  const active = await observersOf()
  expect(
    active?.state,
    '订阅建好了，观察器健康面上却不是 active ⇒ 运维在事件总览上看到的是「按需停止」，' +
      '会以为没人关注、进而把这条来源下线',
  ).toBe('active')
  expect(
    active?.subscriberCount,
    '有效订阅数没记上 ⇒ 「还有几个人在等这条事件」这个下线前的唯一依据是错的',
  ).toBe(1)

  // 真的能被认领并跑一拍。这里不要求它跑成功——外部审批系统在 e2e 里并不存在，
  // 失败是合理结局；要求的是它**不再是 idle**，即「有人关注 ⇒ 平台真的去看了」。
  const ran = await runDue()
  expect(
    ran,
    `有订阅在等的时候 run-due 仍然返回 ${ran} ⇒ 观察器被起来了却永远轮不到它，` +
      '「有人关注就去看」这条链断在认领这一环',
  ).not.toBe('idle')

  // --- ③ 最后一个订阅撤走：必须停 --------------------------------------------
  const cancelled = await jsonOf<{ observerTransition: string }>(
    await req(daemon, `/api/event-center/subscriptions/${subscribed.subscriptionId}`, {
      method: 'DELETE',
    }),
    'unsubscribe',
  )
  expect(
    cancelled.observerTransition,
    '最后一个订阅撤走之后观察器没有被停下 ⇒ 一条没人关注的来源会永远按周期打外部系统，' +
      '而且没有任何界面会告诉运维这件事还在发生',
  ).toBe('stopped')

  const after = await observersOf()
  expect(
    after?.state,
    '订阅清零之后观察器健康面上仍然是 active ⇒ 界面与实际相反，' +
      '运维据此认为「还有人在等」，于是永远不敢下线这条来源',
  ).not.toBe('active')
  expect(
    after?.subscriberCount,
    '订阅撤了但计数没降 ⇒ 有效订阅数只涨不跌，这个数字从此失去意义',
  ).toBe(0)
})

// ---------------------------------------------------------------------------
// EVENT-48 —— 定时任务点火经 /ws/scheduled-tasks 推到每一个打开的标签页
// ---------------------------------------------------------------------------

interface ScheduledRow {
  id: string
  nextRunAt: number | null
  lastTaskId: string | null
}

async function seedIntervalSchedule(
  daemon: DaemonHandle,
  workflowId: string,
  repoUrl: string,
  name: string,
): Promise<ScheduledRow> {
  return jsonOf<ScheduledRow>(
    await req(daemon, '/api/scheduled-tasks', {
      method: 'POST',
      body: JSON.stringify({
        name,
        launchKind: 'workflow',
        // 一天一次：这条用例不等它自己到点（那是 EVENT-42 的事），
        // 用 run-now 主动点火，所以频率只要「不会在用例期间自己跑起来」即可。
        scheduleSpec: { kind: 'daily', at: '03:17', timezone: 'UTC' },
        enabled: true,
        launchPayload: {
          workflowId,
          name: `${name}-run`,
          repoUrl,
          ref: 'main',
          inputs: { topic: 'scheduled' },
        },
      }),
    }),
    `create scheduled task ${name}`,
  )
}

/** 一个可克隆的夹具远端（定时任务的 launchPayload 需要一个真 repoUrl）。 */
function makeFixtureRemote(tag: string): string {
  const root = scratchDir(tag)
  const working = join(root, 'src')
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'README.md'), `# rfc-319 ${tag}\n`, 'utf-8')
  initGitRepo(working, { message: `rfc-319 ${tag}` })
  const bare = join(root, `${tag}.git`)
  cloneBareGitRepo(working, bare)
  return repoRemoteUrl(bare)
}

test('RFC-319 EVENT-48: 一次点火经 /ws/scheduled-tasks 推到每一个打开的标签页，看不见这条规则的人一帧都收不到 @nightly', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const daemon = await launch()
  const repoUrl = makeFixtureRemote('sched-ws')
  const workflowId = await seedEchoWorkflow(daemon, `rfc319-ws-wf-${Date.now().toString(36)}`)
  const schedule = await seedIntervalSchedule(
    daemon,
    workflowId,
    repoUrl,
    `rfc319-ws-${Date.now().toString(36)}`,
  )

  // 陌生人：普通 user 角色自带 scheduled-tasks:read，所以他**进得了** /scheduled，
  // 只是看不见别人私有的那一行。这正是通道鉴权要挡住的形状。
  const strangerName = `rfc319_ws_stranger_${Date.now().toString(36)}`
  const strangerPassword = 'Rfc319WsStranger!1'
  await jsonOf(
    await req(daemon, '/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: strangerName,
        displayName: strangerName,
        email: `${strangerName}@example.com`,
        role: 'user',
        password: strangerPassword,
      }),
    }),
    'create stranger',
  )
  const strangerToken = (
    await jsonOf<{ sessionToken: string }>(
      await fetch(`${daemon.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: strangerName, password: strangerPassword }),
      }),
      'login stranger',
    )
  ).sessionToken

  interface Watcher {
    readonly page: Page
    readonly sockets: string[]
    readonly frames: string[]
  }

  const watch = (page: Page): Watcher => {
    const sockets: string[] = []
    const frames: string[] = []
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/ws/scheduled-tasks')) return
      sockets.push(socket.url())
      socket.on('framereceived', (frame) => frames.push(String(frame.payload)))
    })
    return { page, sockets, frames }
  }

  const strangerContext = await browser.newContext()
  const ownerA = await browser.newContext()
  try {
    const tabA = watch(await ownerA.newPage())
    const tabB = watch(await ownerA.newPage())
    const stranger = watch(await strangerContext.newPage())

    // 两个 owner 标签页停在**详情页**：run-now 刻意不改「上次运行」那几列
    // （EVENT-40 锁的正是这条），所以列表页上没有任何东西会因为这次点火而变，
    // 拿它当判据会写出一条恒假的断言。真正随推送变的是运行历史。
    for (const tab of [tabA, tabB]) {
      await primeAuth(tab.page, daemon)
      await tab.page.goto(`${daemon.baseUrl}/scheduled/${schedule.id}`)
      await expect(
        tab.page.getByTestId('scheduled-detail'),
        '定时任务详情页没渲染 ⇒ 后面的实时断言全都跑在一张白屏上',
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        tab.page.getByTestId('scheduled-history'),
        '还没跑过就已经有运行历史 ⇒ 下面「多出一行」的判据从一开始就成立，等于恒真',
      ).toHaveCount(0)
    }
    await primeAuth(stranger.page, daemon, strangerToken)
    await stranger.page.goto(`${daemon.baseUrl}/scheduled`)
    await expect(
      stranger.page.getByTestId(`scheduled-row-${schedule.id}`),
      '别人私有的定时任务出现在了陌生人的列表里 ⇒ 可见性边界在读面上就已经破了',
    ).toHaveCount(0)

    // 三个标签页都必须真的连上了通道。没有这一条，下面「陌生人一帧都没收到」
    // 会因为他压根没连而恒真。
    for (const [label, tab] of [
      ['owner tab A', tabA],
      ['owner tab B', tabB],
      ['stranger', stranger],
    ] as const) {
      await expect
        .poll(() => tab.sockets.length, {
          timeout: 30_000,
          message: `${label} 没有连上 /ws/scheduled-tasks ⇒ 这个页面此后只能靠轮询兜底`,
        })
        .toBeGreaterThan(0)
    }

    // 第三方（这里是带外 API 调用，等价于同事在另一台机器上按了「立即运行」）点火。
    const run = await jsonOf<{ taskId: string }>(
      await req(daemon, `/api/scheduled-tasks/${schedule.id}/run-now`, { method: 'POST' }),
      'run now',
    )
    expect(run.taskId, '立即运行没有产出任务 ⇒ 这次点火本身就没发生').toBeTruthy()

    for (const [label, tab] of [
      ['owner tab A', tabA],
      ['owner tab B', tabB],
    ] as const) {
      await expect
        .poll(() => tab.frames.filter((frame) => frame.includes('"scheduled.fired"')).length, {
          timeout: 30_000,
          intervals: [250],
          message:
            `${label} 没有收到 scheduled.fired 帧 ⇒ 这个标签页上的「上次运行」要等下一次` +
            '轮询才会变；两个标签页之间会长时间显示互相矛盾的状态',
        })
        .toBeGreaterThan(0)
      const history = tab.page.getByTestId('scheduled-history')
      await expect(
        history,
        `${label} 上运行历史没有在不重载的情况下长出来 ⇒ ` +
          '推送到了却没有接线到界面，实时同步只是一条死在客户端的消息',
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        history.locator('tbody tr'),
        `${label} 的运行历史行数不是 1 ⇒ 这次点火要么没被记进历史，要么记了不止一条`,
      ).toHaveCount(1)
      await expect(
        history.locator('tbody tr a.data-table__link'),
        `${label} 的历史行没有指向这次真正开出来的那个任务 ⇒ 推来的只是一个刷新信号，` +
          '刷回来的内容与这次点火无关',
      ).toHaveAttribute('href', new RegExp(`/tasks/${run.taskId}$`))
    }

    expect(
      stranger.frames.filter((frame) => frame.includes(schedule.id)),
      '陌生人的标签页收到了别人定时任务的推送帧 ⇒ 通道鉴权漏了：' +
        '任何登录用户都能实时旁观别人的自动化在什么时候跑、跑出了哪个任务 id',
    ).toEqual([])
  } finally {
    await strangerContext.close()
    await ownerA.close()
  }
})

// ---------------------------------------------------------------------------
// EVENT-X2 —— 编辑既有定时任务：频率弹窗 + 全量载荷重编辑
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-X2: 频率弹窗改周期真落库并重算下一次触发，全量重编辑按原载荷回填并整体替换而不动频率 @nightly', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const daemon = await launch()
  const repoUrl = makeFixtureRemote('sched-edit')
  const workflowId = await seedEchoWorkflow(daemon, `rfc319-edit-wf-${Date.now().toString(36)}`)
  const originalName = `rfc319-edit-${Date.now().toString(36)}`
  const schedule = await seedIntervalSchedule(daemon, workflowId, repoUrl, originalName)
  expect(
    schedule.nextRunAt,
    '新建的定时任务没有排下一次运行 ⇒ 「改完频率要重算」这条判据没有起点',
  ).not.toBeNull()

  interface ScheduledDetail {
    name: string
    nextRunAt: number | null
    scheduleSpec: { kind?: string; daysOfWeek?: number[]; at?: string } | null
    launchPayload: { name?: string; inputs?: Record<string, unknown> }
  }
  const read = async (): Promise<ScheduledDetail> =>
    jsonOf<ScheduledDetail>(
      await req(daemon, `/api/scheduled-tasks/${schedule.id}`),
      'read scheduled task',
    )
  expect(
    (await read()).scheduleSpec?.kind,
    '前置不成立：这条规则不是按天的，下面「改成按周」就不是一次真的变更',
  ).toBe('daily')

  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/scheduled/${schedule.id}`)
  await expect(
    page.getByTestId('scheduled-detail'),
    '定时任务详情页没渲染 ⇒ 两个编辑入口都无从点起',
  ).toBeVisible({ timeout: 30_000 })

  // --- ① 频率弹窗：daily → weekly ---------------------------------------------
  await page.getByTestId('scheduled-edit').click()
  await expect(
    page.getByTestId('schedule-dialog'),
    '点「编辑」没有打开频率弹窗 ⇒ 一条已经存在的规则再也改不了周期，只能删了重建',
  ).toBeVisible()
  await page.getByTestId('schedule-kind-weekly').click()
  // 从「按天」切过来时弹窗会给 daysOfWeek 一个默认值（当天那一格），所以不能只点一下
  // 星期三就断言 [3]——那样断言会随「今天星期几」在不同日子给出不同结果。先把非目标的
  // 格子逐个关掉，再确保目标格是选中的，判据才与运行日期无关。
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    const cell = page.getByTestId(`schedule-dow-${day}`)
    const pressed = (await cell.getAttribute('aria-pressed')) === 'true'
    if (day === 3 ? !pressed : pressed) await cell.click()
  }
  await expect(
    page.getByTestId('schedule-dow-3'),
    '星期三没有被选上 ⇒ 下面那条「落库的是 [3]」会红在夹具上而不是产品上',
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('schedule-at').fill('04:05')
  const [saveResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/scheduled-tasks/${schedule.id}` &&
        response.request().method() === 'PUT',
    ),
    page.getByTestId('schedule-save').click(),
  ])
  expect(
    saveResponse.status(),
    `保存新频率被拒（${await saveResponse.text()}）⇒ 弹窗里改得动、存不下`,
  ).toBe(200)

  const afterFrequency = await read()
  expect(
    afterFrequency.scheduleSpec?.kind,
    '弹窗里选了「每周」，服务端存下来的却不是 weekly ⇒ 用户看到弹窗关掉、以为改好了，' +
      '实际这条规则还按原来的节奏跑',
  ).toBe('weekly')
  expect(
    afterFrequency.scheduleSpec?.daysOfWeek,
    '选中的星期几没有落库 ⇒ 「每周三」变成了一个没有星期的每周规则',
  ).toEqual([3])
  expect(
    afterFrequency.scheduleSpec?.at,
    '时刻没有落库 ⇒ 规则会在一个用户从来没选过的时间点开工',
  ).toBe('04:05')
  expect(
    afterFrequency.nextRunAt,
    '改完频率之后「下一次触发」没有按新频率重算 ⇒ 界面上写的时间与它真正会跑的时间不是一回事',
  ).not.toBe(schedule.nextRunAt)
  // 只断言「变了」是不够的：把重算换成任何一个别的数字都能满足它（2026-08-26 变异实测，
  // 写成 `now + 999_999_999` 用例照样绿）。每周规则有一条与时区无关的硬性质——下一次
  // 触发必然落在此刻之后、且不超过 7 天。用它把「变了」收紧成「算对了」。
  const weekMs = 7 * 24 * 60 * 60 * 1000
  const sinceNow = (afterFrequency.nextRunAt ?? 0) - Date.now()
  expect(
    sinceNow > 0 && sinceNow <= weekMs + 60_000,
    `每周规则的下一次触发落在 ${Math.round(sinceNow / 3600_000)} 小时之后 ⇒ ` +
      '不是按「每周三 04:05」算出来的（每周规则不可能超过 7 天）',
  ).toBe(true)

  // --- ② 全量重编辑：按原载荷回填，保存是整份替换，且不许动到频率 --------------
  await page.getByTestId('scheduled-edit-config').click()
  await page.waitForURL(new RegExp(`/tasks/new\\?.*editScheduled=${schedule.id}`), {
    timeout: 30_000,
  })
  await expect(
    page.getByTestId('task-wizard'),
    '全量重编辑没有把向导带起来 ⇒ 这条规则的启动参数此后只能靠删了重建来改',
  ).toBeVisible({ timeout: 30_000 })
  // 回填完成后向导停在「空间」步（tasks.new.tsx:658-660），任务名在下一步。
  await page.getByTestId('stepper-next').click()
  const nameField = page.getByTestId('wizard-task-name')
  await expect(nameField, '向导没有走到内容步 ⇒ 下面的回填断言无从落地').toBeVisible({
    timeout: 30_000,
  })
  await expect(
    nameField,
    '向导没有按这条规则原本的载荷回填任务名 ⇒ 用户面对的是一张空表单，' +
      '一保存就把原来的配置整个覆盖掉了',
  ).toHaveValue(`${originalName}-run`)

  const replacedName = `${originalName}-replaced`
  await nameField.fill(replacedName)
  // 工作流输入必须由用户重新填一遍：回填只带回了任务名与空间，`inputs` 没有跟着回来
  // （实测，见报告 §5 的缺陷记录）。这里**照产品当前的实际行为**走完这一步，
  // 而不是把「输入应当被回填」写成一条永远红的断言。
  const topicField = page.getByRole('textbox', { name: 'Topic' })
  await expect(
    topicField,
    '内容步上没有渲染工作流声明的输入 ⇒ 这条规则的输入无从编辑',
  ).toBeVisible()
  await topicField.fill('rescheduled-topic')
  await page.getByTestId('stepper-next').click()
  await expect(
    page.getByTestId('wizard-save-config'),
    '编辑模式下的最后一步没有「保存配置」按钮 ⇒ 改完没有出口',
  ).toBeVisible({ timeout: 30_000 })
  const [configResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/scheduled-tasks/${schedule.id}` &&
        response.request().method() === 'PUT',
    ),
    page.getByTestId('wizard-save-config').click(),
  ])
  expect(
    configResponse.status(),
    `全量重编辑保存被拒（${await configResponse.text()}）⇒ 向导能改、存不下`,
  ).toBe(200)

  const afterConfig = await read()
  expect(
    afterConfig.launchPayload.name,
    '向导里改的任务名没有替换掉原载荷 ⇒ 用户改完看到跳回详情页，以为生效了，' +
      '下一次到点跑的还是旧配置',
  ).toBe(replacedName)
  expect(
    afterConfig.launchPayload.inputs,
    '保存的是**整份**载荷替换：向导里填的工作流输入必须原样落库，' +
      '否则下一次到点跑的是一份缺输入的启动请求，规则会以校验失败收场',
  ).toEqual({ topic: 'rescheduled-topic' })
  expect(
    afterConfig.scheduleSpec?.kind,
    '全量重编辑把频率一起改掉了 ⇒ 两个入口互相踩：改一次启动参数就丢一次周期设置',
  ).toBe('weekly')
  expect(
    afterConfig.scheduleSpec?.daysOfWeek,
    '全量重编辑把星期几冲掉了 ⇒ 同上，两个入口不是正交的',
  ).toEqual([3])
})

// ---------------------------------------------------------------------------
// REPO-39 —— 孤儿工作树与半成品镜像目录的自动回收
// ---------------------------------------------------------------------------

/** 24 小时是这两处回收的年龄地板（gc.ts 的 SCRATCH_ORPHAN_MIN_AGE_MS）。 */
function ageDir(dir: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs)
  utimesSync(dir, when, when)
}

test('RFC-319 REPO-39: 没有任务行锚定的孤儿工作树与半成品镜像目录被后台拍回收，而有主的、未到龄的都原样留着 @nightly', async () => {
  // 这一拍的相位是 daemon 启动后 4 分钟（daemonCadence.ts 的 MAINTENANCE_PHASE.worktreeGc），
  // 既没有 boot 首拍也没有手动入口，所以这条用例只能真等。预算按 4 分钟相位 + 余量给。
  test.setTimeout(420_000)
  const daemon = await launch()
  const worktrees = join(daemon.home, 'worktrees', 'rfc319-fixture-slug')
  const repos = join(daemon.home, 'repos')
  mkdirSync(worktrees, { recursive: true })
  mkdirSync(repos, { recursive: true })

  const anchoredTaskId = '01RFC319GCANCHORED00000'
  const orphanTaskId = '01RFC319GCORPHAN0000000'
  const youngOrphanTaskId = '01RFC319GCYOUNGORPHAN00'

  const plantWorktree = (taskId: string, ageMs: number): string => {
    const dir = join(worktrees, taskId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'work.txt'), 'rfc319-repo-39\n', 'utf-8')
    ageDir(dir, ageMs)
    return dir
  }
  const anchored = plantWorktree(anchoredTaskId, 30 * DAY_MS)
  const orphan = plantWorktree(orphanTaskId, 30 * DAY_MS)
  const youngOrphan = plantWorktree(youngOrphanTaskId, 60_000)

  // 只有 anchored 那一个有任务行。回收判据就是「盘上这个目录名还能不能在 tasks 表里
  // 找到锚」——所以这条对照腿是整条用例的核心：删得动孤儿、又不许碰有主的。
  runSqlite(
    databasePath(daemon),
    'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,' +
      ' base_branch, branch, status, inputs, started_at, finished_at, space_kind, repo_count)' +
      ` VALUES (${sqlText(anchoredTaskId)}, ${sqlText('RFC-319 anchored worktree')},` +
      ` ${sqlText('rfc319-gc-wf')},` +
      ` ${sqlText('{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}')},` +
      ` ${sqlText(join(daemon.home, 'fixture-repo'))}, ${sqlText(anchored)}, ${sqlText('main')},` +
      ` ${sqlText(`agent-workflow/${anchoredTaskId}`)}, ${sqlText('done')}, ${sqlText('{}')},` +
      ` ${String(Date.now() - 30 * DAY_MS)}, ${String(Date.now() - 30 * DAY_MS)},` +
      ` ${sqlText('remote')}, 1);`,
  )
  expect(
    querySqlite<{ id: string }>(databasePath(daemon), 'SELECT id FROM tasks ORDER BY id;').map(
      (row) => row.id,
    ),
    '锚定用的任务行没落库 ⇒ 「有主的目录不许删」这条对照腿会退化成与孤儿同形，' +
      '整条用例就只剩一个「都删了」的空判据',
  ).toEqual([anchoredTaskId])

  // 半成品镜像目录：冷克隆先落到 `<hash>-<slug>~partial~<ULID>`，成功后才原子改名。
  // 进程被 SIGKILL 时它会留在盘上，此前无人回收（gc.ts:583-620）。
  // `~` 不在 slug 白名单里，所以这个判据在字符集层面不可能误命中一个合法镜像目录——
  // 下面那个同前缀的 canonical 目录就是这条「不许误删」的对照。
  const partial = join(repos, 'abcd1234-rfc319~partial~01ARZ3NDEKTSV4RRFFQ69G5FAV')
  const canonical = join(repos, 'abcd1234-rfc319')
  for (const dir of [partial, canonical]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    ageDir(dir, 30 * DAY_MS)
  }

  await expect
    .poll(() => existsSync(orphan), {
      timeout: 330_000,
      intervals: [5_000],
      message:
        '一个没有任何任务行锚定、且早就过了 24 小时年龄地板的工作树目录，在后台拍过之后' +
        '还在盘上 ⇒ 「先删行、再尽力删盘」这套删除语义就没有兜底了：每一次任务硬删' +
        '（或删行与删盘之间的一次崩溃）都会永久留下一整份工作树，机器最终被自己删掉的' +
        '任务塞满磁盘',
    })
    .toBe(false)

  expect(
    existsSync(anchored),
    '还有任务行指着它的工作树被当成孤儿删了 ⇒ 用户点开任务详情看产物时目录已经没了，' +
      '这是数据丢失级别的后果',
  ).toBe(true)
  expect(
    existsSync(youngOrphan),
    '刚建出来一分钟的目录就被当成孤儿删了 ⇒ 年龄地板没生效，' +
      '一次正在进行中的 materialize 会被后台从脚下抽走',
  ).toBe(true)
  expect(
    existsSync(partial),
    '崩在冷克隆中途留下的半成品镜像目录没有被回收 ⇒ 每一次克隆被打断都在 repos/ 下' +
      '留一份几百兆的垃圾，而没有任何界面会列出它们',
  ).toBe(false)
  expect(
    existsSync(canonical),
    '一个正常的镜像目录被半成品回收顺手删了 ⇒ cached_repos.local_path 指向空气，' +
      '所有引用它的任务连工作树都建不起来',
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// REPO-40 —— 子模块递归模式：存下去就对下一次克隆生效
// ---------------------------------------------------------------------------

interface MirrorRow {
  id: string
  localPath: string
  hasSubmodules: boolean | null
}

/** 走产品自己的批量导入接口把一个远端搬进来（不是直连 SQL：这条用例要的是真克隆）。 */
async function importMirror(daemon: DaemonHandle, url: string): Promise<MirrorRow> {
  interface Snapshot {
    batchId: string
    state: 'running' | 'completed'
    rows: Array<{ status: string; message: string | null; cachedRepoId: string | null }>
  }
  let snapshot = await jsonOf<Snapshot>(
    await req(daemon, '/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls: [url] }),
    }),
    `batch import ${url}`,
  )
  await expect
    .poll(
      async () => {
        if (snapshot.state === 'completed') return true
        snapshot = await jsonOf<Snapshot>(
          await req(daemon, `/api/cached-repos/imports/${snapshot.batchId}`),
          'batch snapshot',
        )
        return snapshot.state === 'completed'
      },
      { message: `导入 ${url} 一直没收敛`, timeout: 120_000, intervals: [200, 300, 500] },
    )
    .toBe(true)
  expect(
    snapshot.rows.map((row) => row.status),
    `导入 ${url} 没有成功（${JSON.stringify(snapshot.rows.map((row) => row.message))}）⇒ 夹具没建起来`,
  ).toEqual(['done'])
  const body = await jsonOf<{ items: MirrorRow[] }>(
    await req(daemon, '/api/cached-repos'),
    'list cached repos',
  )
  const hit = body.items.find((row) => row.id === snapshot.rows[0]!.cachedRepoId)
  expect(hit, `导入声称成功但列表里找不到这行：${url}`).toBeTruthy()
  return hit!
}

/** 造一个真带子模块的远端（child 以真 http 远端被 parent 挂进 vendor/child）。 */
function makeSubmoduleRemote(tag: string): string {
  const childRoot = scratchDir(`${tag}-child`)
  const childWorking = join(childRoot, 'src')
  mkdirSync(childWorking, { recursive: true })
  writeFileSync(join(childWorking, 'README.md'), `# rfc-319 ${tag} child\n`, 'utf-8')
  initGitRepo(childWorking, { message: `rfc-319 ${tag} child` })
  const childBare = join(childRoot, `${tag}-child.git`)
  cloneBareGitRepo(childWorking, childBare)

  const parentRoot = scratchDir(`${tag}-parent`)
  const parentWorking = join(parentRoot, 'src')
  mkdirSync(parentWorking, { recursive: true })
  writeFileSync(join(parentWorking, 'README.md'), `# rfc-319 ${tag} parent\n`, 'utf-8')
  initGitRepo(parentWorking, { message: `rfc-319 ${tag} parent` })
  runGit(['submodule', 'add', '-q', repoRemoteUrl(childBare), 'vendor/child'], parentWorking)
  runGit(['add', '.'], parentWorking)
  runGit(
    ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', 'rfc-319 add submodule'],
    parentWorking,
  )
  const parentBare = join(parentRoot, `${tag}-parent.git`)
  cloneBareGitRepo(parentWorking, parentBare)
  return repoRemoteUrl(parentBare)
}

test('RFC-319 REPO-40: 在设置页把子模块模式改成「从不」之后，下一次克隆真的不再拉子模块；改回「总是」的那一次又拉回来了 @nightly', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const daemon = await launch()

  // --- ① 在**界面上**把它改成 never，并确认后端读到的是同一个值 ----------------
  // 这一步专门堵「界面能填、后端不读」：设置页有这个下拉不等于克隆那条路会去看它。
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/settings?tab=git`)
  const modeSelect = page.getByRole('combobox', { name: 'Submodule recursion' })
  await expect(
    modeSelect,
    '设置页的 Git 分区没有「子模块递归模式」这个控件 ⇒ 这条能力在界面上不可达',
  ).toBeVisible({ timeout: 30_000 })
  await modeSelect.click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox, '自绘下拉没有展开 ⇒ 用户点了没反应，这一项等于不可编辑').toBeVisible()
  await listbox.locator('li[role="option"]').filter({ hasText: 'never (off)' }).click()
  await expect(listbox).toBeHidden()
  const [neverSaved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/config' && response.request().method() === 'PUT',
    ),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ])
  expect(
    neverSaved.status(),
    `把子模块模式存成「从不」被拒（${await neverSaved.text()}）⇒ 界面上改得动、存不下`,
  ).toBe(200)

  const configAfterNever = await jsonOf<{ gitRecurseSubmodules?: string }>(
    await req(daemon, '/api/config'),
    'read config',
  )
  expect(
    configAfterNever.gitRecurseSubmodules,
    '界面上选了「从不」，后端读回来的却不是 never ⇒ 这个下拉是个装饰品',
  ).toBe('never')

  // --- ② never 那一次克隆：`.gitmodules` 在，子模块内容不许在 -------------------
  const neverMirror = await importMirror(daemon, makeSubmoduleRemote('repo40-never'))
  expect(
    existsSync(join(neverMirror.localPath, '.gitmodules')),
    '夹具不成立：这个仓根本不带子模块，下面「有没有拉子模块」就无从谈起',
  ).toBe(true)
  expect(
    existsSync(join(neverMirror.localPath, 'vendor', 'child', 'README.md')),
    '子模块模式设成「从不」，克隆时却照样把子模块拉了下来 ⇒ ' +
      '这个设置对克隆无效：运维为了避开一个拉不动的私有子模块把它关掉，' +
      '每一次导入仍然卡在同一个地方',
  ).toBe(false)

  // --- ③ 改成 always：同一形状的另一个仓，这次必须拉下来 -----------------------
  // 换一个远端而不是重导同一个，是因为已经在缓存里的镜像不会再走一次冷克隆，
  // 拿它做对照证明不了「设置对**下一次克隆**生效」。
  const applied = await req(daemon, '/api/config', {
    method: 'PUT',
    body: JSON.stringify({ gitRecurseSubmodules: 'always' }),
  })
  expect(applied.status, `把子模块模式改回「总是」被拒（${await applied.clone().text()}）`).toBe(
    200,
  )

  const alwaysMirror = await importMirror(daemon, makeSubmoduleRemote('repo40-always'))
  expect(
    existsSync(join(alwaysMirror.localPath, 'vendor', 'child', 'README.md')),
    '子模块模式设成「总是」，克隆下来的却仍然是一棵缺子模块的树 ⇒ ' +
      '任务会在一份残缺的代码上开工，而徽标与界面都不会告诉任何人',
  ).toBe(true)
})

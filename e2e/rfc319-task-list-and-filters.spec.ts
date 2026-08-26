// RFC-319 —— `/tasks` 任务列表与「工作区回收」详情降级的用户面 e2e
// （账本 TASK-16 / TASK-17 / TASK-19 / TASK-21 / TASK-24 / TASK-45 / TASK-X5）。
//
// 任务列表是这个平台**唯一**的运行态总览：谁还在跑、谁卡住了、谁失败了、我该先看哪一条，
// 全在这一屏上决定。它坏掉的方式几乎都不报错，只会安静地少给或多给几行——
//
//   * TASK-16 视图页签上的数字是用户的**分诊依据**（「需关注 3」就是今天要处理的三件事）。
//     数字与它筛出来的行对不上，用户会照着一个假的工作量安排一天。搜索去抖没了，则每敲
//     一个字母就打一次全表查询（列表页目标尺度是十万任务）；去抖坏成「永不触发」，用户
//     打完字对着旧结果看，以为搜的东西不存在。状态过滤不经 URL 往返，用户就无法把
//     「我现在看的这一屏」发给同事——那是运维协作里最常见的一个动作。
//   * TASK-17 分页是列表唯一的翻页手段（RFC-311 之后根层显式按钮独占翻页，滚动哨兵已撤，
//     见 tasks.tsx:655-666 的注记）。根层与子分支各有各的游标：任何一侧把另一侧的翻页
//     状态踩掉，症状都是「点了展开的子任务突然折回去」或「翻到第二页根任务列表回到第一页」。
//   * TASK-19 两个空态形状不同：全新安装的空态要**教用户下一步做什么**；「无匹配」要给出
//     **退回全量**的出口。把后者渲染成前者，用户会以为自己的任务全部消失了。
//   * TASK-21 列表打开着不动的时候，别处（另一个人、定时任务、事件中心）会造出新任务、
//     手上这些任务也在自己推进状态。推送断了，界面就那么静止着——不报错、不空白、不转圈，
//     用户以为「还没开始」。反过来，同步做得太粗同样是缺陷：2026-08-26 用户报「每次任务
//     状态更新都会刷新整个任务列表，导致任务列表一直在闪」——当时收到帧只置脏，靠 15 秒
//     一次的 `resetQueries` 整表重建（缓存清空 ⇒ 整屏 loading ⇒ 滚动位置回顶 ⇒ 展开的
//     子分支全塌）。现在两头都要成立：**新行自己进来，且屏幕不许闪**。
//   * TASK-24 取消是运行中任务唯一的用户面刹车。二次确认没了 = 误点一下就杀掉别人跑了
//     半小时的任务；二次确认坏成「点一下就发请求」同理。
//   * TASK-45 工作区回收后，任务记录仍在、但盘上的东西没了。界面若不降级，用户会去点一个
//     必然失败的「重试节点」，然后把这个失败当成系统故障报上来。
//   * TASK-X5 范围（我的 / 共享给我 / 全部）与类别（Agent / 工作流 / 工作组）是多人多租下
//     「这一屏到底在说谁的事」的开关。范围过滤失灵 = 用户看见别人的任务（或看不见自己的）。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check 逐条请求，
// 见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/tasks.tsx:71-117        URL 契约：view / q / statuses / type / scope / origin 六个自有键
//   packages/frontend/src/routes/tasks.tsx:214-230       actor 就绪后把 URL 规范化（默认值键被删掉）
//   packages/frontend/src/routes/tasks.tsx:247-265       搜索去抖：350ms，触发 replace 导航
//   packages/frontend/src/routes/tasks.tsx:282-288       filterDimensionCount / hasAnyFilter 的判据
//   packages/frontend/src/routes/tasks.tsx:290-294       清除过滤 = 导航到裸 /tasks + 焦点回搜索框
//   packages/frontend/src/routes/tasks.tsx:295-310       应用过滤：默认值不写进 URL
//   packages/frontend/src/routes/tasks.tsx:428-434       initialEmpty / noMatches 两个空态的判据
//   packages/frontend/src/routes/tasks.tsx:462-493       initialEmpty 时连工具条都不渲染
//   packages/frontend/src/routes/tasks.tsx:499-518       tasks-empty / tasks-no-matches 两个空态
//   packages/frontend/src/routes/tasks.tsx:538-623       筛选弹窗四个维度：类别 / 状态 / 范围 / 来源
//   packages/frontend/src/routes/tasks.tsx:705-728       根层「加载更多」尾注（不 disabled，见 RFC-311 注记）
//   packages/frontend/src/routes/tasks.tsx:858-877       子分支「加载更多子任务」，独立游标
//   packages/frontend/src/hooks/useTaskOperationsPage.ts:16-44   每页 limit=50，游标来自 nextCursor
//   packages/frontend/src/hooks/useTaskOperationsSync.ts:32-67   六类帧 → 保留数据的 invalidateQueries（就地重取，绝不清缓存）
//   packages/frontend/src/components/operations/OperationsToolbar.tsx:66-125  页签 / 搜索 / 筛选 / 清除的 testid 与角色
//   packages/frontend/src/components/ConfirmButton.tsx:70-99     两击确认：第一击只换文案，不发请求
//   packages/frontend/src/routes/tasks.detail.tsx:526-531        cancelable 的四个状态
//   packages/frontend/src/routes/tasks.detail.tsx:638-645        Cancel 走 ConfirmButton
//   packages/frontend/src/routes/tasks.detail.tsx:853-860        pruning / pruned 两句降级文案
//   packages/frontend/src/routes/tasks.detail.tsx:2041-2047      pruning 期间 3s 轮询，界面自己收敛到 pruned
//   packages/frontend/src/components/NodeDetailDrawer.tsx:134-135 工作区不可用 ⇒ 重试按钮直接不渲染
//   packages/backend/src/services/taskAuthorization.ts:36-55     scope：all / mine（owner∨协作者）/ shared（协作者∧非我）
//   packages/backend/src/services/taskOperations.ts:349-357      view：active / finished / attention 的状态集合
//   packages/backend/src/services/taskOperations.ts:516-535      facets 在 non_view_matches 上求值（含 q / scope / 类别）
//   packages/backend/src/services/taskOperations.ts:471-478      根层排序 (branch_started_at, id) DESC + 行值游标
//   packages/backend/src/modules/task-execution/application/adapters/task-catalog-adapter.ts:7,80
//                                                               类别 = 三个执行源，subject 逐个下推
//   packages/backend/src/services/task.ts:3265-3268              POST /api/tasks 广播 task.created
//   packages/shared/src/taskOperations.ts:10-31                  视图 / 状态集合的单一事实源
//   packages/shared/src/schemas/ws.ts:536                        WS_PATHS.tasksList = '/ws/tasks'
//
// 与既有覆盖的关系（不重复造轮子）：
//   · `e2e/rfc244-task-operations.spec.ts` 的
//     `1280px keeps 30+ tasks dense and paginates roots and child branches independently`
//     已经锁过根层 / 子分支翻页，但它整条跑在 `routeTaskOperationsFixture` 的 **page.route 假
//     后端**上（e2e/task-operations-fixtures.ts:352-440），锁的是前端接线。本文件的 TASK-17
//     跑在**真后端真游标**上：它要证的是服务端 `(branch_started_at, id)` 行值游标与
//     per-source 复合游标真的能把第 51 行之后的任务交出来——那半边假后端一个字节都没碰。
//   · 同文件的 `debounced deep search restores its visible ancestry and advanced status filtering
//     round-trips through URL` 锁的是 UI→URL 方向（填搜索框 / 选状态后看 URL）。本文件的
//     TASK-16 补的是**反方向**：把一条 URL 直接粘进地址栏（同事发过来的那种），界面必须把
//     四个维度都还原回控件里，并且顺手把状态写成规范序。两条方向缺一条，链接就只能单程。
//   · 同文件的 `Event Center and API origin filters…` 锁的是 `origin`（来源）这一维。本文件的
//     TASK-X5 只碰它没碰的另外两维：`scope`（范围）与 `type`（类别）。
//   · `e2e/task-lifecycle-states.spec.ts` 的
//     `task lifecycle: canceled (POST /api/tasks/:id/cancel mid-running)` 锁的是**接口**取消
//     （直接 POST /cancel）。本文件的 TASK-24 锁的是用户真正走的那条路：详情页按钮 + 二次
//     确认，重点在「第一击不能发请求」。
//   · `e2e/live-list-updates.spec.ts` 的 UX-30 锁的是 `/memory` 的实时刷新。任务列表走的是
//     另一条通道（`/ws/tasks` + 就地重取），本文件的 TASK-21 单独覆盖。
//
// 本文件**不用 `page.route` 拦任何 API**（因此也不需要 `unrouteAll`）：整条链路跑真 daemon +
// 真 SQLite。所有夹具要么走产品自己的写接口，要么直连落库（下面每处都注明了为什么只能直连）。
//
// 执行模型：单 daemon、`mode: 'serial'`，文件内用例按**声明顺序**跑。顺序是判据的一部分：
//   · TASK-19 的「全新安装空态」必须第一个跑 —— 任何先跑的用例造出一条任务就让它变成恒假断言；
//     基础语料由它在中途落库，后面几条复用。
//   · TASK-17 的 121 行分页语料排在 TASK-16 / TASK-X5 之后 —— 先塞进去，前面那些精确行计数
//     会被淹进分页窗口里。
//   · TASK-21 / TASK-24 / TASK-45 三条要造**真任务**，排在最后，免得真任务的行混进前面的计数。

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { initGitRepo, repoRemoteUrl, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

declare global {
  interface Window {
    /** TASK-16: page-clock arrival times for each incremental search input. */
    __rfc319TaskSearchInputTimes?: number[]
  }
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let daemon: DaemonHandle
let adminUserId = ''
let peerUserId = ''
let holdDir = ''
let holdFile = ''
let fixtureRepoDir = ''

/** 语料的时间基准：所有种子行的 started_at 都相对它算，保证排序确定。 */
const NOW = Date.now()
const MINUTE = 60_000

const PEER_USERNAME = 'rfc319-taskline-peer'
const PEER_PASSWORD = 'longEnoughPassword'

test.beforeAll(async () => {
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-taskline-hold-'))
  holdFile = join(holdDir, 'turn-hold')
  fixtureRepoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-taskline-repo-'))
  writeFileSync(join(fixtureRepoDir, 'README.md'), '# rfc-319 task list fixture\n', 'utf-8')
  initGitRepo(fixtureRepoDir, { message: 'rfc-319 task list fixture' })

  daemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: {
      STUB_OPENCODE_SLEEP_MS: '0',
      // TASK-45 要一个**必然失败**的真任务（失败的 node_run 才有「重试节点」按钮可看）。
      // 退出码是 daemon 级 env，所以本文件里每一次真启动都以 failed 收场——TASK-21 只看
      // 「新行有没有出现」、TASK-24 在 hold 里就被取消了，两条都不依赖成功收尾。
      STUB_OPENCODE_EXIT_CODE: '1',
      // TASK-24 要一个**确定性地停在 running** 的任务。`STUB_OPENCODE_SLEEP_MS` 只是把窗口
      // 调宽，赢不赢竞态仍看机器快慢；hold 文件给出两个确定信号（stub 起来了会落
      // `<hold>.started`；文件在就不返回），见 packages/system-mocks/src/runtime/mode-slow.ts:53-77。
      // 文件不存在时这段逻辑整个不生效，所以只有 TASK-24 那一刻会 hold。
      STUB_OPENCODE_HOLD_FILE: holdFile,
    },
  })

  adminUserId = (await jsonOf<{ user: { id: string } }>(await req('/api/auth/me'), 'GET /auth/me'))
    .user.id

  const peer = await jsonOf<{ id: string }>(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: PEER_USERNAME,
        displayName: 'RFC-319 taskline peer',
        role: 'user',
        password: PEER_PASSWORD,
      }),
    }),
    'create peer user',
  )
  peerUserId = peer.id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  for (const dir of [holdDir, fixtureRepoDir]) {
    if (dir === '') continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

async function req(path: string, init?: RequestInit): Promise<Response> {
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

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

function sqlNum(value: number | null): string {
  return value === null ? 'NULL' : String(value)
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        // 固定英文：下面所有选择器对的是 en-US 文案。
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function openTasks(page: Page, search = ''): Promise<void> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks${search}`)
  await expect(
    page.getByRole('heading', { name: 'Tasks', exact: true }),
    '/tasks 连页头都没渲染出来 ⇒ 后面每一条断言都只是在断言一张白屏',
  ).toBeVisible()
}

/** 记录本页发往任务目录接口的每一条 GET（只留根层/子层查询，剔除 /sources）。 */
function recordCatalogRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname !== '/api/task-catalog') return
    seen.push(`${url.search}`)
  })
  return seen
}

/** 视图页签上那个计数（`aria-hidden` 的角标，用户就是照它分诊的）。 */
function viewCount(page: Page, view: 'all' | 'active' | 'attention' | 'finished'): Locator {
  return page.getByTestId(`tasks-view-${view}`).locator('.operations-toolbar__count')
}

function filterDialog(page: Page): Locator {
  return page.getByTestId('tasks-filter-dialog').getByRole('dialog')
}

async function openFilterDialog(page: Page): Promise<Locator> {
  await page.getByTestId('tasks-filter-button').click()
  const dialog = filterDialog(page)
  await expect(
    dialog,
    '筛选弹窗打不开 ⇒ 范围 / 类别 / 状态 / 来源四个维度全部不可达，用户只剩一个搜索框',
  ).toBeVisible()
  return dialog
}

/** 断言根层「已加载的行总数」——窗口化后 DOM 里只有可视行，集合大小由 aria-setsize 承载
 *  （同 `e2e/rfc244-task-operations.spec.ts` 的 RFC-311 注记，也正是屏幕阅读器读到的数）。 */
async function expectLoadedRootCount(page: Page, count: number, message: string): Promise<void> {
  await expect(
    page.locator('.task-operations__item[data-depth="0"]').first(),
    message,
  ).toHaveAttribute('aria-setsize', String(count))
}

// ---------------------------------------------------------------------------
// 直连落库夹具
//
// 为什么不全走产品接口：一条真任务要 clone 仓库、起 runtime 子进程、跑完整条调度链，
// 单条就要好几秒；而本文件前四条用例要的是**十几到一百多条、状态/归属/类别精确可控**的
// 语料（`interrupted` 只有 daemon 崩溃后重启才产生，`awaiting_review` 要真评审节点，
// 「别人的任务」要另一个人真去启动）。这些状态真实存在、列表必须说对，所以直连摆出来；
// **它们锁的是 /tasks 这一屏的呈现与过滤**，不是任务生命周期本身（那条另有
// `e2e/task-lifecycle-states.spec.ts` 逐状态覆盖）。TASK-21/24/45 三条要证的是真链路，
// 那三条一律走产品自己的 POST /api/tasks。
// ---------------------------------------------------------------------------

type SeedStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'awaiting_review'
  | 'awaiting_human'

/** 类别 = 三个执行源，判据逐字取自 taskOperations.ts:288-299 的 subject 分支。 */
type SeedCategory = 'workflow' | 'agent' | 'workgroup'

interface SeedTask {
  id: string
  name: string
  status: SeedStatus
  category: SeedCategory
  /** 归属：admin 自己，或 peer（另一个真实账号）。 */
  owner: 'admin' | 'peer'
  /** admin 是否是这条任务的协作者（scope=shared 的判据是「协作者 ∧ 非我」）。 */
  adminIsCollaborator?: boolean
  startedAt: number
  parentId?: string
  /** 子树内 max(started_at) 的物化缓存；根层排序键（schema.ts:1189）。 */
  branchStartedAt?: number
}

const TERMINAL: readonly string[] = ['done', 'failed', 'canceled', 'interrupted']

function seedTaskStatements(rows: readonly SeedTask[]): string[] {
  const statements: string[] = []
  for (const row of rows) {
    const ownerId = row.owner === 'admin' ? adminUserId : peerUserId
    const values = [
      sqlText(row.id),
      sqlText(row.name),
      sqlText(`rfc319-taskline-workflow-${row.category}`),
      sqlText('{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'),
      sqlText('/tmp/rfc319-taskline/fixture-repo'),
      sqlText(`/tmp/rfc319-taskline/worktrees/${row.id}`),
      sqlText('main'),
      sqlText(`agent-workflow/${row.id}`),
      sqlText(row.status),
      sqlText('{}'),
      String(row.startedAt),
      sqlNum(TERMINAL.includes(row.status) ? row.startedAt + 30_000 : null),
      sqlText(ownerId),
      String(row.branchStartedAt ?? row.startedAt),
      sqlText(row.parentId ?? row.id),
      sqlText(row.parentId ?? null),
      sqlNum(row.parentId === undefined ? 0 : 1),
      sqlText(row.category === 'agent' ? 'rfc319-taskline-agent' : null),
      sqlText(row.category === 'agent' ? 'rfc319-taskline-agent-id' : null),
      sqlText(row.category === 'workgroup' ? 'rfc319-taskline-workgroup-id' : null),
      sqlText(row.category === 'workgroup' ? '{"workgroupName":"RFC-319 taskline squad"}' : null),
    ].join(', ')
    statements.push(
      'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,' +
        ' base_branch, branch, status, inputs, started_at, finished_at, owner_user_id,' +
        ' branch_started_at, root_task_id, parent_task_id, invocation_depth, source_agent_name,' +
        ` source_agent_id, workgroup_id, workgroup_config_json) VALUES (${values});`,
    )
    if (row.adminIsCollaborator === true) {
      statements.push(
        'INSERT INTO task_collaborators (task_id, user_id, role, added_by, added_at) VALUES (' +
          [
            sqlText(row.id),
            sqlText(adminUserId),
            sqlText('collaborator'),
            sqlText(ownerId),
            String(row.startedAt),
          ].join(', ') +
          ');',
      )
    }
  }
  return statements
}

function seedTasks(rows: readonly SeedTask[]): void {
  runSqlite(dbPath(), seedTaskStatements(rows).join('\n'))
}

/**
 * 基础语料：11 条根任务，四个视图 / 三个类别 / 三种归属都各有代表。
 *
 * | 视图     | 条数 | 由谁贡献                                        |
 * | all      | 11   | 全部                                                        |
 * | active   |  4   | running + pending + awaiting_review + awaiting_human         |
 * | attention|  3   | failed + awaiting_review + awaiting_human                    |
 * | finished |  7   | done×4（含 shared/foreign/quicksilver）+ failed + canceled + interrupted |
 *
 * 注意 active 与 attention **有重叠**（两个 awaiting_* 同时属于两边），finished 也包含
 * failed —— 这是 shared/taskOperations.ts:14-31 三个集合的定音，不是笔误：四个页签本来
 * 就不是一个划分，而是四种「我现在想看什么」。
 *
 * | 范围        | 条数 | 说明                                    |
 * | all         | 11   | admin 有 tasks:read:all                 |
 * | mine        | 10   | admin 自己 9 条 + 被拉进协作的 1 条     |
 * | shared      |  1   | 只有「别人的 ∧ 拉了我」那一条；alpha 虽然也挂着我的协作行，但它是我自己的 |
 *
 * | 类别      | 条数 |
 * | agent     |  3   |
 * | workflow  |  6   |
 * | workgroup |  2   |
 */
const BASE_CORPUS: readonly SeedTask[] = [
  {
    id: 'rfc319tl-run',
    name: 'RFC-319 taskline alpha running',
    status: 'running',
    category: 'workflow',
    owner: 'admin',
    // 我**自己**的任务，同时我也在它的协作名单里。这是 `scope=shared` 判据里
    // 「owner ≠ 我」那一半唯一的反例：少了它，shared 会把我自己的任务也算成
    // 「别人共享给我的」，而这一档存在的全部意义就是回答「别人交给我什么活」
    // （taskAuthorization.ts:51-53）。
    adminIsCollaborator: true,
    startedAt: NOW - 1 * MINUTE,
  },
  {
    id: 'rfc319tl-pend',
    name: 'RFC-319 taskline bravo pending',
    status: 'pending',
    category: 'workflow',
    owner: 'admin',
    startedAt: NOW - 2 * MINUTE,
  },
  {
    id: 'rfc319tl-fail',
    name: 'RFC-319 taskline charlie failed',
    status: 'failed',
    category: 'agent',
    owner: 'admin',
    startedAt: NOW - 3 * MINUTE,
  },
  {
    id: 'rfc319tl-review',
    name: 'RFC-319 taskline delta awaiting review',
    status: 'awaiting_review',
    category: 'agent',
    owner: 'admin',
    startedAt: NOW - 4 * MINUTE,
  },
  {
    id: 'rfc319tl-human',
    name: 'RFC-319 taskline echo awaiting human',
    status: 'awaiting_human',
    category: 'workgroup',
    owner: 'admin',
    startedAt: NOW - 5 * MINUTE,
  },
  {
    id: 'rfc319tl-done',
    name: 'RFC-319 taskline foxtrot done',
    status: 'done',
    category: 'workflow',
    owner: 'admin',
    startedAt: NOW - 6 * MINUTE,
  },
  {
    id: 'rfc319tl-cancel',
    name: 'RFC-319 taskline golf canceled',
    status: 'canceled',
    category: 'workgroup',
    owner: 'admin',
    startedAt: NOW - 7 * MINUTE,
  },
  {
    id: 'rfc319tl-intr',
    name: 'RFC-319 taskline hotel interrupted',
    status: 'interrupted',
    category: 'agent',
    owner: 'admin',
    startedAt: NOW - 8 * MINUTE,
  },
  {
    id: 'rfc319tl-shared',
    name: 'RFC-319 taskline india shared with me',
    status: 'done',
    category: 'workflow',
    owner: 'peer',
    adminIsCollaborator: true,
    startedAt: NOW - 9 * MINUTE,
  },
  {
    id: 'rfc319tl-foreign',
    name: 'RFC-319 taskline juliett someone else only',
    status: 'done',
    category: 'workflow',
    owner: 'peer',
    startedAt: NOW - 10 * MINUTE,
  },
  {
    id: 'rfc319tl-quick',
    name: 'RFC-319 taskline quicksilver singleton',
    status: 'done',
    category: 'workflow',
    owner: 'admin',
    startedAt: NOW - 11 * MINUTE,
  },
]

const BASE_ALL = BASE_CORPUS.length // 11
const BASE_ACTIVE = 4
const BASE_ATTENTION = 3
const BASE_FINISHED = 7
const BASE_MINE = 10
const BASE_SHARED = 1
const BASE_AGENT = 3
const BASE_WORKFLOW = 6
const BASE_WORKGROUP = 2

/** TASK-17 的分页语料：60 条额外根任务 + 1 条带 60 个子任务的分支。 */
const PAGE_ROOTS = 60
const BRANCH_CHILDREN = 60
const BRANCH_PARENT_ID = 'rfc319pg-branch'

function paginationCorpus(): SeedTask[] {
  const rows: SeedTask[] = []
  // 分支父任务给**最新**的时间，保证它稳定落在第一屏第一行——展开它不必先滚动。
  rows.push({
    id: BRANCH_PARENT_ID,
    name: 'RFC-319 taskline branch parent',
    status: 'done',
    category: 'workflow',
    owner: 'admin',
    startedAt: NOW + MINUTE,
    branchStartedAt: NOW + MINUTE,
  })
  for (let i = 1; i <= BRANCH_CHILDREN; i += 1) {
    rows.push({
      id: `rfc319pg-child-${String(i).padStart(2, '0')}`,
      name: `RFC-319 taskline branch child ${String(i).padStart(2, '0')}`,
      status: 'done',
      category: 'workflow',
      owner: 'admin',
      parentId: BRANCH_PARENT_ID,
      startedAt: NOW - i * 1000,
    })
  }
  // 根任务按 started_at 递减铺开，且全部比基础语料更旧 ⇒ 排序稳定、第二页装的一定是
  // 编号最大的那批（下面的断言据此点名 rfc319pg-60）。
  for (let i = 1; i <= PAGE_ROOTS; i += 1) {
    rows.push({
      id: `rfc319pg-${String(i).padStart(2, '0')}`,
      name: `RFC-319 taskline page ${String(i).padStart(2, '0')}`,
      status: 'done',
      category: 'workflow',
      owner: 'admin',
      startedAt: NOW - (60 + i) * MINUTE,
    })
  }
  return rows
}

/** 一页 50（useTaskOperationsPage.ts:39），三个执行源各自一份游标。 */
const PAGE_LIMIT = 50
const TOTAL_ROOTS = BASE_ALL + PAGE_ROOTS + 1 // 72
const TOTAL_WORKFLOW_ROOTS = BASE_WORKFLOW + PAGE_ROOTS + 1 // 67
const FIRST_PAGE_ROOTS = PAGE_LIMIT + BASE_AGENT + BASE_WORKGROUP // 55

// ---------------------------------------------------------------------------
// 真任务夹具（TASK-21 / TASK-24 / TASK-45）
// ---------------------------------------------------------------------------

let liveWorkflowId = ''

/** 最小可跑工作流：input → agent-single → output，节点 retries=0（失败就是失败）。 */
async function ensureLiveWorkflow(): Promise<string> {
  if (liveWorkflowId !== '') return liveWorkflowId
  const agent = await jsonOf<{ id: string }>(
    await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-taskline-live-agent',
        description: 'RFC-319 task list e2e stub agent',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    }),
    'create live agent',
  )
  const workflow = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-taskline-live-workflow',
        description: 'RFC-319 task list e2e workflow',
        definition: {
          $schema_version: 2,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'agent_1',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-taskline-live-agent',
              promptTemplate: '{{topic}}',
              retries: 0,
              position: { x: 320, y: 0 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
              position: { x: 640, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e1',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'agent_1', portName: 'topic' },
            },
            {
              id: 'e2',
              source: { nodeId: 'agent_1', portName: 'answer' },
              target: { nodeId: 'out_1', portName: 'answer' },
            },
          ],
        },
      }),
    }),
    'create live workflow',
  )
  liveWorkflowId = workflow.id
  return liveWorkflowId
}

async function launchLiveTask(name: string): Promise<string> {
  const workflowId = await ensureLiveWorkflow()
  const task = await jsonOf<{ id: string }>(
    await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId,
        name,
        inputs: { topic: 'rfc-319 task list' },
        repoUrl: repoRemoteUrl(fixtureRepoDir),
        ref: 'main',
      }),
    }),
    `launch live task ${name}`,
  )
  return task.id
}

async function taskStatusOf(taskId: string): Promise<string> {
  const body = await jsonOf<{ status: string }>(
    await req(`/api/tasks/${encodeURIComponent(taskId)}`),
    `read task ${taskId}`,
  )
  return body.status
}

async function waitForTaskStatus(taskId: string, expected: string, message: string): Promise<void> {
  await expect
    .poll(async () => taskStatusOf(taskId), {
      message,
      timeout: 90_000,
      intervals: [200, 300, 500, 1000],
    })
    .toBe(expected)
}

// ---------------------------------------------------------------------------
// TASK-19 —— 两个空态
// ---------------------------------------------------------------------------

test('RFC-319 TASK-19：全新安装的空列表教用户开工，而过滤过窄的空列表给的是退回全量的出口 @nightly', async ({
  page,
}) => {
  await openTasks(page)

  // --- 全新安装：一条任务都没有 -------------------------------------------------
  const emptyState = page.getByTestId('tasks-empty')
  await expect(
    emptyState,
    '全新安装打开 /tasks 没有渲染引导空态 ⇒ 用户面对一片空白，不知道这个平台要怎么开始用',
  ).toBeVisible()
  await expect(
    emptyState,
    '空态没写清楚这里将来会有什么 ⇒ 用户无法判断是「还没建」还是「建了但没显示」',
  ).toContainText('Launch a workflow, workgroup, or single agent')
  await expect(
    emptyState.getByTestId('tasks-new-button'),
    '引导空态里没有「新建任务」入口 ⇒ 平台把用户领到死胡同：告诉他这里空的，却不给下一步',
  ).toBeVisible()
  await expect(
    page.getByTestId('tasks-no-matches'),
    '一条任务都没有却渲染成「无匹配」⇒ 用户会去清过滤，清完还是空的，白折腾一圈',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('tasks-views'),
    '空到没有任何任务时仍然渲染视图 / 搜索 / 筛选工具条 ⇒ 一整排永远筛不出东西的控件，' +
      '把「你还没开始」这条唯一有用的信息挤没了（tasks.tsx:480 的 initialEmpty 判据）',
  ).toHaveCount(0)

  // --- 落基础语料，回到有任务的常态 ---------------------------------------------
  seedTasks(BASE_CORPUS)
  await page.reload()
  await expect(
    page.getByTestId('task-row-rfc319tl-run'),
    '语料落库后列表仍然是空的 ⇒ 前置条件不成立，本文件后面每一条计数断言都会退化成断言空集',
  ).toBeVisible()
  await expect(
    page.getByTestId('tasks-empty'),
    '已经有 11 条任务了还在渲染「全新安装」空态 ⇒ 用户以为自己的任务全丢了',
  ).toHaveCount(0)

  // --- 过滤过窄：有任务，但这一屏筛不出东西 --------------------------------------
  await page.getByTestId('tasks-search').fill('rfc319-no-such-task-anywhere')
  const noMatches = page.getByTestId('tasks-no-matches')
  await expect(
    noMatches,
    '过滤到空集时没有给出「无匹配」提示 ⇒ 界面只剩一片空白，用户分不清是筛没了还是坏了',
  ).toBeVisible()
  await expect(
    noMatches,
    '「无匹配」态复用了全新安装的文案 ⇒ 用户会以为整个平台的任务都不见了，而不是自己筛窄了',
  ).toContainText('No matches')
  await expect(
    page.getByTestId('tasks-empty'),
    '同一时刻两个空态同时在场 ⇒ 界面自相矛盾（tasks.tsx:445-451 的 noMatches 定义就是 !initialEmpty）',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('tasks-views'),
    '「无匹配」时把工具条也撤了 ⇒ 用户被锁死在一个筛空的视图里，连改都改不回来',
  ).toBeVisible()

  // 退回全量的出口必须长在空态自己身上——工具条在页面顶端，空态在中间，
  // 用户视线落在哪儿，出口就得在哪儿。
  await noMatches.getByRole('button', { name: 'Clear filters' }).click()
  await expect(
    page,
    '空态里的「清除过滤」没有把 URL 恢复成裸 /tasks ⇒ 过滤残留在地址栏里，刷新一下又空了',
  ).toHaveURL(/\/tasks$/)
  await expect(
    page.getByTestId('task-row-rfc319tl-run'),
    '清除过滤后任务没有回来 ⇒ 那个出口是个装饰品，用户点了等于没点',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// TASK-16 —— 视图页签 / 搜索去抖 / 状态过滤 / 清除过滤 / URL 往返
// ---------------------------------------------------------------------------

test('RFC-319 TASK-16：四个视图页签的计数与行数一致、搜索去抖只打一次、状态过滤经 URL 双向往返 @nightly', async ({
  page,
}) => {
  const catalogRequests = recordCatalogRequests(page)
  await openTasks(page)
  await expect(
    page.getByTestId('task-row-rfc319tl-run'),
    '基础语料不在列表里 ⇒ 前置条件不成立（TASK-19 应当已经把它落库）',
  ).toBeVisible()

  // --- 视图页签：角标数字就是用户的分诊依据 --------------------------------------
  await expect(
    viewCount(page, 'all'),
    '「全部」角标与语料条数对不上 ⇒ 用户拿它判断今天有多少活，数字骗了他',
  ).toHaveText(String(BASE_ALL))
  await expect(
    viewCount(page, 'active'),
    '「进行中」角标与「未收尾的任务」条数对不上 ⇒ 用户以为没有在跑的任务，' +
      '结果盘上还占着 worktree 和 runtime 进程',
  ).toHaveText(String(BASE_ACTIVE))
  await expect(
    viewCount(page, 'attention'),
    '「需关注」角标与 failed+awaiting_review+awaiting_human 的实际条数对不上 ⇒ ' +
      '这正是用户唯一会当成待办清单看的数字，错了就有任务被永远晾着',
  ).toHaveText(String(BASE_ATTENTION))
  await expect(
    viewCount(page, 'finished'),
    '「已结束」角标与终态（done/failed/canceled/interrupted）条数对不上 ⇒ 归档面失真，' +
      '用户会重复启动已经跑过的任务',
  ).toHaveText(String(BASE_FINISHED))

  await page.getByTestId('tasks-view-attention').click()
  await expect(page, '切「需关注」页签没有写进 URL ⇒ 这一屏发不出去，也刷不回来').toHaveURL(
    /[?&]view=attention(?:&|$)/,
  )
  await expect(
    page.locator('.task-operations__item[data-depth="0"]'),
    '「需关注」页签筛出来的行数与它自己角标上的数字不一致 ⇒ 页签在撒谎，' +
      '用户按数字排班、按行干活，两者对不上',
  ).toHaveCount(BASE_ATTENTION)
  for (const id of ['rfc319tl-fail', 'rfc319tl-review', 'rfc319tl-human']) {
    await expect(
      page.getByTestId(`task-row-${id}`),
      `${id} 该进「需关注」却没进 ⇒ 一条要人处理的任务从待办清单里消失了`,
    ).toBeVisible()
  }
  await expect(
    page.getByTestId('task-row-rfc319tl-done'),
    '已完成的任务混进了「需关注」⇒ 待办清单里塞进不需要处理的东西，用户会开始不信任它',
  ).toHaveCount(0)

  await page.getByTestId('tasks-view-all').click()
  await expect(
    page,
    '切回「全部」没有把 view 从 URL 里删掉 ⇒ 默认值被钉进链接，' +
      '别人打开时看到的不是默认视图（tasks.tsx:487-491 明确把 all 映射成 undefined）',
  ).not.toHaveURL(/[?&]view=/)

  // --- 搜索去抖 ---------------------------------------------------------------
  //
  // 判据是 tasks.tsx:249-267 的 350ms 去抖。这里**不**照着 350 去 waitForTimeout 再硬断言：
  //   ① 那样等于把生产常量抄进测试，改常量的变异咬不中；
  //   ② 慢机器上「等够 350ms」也不代表导航已经发生。
  // 改成两条互补的约束：
  //   · 上界（数量）：逐字符敲完 11 个字母，发出去的带 q 的目录查询不得超过页面时钟
  //     实际观察到的输入 burst 数。去抖被删掉时每一击都会 navigate → 一次查询，11 次；
  //     留着时，同一个 350ms burst 塌成一次。按页面时钟分 burst，避免把 hosted runner
  //     在两次 Playwright 按键之间卡住 350ms 误判成产品逐键查询。
  //   · 上界（时延）：敲完之后 URL 必须在 3 秒内收敛。去抖被调成 30 秒之类的值时，
  //     用户打完字盯着旧结果看，这条会红。
  const before = catalogRequests.length
  const search = page.getByTestId('tasks-search')
  await page.evaluate(() => {
    window.__rfc319TaskSearchInputTimes = []
    document.addEventListener(
      'input',
      (event) => {
        if ((event.target as HTMLElement | null)?.dataset.testid === 'tasks-search') {
          window.__rfc319TaskSearchInputTimes?.push(performance.now())
        }
      },
      true,
    )
  })
  await search.click()
  await search.pressSequentially('quicksilver', { delay: 10 })
  await expect(
    page,
    '搜索词没有在 3 秒内落进 URL ⇒ 去抖窗口被拉长成了用户能感知的停顿，' +
      '打完字对着旧结果看，以为搜的东西不存在',
  ).toHaveURL(/[?&]q=quicksilver(?:&|$)/, { timeout: 3000 })
  await expect(
    page.getByTestId('task-row-rfc319tl-quick'),
    '搜到的词命中的那一条没有显示出来 ⇒ 搜索框是个摆设',
  ).toBeVisible()
  await expect(
    page.locator('.task-operations__item[data-depth="0"]'),
    '搜索没有把不相干的任务筛掉 ⇒ 在十万任务的目标尺度上，搜索等于没有',
  ).toHaveCount(1)
  await expect(
    viewCount(page, 'all'),
    '搜索之后视图角标没有跟着收敛 ⇒ 角标说 11、列表只有 1 条，用户不知道该信哪个' +
      '（facets 与匹配集同源，taskOperations.ts:516-535）',
  ).toHaveText('1')

  const typedQueries = catalogRequests.slice(before).filter((qs) => qs.includes('q='))
  const inputTimes = await page.evaluate(() => window.__rfc319TaskSearchInputTimes ?? [])
  expect(inputTimes, '11 次输入事件没有逐次到达页面 ⇒ 数查询请求的前提不成立').toHaveLength(11)
  // On a saturated hosted macOS runner Playwright can pause longer than the
  // production 350ms window between two nominally 10ms key presses. Each such
  // observed user-visible pause legitimately closes one debounce burst; only
  // requests beyond those page-clock bursts indicate per-keystroke querying.
  const distinctBursts =
    1 + inputTimes.slice(1).filter((time, index) => time - inputTimes[index]! >= 350).length
  expect(
    typedQueries.length,
    `逐字符敲入 11 个字母发出了 ${typedQueries.length} 次带 q 的目录查询` +
      `（${JSON.stringify(typedQueries)}）⇒ 去抖没起作用：每一次击键都在打一次全表检索，` +
      '列表页的目标尺度是十万任务，这会把 daemon 拖垮',
  ).toBeLessThanOrEqual(distinctBursts)
  expect(
    typedQueries.length,
    '敲完整个词一次带 q 的查询都没发出 ⇒ 搜索结果不可能是真的，界面在拿旧数据糊弄用户',
  ).toBeGreaterThanOrEqual(1)

  await search.fill('')
  await expect(
    page,
    '清空搜索框后 q 还留在 URL 里 ⇒ 用户以为已经退出搜索，链接却仍然带着过滤',
  ).not.toHaveURL(/[?&]q=/)

  // --- 状态过滤：UI → URL --------------------------------------------------------
  const dialog = await openFilterDialog(page)
  const statusField = dialog.getByRole('combobox', { name: 'Exact status' })
  await statusField.fill('failed')
  await statusField.press('Enter')
  await statusField.fill('running')
  await statusField.press('Enter')
  await statusField.press('Escape')
  await dialog.getByRole('button', { name: 'Apply filters' }).click()
  await expect(
    page,
    '精确状态过滤没有写成规范序的 statuses ⇒ 同样两个状态会产生两种链接，' +
      '游标指纹也随之分叉（TASK_STATUS 的顺序是 running 在 failed 之前）',
  ).toHaveURL(/[?&]statuses=running(?:%2C|,)failed(?:&|$)/)
  await expect(
    page.locator('.task-operations__item[data-depth="0"]'),
    '按两个状态过滤后行数不是 2 ⇒ 过滤要么漏放要么错放，用户照着它做处置',
  ).toHaveCount(2)

  // --- 状态过滤：URL → UI（同事把链接发给你的那一路） -----------------------------
  await page.goto(`${daemon.baseUrl}/tasks?statuses=failed,running&view=attention`)
  await expect(
    page.getByTestId('task-row-rfc319tl-fail'),
    '粘一条带过滤的链接进来，列表没有按它渲染 ⇒ 运维协作里最常见的「把这一屏发给你」直接断掉',
  ).toBeVisible()
  await expect(
    page,
    '外来链接里的状态没有被规范化回 running,failed ⇒ 同一屏有两种 URL 写法，' +
      '分享出去的链接与自己点出来的对不上（tasks.tsx:88-100 的 canonicalSearch）',
  ).toHaveURL(/[?&]statuses=running(?:%2C|,)failed(?:&|$)/)
  await expect(
    page.locator('.task-operations__item[data-depth="0"]'),
    '「需关注 ∩ {running,failed}」应当只剩 failed 那一条 ⇒ 视图与状态两个维度没有同时生效',
  ).toHaveCount(1)

  const restored = await openFilterDialog(page)
  const statusChips = restored.locator('.multi-select__field')
  await expect(
    statusChips,
    '链接里的状态没有回填进筛选弹窗 ⇒ 用户看得见结果被筛过，却看不出被筛成了什么，' +
      '想微调只能整个清掉重来',
  ).toContainText('Running')
  await expect(
    statusChips,
    '链接里的第二个状态没有回填 ⇒ 同上：过滤条件对用户不可见',
  ).toContainText('Failed')
  await restored.getByRole('button', { name: 'Apply filters' }).click()

  // --- 清除过滤 -----------------------------------------------------------------
  await page.locator('.operations-toolbar__clear').click()
  await expect(
    page,
    '「清除过滤」没有把 URL 恢复成裸 /tasks ⇒ 用户以为清干净了，刷新一下过滤又回来了',
  ).toHaveURL(/\/tasks$/)
  await expect(
    viewCount(page, 'all'),
    '清除过滤后角标没有回到全量 ⇒ 清除只清了列表没清计数，界面自相矛盾',
  ).toHaveText(String(BASE_ALL))
  await expect(
    page.getByTestId('tasks-search'),
    '「清除过滤」没有把搜索框里的字清掉 ⇒ 框里写着词、结果却是全量，用户完全无法解释眼前这一屏',
  ).toHaveValue('')
})

// ---------------------------------------------------------------------------
// TASK-X5 —— 范围（我的 / 共享给我 / 全部）与类别（Agent / 工作流 / 工作组）
// ---------------------------------------------------------------------------

test('RFC-319 TASK-X5：筛选弹窗的范围三档与类别三档各自独立收敛，默认档不写进 URL @nightly', async ({
  page,
}) => {
  await openTasks(page)
  await expect(
    page.getByTestId('task-row-rfc319tl-foreign'),
    '管理员默认看不到别人的任务 ⇒ 前置条件不成立（有 tasks:read:all 时默认范围就是「全部」，' +
      'tasks.tsx:213-215）',
  ).toBeVisible()

  // --- 范围：我的 ---------------------------------------------------------------
  let dialog = await openFilterDialog(page)
  const scopeGroup = dialog.getByRole('radiogroup', { name: 'Task-user scope' })
  expect(
    await scopeGroup.getByRole('radio').allTextContents(),
    '范围三档的档位或顺序变了 ⇒ 下面按名字点的每一步都在点别的东西',
  ).toEqual(['My tasks', 'Shared with me', 'All tasks'])
  await scopeGroup.getByRole('radio', { name: 'My tasks', exact: true }).click()
  await dialog.getByRole('button', { name: 'Apply filters' }).click()

  await expect(
    page,
    '切到「我的任务」没有写进 URL ⇒ 这一屏刷新后就跳回全部，用户每次都要重设',
  ).toHaveURL(/[?&]scope=mine(?:&|$)/)
  await expect(
    page.locator('.task-operations__item[data-depth="0"]'),
    '「我的任务」的条数不等于「我拥有的 + 拉我进来协作的」⇒ 多人环境下用户会' +
      '在别人的任务上做处置，或者找不到自己的任务',
  ).toHaveCount(BASE_MINE)
  await expect(
    page.getByTestId('task-row-rfc319tl-foreign'),
    '别人独有的任务出现在「我的任务」里 ⇒ 范围过滤名存实亡，这一档等于「全部」',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('task-row-rfc319tl-shared'),
    '把我拉进协作的任务不在「我的任务」里 ⇒ 用户被指派了活却在自己的列表上看不见' +
      '（taskAuthorization.ts:54 的 mine = owner ∨ 协作者）',
  ).toBeVisible()

  // --- 范围：共享给我 ------------------------------------------------------------
  dialog = await openFilterDialog(page)
  await dialog
    .getByRole('radiogroup', { name: 'Task-user scope' })
    .getByRole('radio', { name: 'Shared with me', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Apply filters' }).click()

  await expect(page, '「共享给我」没有写进 URL ⇒ 同上，这一屏不可复现').toHaveURL(
    /[?&]scope=shared(?:&|$)/,
  )
  await expect(
    page.locator('.task-operations__item[data-depth="0"]'),
    '「共享给我」的条数不等于「别人的 ∧ 拉了我」⇒ 这一档就是用来回答' +
      '「别人交给我什么活」的，混进自己的任务它就没有存在意义了',
  ).toHaveCount(BASE_SHARED)
  await expect(
    page.getByTestId('task-row-rfc319tl-shared'),
    '唯一一条真正共享给我的任务没显示 ⇒ 用户会漏掉别人指派过来的活',
  ).toBeVisible()
  await expect(
    page.getByTestId('task-row-rfc319tl-run'),
    '我自己的任务混进了「共享给我」⇒ 判据里少了「owner ≠ 我」那一半：alpha 这条' +
      '既是我拥有的、又挂着我的协作行，它一旦出现在这一档，用户就分不清' +
      '「别人交给我的活」和「我自己开的活」（taskAuthorization.ts:51-53）',
  ).toHaveCount(0)

  // --- 范围：全部（管理员的默认档，必须从 URL 里消失） -----------------------------
  dialog = await openFilterDialog(page)
  await dialog
    .getByRole('radiogroup', { name: 'Task-user scope' })
    .getByRole('radio', { name: 'All tasks', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Apply filters' }).click()
  await expect(
    page,
    '回到默认范围后 scope 还钉在 URL 里 ⇒ 默认值被写死进链接，' +
      '发给权限更低的同事时会被强行降级或报错（tasks.tsx:220-232 的规范化）',
  ).not.toHaveURL(/[?&]scope=/)
  await expect(
    page.locator('.task-operations__item[data-depth="0"]'),
    '回到「全部」后没有恢复全量 ⇒ 范围档位切不回去，用户被困在一个子集里',
  ).toHaveCount(BASE_ALL)

  // --- 类别：Agent / 工作流 / 工作组 ----------------------------------------------
  dialog = await openFilterDialog(page)
  const typeGroup = dialog.getByRole('radiogroup', { name: 'Task type' })
  expect(
    await typeGroup.getByRole('radio').allTextContents(),
    '类别档位或顺序变了 ⇒ 下面按名字点的每一步都在点别的东西' +
      '（顺序取自 TASK_SOURCE_REGISTRATIONS 的 order）',
  ).toEqual(['All tasks', 'Agent', 'Workflow', 'Workgroup', 'Digital employee'])
  // 枚举完先关掉：下面每一档都从「重新打开弹窗」开始，读到的才是**当前生效**的过滤，
  // 而不是上一轮留在草稿里的选择。
  await page.keyboard.press('Escape')
  await expect(filterDialog(page), '按 Esc 关不掉筛选弹窗 ⇒ 用户被困在弹层里').toBeHidden()

  for (const probe of [
    { label: 'Agent', wire: 'agent', count: BASE_AGENT, present: 'rfc319tl-fail' },
    { label: 'Workflow', wire: 'workflow', count: BASE_WORKFLOW, present: 'rfc319tl-run' },
    { label: 'Workgroup', wire: 'workgroup', count: BASE_WORKGROUP, present: 'rfc319tl-human' },
  ] as const) {
    const open = await openFilterDialog(page)
    await open
      .getByRole('radiogroup', { name: 'Task type' })
      .getByRole('radio', { name: probe.label, exact: true })
      .click()
    await open.getByRole('button', { name: 'Apply filters' }).click()

    await expect(page, `类别「${probe.label}」没有写进 URL ⇒ 这一屏发不出去也刷不回来`).toHaveURL(
      new RegExp(`[?&]type=${probe.wire}(?:&|$)`),
    )
    await expect(
      page.locator('.task-operations__item[data-depth="0"]'),
      `类别「${probe.label}」筛出来的条数不对 ⇒ 三类任务的执行面完全不同` +
        '（Agent 直跑 / 工作流编排 / 工作组会话），混在一起用户没法按类处置',
    ).toHaveCount(probe.count)
    await expect(
      page.getByTestId(`task-row-${probe.present}`),
      `属于「${probe.label}」的任务没出现在该类别下 ⇒ 这条任务对按类别找它的用户彻底消失了`,
    ).toBeVisible()
    await expect(
      viewCount(page, 'all'),
      `类别「${probe.label}」下角标没有跟着收敛 ⇒ 角标数的是全量、列表数的是本类，` +
        '两个数字并排摆着互相矛盾',
    ).toHaveText(String(probe.count))
  }

  // 三个类别的条数必须正好把全量分完——否则要么有任务落在任何类别之外（用户按类别找永远
  // 找不到它），要么被重复计入两个类别。
  expect(
    BASE_AGENT + BASE_WORKFLOW + BASE_WORKGROUP,
    '三个类别加起来不等于全量 ⇒ 有任务掉在类别之外或被重复统计',
  ).toBe(BASE_ALL)

  await page.locator('.operations-toolbar__clear').click()
  await expect(
    page,
    '清除过滤没有把 type 从 URL 里拿掉 ⇒ 类别过滤黏在链接上，用户以为已经看的是全量',
  ).not.toHaveURL(/[?&]type=/)
})

// ---------------------------------------------------------------------------
// TASK-17 —— 根层与子分支各自独立翻页（真后端 / 真游标）
// ---------------------------------------------------------------------------

test('RFC-319 TASK-17：根层「加载更多」与子分支「加载更多子任务」各自独立翻页，互不清空对方 @nightly', async ({
  page,
}) => {
  seedTasks(paginationCorpus())
  await openTasks(page)
  await expect(
    page.getByTestId('task-row-rfc319pg-branch'),
    '分支父任务不在第一屏 ⇒ 前置条件不成立（它的 branch_started_at 最大，应当排在最前）',
  ).toBeVisible()

  // 三个执行源各带一份游标：workflow 源第一页交出 50 条，agent / workgroup 源条数不足
  // 各自一次交完，合起来就是第一页的规模。
  await expectLoadedRootCount(
    page,
    FIRST_PAGE_ROOTS,
    `第一页装进来的根任务不是 ${FIRST_PAGE_ROOTS} 条 ⇒ 每页 50 的约定或 per-source 复合游标` +
      '变了，翻页断言全部失去意义',
  )
  expect(
    TOTAL_WORKFLOW_ROOTS,
    '工作流类根任务没有超过一页 ⇒ 这条用例根本翻不到第二页，等于什么都没测',
  ).toBeGreaterThan(PAGE_LIMIT)

  // --- 子分支翻页 ---------------------------------------------------------------
  await page.getByTestId(`task-expand-${BRANCH_PARENT_ID}`).click()
  await expect(
    page.getByTestId('task-row-rfc319pg-child-01'),
    '展开分支后一个子任务都没出来 ⇒ 父任务下面挂的东西对用户不可达',
  ).toBeVisible()
  // 子层容器是这一行自己的 role="list"（aria-label = 父任务标题，tasks.tsx:788-794）。
  const childRows = page
    .getByRole('list', { name: 'RFC-319 taskline branch parent', exact: true })
    .locator('.task-operations__row--child')
  await expect(
    childRows,
    `子分支第一页不是 ${PAGE_LIMIT} 条 ⇒ 子层分页的页大小与根层不一致，下面的独立性断言失准`,
  ).toHaveCount(PAGE_LIMIT)
  await expect(
    page.getByTestId(`task-row-rfc319pg-child-${BRANCH_CHILDREN}`),
    '第 60 个子任务在只翻了一页时就已经在场 ⇒ 子层压根没分页，这条用例测不到东西',
  ).toHaveCount(0)

  await page.getByRole('button', { name: 'Load more child tasks' }).click()
  await expect(
    page.getByTestId(`task-row-rfc319pg-child-${BRANCH_CHILDREN}`),
    '点了「加载更多子任务」第 51 条之后的子任务仍然拿不到 ⇒ 子层游标坏了，' +
      '一个分支里超过 50 个子任务的部分对用户永久不可见',
  ).toBeVisible()
  await expect(
    childRows,
    `子分支翻完不是 ${BRANCH_CHILDREN} 条 ⇒ 子层游标漏页或重复页`,
  ).toHaveCount(BRANCH_CHILDREN)

  // 独立性 ①：子层翻页不能把根层的分页状态踩回去。
  await expectLoadedRootCount(
    page,
    FIRST_PAGE_ROOTS,
    '展开并翻完子任务之后，根层已加载的行数变了 ⇒ 两个分页共用了同一份状态，' +
      '用户展开一个分支就会把已经翻出来的根任务弄丢',
  )

  // --- 根层翻页 -----------------------------------------------------------------
  await expect(
    page.getByTestId(`task-row-rfc319pg-${PAGE_ROOTS}`),
    `编号最大（最旧）的根任务在第一页就出现了 ⇒ 排序或页大小不对，第二页测不到东西`,
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Load more tasks' }).click()
  await expectLoadedRootCount(
    page,
    TOTAL_ROOTS,
    `点了「加载更多」根任务总数不是 ${TOTAL_ROOTS} ⇒ 根层行值游标 (branch_started_at, id) ` +
      '坏了：第 51 行之后的任务对用户永久不可达，而列表看上去完全正常',
  )

  // 第二页的行落在虚拟窗口之外，滚到底才进 DOM（RFC-311 窗口化，同 rfc244 的处置）。
  await page.locator('.task-operations__list').evaluate((list) => {
    list.scrollTop = list.scrollHeight
  })
  await expect(
    page.getByTestId(`task-row-rfc319pg-${PAGE_ROOTS}`),
    '翻到第二页后最旧的那条根任务仍然拿不到 ⇒ 第 51 行之后的任务事实上被平台吞了',
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Load more tasks' }),
    '全部翻完之后「加载更多」按钮还在 ⇒ 用户会一直点一个不再产生新行的按钮，' +
      '以为还有没加载出来的任务',
  ).toHaveCount(0)

  // 独立性 ②：根层翻页（以及随之而来的滚动）不能把已经展开、已经翻完的子分支收回去。
  // 滚回顶部让分支行重新进入虚拟窗口——用户真实的动作就是「翻一页、再滚回去看刚才那棵树」。
  await page.locator('.task-operations__list').evaluate((list) => {
    list.scrollTop = 0
  })
  await expect(
    page.getByTestId('task-row-rfc319pg-child-01'),
    '翻过一页根任务再滚回来，展开着的分支折回去了 ⇒ 用户每翻一页就要把树重新展开一遍',
  ).toBeVisible()
  await expect(
    childRows,
    '根层翻页之后子分支的行数变了 ⇒ 用户翻一次根列表，手上展开的那个分支就被清空重来，' +
      '之前翻出来的 60 条子任务白翻',
  ).toHaveCount(BRANCH_CHILDREN)
})

// ---------------------------------------------------------------------------
// TASK-21 —— WS 推送后的就地更新（不空屏、不换行节点）
//
// 2026-08-26 契约变更：此前这里锁的是「置脏横幅 + 点刷新才取回新行」。用户实测反馈
// 「每次任务状态更新都会刷新整个任务列表，导致任务列表一直在闪」——那个横幅背后是
// 15 秒一次的 `resetQueries` 整表重建：缓存清空 ⇒ 整屏换成 tasks-loading ⇒ VirtualList
// 连滚动位置一起重挂 ⇒ 展开着的子分支全塌。用户当日拍板：状态就地更新、新行也自动
// 进来、横幅取消。于是本用例改锁新契约的两头——**该进的行自己进来，且屏幕不许闪**。
// ---------------------------------------------------------------------------

test('RFC-319 TASK-21：别处新建的任务自己进列表、状态就地翻面，全程不空屏也不换行节点 @nightly', async ({
  page,
}) => {
  await openTasks(page)
  const anchorRow = page.getByTestId('task-row-rfc319tl-run')
  await expect(anchorRow, '列表没渲染出来 ⇒ WS 订阅也不会建立，这条用例后面全是空转').toBeVisible()

  // 判据①：给一条**与本次推送无关**的既有行打标记。整表重建会把它连同整棵列表
  // 卸载重建，标记随之消失；就地更新则复用同一个 DOM 节点。用户能感知到的差别就是
  // 滚动位置、展开的子分支保不保得住。
  await anchorRow.evaluate((el) => {
    ;(el as unknown as Record<string, unknown>).__task21Mark = true
  })
  // 判据②：全程盯着整表 loading 有没有被插入过一次——那一下就是用户说的「闪」。
  await page.evaluate(() => {
    const bag = window as unknown as { __task21Flash?: number }
    bag.__task21Flash = 0
    const hit = (node: Node): boolean =>
      node instanceof HTMLElement &&
      (node.matches('[data-testid="tasks-loading"]') ||
        node.querySelector('[data-testid="tasks-loading"]') !== null)
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (hit(node)) bag.__task21Flash = (bag.__task21Flash ?? 0) + 1
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })

  // 触发是**确定性**的：走产品自己的 POST /api/tasks，它在任务落库后同步广播
  // task.created（services/task.ts:3265-3268）。不靠任何后台定时任务碰巧跑。
  const liveName = `RFC-319 taskline live ${Date.now().toString(36)}`
  const liveTaskId = await launchLiveTask(liveName)

  const liveRow = page.getByTestId(`task-row-${liveTaskId}`)
  await expect(
    liveRow,
    '别处新建了任务，已经打开的列表没有把它显示出来 ⇒ 界面就那么静止着：不报错、' +
      '不空白、不转圈，用户以为任务还没开始（/ws/tasks 的 task.created 在 ' +
      'useTaskOperationsSync.ts:32-39 的规则表里）',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    liveRow,
    '新行进来了但标题不对 ⇒ 用户在列表上认不出刚才启动的是哪一条',
  ).toContainText(liveName)

  // 这条 live 任务会走到 failed（同 TASK-45 的语料）。用它锁「状态就地翻面」：
  // 服务端到终态之后，列表上那一行必须自己变，且**不是**靠整表重建变的。
  await waitForTaskStatus(
    liveTaskId,
    'failed',
    '任务没有走到终态 ⇒ 「状态就地翻面」这半个契约无从判定',
  )
  await expect(
    liveRow.locator('.status-chip', { hasText: /^failed$/i }),
    '服务端已经失败，列表上那一行还挂着旧状态 ⇒ 用户照着一屏过期状态分诊',
  ).toBeVisible({ timeout: 30_000 })

  expect(
    await page.evaluate(
      () => (window as unknown as { __task21Flash?: number }).__task21Flash ?? -1,
    ),
    '同步期间整张列表被 loading 顶替过 ⇒ 这就是用户报的「任务列表一直在闪」：' +
      '每次状态更新都空屏一下，滚动位置回顶，展开的子分支全塌',
  ).toBe(0)
  expect(
    await anchorRow.evaluate(
      (el) => (el as unknown as Record<string, unknown>).__task21Mark === true,
    ),
    '与这次推送无关的行也被换成了新的 DOM 节点 ⇒ 列表是整表重建出来的，' +
      '用户手上的滚动位置和展开态每同步一次就丢一次',
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// TASK-24 —— 详情页取消运行中的任务（两击确认）
// ---------------------------------------------------------------------------

test('RFC-319 TASK-24：详情页取消运行中的任务需要两击，第一击只换文案、一个请求都不发 @nightly', async ({
  page,
}) => {
  // hold 文件让 stub 停在回合里不返回，任务因此**确定性地**停在 running；
  // 不靠 sleep 去赌机器快慢（mode-slow.ts:53-77）。先把上一轮留下的 `.started`
  // 标记删掉，否则下面等的是一个**陈旧**信号，等于没等。
  rmSync(`${holdFile}.started`, { force: true })
  writeFileSync(holdFile, '', 'utf-8')
  try {
    const taskId = await launchLiveTask('RFC-319 taskline cancel target')
    await expect
      .poll(() => existsSync(`${holdFile}.started`), {
        message: 'stub 一直没进入回合 ⇒ 任务不一定真的在跑，取消按钮的前置条件不成立',
        timeout: 90_000,
        intervals: [100, 200, 400],
      })
      .toBe(true)
    await waitForTaskStatus(
      taskId,
      'running',
      '任务没有进入 running ⇒ 详情页不会渲染取消按钮（tasks.detail.tsx:526-531 的 cancelable）',
    )

    const cancelPosts: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      if (new URL(request.url()).pathname.endsWith('/cancel')) cancelPosts.push(request.url())
    })

    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    const armButton = page.getByRole('button', { name: 'Cancel task', exact: true })
    await expect(
      armButton,
      '运行中的任务详情页没有取消按钮 ⇒ 用户对着一个正在烧 CPU、占着 worktree 的任务' +
        '毫无办法，只能去杀进程',
    ).toBeVisible({ timeout: 30_000 })

    await armButton.click()
    const confirmButton = page.getByRole('button', { name: 'Confirm?', exact: true })
    await expect(
      confirmButton,
      '第一击之后按钮没有进入确认态 ⇒ 二次确认没了（ConfirmButton.tsx:70-77）',
    ).toBeVisible({ timeout: 5000 })
    await expect(
      armButton,
      '确认态下「Cancel task」这个可及名还在 ⇒ 屏幕阅读器用户听不出自己已经处在' +
        '「再点一下就真取消」的状态里',
    ).toHaveCount(0)
    expect(
      cancelPosts,
      '第一击就把取消请求发出去了 ⇒ 误点一下就杀掉别人跑了半小时的任务，' +
        '而且不可撤销（取消是终态）',
    ).toHaveLength(0)

    await confirmButton.click()
    await expect
      .poll(() => cancelPosts.length, {
        message: '两击都点完了却没有发出取消请求 ⇒ 按钮点了等于没点，用户会反复点、反复失望',
        timeout: 15_000,
      })
      .toBe(1)

    await waitForTaskStatus(
      taskId,
      'canceled',
      '界面上点完取消，服务端的任务却没有停 ⇒ runtime 子进程还在跑，' +
        '用户以为已经刹住了（这正是取消存在的全部意义）',
    )
    await expect(
      page.locator('.status-chip', { hasText: /^canceled$/i }).first(),
      '任务已经取消了详情页却不显示 canceled ⇒ 用户不敢确认它到底停没停，只能去看进程列表',
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    rmSync(holdFile, { force: true })
  }
})

// ---------------------------------------------------------------------------
// TASK-45 —— 工作区回收后的详情页降级
// ---------------------------------------------------------------------------

test('RFC-319 TASK-45：工作区从 pruning 走到 pruned，详情页自己收敛并关掉节点重试 @nightly', async ({
  page,
}) => {
  const taskName = 'RFC-319 taskline prune target'
  const taskId = await launchLiveTask(taskName)
  await waitForTaskStatus(
    taskId,
    'failed',
    '任务没有走到 failed ⇒ 拿不到一条失败的 node_run，「重试节点」按钮的前置条件不成立',
  )

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
  await expect(
    page.locator('.status-chip', { hasText: /^failed$/i }).first(),
    '详情页没渲染出失败态 ⇒ 后面所有降级断言都只是在断言一张没加载完的页面',
  ).toBeVisible({ timeout: 30_000 })

  // 打开失败节点的抽屉：重试入口只长在这里。
  const openFailedNodeDrawer = async (): Promise<void> => {
    await expect(
      page.locator('.canvas-node--agent').first(),
      '任务画布上没有 agent 节点 ⇒ 抽屉打不开，重试按钮的在场/不在场都无从判定',
    ).toBeVisible({ timeout: 30_000 })
    await page.locator('.canvas-node--agent').first().click()
  }
  const retryButton = page.getByRole('button', { name: 'Retry node', exact: true })

  await openFailedNodeDrawer()
  await expect(
    retryButton,
    '工作区还在的时候失败节点就没有「重试节点」按钮 ⇒ 前置条件不成立，' +
      '下面「回收后按钮消失」会退化成恒真断言',
  ).toBeVisible({ timeout: 15_000 })

  // 直连落库把任务推进 pruning / pruned。
  //
  // 为什么只能直连：这两个状态由后台工作区 GC 的两阶段协议写入（services/gc.ts:10-19：
  // CLAIM 落 workspace_pruning_at、物理删除成功后才落 workspace_pruned_at），没有任何
  // 用户可达的接口能把一条任务摆成这两个形态。**这一条锁的是界面在这两个形态下的降级
  // 呈现，不是回收本身的判定**（回收链路另有 backend 的 gc 单测覆盖）。同理，这里只写
  // 墓碑列、不删盘上的目录：目录还在不影响本条要证的东西，而删了反而会把断言绑到
  // 文件系统上。
  runSqlite(
    dbPath(),
    `UPDATE tasks SET workspace_pruning_at = ${Date.now()} WHERE id = ${sqlText(taskId)};`,
  )
  // 这一跳需要显式刷新：终态任务在工作区仍可用时**不轮询**
  // （taskDetailRefetchInterval：isTerminal ⇒ false，tasks.detail.tsx:2042-2047），
  // 而 GC 的认领不走 WS。用户真实的动作就是「过一会儿刷新一下这一页」。
  await page.reload()
  await expect(
    page.locator('.task-detail__banner-stack'),
    '工作区正在回收，详情页只字不提 ⇒ 用户手上这一页已经在失能，他却要等到点了' +
      '某个按钮报错才知道，还会把它当成系统故障',
  ).toContainText('is being cleaned up', { timeout: 30_000 })

  // 从这里开始**不再刷新**：pruning 期间轮询被显式打开（同一函数的第一分支），
  // 它存在的唯一理由就是让界面自己走完 pruning → pruned 这一跳。
  runSqlite(
    dbPath(),
    `UPDATE tasks SET workspace_pruned_at = ${Date.now()} WHERE id = ${sqlText(taskId)};`,
  )
  await expect(
    page.locator('.task-detail__banner-stack'),
    'pruning 之后界面没有自己收敛到 pruned ⇒ 用户对着「清理中」看到天荒地老，' +
      '不知道到底还能不能用（3 秒轮询存在的唯一理由就是走完这一步）',
  ).toContainText('was cleaned up', { timeout: 30_000 })
  await expect(
    page.locator('.task-detail__banner-stack'),
    '已经清理完了还挂着「清理中」⇒ 两句互相矛盾的提示同时在场，用户无从判断现在能做什么',
  ).not.toContainText('is being cleaned up')

  await openFailedNodeDrawer()
  await expect(
    page.getByRole('tab', { name: /Session/ }).first(),
    '工作区回收后节点抽屉整个打不开了 ⇒ 下面「重试按钮不在场」会退化成' +
      '「抽屉没渲染」，什么都没证到',
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    retryButton,
    '工作区已回收，失败节点上的「重试节点」按钮还在 ⇒ 用户会去点一个必然失败的动作，' +
      '然后把这个失败当成系统故障报上来（NodeDetailDrawer.tsx:134-135 的判据）',
  ).toHaveCount(0)

  // 降级不是删除：回收掉的是盘上的工作区，任务记录本身必须原样留着。
  await expect(
    page.locator('.status-chip', { hasText: /^failed$/i }).first(),
    '工作区回收后连任务状态都不显示了 ⇒ 平台把「清掉磁盘」做成了「清掉历史」，' +
      '事后复盘无从谈起',
  ).toBeVisible()
  await expect(
    page.getByText(taskName, { exact: false }).first(),
    '工作区回收后任务名也没了 ⇒ 同上：这一页应当仍然是一条可读的历史记录',
  ).toBeVisible()
})

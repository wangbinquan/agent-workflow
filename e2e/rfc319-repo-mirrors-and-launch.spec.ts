// RFC-319 —— 缓存镜像的**保鲜 / 回收**与**以仓库开工**这两段用户面
// （账本 REPO-04/05/06/12/15/16/44/X4/X5）。
//
// 这两段合成一条链：镜像新不新决定任务跑在什么代码上，镜像删不删得掉决定磁盘
// 能不能收回，而向导里那几个控件决定用户能不能把仓开成任务。它们坏掉的时候几乎
// 都不报错，只会安静地做错事——
//
//   * REPO-04 手动刷新是「这份镜像已经旧了」时**唯一**的自助出口。它必须真的跑
//     `git fetch --all --prune --tags`：少了 `--tags` 就拉不到新 tag（按 tag 启动的
//     任务会说「ref 不存在」）；少了 `--prune` 就留着远端早已删掉的分支（用户在
//     向导的分支下拉里选中一条已经不存在的线，任务开在一个幽灵分支上）；只 fetch
//     不刷界面则用户点完看到的还是「3 小时前抓取」，会一直点下去。
//   * REPO-05 刷新失败有**五种完全不同的成因**，对应五种完全不同的动作：网络/凭据
//     不通要去修网络，镜像目录损坏要删掉重克隆，「尚未取回内容」要去重试任务的
//     准备步骤（**不是**删镜像），URL 解不开要去恢复 secret.key，`file://` 则是
//     这条来源已经不再受支持、要把仓推到真远端。把它们糊成同一句「操作失败」，
//     用户就会拿错误的处方去治。源码里那两段长注释（gitRepoCache.ts:1509-1523 与
//     1541-1548）记的正是三轮/四轮门实测到的两次误导。
//   * REPO-06 无引用镜像直删（不弹确认框）是磁盘吃紧时的常规动作。它多弹一个确认
//     框不算灾难，但**删不掉**就意味着磁盘再也收不回来。
//   * REPO-X5 相反的一半：镜像被**仓库组**引用时服务端 409，而 `/repos` 的行内删除
//     对这一种**没有**强删出口（确认框只在「有任务引用」时才开，repos.tsx:718-720）。
//     这条锁的就是「409 之后界面上不该凭空长出一个强删按钮」——那会让用户一键把
//     别人手工编排的组打出一个洞，而组的定义里从此少一个仓、下次启动才发现。
//   * REPO-12 子模块徽标是「这仓拉下来是不是残的」的唯一信号。用假数据摆出来的
//     徽标只能证明渲染函数，证明不了「真克隆一个带子模块的仓会把它记对」——所以
//     这条用**真的带子模块的仓**跑完整条链：真克隆 → 真 `--recurse-submodules` →
//     真子模块同步失败 → 徽标翻红 → 进「需关注」视图。
//   * REPO-15 启动时地址写错分两种：**格式非法**必须在用户还没提交前就拦住（红字
//     + Next 不可点），**格式合法但拉不动**则必须留下一条可看可重试的失败任务
//     （RFC-287 G7 的整个动机就是这个：此前是「转半天圈、一个 HTTP 错误、列表里
//     什么都没有」）。
//   * REPO-16 非默认基线分支：用户在向导里填了 `release/…`，任务就必须真的开在
//     那条线上。填了没生效的后果是 agent 在 main 上改代码并 commit&push，界面零
//     提示——RFC-248 当年专门在 schema 里硬拒过同一形态。
//   * REPO-X4 从下拉里复用一个已缓存镜像：必须**复用**而不是再克隆一份。复用坏掉
//     的表征是磁盘上悄悄多出一份同一个仓的镜像，而界面上看不出任何异常。
//   * REPO-44 `/api/repos/refs` 与 `/files` 的 `path` 是**调用方可控**的，而
//     `repos:read` 在 user 基线里（permission.ts:945）。白名单破了 = 任何登录用户
//     可以枚举 daemon 主机上任意 git 仓的分支与文件清单。同一对接口又是向导里
//     分支下拉的数据源，所以白名单与下拉必须一起锁。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/backend/src/services/gitRepoCache.ts:1491-1520   刷新：先失效 facets、行不存在 404、urlRedacted 为 NULL → repo-url-unavailable
//   packages/backend/src/services/gitRepoCache.ts:1528-1534   file:// → repo-url-file-scheme-unsupported（400）
//   packages/backend/src/services/gitRepoCache.ts:1537-1546   lastFetchedAt=0 且目录不在 → repo-cache-not-fetched-yet（409）
//   packages/backend/src/services/gitRepoCache.ts:1547-1555   目录不是合法 git dir → repo-cache-corrupt（409）
//   packages/backend/src/services/gitRepoCache.ts:1563-1583   fetch 非零 → repo-refresh-failed（502，details.stderr 带 git 原话）
//   packages/backend/src/services/gitRepoCache.ts:261-271     fetch 的真实 argv：`fetch --all --prune --tags`
//   packages/backend/src/services/gitRepoCache.ts:1584-1600   子模块同步失败只落行、不失败请求
//   packages/backend/src/services/gitRepoCache.ts:1319        attention 视图 = has_submodules=1 且 last_submodule_sync_ok=0
//   packages/backend/src/services/gitRepoCache.ts:1634-1690   删除：任务引用 ∪ 仓库组引用 → CachedRepoHasReferencesError(409)
//   packages/backend/src/services/gitRepoCache.ts:879-887     冷克隆 argv：`clone --recurse-submodules [--jobs N]`
//   packages/backend/src/routes/repos.ts:19-30                requireKnownPath：path 必须落在某个镜像 local_path 之内
//   packages/backend/src/services/repo.ts:27-33               isKnownRepoPath：resolve 后同一或以 root+sep 开头
//   packages/backend/src/routes/tasks.ts:325-334              JSON 启动 deferRepoPreparation=true（先落任务行、后台准备）
//   packages/backend/src/services/task.ts:2793-2800           延后准备前先 ensureCachedRepoIdentity（落 lastFetchedAt=0 的身份行）
//   packages/backend/src/services/task.ts:5104-5140           准备失败 → 合成 `__repo_prep__` 行 failed + git 原话上行
//   packages/shared/src/gitFailureClass.ts:33                  `repository not found` 判 permanent ⇒ 不占重试窗口，秒失败
//   packages/shared/src/schemas/repoBatchImport.ts:20-28       批量导入**刻意不拒** file://（存量可见不可运行）
//   packages/frontend/src/routes/repos.tsx:146-158            refresh / remove 两个 mutation，onSuccess 都 invalidate ['cached-repos']
//   packages/frontend/src/routes/repos.tsx:566-572            refresh.error / remove.error 各自一条 ErrorBanner
//   packages/frontend/src/routes/repos.tsx:706-729            行内 Refresh / Delete 按钮
//   packages/frontend/src/routes/repos.tsx:729-733            删除分流：有任务引用才开确认框，否则直删
//   packages/frontend/src/routes/repos.tsx:771-806            确认框（唯一的 force=1 出口）
//   packages/frontend/src/components/repos/SubmoduleBadge.tsx:34-63  三态徽标 + title 带 stderr
//   packages/frontend/src/components/launch/RepoSourceRow.tsx:205-244 下拉：缓存镜像 / 组 / 手工 URL 三类条目
//   packages/frontend/src/components/launch/RepoSourceRow.tsx:262-266 URL 非法 → repo-source-url-error-N
//   packages/frontend/src/components/launch/GitPicker.tsx:52-57       分支下拉的数据源 /api/repos/refs?path=
//   packages/frontend/src/lib/launch-repo-source.ts:106-128           resolveUrlRepoPath：按 canonical key 找镜像 localPath
//   packages/frontend/src/routes/tasks.new.tsx:1106-1114              sourceReady：每一行 URL 都要 parse 得动
//   packages/frontend/src/i18n/en-US.ts:8031-8046                     repo 家族的精确错误文案（未列码走域兜底 + raw）
//
// 与既有覆盖的关系（不重复造轮子）：
//   · `e2e/rfc319-repos-list-and-import.spec.ts` 覆盖 `/repos` 的**列表与导入**
//     （空态 / 行渲染 / 搜索视图 / 分页 / 权限门）。本文件一条都不重复，只做
//     「刷新 / 删除 / 以镜像开工」。
//   · `e2e/repo-governance.spec.ts` 在 wire 层锁凭据脱敏；本文件不碰脱敏。
//   · `e2e/repo-group-launch.spec.ts` 锁「从下拉里选**组**」；本文件只碰「选**仓**」。
//   · `e2e/main.spec.ts` 的 happy path 用手工 URL 启动一次；本文件补的是它没走的
//     三条：复用镜像、非默认 ref、以及两种写错地址。
//
// 执行模型：全文件共用一个 daemon；`playwright.config.ts` 的 `fullyParallel` 是
// false，所以用例按**声明顺序**串行。这里**刻意不加** `describe.configure({ mode:
// 'serial' })`——串行顺序本来就有，而 serial 会让第一条红之后其余全部 `did not run`，
// 变异验证时无法按「红了几条」归因。此外**每条用例都自带自己的夹具**、不依赖前一条
// 跑没跑成——Playwright 在任一用例失败后会换一个 worker 重跑 `beforeAll`（daemon 也就
// 换了一个），跨用例的状态依赖会在那一刻凭空消失，把「前面红了」放大成一串莫名其妙的
// 连带红（本文件初稿实撞：删除用例原本拿「alpha 已被前面的启动用例引用」当正向对照，
// 前面一红它就跟着红，而根因完全无关）。剩下的顺序约定只有一条：
//   · REPO-04 先跑：它对 alpha 远端做增删（新分支 / 新 tag / 删分支）。放在后面会与
//     REPO-44 读同一个镜像的 refs 相互干扰。
//   · REPO-06 / REPO-X5 放最后：它们真的删镜像。

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

import { cloneBareGitRepo, initGitRepo, repoRemoteUrl, runGit, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(240_000)

let daemon: DaemonHandle
const scratchDirs: string[] = []

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ---------------------------------------------------------------------------
// HTTP / 页面通用工具
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
  expect(res.ok, `${what}: HTTP ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, sessionToken }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', sessionToken)
        // 固定英文：下面所有文案选择器对的都是 en-US。
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore — chromium 下不会失败 */
      }
    },
    { baseUrl: daemon.baseUrl, sessionToken: daemon.token },
  )
}

async function openRepos(page: Page): Promise<void> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/repos`)
  await expect(
    page.getByRole('heading', { name: 'Code repositories', exact: true }),
    '/repos 连页头都没渲染 ⇒ 后面所有断言都只是在断言一张白屏',
  ).toBeVisible()
}

/** 页面上唯一那条错误横幅（ErrorBanner → NoticeBanner tone=error）。 */
function errorBanner(page: Page) {
  return page.locator('.notice-banner--error')
}

// ---------------------------------------------------------------------------
// 镜像夹具
// ---------------------------------------------------------------------------

interface MirrorLite {
  id: string
  urlRedacted: string
  localPath: string
  defaultBranch: string | null
  /** ISO 串；`Date.parse(...) === 0` 即 RFC-287 G7 的「尚未取回内容」。 */
  lastFetchedAt: string
  hasSubmodules: boolean | null
  lastSubmoduleSyncOk: boolean | null
  lastSubmoduleSyncError: string | null
  referencingTaskCount: number
}

async function listMirrors(): Promise<MirrorLite[]> {
  const body = await jsonOf<{ items: MirrorLite[] }>(
    await req('/api/cached-repos'),
    'list cached repos',
  )
  return body.items
}

async function mirrorByUrl(urlRedacted: string): Promise<MirrorLite> {
  const items = await listMirrors()
  const hit = items.find((row) => row.urlRedacted === urlRedacted)
  expect(
    hit,
    `镜像 ${urlRedacted} 不在列表里 ⇒ 前置夹具没落库，后面的断言会跑在一个不存在的行上：${JSON.stringify(
      items.map((row) => row.urlRedacted),
    )}`,
  ).toBeTruthy()
  return hit!
}

/**
 * 走**产品自己的**批量导入接口把一个远端搬进来（不是直连 SQL）。
 *
 * 这几条用例要证的东西全都依赖「镜像目录是真克隆出来的」——刷新要有 origin 可
 * fetch、内省要有 refs 可读、子模块徽标要有 `.gitmodules` 可探。SQL 摆出来的行
 * 一条都做不到。
 */
async function importMirror(url: string): Promise<MirrorLite> {
  interface Snapshot {
    batchId: string
    state: 'running' | 'completed'
    rows: Array<{ status: string; message: string | null; cachedRepoId: string | null }>
  }
  let snapshot = await jsonOf<Snapshot>(
    await req('/api/cached-repos/batch-import', {
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
          await req(`/api/cached-repos/imports/${snapshot.batchId}`),
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
  const items = await listMirrors()
  const hit = items.find((row) => row.id === snapshot.rows[0]!.cachedRepoId)
  expect(hit, `导入声称成功但列表里找不到这行：${url}`).toBeTruthy()
  return hit!
}

// --- git 远端夹具 -----------------------------------------------------------

interface RemoteFixture {
  /** 裸仓在盘上的路径。夹具直接改它来模拟「远端侧发生了什么」。 */
  barePath: string
  /** 经 system-mock smart-HTTP 网关的可克隆 URL（不是 `file://`）。 */
  url: string
}

/**
 * 建一个可克隆的裸仓。
 *
 * 一律走 `repoRemoteUrl` 的真远端而不是 `file://`：产品对 `file://` 的处置是
 * 「导得进来但启动 / 刷新都会被拒」（schemas/repoBatchImport.ts:20-28 与
 * gitRepoCache.ts:1528-1534），拿它造夹具等于让整条用户路径跑在一个产品自己判为
 * 半残的形态上。唯一的例外是下面 REPO-05 那条**专门证明这条拒绝**的用例。
 */
function makeRemote(label: string, build?: (workingDir: string) => void): RemoteFixture {
  const root = mkdtempSync(join(tmpdir(), `aw-rfc319-mirror-${label}-`))
  scratchDirs.push(root)
  const working = join(root, 'src')
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'README.md'), `# rfc-319 ${label}\n`, 'utf-8')
  initGitRepo(working, { message: `rfc-319 ${label}` })
  build?.(working)
  const bare = join(root, `${label}.git`)
  cloneBareGitRepo(working, bare)
  return { barePath: bare, url: repoRemoteUrl(bare) }
}

/** 在工作树里落一个新提交（夹具用；与 command.ts 的 initGitRepo 同一套非交互参数）。 */
function commitAll(workingDir: string, message: string): void {
  runGit(['add', '.'], workingDir)
  runGit(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message], workingDir)
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * 给一个镜像造一条「有任务引用」的事实。
 *
 * `refTaskCount` 的三个来源里，`tasks.cached_repo_id`（且该任务没有 task_repos 行）
 * 是最小的一条（gitRepoCache.ts:1118-1128）。这里只需要「被引用」这个事实本身——
 * 真跑一个任务再拿它当对照会让这条用例依赖前面几条**都跑成功**，而 Playwright 在
 * 任一用例失败后会换一个 worker 重跑 `beforeAll`（daemon 也就换了一个），那时前面
 * 那些任务并不存在，对照会莫名其妙地失败并掩盖真正的红。
 */
function seedReferencingTask(taskId: string, cachedRepoId: string): void {
  const now = Date.now()
  const values = [
    sqlText(taskId),
    sqlText('RFC-319 mirror-delete control task'),
    sqlText('rfc319-mirror-delete-control-workflow'),
    sqlText('{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}'),
    sqlText('/tmp/rfc319-mirror-fixture/repo'),
    sqlText(cachedRepoId),
    sqlText('/tmp/rfc319-mirror-fixture/worktree'),
    sqlText('main'),
    sqlText(`agent-workflow/${taskId}`),
    sqlText('done'),
    sqlText('{}'),
    String(now),
    String(now),
  ].join(', ')
  runSqlite(
    join(daemon.home, 'db.sqlite'),
    'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, cached_repo_id,' +
      ' worktree_path, base_branch, branch, status, inputs, started_at, finished_at)' +
      ` VALUES (${values});`,
  )
}

// ---------------------------------------------------------------------------
// 工作流 / 任务夹具
// ---------------------------------------------------------------------------

interface WorkflowInputDecl {
  kind: string
  key: string
  label: string
  required?: boolean
  gitKind?: string
}

let seedSeq = 0

/** 一条 input → agent → output 的最小工作流；`inputs` 为空时向导第 3 步只要个名字。 */
async function seedWorkflow(inputs: readonly WorkflowInputDecl[]): Promise<string> {
  const suffix = `${(seedSeq += 1)}`
  const agentName = `rfc319-mirror-agent-${suffix}`
  const agent = await jsonOf<{ id: string }>(
    await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: agentName,
        description: 'rfc-319 repo-mirror e2e stub',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    }),
    `seed agent ${agentName}`,
  )
  const nodes: unknown[] = [
    ...inputs.map((decl, index) => ({
      id: `in_${index}`,
      kind: 'input',
      inputKey: decl.key,
      position: { x: 0, y: index * 120 },
    })),
    {
      id: 'agent_1',
      kind: 'agent-single',
      agentId: agent.id,
      agentName,
      promptTemplate: inputs.length > 0 ? `{{${inputs[0]!.key}}}` : 'rfc-319 mirror probe',
      position: { x: 320, y: 0 },
    },
    {
      id: 'out_1',
      kind: 'output',
      ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
      position: { x: 640, y: 0 },
    },
  ]
  const edges: unknown[] = [
    ...inputs.map((decl, index) => ({
      id: `e_in_${index}`,
      source: { nodeId: `in_${index}`, portName: decl.key },
      target: { nodeId: 'agent_1', portName: decl.key },
    })),
    {
      id: 'e_out',
      source: { nodeId: 'agent_1', portName: 'answer' },
      target: { nodeId: 'out_1', portName: 'answer' },
    },
  ]
  const wf = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-mirror-wf-${suffix}`,
        description: 'rfc-319 repo-mirror e2e workflow',
        definition: { $schema_version: 2, inputs, nodes, edges },
      }),
    }),
    'seed workflow',
  )
  return wf.id
}

interface TaskLite {
  id: string
  status: string
  baseBranch: string
  worktreePath: string
  repos: Array<{
    repoIndex: number
    cachedRepoId: string | null
    baseBranch: string
    baseCommit: string | null
    repoUrl: string | null
  }>
}

async function getTask(taskId: string): Promise<TaskLite> {
  return jsonOf<TaskLite>(await req(`/api/tasks/${taskId}`), `read task ${taskId}`)
}

async function waitForTask(
  taskId: string,
  predicate: (task: TaskLite) => boolean,
  message: string,
): Promise<TaskLite> {
  let last: TaskLite | null = null
  await expect
    .poll(
      async () => {
        last = await getTask(taskId)
        return predicate(last)
      },
      { message, timeout: 120_000, intervals: [200, 300, 500, 1000] },
    )
    .toBe(true)
  return last!
}

// ---------------------------------------------------------------------------
// 向导通用步骤
// ---------------------------------------------------------------------------

async function openWizard(page: Page, workflowId: string): Promise<void> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workflows/${workflowId}/launch`)
  await expect(
    page.getByTestId('task-wizard'),
    '向导没挂载 ⇒ 用户根本走不到「选仓库」这一步',
  ).toBeVisible()
  // scratch 是默认空间（用户 2026-07-11）——先切到「仓库」。
  await page.getByTestId('wizard-space-remote').click()
  await expect(
    page.getByTestId('repo-source-row-0'),
    '切到「仓库」空间后没有仓库选择行 ⇒ 这条空间在界面上不可用',
  ).toBeVisible()
}

/** 在下拉里选中一个已缓存镜像（条目文案就是它的脱敏 URL）。 */
async function pickCachedMirror(page: Page, mirror: MirrorLite): Promise<void> {
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: mirror.urlRedacted, exact: true }).click()
}

/** 在下拉里切到「手工输入 URL」。 */
async function chooseManualUrl(page: Page): Promise<void> {
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: 'Enter a new Git URL…', exact: true }).click()
}

// ---------------------------------------------------------------------------
// 全局夹具（一次建好，后面各用例分头用）
// ---------------------------------------------------------------------------

/** alpha：主力镜像。三条分支——main（默认）/ release（非默认基线）/ stale（待 prune）。 */
const ALPHA_RELEASE_BRANCH = 'release/rfc319'
const ALPHA_STALE_BRANCH = 'stale/rfc319'
const ALPHA_NEW_BRANCH = 'hotfix/rfc319'
const ALPHA_NEW_TAG = 'v-rfc319-refresh'

let alphaRemote: RemoteFixture
let alphaMirror: MirrorLite
/** 无输入工作流（复用镜像 / 非默认 ref / 写错地址三条都用它）。 */
let plainWorkflowId = ''
/** 带一个 `kind: 'git'` + `gitKind: 'branch'` 输入的工作流（分支下拉）。 */
let gitInputWorkflowId = ''

test.beforeAll(async () => {
  alphaRemote = makeRemote('alpha', (dir) => {
    runGit(['checkout', '-q', '-b', ALPHA_RELEASE_BRANCH], dir)
    writeFileSync(join(dir, 'RELEASE.md'), '# rfc-319 release line\n', 'utf-8')
    commitAll(dir, 'rfc-319 release line')
    runGit(['checkout', '-q', 'main'], dir)
    runGit(['branch', ALPHA_STALE_BRANCH], dir)
  })
  alphaMirror = await importMirror(alphaRemote.url)
  plainWorkflowId = await seedWorkflow([])
  gitInputWorkflowId = await seedWorkflow([
    { kind: 'git', key: 'baseline', label: 'Baseline', required: true, gitKind: 'branch' },
  ])
})

// ===========================================================================
// REPO-04 —— 手动刷新
// ===========================================================================

test('REPO-04 行内「Refresh」真的跑了 git fetch --all --prune --tags：新分支/新 tag 进来、已删分支被剪掉、列表随即自刷新 @nightly', async ({
  page,
}) => {
  interface Refs {
    branches: string[]
    tags: string[]
  }
  const refsOf = async (): Promise<Refs> =>
    jsonOf<Refs>(
      await req(`/api/repos/refs?path=${encodeURIComponent(alphaMirror.localPath)}`),
      'read mirror refs',
    )

  const before = await refsOf()
  expect(
    before.branches,
    '刚克隆的镜像里没有远端那条待剪分支 ⇒ 下面的 --prune 断言会退化成恒真',
  ).toContain(`origin/${ALPHA_STALE_BRANCH}`)
  expect(
    before.branches,
    '刚克隆的镜像里就已经有「远端稍后才会新增」的分支 ⇒ 夹具没摆对，--all 断言恒真',
  ).not.toContain(`origin/${ALPHA_NEW_BRANCH}`)
  expect(before.tags, '刚克隆的镜像里就已经有那个 tag ⇒ --tags 断言恒真').not.toContain(
    ALPHA_NEW_TAG,
  )

  // 远端侧发生变化：加一条分支、加一个 tag、删掉一条分支。
  runGit(['branch', ALPHA_NEW_BRANCH, 'main'], alphaRemote.barePath)
  runGit(['tag', ALPHA_NEW_TAG, 'main'], alphaRemote.barePath)
  runGit(['branch', '-D', ALPHA_STALE_BRANCH], alphaRemote.barePath)

  const listReads: number[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/cached-repos' && request.method() === 'GET') {
      listReads.push(Date.now())
    }
  })

  await openRepos(page)
  const row = page.getByTestId(`repos-row-${alphaMirror.id}`)
  await expect(row, '镜像行没渲染 ⇒ 用户点不到它的刷新按钮').toBeVisible()

  const refreshPath = `/api/cached-repos/${alphaMirror.id}/refresh`
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === refreshPath && r.request().method() === 'POST',
    ),
    page.getByTestId(`repos-refresh-${alphaMirror.id}`).click(),
  ])
  const clickedAt = Date.now()
  expect(
    response.status(),
    `点了 Refresh 却不是 200（${response.status()}）⇒ 用户唯一的手动保鲜出口是坏的`,
  ).toBe(200)

  const after = await refsOf()
  expect(
    after.branches,
    '刷新之后远端新增的分支没进来 ⇒ fetch 没有覆盖全部 refs，' +
      '用户在分支下拉里找不到刚推上去的那条线',
  ).toContain(`origin/${ALPHA_NEW_BRANCH}`)
  expect(
    after.tags,
    '刷新之后新 tag 没进来 ⇒ `--tags` 丢了，按 tag 启动的任务会说「ref 不存在」，' +
      '而用户明明看得见那个 tag 在远端',
  ).toContain(ALPHA_NEW_TAG)
  expect(
    after.branches,
    '远端已删掉的分支刷新后还留在镜像里 ⇒ `--prune` 丢了，用户会在下拉里选中一条' +
      '幽灵分支，任务开在一段谁都不再维护的代码上',
  ).not.toContain(`origin/${ALPHA_STALE_BRANCH}`)

  const refreshed = await mirrorByUrl(alphaRemote.url)
  expect(
    Date.parse(refreshed.lastFetchedAt),
    '刷新成功却没有推进抓取时间 ⇒ 界面上这仓永远显示成「很久没抓过」，' + '用户会一遍遍点刷新',
  ).toBeGreaterThan(Date.parse(alphaMirror.lastFetchedAt))

  expect(
    listReads.some((at) => at >= clickedAt),
    '刷新成功后界面没有重新拉列表 ⇒ 用户点完看到的还是刷新前那句「N 小时前抓取」，' +
      '无从判断这次刷新到底生没生效',
  ).toBe(true)
  await expect(errorBanner(page), '刷新成功却弹了错误横幅 ⇒ 成功路径被当成失败呈现').toHaveCount(0)

  alphaMirror = refreshed
})

// ===========================================================================
// REPO-44 —— 仓库内省接口的路径白名单 + 向导里的分支下拉
// ===========================================================================

test('REPO-44 /api/repos/refs 与 /files 只认缓存镜像内的路径，向导的分支下拉正是从它取的数 @nightly', async ({
  page,
}) => {
  // --- 接口面：白名单 -----------------------------------------------------
  const outsideRepo = makeRemote('outsider').barePath
  const cases: Array<{ what: string; path: string | null; why: string }> = [
    {
      what: 'missing',
      path: null,
      why: '不带 path 也肯回答 ⇒ 接口在拿某个默认目录作答，用户看到的是别人的仓',
    },
    {
      what: 'system dir',
      path: '/etc',
      why: '主机上任意目录都能问 ⇒ repos:read 在 user 基线里，等于人人可枚举本机文件树',
    },
    {
      what: 'a real git repo outside the cache',
      path: outsideRepo,
      why:
        '只要是个 git 仓就放行 ⇒ 白名单退化成「是不是 git 仓」，' +
        'daemon 主机上任何一个仓的分支与文件清单都被暴露',
    },
    {
      what: 'escape via ..',
      path: join(alphaMirror.localPath, '..', '..'),
      why: '用 `..` 能从镜像里爬出去 ⇒ 白名单只比字符串前缀，没做规范化',
    },
  ]
  for (const probe of cases) {
    for (const endpoint of ['refs', 'files'] as const) {
      const url =
        probe.path === null
          ? `/api/repos/${endpoint}`
          : `/api/repos/${endpoint}?path=${encodeURIComponent(probe.path)}`
      const res = await req(url)
      expect(res.status, `${endpoint} / ${probe.what}: ${probe.why}`).toBe(422)
      const body = (await res.json()) as { code?: string }
      expect(
        body.code,
        `${endpoint} / ${probe.what} 拒了但没给出可分辨的原因 ⇒ 调用方分不清「没填参数」和「路径不在白名单」`,
      ).toBe(probe.path === null ? 'path-required' : 'repo-path-unknown')
    }
  }

  // 正向：镜像本体读得到，且读到的是**这个仓**的分支。
  const refs = await jsonOf<{ branches: string[]; defaultBranch: string | null }>(
    await req(`/api/repos/refs?path=${encodeURIComponent(alphaMirror.localPath)}`),
    'refs of the mirror itself',
  )
  expect(
    refs.branches,
    '镜像本体也读不到分支 ⇒ 白名单把正常路径一起拒了，向导的分支下拉此后永远是空的',
  ).toContain(`origin/${ALPHA_RELEASE_BRANCH}`)
  const files = await jsonOf<{ files: string[] }>(
    await req(`/api/repos/files?path=${encodeURIComponent(alphaMirror.localPath)}`),
    'files of the mirror itself',
  )
  expect(files.files, '镜像本体读不到文件清单 ⇒ 依赖它的 files 输入选择器整个不可用').toContain(
    'README.md',
  )

  // --- 界面面：分支下拉 ---------------------------------------------------
  const refsQueries: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/repos/refs') refsQueries.push(url.searchParams.get('path') ?? '')
  })

  await openWizard(page, gitInputWorkflowId)
  await pickCachedMirror(page, alphaMirror)
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill('rfc319-branch-dropdown')

  const branchSelect = page.getByRole('combobox', { name: 'Branch', exact: true })
  await expect(
    branchSelect,
    '分支输入退化成了自由文本 ⇒ 用户得自己把分支名一个字一个字敲对，' + '敲错了要等任务失败才知道',
  ).toBeVisible()
  await branchSelect.click()
  await expect(
    page.getByRole('option', { name: `origin/${ALPHA_RELEASE_BRANCH}`, exact: true }),
    '下拉里没有这个仓真实存在的分支 ⇒ 下拉不是从这个镜像取的数，' + '用户选不到自己要的那条线',
  ).toBeVisible()
  await page.getByRole('option', { name: `origin/${ALPHA_RELEASE_BRANCH}`, exact: true }).click()
  await expect(
    branchSelect,
    '选完分支下拉没回显选中的值 ⇒ 用户不确定自己选中了没有，会反复点',
  ).toContainText(`origin/${ALPHA_RELEASE_BRANCH}`)

  expect(
    refsQueries,
    '分支下拉查的不是这个镜像的本地路径 ⇒ 要么它在问别的仓（选出来的分支不属于' +
      `这个仓），要么它在问一个白名单不认的路径（下拉永远空白）：${JSON.stringify(refsQueries)}`,
  ).toContain(alphaMirror.localPath)
})

// ===========================================================================
// REPO-X4 —— 从下拉里复用一个已缓存镜像启动任务
// ===========================================================================

test('REPO-X4 从下拉里挑一个已缓存镜像启动：任务绑回同一行镜像，盘上不会多出第二份 @nightly', async ({
  page,
}) => {
  const before = await listMirrors()
  const bodies: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/tasks' && request.method() === 'POST') {
      bodies.push(request.postData() ?? '')
    }
  })

  await openWizard(page, plainWorkflowId)
  await pickCachedMirror(page, alphaMirror)
  // 选中已有镜像之后**不该**再要求用户手敲 URL——那正是「复用」的意义。
  await expect(
    page.getByTestId('repo-source-url-0'),
    '从下拉里选了镜像还要求再填一遍 URL ⇒ 复用入口形同虚设',
  ).toHaveCount(0)
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill('rfc319-reuse-cached-mirror')
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-launch').click()
  await page.waitForURL(/\/tasks\/[A-Z0-9]{26}$/i, { timeout: 30_000 })
  const taskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!

  expect(bodies.length, '启动请求不是一条 ⇒ 要么根本没发，要么重复提交了').toBe(1)
  const wire = JSON.parse(bodies[0]!) as { repoUrl?: string; cachedRepoId?: string }
  // 记录**实际**契约：向导对「选中的镜像」发的是它的脱敏 URL（`buildLaunchBody`
  // 只盖 repoUrl/ref，不盖 cachedRepoId —— packages/frontend/src/lib/launch-repo-source.ts:75-88，
  // 由 packages/frontend/tests/task-wizard-builders.test.ts:66 锁死）。账本把这条
  // 写成「cachedRepoId 路径」，与实现不符；这里按源码实际断言，见文件末尾的说明。
  expect(
    wire.repoUrl ?? wire.cachedRepoId,
    '启动请求既没带 URL 也没带镜像 id ⇒ 服务端无从知道用户选的是哪个仓',
  ).toBe(alphaMirror.urlRedacted)

  const task = await waitForTask(
    taskId,
    (t) => t.repos.length > 0 && t.repos[0]!.cachedRepoId !== null,
    '任务始终没回填仓库投影 ⇒ 用镜像启动这条路走不通',
  )
  expect(
    task.repos[0]!.cachedRepoId,
    '任务绑到了另一行镜像 ⇒ 「复用」没兑现：同一个仓在盘上会有第二份缓存，' +
      '磁盘翻倍而界面看不出任何异常',
  ).toBe(alphaMirror.id)

  const after = await listMirrors()
  expect(
    after.length,
    `复用一个已缓存镜像启动，镜像总数却变了（${before.length} → ${after.length}）⇒ ` +
      '产品又克隆了一份，用户的磁盘在每次启动时静默增长',
  ).toBe(before.length)
})

// ===========================================================================
// REPO-16 —— 以非默认基线分支启动
// ===========================================================================

test('REPO-16 向导里填了非默认基线分支，任务就真的开在那条线上（不是悄悄落回默认分支）@nightly', async ({
  page,
}) => {
  expect(
    alphaMirror.defaultBranch,
    `夹具镜像的默认分支不是 main（${alphaMirror.defaultBranch}）⇒ 下面这条「非默认」断言失去意义`,
  ).toBe('main')
  const releaseSha = runGit(['rev-parse', ALPHA_RELEASE_BRANCH], alphaRemote.barePath).trim()
  const mainSha = runGit(['rev-parse', 'main'], alphaRemote.barePath).trim()
  expect(releaseSha, '夹具的两条分支指向同一个提交 ⇒ 「开在哪条线上」根本无从分辨').not.toBe(
    mainSha,
  )

  await openWizard(page, plainWorkflowId)
  await pickCachedMirror(page, alphaMirror)
  const refInput = page.getByTestId('repo-source-ref-0')
  await expect(
    refInput,
    '选中仓库后没有基线分支输入 ⇒ 用户只能开在默认分支上，' +
      '「从 release 线开工」这件事在界面上不可达',
  ).toBeVisible()
  await refInput.fill(ALPHA_RELEASE_BRANCH)
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill('rfc319-non-default-baseline')
  await page.getByTestId('stepper-next').click()
  await expect(
    page.getByTestId('wizard-summary-space'),
    '确认页没有回显用户选的基线分支 ⇒ 最后一道人工复核看不到这次改动',
  ).toContainText(ALPHA_RELEASE_BRANCH)
  await page.getByTestId('wizard-launch').click()
  await page.waitForURL(/\/tasks\/[A-Z0-9]{26}$/i, { timeout: 30_000 })
  const taskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!

  const task = await waitForTask(
    taskId,
    (t) => t.repos.length > 0 && (t.repos[0]!.baseCommit ?? '') !== '',
    '任务始终没回填基线提交 ⇒ 仓库准备没走完，下面的分支断言无从判定',
  )
  expect(
    task.repos[0]!.baseBranch,
    '任务的基线分支不是用户填的那条 ⇒ 用户以为自己换了线，agent 却在别的分支上' +
      '改代码并 commit&push，界面零提示',
  ).toBe(ALPHA_RELEASE_BRANCH)
  expect(
    task.repos[0]!.baseCommit,
    '基线分支名对了但基线提交落在默认分支的 tip 上 ⇒ 名字只是个标签，' +
      '工作树里其实还是 main 的代码',
  ).toBe(releaseSha)
  expect(task.baseBranch, '顶层 baseBranch 与 repos[0] 不一致 ⇒ 任务详情与 API 会各说一套').toBe(
    ALPHA_RELEASE_BRANCH,
  )
})

// ===========================================================================
// REPO-15 —— 启动时地址写错（格式非法 / 拉不动）
// ===========================================================================

test('REPO-15 启动时地址写错：格式非法当场红字拦住，格式合法但拉不动则留下一条可看可重试的失败任务 @nightly', async ({
  page,
}) => {
  // --- 甲：格式非法，提交前就拦住 -----------------------------------------
  await openWizard(page, plainWorkflowId)
  await chooseManualUrl(page)
  await page.getByTestId('repo-source-url-0').fill('definitely not a git url')
  await expect(
    page.getByTestId('repo-source-url-error-0'),
    '地址明显不合法却没有任何提示 ⇒ 用户要走完整个向导、等到启动失败才知道打错了',
  ).toBeVisible()
  await expect(
    page.getByTestId('repo-source-url-error-0'),
    '提示没说清「哪里不对」⇒ 一句无信息量的红字，用户不知道该改成什么',
  ).toHaveText('URL not recognized (must be SSH or HTTP/HTTPS).')
  await expect(
    page.getByTestId('stepper-next'),
    '地址不合法却仍能进下一步 ⇒ 红字只是装饰，用户照样能提交一个必然失败的启动',
  ).toBeDisabled()

  // 接口门同样要合上：界面拦住不等于门合上，一个复制粘贴的 curl 就能绕过去。
  const refused = await req('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: plainWorkflowId,
      name: 'rfc319-malformed-url',
      inputs: {},
      repoUrl: 'definitely not a git url',
    }),
  })
  expect(
    refused.status,
    `非法地址直接调接口没有被拒（HTTP ${refused.status}）⇒ 校验只画在界面上`,
  ).toBe(422)
  const refusedBody = (await refused.json()) as { code?: string }
  expect(
    refusedBody.code,
    '接口拒了但没给出可分辨的原因 ⇒ 自动化调用方只知道 400，不知道是地址的问题',
  ).toBe('repo-url-invalid')

  // --- 乙：格式合法但拉不动 ------------------------------------------------
  // RFC-287 G7：这条不再是「转半天圈然后一个 HTTP 错误、列表里什么都没有」，
  // 而是**留下一条 failed 任务**，git 原话可看、准备步骤可重试。
  const unreachable = `${alphaRemote.url.replace(/[^/]+\.git$/, '')}rfc319-unreachable-repo.git`
  await page.getByTestId('repo-source-url-0').fill(unreachable)
  await expect(
    page.getByTestId('repo-source-url-error-0'),
    '格式合法的地址被判成非法 ⇒ 用户被挡在一个其实写对了的地址上',
  ).toHaveCount(0)
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill('rfc319-unreachable-remote')
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-launch').click()
  await page.waitForURL(/\/tasks\/[A-Z0-9]{26}$/i, { timeout: 30_000 })
  const taskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!

  const failed = await waitForTask(
    taskId,
    (t) => t.status === 'failed',
    '拉不动的远端没有把任务收敛成 failed ⇒ 用户面对一条永远「准备中」的任务，' +
      '既看不到原因也不知道该等还是该放弃',
  )
  expect(
    failed.worktreePath,
    '准备都没成功却已经有工作树路径 ⇒ 状态自相矛盾，恢复逻辑会照着它去找一个不存在的目录',
  ).toBe('')

  await page.reload()
  const errorDetail = page.locator('.task-error-banner')
  await expect(
    errorDetail,
    '任务失败了但详情页没有失败横幅 ⇒ 用户只看到一个红色状态点，得自己去翻时间线',
  ).toBeVisible()
  await expect(
    errorDetail,
    '失败横幅里没有出现拉不动的那个地址 ⇒ 多仓 / 多任务的用户无从判断是哪个远端出的事',
  ).toContainText('rfc319-unreachable-repo.git')
  await expect(
    page.getByRole('button', { name: 'Retry repository preparation', exact: true }),
    '卡在仓库准备却没有「重试准备」的出口 ⇒ 用户只能另起一个任务，' +
      '而准备行不在工作流图里、画布上永远点不到它（RFC-287 AC-11）',
  ).toBeVisible()
})

// ===========================================================================
// REPO-05 —— 刷新失败的五种原因各自可辨
// ===========================================================================

test('REPO-05 刷新失败的五种原因在界面上各说各的：抓取失败 / 目录损坏 / 尚未取回 / URL 读不出 / file:// 被拒 @nightly', async ({
  page,
}) => {
  // ---- 夹具：五行镜像，每行一种成因 --------------------------------------
  // 1) 抓取失败：真镜像，远端随后消失。
  const goneRemote = makeRemote('fetchgone')
  const goneMirror = await importMirror(goneRemote.url)
  rmSync(goneRemote.barePath, { recursive: true, force: true })

  // 2) 目录损坏：真镜像，缓存目录随后被清掉（磁盘清理 / 半截删除的真实形态）。
  const corruptRemote = makeRemote('corrupted')
  const corruptMirror = await importMirror(corruptRemote.url)
  rmSync(corruptMirror.localPath, { recursive: true, force: true })

  // 3) 尚未取回内容：走产品自己的路——JSON 启动会先落身份行（lastFetchedAt=0）、
  //    再后台克隆；克隆失败后这行就停在「已登记身份、没有内容」的形态上。
  const pendingUrl = `${alphaRemote.url.replace(/[^/]+\.git$/, '')}rfc319-never-fetched.git`
  const pendingTask = await jsonOf<{ id: string }>(
    await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: plainWorkflowId,
        name: 'rfc319-identity-only-mirror',
        inputs: {},
        repoUrl: pendingUrl,
      }),
    }),
    'launch against an unreachable remote',
  )
  await waitForTask(
    pendingTask.id,
    (t) => t.status === 'failed',
    '拉不动的远端没有让任务收敛 ⇒ 「尚未取回内容」这行镜像还没定型',
  )
  const pendingMirror = await mirrorByUrl(pendingUrl)
  expect(
    Date.parse(pendingMirror.lastFetchedAt),
    '身份行没有停在 epoch 0 ⇒ 它不是「尚未取回内容」的那一形态，这条分支测不到',
  ).toBe(0)
  expect(
    existsSync(pendingMirror.localPath),
    '身份行的缓存目录居然存在 ⇒ 克隆其实成功了，这条分支测不到',
  ).toBe(false)

  // 4) URL 读不出：`url_redacted IS NULL` 只可能来自 RFC-204 迁移前的存量行
  //    （密钥轮换后 `url_enc` 解不开），产品今天没有任何路径能造出它——直连落库。
  const unreadableId = 'rfc319-unreadable-url-mirror'
  runSqlite(
    join(daemon.home, 'db.sqlite'),
    'INSERT INTO cached_repos (id, url_hash, url_redacted, local_path, default_branch,' +
      ' last_fetched_at, created_at) VALUES (' +
      `'${unreadableId}', 'feed9901', NULL, '/var/fixture/rfc319/unreadable',` +
      ` 'main', ${Date.now() - 3600_000}, ${Date.now()});`,
  )
  const seeded = await listMirrors()
  expect(
    seeded.filter((row) => row.id === unreadableId),
    '直连落库的那一行没进去 ⇒ bun:sqlite 的 exec 对约束错误不抛异常，' +
      '看似成功实则零行（见 docs/dev-gotchas.md）',
  ).toHaveLength(1)

  // 5) file:// 被拒：注册面**刻意不拒** file://（schemas/repoBatchImport.ts:20-28
  //    的定音：存量可见不可运行），所以这一行也是走产品自己的导入建出来的。
  const fileRemote = makeRemote('filescheme')
  const fileMirror = await importMirror(pathToFileURL(fileRemote.barePath).href)
  expect(
    fileMirror.urlRedacted.startsWith('file://'),
    '导进来的这行不是 file:// 形态 ⇒ 这条拒绝分支测不到',
  ).toBe(true)

  // ---- 逐条点 Refresh，看界面说了什么 ------------------------------------
  await openRepos(page)

  const refreshAndRead = async (mirror: MirrorLite, searchKey: string): Promise<string> => {
    await page.getByTestId('repos-search').fill(searchKey)
    const row = page.getByTestId(`repos-row-${mirror.id}`)
    await expect(row, `搜不到 ${searchKey} 这一行 ⇒ 点不到它的刷新按钮`).toBeVisible()
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/cached-repos/${mirror.id}/refresh` &&
          r.request().method() === 'POST',
      ),
      page.getByTestId(`repos-refresh-${mirror.id}`).click(),
    ])
    expect(
      response.ok(),
      `刷新 ${searchKey} 居然成功了（HTTP ${response.status()}）⇒ 这条失败分支没被触发，` +
        '下面的文案断言会变成断言一个不存在的横幅',
    ).toBe(false)
    const banner = errorBanner(page)
    await expect(banner, `刷新 ${searchKey} 失败了却没有任何错误提示`).toHaveCount(1)
    // 用 textContent 而不是 innerText：RFC-203 把后端原话收进折叠 `<details>`，
    // innerText 看不见折叠内容——而那正是这五条里三条唯一的可分辨信号。折叠块
    // 对用户可达这件事由本用例末尾单独展开验证一次。
    return (await banner.textContent()) ?? ''
  }

  // 1) 抓取失败 —— 精确文案 + git 原话
  const fetchText = await refreshAndRead(goneMirror, 'fetchgone.git')
  expect(
    fetchText,
    '抓取失败没有说清「上次成功的抓取时间被保留了」⇒ 用户不知道镜像现在是不是被弄坏了',
  ).toContain('Repository refresh failed; the last successful fetch time was preserved.')
  expect(
    fetchText,
    '抓取失败没有给出下一步 ⇒ 用户只知道红了，不知道该去查网络还是查凭据',
  ).toContain('Check repository credentials and network access, then retry.')
  expect(
    fetchText,
    '抓取失败没有把 git 的原话带出来 ⇒ 「404 / 权限 / DNS」三种截然不同的成因在界面上同形',
  ).toContain('git output')

  // 2) 目录损坏 —— 与抓取失败必须**不同**，且处方是「删掉重克隆」
  const corruptText = await refreshAndRead(corruptMirror, 'corrupted.git')
  expect(
    corruptText,
    '缓存目录没了却报成抓取失败 ⇒ 用户会去查网络，而真正该做的是删掉这份缓存重克隆',
  ).toContain('The repository cache directory is corrupt.')
  expect(
    corruptText,
    '目录损坏没给出「删掉重克隆」的处方 ⇒ 用户在一个刷新永远不会成功的镜像上反复点',
  ).toContain('Delete the cached repo, then launch again to re-clone.')
  expect(
    corruptText,
    '目录损坏与抓取失败共用同一句文案 ⇒ 两种成因、两种处方，界面却只说一件事',
  ).not.toContain('Repository refresh failed; the last successful fetch time was preserved.')

  // 3) 尚未取回内容 —— 处方是「重试任务的准备步骤」，**不是**删镜像
  const pendingText = await refreshAndRead(pendingMirror, 'rfc319-never-fetched.git')
  expect(
    pendingText,
    '「已登记身份、还没取回内容」被说成别的成因 ⇒ 用户按错误的处方去删镜像，' +
      '而那正好会把任务重试所依赖的那行 id 一起删掉（gitRepoCache.ts:1537-1546 的原话）',
  ).toContain('has not fetched its content yet')
  expect(pendingText, '没有告诉用户该去重试任务的准备步骤 ⇒ 处方缺失，用户只能猜').toContain(
    "retry the task's repository-preparation step instead of refreshing",
  )
  expect(
    pendingText,
    '「尚未取回内容」被谎报成缓存目录损坏 ⇒ 这正是四轮门实测到的那次误导',
  ).not.toContain('The repository cache directory is corrupt.')

  // 4) URL 读不出 —— 处方是恢复密钥，不能与 file:// 混为一谈
  const unreadable = seeded.find((row) => row.id === unreadableId)!
  const unreadableText = await refreshAndRead(unreadable, '<url unavailable>')
  expect(
    unreadableText,
    'URL 解不开时没说清「地址读不出来所以没法验证远端」⇒ 用户不知道要去恢复 secret.key',
  ).toContain('its URL is unreadable')
  expect(
    unreadableText,
    'URL 读不出被谎报成「file:// 已不受支持」⇒ 会把用户引向「把仓推到远端」这条' +
      '完全错误的修法（gitRepoCache.ts:1509-1520 记的正是这次事故）',
  ).not.toContain('file:// mirrors are no longer a supported remote')

  // 5) file:// —— 必须给出**拒绝的理由**，而不是一句通用失败
  const fileText = await refreshAndRead(fileMirror, 'filescheme.git')
  expect(
    fileText,
    'file:// 镜像刷新被拒时没有给出拒绝的理由 ⇒ 用户看到一句通用「操作失败」，' +
      '会以为是网络问题，反复重试一条产品已经明确不再支持的来源',
  ).toContain('file:// mirrors are no longer a supported remote')
  expect(
    fileText,
    'file:// 被拒却报成抓取失败 ⇒ 用户会去查网络，而这条来源无论网络多好都不会再通',
  ).not.toContain('Repository refresh failed; the last successful fetch time was preserved.')
  expect(
    fileText,
    'file:// 被拒却报成缓存目录损坏 ⇒ 处方变成「删掉重克隆」，而重克隆同样会被拒',
  ).not.toContain('The repository cache directory is corrupt.')

  // 理由是**用户点得开**的，不是只躺在 DOM 里：RFC-203 把 raw 收进折叠块，
  // 折叠块打不开就等于没有。
  const banner = errorBanner(page)
  await banner.getByText('Raw error message', { exact: true }).click()
  await expect(
    banner.locator('pre'),
    '折叠块展开后看不到拒绝理由 ⇒ 这条理由对用户实际上不可达',
  ).toContainText('file:// mirrors are no longer a supported remote')
})

// ===========================================================================
// REPO-12 —— 真的带子模块的仓：徽标 + 「需关注」视图
// ===========================================================================

test('REPO-12 真带子模块的仓：克隆后徽标为「同步成功」，子模块拉不动后翻红并进「需关注」，而刷新请求本身仍成功 @nightly', async ({
  page,
}) => {
  // --- 夹具：child 被 parent 以真 http 远端挂成子模块 ----------------------
  const child = makeRemote('submodule-child')
  const parentRoot = mkdtempSync(join(tmpdir(), 'aw-rfc319-mirror-submodule-parent-'))
  scratchDirs.push(parentRoot)
  const parentWorking = join(parentRoot, 'src')
  mkdirSync(parentWorking, { recursive: true })
  writeFileSync(join(parentWorking, 'README.md'), '# rfc-319 submodule parent\n', 'utf-8')
  initGitRepo(parentWorking, { message: 'rfc-319 submodule parent' })
  runGit(['submodule', 'add', '-q', child.url, 'vendor/child'], parentWorking)
  commitAll(parentWorking, 'rfc-319 add submodule')
  const parentBare = join(parentRoot, 'submodule-parent.git')
  cloneBareGitRepo(parentWorking, parentBare)
  const parentUrl = repoRemoteUrl(parentBare)

  // --- 导入：冷克隆走 `clone --recurse-submodules` -------------------------
  const parentMirror = await importMirror(parentUrl)
  expect(
    parentMirror.hasSubmodules,
    '真带子模块的仓被记成「没有子模块」⇒ 徽标此后永远不出现，' +
      '拉下来是不是残的这件事在界面上彻底不可见',
  ).toBe(true)
  expect(
    parentMirror.lastSubmoduleSyncOk,
    '克隆成功却没把子模块同步记成成功 ⇒ 一个刚拉好的仓一上来就挂着告警',
  ).toBe(true)
  const mirrorFiles = await jsonOf<{ files: string[] }>(
    await req(`/api/repos/files?path=${encodeURIComponent(parentMirror.localPath)}`),
    'files of the submodule mirror',
  )
  expect(
    mirrorFiles.files,
    '镜像里没有 .gitmodules ⇒ has_submodules 那个 true 是凭空来的，不是真克隆出来的',
  ).toContain('.gitmodules')
  expect(
    existsSync(join(parentMirror.localPath, 'vendor', 'child', 'README.md')),
    '子模块的内容根本没被拉下来 ⇒ 「同步成功」是假的，任务会在一棵残缺的树上开工',
  ).toBe(true)

  await openRepos(page)
  await page.getByTestId('repos-search').fill('submodule-parent.git')
  const row = page.getByTestId(`repos-row-${parentMirror.id}`)
  await expect(row, '带子模块的镜像行没渲染 ⇒ 下面的徽标断言会退化成断言空集').toBeVisible()
  await expect(
    row.getByTestId('submodule-badge-ok'),
    '同步成功的子模块没有徽标 ⇒ 用户看不出这仓是带子模块的，出问题时不会往那儿想',
  ).toBeVisible()
  await expect(
    row.getByTestId('submodule-badge-error'),
    '刚拉好就挂着失败徽标 ⇒ 徽标恒红，用户很快学会无视它',
  ).toHaveCount(0)

  // --- 打断子模块：远端消失，本地那份也被清掉 ------------------------------
  // 只删远端不够——已初始化的子模块 checkout 不碰网络（本机实测）。这里摆的是
  // 「子模块远端没了 + 缓存里那份内容也没了」这一真实运维形态，随后由**产品
  // 自己的**刷新路径去踩它。
  rmSync(child.barePath, { recursive: true, force: true })
  rmSync(join(parentMirror.localPath, 'vendor', 'child'), { recursive: true, force: true })
  rmSync(join(parentMirror.localPath, '.git', 'modules', 'vendor'), {
    recursive: true,
    force: true,
  })

  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/cached-repos/${parentMirror.id}/refresh` &&
        r.request().method() === 'POST',
    ),
    page.getByTestId(`repos-refresh-${parentMirror.id}`).click(),
  ])
  expect(
    response.status(),
    '父仓 fetch 明明成功、只是子模块拉不动，刷新请求却整个失败了 ⇒ ' +
      '一个可用的镜像被当成不可用，用户会去删它',
  ).toBe(200)
  await expect(
    errorBanner(page),
    '子模块同步失败被抬成了请求级错误横幅 ⇒ 与「fetch 真的失败了」在界面上同形，' +
      '两种严重程度完全不同的事被说成一件',
  ).toHaveCount(0)

  await expect(
    row.getByTestId('submodule-badge-error'),
    '子模块同步失败后徽标没有翻红 ⇒ 拉下来的是一份残缺工作树，' + '用户要等任务跑挂了才知道',
  ).toBeVisible()
  await expect(
    row.getByTestId('submodule-badge-ok'),
    '失败之后成功徽标还挂着 ⇒ 界面同时说「好了」和「坏了」',
  ).toHaveCount(0)
  const failedTitle = await row.getByTestId('submodule-badge-error').getAttribute('title')
  expect(
    failedTitle ?? '',
    '失败徽标没带上 git 的原话 ⇒ 用户只知道「子模块出问题了」，' +
      '不知道是哪个子模块、也不知道是权限还是地址',
  ).toContain('vendor/child')

  // --- 「需关注」视图必须把它捞出来 ---------------------------------------
  await page.getByTestId('repos-search').fill('')
  await page.getByTestId('repos-view-attention').click()
  await expect(
    page.getByTestId(`repos-row-${parentMirror.id}`),
    '子模块同步失败的仓没进「需关注」⇒ 唯一一个把坏仓捞出来的入口漏掉了它',
  ).toBeVisible()
  await expect(
    page.getByTestId(`repos-row-${alphaMirror.id}`),
    '一个健康的仓也被算进「需关注」⇒ 视图里混着没事的仓，用户不再信它',
  ).toHaveCount(0)
  await page.getByTestId('repos-view-all').click()
})

// ===========================================================================
// REPO-06 / REPO-X5 —— 删除（直删 / 被组引用时 409 且无强删出口）
// ===========================================================================

test('REPO-06 / REPO-X5 无引用镜像直删不弹确认框；被仓库组引用的镜像 409 后界面上没有任何强删出口 @nightly', async ({
  page,
}) => {
  // --- 夹具 ---------------------------------------------------------------
  const freeRemote = makeRemote('deletable')
  const freeMirror = await importMirror(freeRemote.url)
  const groupedRemote = makeRemote('grouped')
  const groupedMirror = await importMirror(groupedRemote.url)
  const taskRefRemote = makeRemote('taskref')
  const taskRefMirror = await importMirror(taskRefRemote.url)
  seedReferencingTask('rfc319-mirror-delete-control-task', taskRefMirror.id)
  const groupName = `rfc319-mirror-group-${Date.now() % 100000}`
  await jsonOf<{ id: string }>(
    await req('/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: groupName,
        description: '',
        nodes: [{ path: '', attachment: { kind: 'repo', cachedRepoId: groupedMirror.id } }],
      }),
    }),
    'seed repo group referencing the mirror',
  )

  const fresh = await listMirrors()
  const freeNow = fresh.find((row) => row.id === freeMirror.id)!
  const groupedNow = fresh.find((row) => row.id === groupedMirror.id)!
  expect(
    freeNow.referencingTaskCount,
    '「无引用」那一行其实被任务引用着 ⇒ 它会走确认框分支，REPO-06 测不到直删',
  ).toBe(0)
  expect(
    groupedNow.referencingTaskCount,
    '「被组引用」那一行同时也被任务引用着 ⇒ 确认框会照常打开，' +
      'REPO-X5 要证的「零任务引用时没有强删出口」就落空了',
  ).toBe(0)

  await openRepos(page)

  // --- 正向对照 A：确认框这个锚点是活的（有任务引用时它确实会开）----------
  // 没有这一条，下面两处 `toHaveCount(0)` 会被「testid 改名了」之类的变化变成恒真。
  const taskRefNow = fresh.find((row) => row.id === taskRefMirror.id)!
  expect(
    taskRefNow.referencingTaskCount,
    '对照镜像没有被任务引用 ⇒ 它不会走确认框分支，这条正向对照本身就是坏的',
  ).toBeGreaterThan(0)
  await page.getByTestId('repos-search').fill('taskref.git')
  await expect(page.getByTestId(`repos-row-${taskRefMirror.id}`)).toBeVisible()
  await page.getByTestId(`repos-delete-${taskRefMirror.id}`).click()
  await expect(
    page.getByTestId('repos-delete-confirm'),
    '有任务引用的镜像点删除却不弹确认框 ⇒ 一次误点就连着别人的任务一起废掉；' +
      '同时这也说明下面两条「不该出现确认框」的断言是恒真的',
  ).toBeVisible()
  await expect(
    page.getByTestId('repos-delete-confirm-action'),
    '确认框里没有强删按钮 ⇒ 下面 REPO-X5 的「没有强删出口」同样退化成恒真',
  ).toBeVisible()
  await page
    .getByTestId('repos-delete-confirm')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await expect(page.getByTestId('repos-delete-confirm')).toHaveCount(0)

  // --- REPO-06：零引用镜像直删，不弹确认框 --------------------------------
  await page.getByTestId('repos-search').fill('deletable.git')
  const freeRow = page.getByTestId(`repos-row-${freeMirror.id}`)
  await expect(freeRow, '待删镜像行没渲染 ⇒ 用户点不到它的删除按钮').toBeVisible()
  const [deleteResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/cached-repos/${freeMirror.id}` &&
        r.request().method() === 'DELETE',
    ),
    page.getByTestId(`repos-delete-${freeMirror.id}`).click(),
  ])
  expect(
    new URL(deleteResponse.url()).searchParams.get('force'),
    '零引用的删除也带上了 force=1 ⇒ 引用守卫被无条件绕过，' +
      '「有引用时先拦一下」这道门此后对谁都不生效',
  ).toBeNull()
  await expect(
    page.getByTestId('repos-delete-confirm'),
    '零引用的镜像也弹确认框 ⇒ 每清一个闲置缓存都要多点一次，批量清理时成本翻倍',
  ).toHaveCount(0)
  await expect(
    freeRow,
    '删除返回了但行还在 ⇒ 用户会以为没删掉，反复点；或者它其实真的没删掉',
  ).toHaveCount(0)
  const afterDelete = await listMirrors()
  expect(
    afterDelete.some((row) => row.id === freeMirror.id),
    '界面上行消失了但库里还在 ⇒ 磁盘没收回来，刷新页面它又会冒出来',
  ).toBe(false)
  expect(
    existsSync(freeMirror.localPath),
    '库里删了但盘上的缓存目录还在 ⇒ 用户删镜像的**唯一**目的（腾磁盘）没有达成',
  ).toBe(false)

  // --- REPO-X5：被仓库组引用 → 409，且界面上不长出强删出口 ----------------
  await page.getByTestId('repos-search').fill('grouped.git')
  const groupedRow = page.getByTestId(`repos-row-${groupedMirror.id}`)
  await expect(groupedRow, '被组引用的镜像行没渲染 ⇒ 后面的断言会跑在空集上').toBeVisible()
  const [conflict] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/cached-repos/${groupedMirror.id}` &&
        r.request().method() === 'DELETE',
    ),
    page.getByTestId(`repos-delete-${groupedMirror.id}`).click(),
  ])
  expect(
    conflict.status(),
    `被仓库组引用的镜像被删掉了（HTTP ${conflict.status()}）⇒ 用户手工编排的组从此少` +
      '一个仓，下次启动才发现，而那时已经想不起是哪次删除导致的',
  ).toBe(409)

  const banner = errorBanner(page)
  await expect(banner, '删除被拒却没有任何提示 ⇒ 用户点了没反应，会一直点').toHaveCount(1)
  await expect(
    banner,
    '拒绝原因里没提到仓库组 ⇒ 用户只知道「删不掉」，不知道该先去哪个组里把它摘出来',
  ).toContainText('repo group(s) still reference')
  await expect(
    groupedRow,
    '409 之后行却消失了 ⇒ 界面在骗用户「删掉了」，刷新后它会回来',
  ).toBeVisible()

  // 核心：**没有**强删出口。确认框只在「有任务引用」时才开（repos.tsx:729-733），
  // 组引用这一支既不开框、也不该在别处冒出一个 force 按钮。
  await expect(
    page.getByTestId('repos-delete-confirm'),
    '被组引用时弹出了确认框 ⇒ 用户下一步就会点「Confirm delete」，' +
      '那一下带 force=1，会把组里的成员静默摘掉',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('repos-delete-confirm-action'),
    '界面上出现了强删按钮 ⇒ 同上，一键把别人编排好的组打出一个洞',
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /force/i }),
    '错误横幅上长出了一个「强制」动作 ⇒ 409 的意义是「先去改组」，不是「再按一次就能删」',
  ).toHaveCount(0)

  const stillThere = await listMirrors()
  expect(
    stillThere.some((row) => row.id === groupedMirror.id),
    '409 之后镜像其实已经被删掉了 ⇒ 守卫只是嘴上拦了一下，副作用照旧发生',
  ).toBe(true)
})

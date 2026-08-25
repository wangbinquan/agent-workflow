// RFC-319 —— `/repos`「远端仓库」页签的用户面 e2e（账本 REPO-01/02/03/08/09/10/11/33）。
//
// 这一页是**任务能不能开工**的前置面：镜像导进来了没有、导失败的那几行还救不救得回
// 来、列表上写的东西是不是真的。它坏掉时几乎不报错，只会安静地说错话——
//
//   * REPO-01 批量导入是把远端搬进平台的**唯一**用户入口。混合合法 / 非法 URL 是真实
//     粘贴场景（从工单里抄一段，中间夹一行注释）。一行非法就让整批 400，用户要自己
//     二分找出是哪一行；反过来非法行被静默吞掉，用户以为 12 个仓都导进来了，直到某天
//     启动任务才发现少了一个——而那时他已经想不起当初粘的是什么。
//   * REPO-02 「改 URL 重试」是失败行**唯一**的自助出口。没有它，用户只能关掉弹窗、
//     把剩下的 URL 重新拼一遍再导一次；已经成功的那些还会被重复走一遍缓存命中。
//   * REPO-03 进度是 `/ws/repo-imports/{batchId}` 推的，前端**不轮询**（BatchImportDialog
//     只在重开批次时读一次快照）。推送断了，界面就永远停在「Queued」：克隆其实早就
//     跑完了，用户却在等一个永远不来的完成，最后关掉弹窗以为导入挂了。
//   * REPO-08 主表的每一列都是决策依据：脱敏 URL 决定「这是哪个仓」，本地路径决定
//     「盘上是哪一份」，抓取时间决定「敢不敢直接拿它开任务」，引用数决定「能不能删」，
//     子模块徽标决定「这仓拉下来是不是残的」。任何一列渲染错，用户都会照着错的做决定。
//   * REPO-09 搜索 / 视图 / 高级过滤在 RFC-311 T28 之后**全部下推服务端**。任何一项退回
//     前端过滤，在十万仓的目标尺度上就是「只在第一页 50 行里搜」——用户搜不到的东西
//     明明存在，而界面对此只字不提。
//   * REPO-10 游标分页是这页唯一的翻页手段（`/repos` 没有滚动哨兵，只有显式按钮）。
//     翻页坏掉 = 第 51 个仓起全部不可达，而列表看上去完全正常。
//   * REPO-11 两个空态形状不同：首次空态要**教用户下一步做什么**（带导入按钮），
//     「无匹配」要给出**退回全量**的出口。把后者渲染成前者，用户会以为自己的仓全没了。
//   * REPO-33 写权限门。按钮渲染出来但请求被 403 挡住 ≠ 门合上了：用户点得到、点了报错，
//     以为是系统故障而不是自己没权限。判据必须是「按钮不存在」+「该发的请求一条没发」。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check 逐条
// 请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/repos.tsx:190-217          分页查询恒发 limit=50 / view / q / submodules / auto_refresh / cursor
//   packages/frontend/src/routes/repos.tsx:219-222          facets 来自服务端；isInitialEmpty / noMatches 两个空态分支
//   packages/frontend/src/routes/repos.tsx:352-373          canOpenBatchDialog：create ∨（execute ∧ 有活跃批次）
//   packages/frontend/src/routes/repos.tsx:534-560          isInitialEmpty 时连工具条都不渲染
//   packages/frontend/src/routes/repos.tsx:576-594          repos-empty / repos-no-matches 两个空态
//   packages/frontend/src/routes/repos.tsx:625-641          「加载更多」尾注（不 disabled，见 RFC-311 注记）
//   packages/frontend/src/routes/repos.tsx:643-731          行渲染：脱敏 URL / 徽标 / 本地路径 / 分支 / 抓取时间 / 引用数
//   packages/frontend/src/routes/repos.tsx:678-688          epoch 0 → 「Never synced」，不渲染成「56 年前」
//   packages/frontend/src/routes/repos.tsx:706-729          canExecute / canDelete 决定行内按钮，两者皆无渲染 em dash
//   packages/frontend/src/components/repos/BatchImportDialog.tsx:127-165  重开批次时**只读一次**快照
//   packages/frontend/src/components/repos/BatchImportDialog.tsx:176-206  WS row.update / batch.completed 应用到界面
//   packages/frontend/src/components/repos/BatchImportDialog.tsx:212-217  订阅路径来自 WS_PATHS.repoImport
//   packages/frontend/src/components/repos/BatchImportDialog.tsx:293-321  改 URL 重试：空串 = 原 URL 重试
//   packages/frontend/src/components/VirtualList.tsx:150-163              aria-setsize = 已加载总数
//   packages/backend/src/routes/cached-repos.ts:41-70                     无参 = 旧全量形状；带任一参数 = 分页封套
//   packages/backend/src/services/gitRepoCache.ts:1321-1367               q 三列 LIKE / 三个视图 / 游标行值比较
//   packages/backend/src/services/gitRepoCache.ts:1441-1452               facets 恒为全量视角
//   packages/backend/src/services/gitRepoCache.ts:1262                    facets 5s TTL（下面 waitForRepoFacets 的由来）
//   packages/backend/src/services/repoBatchImport.ts:188-224              非法 URL 的行「出生即失败」，不进队列
//   packages/backend/src/services/repoBatchImport.ts:519-534              rowToWire 两次 redactGitUrl
//   packages/shared/src/schemas/ws.ts:542                                 WS_PATHS.repoImport
//   packages/shared/src/schemas/permission.ts:1083-1087                   repos:create/update/delete/execute 是 manager 档
//   packages/shared/src/schemas/permission.ts:945                         repos:read 在 user 基线里
//
// 与既有覆盖的关系（不重复造轮子）：
//   · `e2e/main.spec.ts` 的 `RFC-033: batch import remote repos on /repos page` 已经走过一遍
//     弹窗导入，但它的收敛与结果断言全部走 `fetch` 轮询 API，**界面只被断言到「表格出现」**。
//     本文件补的是用户真正看见的那一层：每行的状态措辞、失败行的自助出口、以及进度到底
//     是不是推过来的。
//   · `e2e/repo-governance.spec.ts` 的 REPO-13 已在 **wire 层**锁死带凭据 URL 的脱敏（重点是
//     克隆失败路径）。本文件只补它没覆盖的那半边：**成功导入之后，列表界面上**呈现的是
//     脱敏形态，明文一个字节都不落进 DOM。
//   · `e2e/keyboard-flows.spec.ts` 用同一个弹窗锁 Dialog 的键盘契约（焦点陷阱 / Esc / 焦点归还），
//     本文件不再重复这些。
//   · `e2e/repo-group-launch.spec.ts` 锁 `/repos` 的 tab URL 契约与仓库组页签，本文件只碰
//     「远端仓库」页签。
//
// 执行模型：本文件所有用例共用一个 daemon，playwright.config.ts 的 fullyParallel 留在默认
// false，因此文件内用例按**声明顺序串行**。顺序是判据的一部分：
//   · REPO-11 的首次空态必须第一个跑 —— 任何先跑的用例导进一个仓就把它变成恒假断言。
//   · REPO-10 的 60 行分页夹具放在 REPO-09 之后 —— 先塞进去会让视图 / 过滤那条的行计数断言
//     被淹没在分页窗口里。
//   · REPO-33 放最后 —— 它只读，不改任何状态，谁在它前面都无所谓。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cloneBareGitRepo, initGitRepo, repoRemoteUrl, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let daemon: DaemonHandle
const scratchDirs: string[] = []

/** 导入夹具产出的两个镜像（REPO-01 建，REPO-08 复用其中的凭据那一个）。 */
let importedPlainUrl = ''
let importedCredentialUrl = ''
let importedCredentialRedacted = ''

/**
 * 夹具里的「凭据」刻意**不带任何真实供应商前缀**（`glpat-` / `ghp_` …）：仓库的
 * gitleaks 扫描按前缀 + 熵判定，用真实形状的假凭据会让 Static scans 变红，而那条红与
 * 本用例要证的东西毫无关系（同 `e2e/repo-governance.spec.ts` 头部记的实撞）。
 */
const EMBEDDED_CREDENTIAL = 'rfc319-fixture-embedded-credential-Kp42'

const LOW_PRIVILEGE_USERNAME = 'rfc319-repos-reader'
const LOW_PRIVILEGE_PASSWORD = 'longEnoughPassword'

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
// 通用夹具工具
// ---------------------------------------------------------------------------

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

async function req(path: string, init?: RequestInit, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
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

async function primeAuth(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, sessionToken }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', sessionToken)
        // 固定英文，测试选择器对的是 en-US 文案。
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore — chromium 下不会失败 */
      }
    },
    { baseUrl: daemon.baseUrl, sessionToken: token },
  )
}

async function openRepos(page: Page, token = daemon.token): Promise<void> {
  await primeAuth(page, token)
  await page.goto(`${daemon.baseUrl}/repos`)
  await expect(
    page.getByRole('heading', { name: 'Code repositories', exact: true }),
    '/repos 连页头都没渲染出来 ⇒ 后面所有断言都只是在断言一张白屏',
  ).toBeVisible()
}

interface CachedRepoLite {
  id: string
  urlRedacted: string
  referencingTaskCount: number
}

async function listMirrors(token?: string): Promise<CachedRepoLite[]> {
  const body = await jsonOf<{ items: CachedRepoLite[] }>(
    await req('/api/cached-repos', undefined, token),
    'list cached repos',
  )
  return body.items
}

async function mirrorIdFor(urlRedacted: string): Promise<string> {
  const items = await listMirrors()
  const hit = items.find((row) => row.urlRedacted === urlRedacted)
  expect(
    hit,
    `镜像 ${urlRedacted} 不在列表里 ⇒ 导入声称成功但什么都没落库：${JSON.stringify(
      items.map((row) => row.urlRedacted),
    )}`,
  ).toBeTruthy()
  return hit!.id
}

interface RepoFacets {
  all: number
  referenced: number
  attention: number
  unused: number
}

/**
 * 等服务端 facets 收敛。
 *
 * 为什么需要它：facets（以及 scheduled 引用集）在 daemon 进程里带 **5 秒 TTL 的缓存**
 * （gitRepoCache.ts:1262），**只有产品自己的写路径**会显式失效它。批量导入走
 * `resolveCachedRepo`，会自己失效；而下面几条用直连 SQL 落的夹具行绕过了那条路径，
 * 于是计数最多滞后一个 TTL。这不是「重跑就过了」——滞后有确定上界，等它收敛是**确定
 * 性等待**，不是碰运气；分页 items 本身是每次实查，从不滞后。
 */
async function waitForRepoFacets(
  predicate: (facets: RepoFacets) => boolean,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await req('/api/cached-repos?limit=1')
        if (!res.ok) return false
        const body = (await res.json()) as { facets: RepoFacets }
        return predicate(body.facets)
      },
      { message, timeout: 30_000, intervals: [200, 300, 500, 1000] },
    )
    .toBe(true)
}

// --- git 夹具 ---------------------------------------------------------------

/** 建一个可克隆的裸仓，返回它经 system-mock smart-HTTP 网关的远端 URL。 */
function fixtureRemote(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `aw-rfc319-import-${label}-`))
  scratchDirs.push(root)
  const working = join(root, 'src')
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'README.md'), `# rfc-319 ${label}\n`, 'utf-8')
  initGitRepo(working, { message: `rfc-319 ${label}` })
  const bare = join(root, `${label}.git`)
  cloneBareGitRepo(working, bare)
  // `repoRemoteUrl` 强制走 system-mock 的 smart-HTTP 网关：产品对 `file://` 的处置是
  // 「导得进来但启动 / 刷新都会被拒」（schemas/repoBatchImport.ts 顶部 RFC-287 G5 的定音），
  // 用它造夹具等于让整条用户路径跑在一个产品自己判为半残的形态上。这里和其余仓库类
  // spec 一样，一律用真远端。
  return repoRemoteUrl(bare)
}

function withEmbeddedCredential(url: string, credential: string): string {
  expect(
    url.startsWith('http://'),
    'system-mock 的 git 网关不再是 http:// ⇒ 下面的凭据拼接与脱敏期望值都失效了',
  ).toBe(true)
  return url.replace('http://', `http://ci-bot:${credential}@`)
}

/** `redactGitUrl` 对 http(s) 的处置是整段 userinfo 换成 `***`（git-url.ts:174）。 */
function expectedRedaction(url: string): string {
  return url.replace('http://', 'http://***@')
}

// --- 直连落库夹具 -----------------------------------------------------------

interface SeedRepoRow {
  id: string
  urlRedacted: string
  localPath: string
  defaultBranch: string | null
  lastFetchedAt: number
  lastAutoRefreshAt: number | null
  hasSubmodules: number | null
  lastSubmoduleSyncOk: number | null
  lastSubmoduleSyncError: string | null
}

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

function sqlNum(value: number | null): string {
  return value === null ? 'NULL' : String(value)
}

/** `url_hash` 有唯一约束；夹具用一段自带前缀的确定性 16 进制，不会撞上真镜像的 sha1。 */
function fixtureUrlHash(index: number): string {
  return (0xfeed0000 + index).toString(16)
}

/**
 * 直连落 `cached_repos` 行。
 *
 * 为什么不全用产品 API：真镜像只能靠 `git clone` 造，而「从未取回内容（epoch 0）」
 * 「子模块同步失败」「后台保鲜过 / 没保鲜过」这几种状态服务端根本没有用户可达的接口
 * 能摆出来——它们要么来自失败的克隆，要么来自 6 小时一拍的后台循环。真实存在、界面
 * 必须说对，所以用直连夹具摆出来；**它们锁的是 `/repos` 这一段的呈现**，不是克隆链路
 * （那条另有 `e2e/main.spec.ts` 的 RFC-024 / RFC-033 覆盖）。
 */
function seedRepoRows(rows: readonly SeedRepoRow[], hashOffset: number): void {
  const statements = rows.map((row, index) => {
    const values = [
      sqlText(row.id),
      sqlText(fixtureUrlHash(hashOffset + index)),
      sqlText(row.urlRedacted),
      sqlText(row.localPath),
      sqlText(row.defaultBranch),
      String(row.lastFetchedAt),
      String(Date.now()),
      sqlNum(row.hasSubmodules),
      sqlNum(row.lastSubmoduleSyncOk),
      sqlText(row.lastSubmoduleSyncError),
      sqlNum(row.lastAutoRefreshAt),
    ].join(', ')
    return (
      'INSERT INTO cached_repos (id, url_hash, url_redacted, local_path, default_branch,' +
      ' last_fetched_at, created_at, has_submodules, last_submodule_sync_ok,' +
      ` last_submodule_sync_error, last_auto_refresh_at) VALUES (${values});`
    )
  })
  runSqlite(dbPath(), statements.join('\n'))
}

/**
 * 给一个镜像造一条「有任务引用」的事实。
 *
 * `referencingTaskCount` 的三个来源里，`tasks.cached_repo_id`（且该任务没有 task_repos
 * 行）是最小的一条（gitRepoCache.ts:1310-1316）。真造一条引用要跑完一整个任务——那是
 * 另一条链路的覆盖面，这里只要「被引用」这个事实。
 */
function seedReferencingTask(taskId: string, cachedRepoId: string): void {
  const now = Date.now()
  const values = [
    sqlText(taskId),
    sqlText('RFC-319 repos-list fixture task'),
    sqlText('rfc319-repos-fixture-workflow'),
    sqlText('{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}'),
    sqlText('/tmp/rfc319-repos-fixture/repo'),
    sqlText(cachedRepoId),
    sqlText('/tmp/rfc319-repos-fixture/worktree'),
    sqlText('main'),
    sqlText(`agent-workflow/${taskId}`),
    sqlText('done'),
    sqlText('{}'),
    String(now),
    String(now),
  ].join(', ')
  runSqlite(
    dbPath(),
    'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, cached_repo_id,' +
      ' worktree_path, base_branch, branch, status, inputs, started_at, finished_at)' +
      ` VALUES (${values});`,
  )
}

// --- 批量导入弹窗 -----------------------------------------------------------

/** 打开导入弹窗（首次空态里按钮挂在空态上，有仓之后挂在页头，testid 同一个）。 */
async function openBatchImportDialog(page: Page): Promise<void> {
  await page.getByTestId('repos-batch-import-button').click()
  await expect(
    page.getByTestId('batch-import-dialog'),
    '导入弹窗没打开 ⇒ 平台没有第二条把远端搬进来的入口，用户到此为止',
  ).toBeVisible()
}

async function startBatchImport(page: Page, urls: readonly string[]): Promise<void> {
  await page.getByTestId('batch-import-textarea').fill(urls.join('\n'))
  await page.getByTestId('batch-import-start').click()
  await expect(
    page.getByTestId('batch-import-table'),
    '点了「Start import」却没进进度视图 ⇒ 用户不知道导入到底有没有开始',
  ).toBeVisible()
}

/** 进度表里某一行的定位器（rowId 由后端分配，从 DOM 上读）。 */
function importRow(page: Page, rowId: string) {
  return page.getByTestId(`batch-import-row-${rowId}`)
}

async function rowIdWithStatus(page: Page, status: string): Promise<string> {
  const locator = page.locator(`[data-testid^="batch-import-row-"][data-row-status="${status}"]`)
  await expect(
    locator,
    `进度表里没有任何 ${status} 行 ⇒ 前置条件不成立，后面的断言会变成断言空集`,
  ).toHaveCount(1)
  const testid = await locator.getAttribute('data-testid')
  expect(testid, `${status} 行没有 data-testid ⇒ 无法定位它`).toBeTruthy()
  return testid!.replace('batch-import-row-', '')
}

/** 等整批收敛（进度是 WS 推的，这里只等界面上的终态措辞）。 */
async function waitForImportRowsSettled(page: Page, expectedRows: number): Promise<void> {
  await expect(
    page.locator('[data-testid^="batch-import-row-"]'),
    `进度表的行数不是 ${expectedRows} ⇒ 用户粘进去的 URL 有的根本没被受理`,
  ).toHaveCount(expectedRows)
  await expect
    .poll(
      async () =>
        page.locator('[data-testid^="batch-import-row-"][data-row-status="done"]').count(),
      {
        message: '有 URL 一直停在 queued / cloning ⇒ 用户在等一个永远不来的完成',
        timeout: 120_000,
      },
    )
    .toBeGreaterThan(0)
}

/**
 * 关掉导入弹窗。
 *
 * 走 footer 里那颗主按钮，而不是 `getByRole('button', { name: 'Close' })`——共享
 * `<Dialog>` 的右上角 `×` 的无障碍名也是 "Close"（Dialog.tsx:425），两者同名，
 * 直接按名字取会 strict-mode 撞车。这里限定在 `.dialog__footer` 里，取的就是用户
 * 会去点的那颗。
 */
async function closeBatchImportDialog(page: Page): Promise<void> {
  await page
    .getByTestId('batch-import-dialog')
    .locator('.dialog__footer')
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  await expect(
    page.getByTestId('batch-import-dialog'),
    '点了 Close 弹窗没关 ⇒ 用户被困在进度视图里，回不到自己的仓库列表',
  ).toHaveCount(0)
}

// ===========================================================================
// REPO-11（首次空态）—— 必须第一个跑
// ===========================================================================

test('REPO-11 首次进入 /repos：空态引导取代空表格，工具条与表头一并让位', async ({ page }) => {
  await openRepos(page)

  await expect(
    page.getByTestId('repos-empty'),
    '一个仓都没有时不给空态 ⇒ 新用户面对一张没有任何提示的空表，不知道第一步该做什么',
  ).toBeVisible()
  await expect(
    page.getByTestId('repos-empty'),
    '空态没说清「这里本该有什么、怎么开始」⇒ 引导退化成一句无信息量的「暂无数据」',
  ).toContainText('No cached repos yet')

  // 空态里必须**自带**下一步的按钮。页头那一份在空态下刻意不渲染（repos.tsx:534），
  // 两处都没有的话用户就真的走不下去了。
  await expect(
    page.getByTestId('repos-empty').getByTestId('repos-batch-import-button'),
    '首次空态里没有导入入口 ⇒ 用户看得懂「还没有仓」，却找不到把仓弄进来的地方',
  ).toBeVisible()

  await expect(
    page.getByTestId('repos-table'),
    '零行时仍渲染表格骨架 ⇒ 用户看到的是一张「疑似加载失败」的空表，而不是引导',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('repos-views'),
    '零行时仍渲染视图 / 搜索工具条 ⇒ 界面在邀请用户过滤一个空集合，四个计数全是 0',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('repos-no-matches'),
    '首次空态被渲染成「无匹配」⇒ 用户以为自己的仓被某个筛选藏起来了，去清筛选而不是去导入',
  ).toHaveCount(0)
})

// ===========================================================================
// REPO-01 —— 批量导入（混合合法 + 非法 URL）
// ===========================================================================

test('REPO-01 批量导入：合法行各自落库、非法行当场判失败，一行坏的不拖垮整批', async ({ page }) => {
  importedPlainUrl = fixtureRemote('plain')
  // 同一个远端的两种写法：用户粘进去的那份带凭据，界面上该出现的那份不带。
  const credentialRemote = fixtureRemote('cred')
  importedCredentialUrl = withEmbeddedCredential(credentialRemote, EMBEDDED_CREDENTIAL)
  importedCredentialRedacted = expectedRedaction(credentialRemote)
  const garbage = 'not-a-git-url'

  await openRepos(page)
  await openBatchImportDialog(page)
  await startBatchImport(page, [importedPlainUrl, importedCredentialUrl, garbage])

  // 非法那一行是「出生即失败」的（repoBatchImport.ts:188-206）：它连队列都不进，
  // 所以在同步返回的第一份快照里就该是 failed。
  const failedRowId = await rowIdWithStatus(page, 'failed')
  await expect(
    importRow(page, failedRowId),
    '非法 URL 没被判失败 ⇒ 用户以为这一行也导进来了，直到启动任务才发现少一个仓',
  ).toContainText('Failed')
  await expect(
    importRow(page, failedRowId),
    '失败行不说明为什么失败 ⇒ 用户只知道「红了」，不知道是 URL 打错了还是网络不通',
  ).toContainText('unsupported or malformed Git URL')
  await expect(
    importRow(page, failedRowId),
    '失败行没回显是哪一条 URL ⇒ 粘了 12 行的用户得自己二分找出坏的那一行',
  ).toContainText(garbage)

  // 两条合法 URL 必须各自跑完，且**不被那条非法行连累**。
  await waitForImportRowsSettled(page, 3)
  await expect
    .poll(
      async () =>
        page.locator('[data-testid^="batch-import-row-"][data-row-status="done"]').count(),
      {
        message: '合法 URL 没有全部完成 ⇒ 同一批里有一行非法就把好行也拖垮了',
        timeout: 120_000,
      },
    )
    .toBe(2)
  await expect(
    page.locator('[data-testid^="batch-import-row-"][data-row-status="done"]').first(),
    '完成行不区分「新克隆」与「命中缓存」⇒ 用户看不出这次导入到底有没有真的拉盘',
  ).toContainText('Cloned')

  // 关掉弹窗回到主表：两个镜像都要出现在**用户看得见的那张表**上，而不只是 API 里。
  await closeBatchImportDialog(page)

  const plainId = await mirrorIdFor(importedPlainUrl)
  const credId = await mirrorIdFor(importedCredentialRedacted)
  await expect(
    page.getByTestId(`repos-row-${plainId}`),
    '导入成功的镜像没有出现在主表里 ⇒ 用户刚导完就看不见它，只能刷新页面碰运气',
  ).toBeVisible()
  await expect(
    page.getByTestId(`repos-row-${credId}`),
    '第二个镜像没进主表 ⇒ 批量导入的「批量」只兑现了一半',
  ).toBeVisible()
  await expect(
    page.getByTestId('repos-empty'),
    '导进两个仓之后还挂着首次空态 ⇒ 用户以为导入没生效，会一遍遍重导',
  ).toHaveCount(0)
})

// ===========================================================================
// REPO-03 —— 进度经 /ws/repo-imports/{batchId} 实时推送
// ===========================================================================

test('REPO-03 导入进度由 /ws/repo-imports 推上来，界面不靠轮询也会自己走到完成', async ({
  page,
}) => {
  const remote = fixtureRemote('ws')

  // 先挂监听再打开弹窗：socket 是弹窗挂载时才建的，晚一步就分不清「没收到帧」是
  // 产品没推，还是我们连上得太晚——两种原因指向完全不同的修法。
  const socketUrls: string[] = []
  const frames: string[] = []
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/ws/repo-imports/')) return
    socketUrls.push(socket.url())
    socket.on('framereceived', (frame) => frames.push(String(frame.payload)))
  })

  // 快照读取是 REPO-03 的对照面：前端只在「重开一个已有批次」时读一次
  // （BatchImportDialog.tsx:127-165），此后完全靠 WS。把它数出来，才能排除
  // 「其实是轮询轮出来的」这个解释。
  const snapshotReads: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/api/cached-repos/imports/')) {
      snapshotReads.push(`${request.method()} ${pathname}`)
    }
  })

  await openRepos(page)
  await openBatchImportDialog(page)
  await startBatchImport(page, [remote])

  const batchId = await page.evaluate(() => window.localStorage.getItem('repo-import-batch-id'))
  expect(
    batchId,
    '批次 id 没落进 localStorage ⇒ 用户关掉弹窗再打开就再也找不回这次导入的进度',
  ).toBeTruthy()

  await expect
    .poll(() => socketUrls.length, {
      message: '浏览器根本没连上 /ws/repo-imports ⇒ 进度界面此后只能停在打开那一刻的静止快照',
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
  expect(
    new URL(socketUrls[0]!).pathname,
    '订阅的不是这个批次的通道 ⇒ 推来的是别人的进度，或者压根没人往这条通道上推',
  ).toBe(`/ws/repo-imports/${batchId!}`)

  // 界面自己走到完成。这一步没有任何 reload、没有任何手动刷新动作。
  await waitForImportRowsSettled(page, 1)
  const doneRowId = await rowIdWithStatus(page, 'done')
  await expect(
    importRow(page, doneRowId),
    '这一行没在界面上走到完成态 ⇒ 克隆早就跑完了，用户还在盯着「Queued」等',
  ).toContainText('Cloned')

  const rowUpdates = frames.filter((frame) => frame.includes('"type":"row.update"'))
  expect(
    rowUpdates.length,
    '一条 row.update 都没推 ⇒ 逐行进度是死的，用户无法判断卡在了哪个仓上',
  ).toBeGreaterThan(0)
  expect(
    frames.some((frame) => frame.includes('"type":"batch.completed"')),
    '整批完成没有推送 ⇒ 弹窗永远给不出「Import more」，用户只能靠关掉重开来确认结束',
  ).toBe(true)

  // 决定性的一步：整个过程中快照接口**只被读过一次**（重开批次那一次）。既然状态
  // 后来还变了，那它只能是推上来的——排除掉「其实是轮询」这个解释。
  expect(
    snapshotReads.length,
    `进度快照被读了 ${snapshotReads.length} 次（${snapshotReads.join(
      ', ',
    )}）⇒ 界面在轮询兜底，一旦 WS 真的断了也看不出来，这条推送契约就失去了守卫`,
  ).toBe(1)
})

// ===========================================================================
// REPO-02 —— 失败行的「改 URL 重试」
// ===========================================================================

test('REPO-02 导入失败的那一行可以就地改 URL 重试，并且只重跑它自己', async ({ page }) => {
  const good = fixtureRemote('retry-good')
  const typo = 'https://git.example.invalid/rfc319/typo repo.git'

  await openRepos(page)
  await openBatchImportDialog(page)
  await startBatchImport(page, [typo])

  const rowId = await rowIdWithStatus(page, 'failed')
  await expect(
    page.getByTestId(`batch-import-edit-${rowId}`),
    '失败行没有「改 URL 重试」的出口 ⇒ 用户只能关掉弹窗，把整批 URL 重新拼一遍再导一次',
  ).toBeVisible()

  await page.getByTestId(`batch-import-edit-${rowId}`).click()
  const override = page.getByTestId('batch-import-override-input')
  await expect(
    override,
    '改 URL 的输入框没出现 ⇒ 「重试」只能原样重跑，打错的地址永远还是打错的',
  ).toBeVisible()
  await override.fill(good)
  await page.getByTestId('batch-import-override-submit').click()

  await expect
    .poll(() => importRow(page, rowId).getAttribute('data-row-status'), {
      message: '改过 URL 的行没有走到完成 ⇒ 自助修复给了入口却修不好，比没有更糟',
      timeout: 120_000,
    })
    .toBe('done')
  await expect(
    importRow(page, rowId),
    '重试后这一行还显示着旧 URL ⇒ 用户无从确认自己改的那个地址真的被用上了',
  ).toContainText(good)
  await expect(
    page.getByTestId(`batch-import-override-${rowId}`),
    '重试成功后编辑区没有收起 ⇒ 用户不确定这次提交到底算不算数，会重复点',
  ).toHaveCount(0)

  await closeBatchImportDialog(page)
  const rescuedId = await mirrorIdFor(good)
  await expect(
    page.getByTestId(`repos-row-${rescuedId}`),
    '救回来的那个仓没进主表 ⇒ 重试看着成功了，实际什么都没留下',
  ).toBeVisible()
})

// ===========================================================================
// REPO-08 —— 主表行渲染
// ===========================================================================

const ALPHA = 'rfc319-repo-alpha'
const BRAVO = 'rfc319-repo-bravo'
const CHARLIE = 'rfc319-repo-charlie'
const DELTA = 'rfc319-repo-delta'
const REF_TASK = 'rfc319-repos-ref-task'

const ALPHA_URL = 'https://git.example.test/rfc319/alpha.git'
const BRAVO_URL = 'https://git.example.test/rfc319/bravo.git'
const CHARLIE_URL = 'https://git.example.test/rfc319/charlie.git'
const DELTA_URL = 'https://git.example.test/rfc319/delta.git'
const ALPHA_PATH = '/var/fixture/agent-workflow/repos/aaaa1111-alpha'
const BRAVO_SYNC_ERROR = 'fatal: could not read Username for submodule vendor/sdk'

test.describe('REPO-08 / REPO-09 / REPO-11（无匹配）', () => {
  test.beforeAll(() => {
    const hour = 60 * 60 * 1000
    const now = Date.now()
    seedRepoRows(
      [
        {
          id: ALPHA,
          urlRedacted: ALPHA_URL,
          localPath: ALPHA_PATH,
          defaultBranch: 'release/2026-08',
          lastFetchedAt: now - hour,
          lastAutoRefreshAt: null,
          hasSubmodules: 1,
          lastSubmoduleSyncOk: 1,
          lastSubmoduleSyncError: null,
        },
        {
          id: BRAVO,
          urlRedacted: BRAVO_URL,
          localPath: '/var/fixture/agent-workflow/repos/bbbb2222-bravo',
          defaultBranch: 'main',
          lastFetchedAt: now - 2 * hour,
          lastAutoRefreshAt: now - 10 * 60 * 1000,
          hasSubmodules: 1,
          lastSubmoduleSyncOk: 0,
          lastSubmoduleSyncError: BRAVO_SYNC_ERROR,
        },
        {
          id: CHARLIE,
          // RFC-287 G7 的「已登记身份、尚未取回内容」形态：epoch 0。
          urlRedacted: CHARLIE_URL,
          localPath: '/var/fixture/agent-workflow/repos/cccc3333-charlie',
          defaultBranch: null,
          lastFetchedAt: 0,
          lastAutoRefreshAt: null,
          hasSubmodules: 0,
          lastSubmoduleSyncOk: null,
          lastSubmoduleSyncError: null,
        },
        {
          id: DELTA,
          urlRedacted: DELTA_URL,
          localPath: '/var/fixture/agent-workflow/repos/dddd4444-delta',
          defaultBranch: 'main',
          lastFetchedAt: now - 3 * hour,
          lastAutoRefreshAt: null,
          hasSubmodules: null,
          lastSubmoduleSyncOk: null,
          lastSubmoduleSyncError: null,
        },
      ],
      0,
    )
    seedReferencingTask(REF_TASK, ALPHA)
  })

  test('REPO-08 主表逐列渲染真后端数据：脱敏 URL、本地路径、默认分支、抓取时间、引用数、子模块徽标', async ({
    page,
  }) => {
    await waitForRepoFacets(
      (facets) => facets.all >= 8 && facets.attention === 1 && facets.referenced === 1,
      '服务端 facets 没有收敛到夹具形状 ⇒ 后面的行断言会跑在一份过期快照上',
    )
    await openRepos(page)

    const alpha = page.getByTestId(`repos-row-${ALPHA}`)
    await expect(
      alpha,
      '镜像行根本没渲染 ⇒ 库里有这个仓，界面上却找不到，用户会重复导入一份',
    ).toBeVisible()
    await expect(
      alpha,
      '行上没有远端 URL ⇒ 一屏本地缓存路径长得都一样，用户分不出哪一行是哪个仓',
    ).toContainText(ALPHA_URL)
    await expect(
      alpha.locator('code'),
      '本地缓存路径没渲染 ⇒ 用户没法在盘上找到这份镜像，磁盘吃紧时无从下手',
    ).toHaveText(ALPHA_PATH)
    await expect(alpha, '默认分支没渲染 ⇒ 用户不知道不指定分支时任务会从哪条线开工').toContainText(
      'branch release/2026-08',
    )
    await expect(
      alpha.locator('time'),
      '抓取时间没渲染成时间元素 ⇒ 用户无法判断这份镜像新不新，敢不敢直接拿它开任务',
    ).toHaveCount(1)
    await expect(
      alpha.locator('time'),
      '抓取时间的绝对值没进无障碍名 ⇒ 读屏用户只听得到「1 小时前」，永远拿不到确切时刻',
    ).toHaveAttribute('aria-label', /\d/)
    await expect(
      alpha.locator('strong'),
      '引用数没渲染 ⇒ 用户删仓前看不出「还有任务在用它」，删完才发现连累了别人',
    ).toHaveText('1')
    await expect(
      alpha,
      '从没被后台保鲜过的镜像没给出「—」⇒ 空白格与「刚刚刷过」在视觉上无从分辨',
    ).toContainText('Auto-refresh —')
    await expect(
      alpha.getByTestId('submodule-badge-ok'),
      '同步成功的子模块没有徽标 ⇒ 用户看不出这仓是带子模块的，出问题时不会往那儿想',
    ).toBeVisible()

    const bravo = page.getByTestId(`repos-row-${BRAVO}`)
    await expect(
      bravo.getByTestId('submodule-badge-error'),
      '子模块同步失败没有徽标 ⇒ 拉下来的是一份残缺工作树，用户要等任务跑挂了才知道',
    ).toBeVisible()
    await expect(
      bravo.getByTestId('submodule-badge-error'),
      '失败徽标没带上具体 stderr ⇒ 用户只知道「子模块出问题了」，不知道是权限还是地址',
    ).toHaveAttribute('title', BRAVO_SYNC_ERROR)
    await expect(
      bravo.locator('time'),
      '后台保鲜时间没渲染 ⇒ 用户分不清「一直没人管」和「后台刚保鲜过」',
    ).toHaveCount(2)

    const charlie = page.getByTestId(`repos-row-${CHARLIE}`)
    await expect(
      charlie,
      'epoch 0 的「尚未取回内容」被当成真实时间戳 ⇒ 界面会说这仓「56 年前抓过」，' +
        '用户照着这个判断敢不敢用它',
    ).toContainText('Never synced')
    await expect(
      charlie.locator('time'),
      '从未同步的行仍渲染出时间元素 ⇒ 读屏用户听到的是一个 1970 年的确切时刻',
    ).toHaveCount(0)
    await expect(
      charlie.getByTestId('submodule-badge-ok'),
      '没有子模块的仓挂了子模块徽标 ⇒ 徽标失去信号价值，用户学会无视它',
    ).toHaveCount(0)

    // 脱敏：用户粘进去的是带凭据的 URL，列表上呈现的必须是脱敏形态。
    // （wire 层的脱敏由 `e2e/repo-governance.spec.ts` 的 REPO-13 锁在失败路径上；
    //  这里补的是成功导入之后、用户真正盯着看的那一层。）
    const credId = await mirrorIdFor(importedCredentialRedacted)
    await expect(
      page.getByTestId(`repos-row-${credId}`),
      '带凭据导入的镜像行没有呈现脱敏形态 ⇒ 用户填的凭据在自己的列表页上被原样回显，' +
        '一次投屏 / 一张截图就泄露了',
    ).toContainText(importedCredentialRedacted)
    const pageText = await page.locator('body').innerText()
    expect(
      pageText.includes(EMBEDDED_CREDENTIAL),
      '页面文本里出现了明文凭据 ⇒ 凭据顺着列表界面泄露，而这条路径没有任何提示',
    ).toBe(false)
  })

  test('REPO-09 搜索 / 视图 / 高级过滤全部下推服务端，不是在已加载的那一页里挑', async ({
    page,
  }) => {
    const listQueries: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/cached-repos' && request.method() === 'GET') {
        listQueries.push(url.search)
      }
    })

    await openRepos(page)
    await expect(page.getByTestId(`repos-row-${DELTA}`)).toBeVisible()

    // --- 搜索 -------------------------------------------------------------
    await page.getByTestId('repos-search').fill('bravo')
    await expect(
      page.getByTestId(`repos-row-${BRAVO}`),
      '搜索把命中的那一行也过滤掉了 ⇒ 用户搜自己刚导的仓，搜出来一片空白',
    ).toBeVisible()
    await expect(
      page.getByTestId(`repos-row-${DELTA}`),
      '搜索没有真的收窄结果 ⇒ 搜索框成了摆设，仓多起来后这一页无法使用',
    ).toHaveCount(0)
    await expect
      .poll(() => listQueries.some((search) => search.includes('q=bravo')), {
        message:
          '搜索词没有发给服务端 ⇒ 过滤退回前端，只在已加载的 50 行里搜；第 51 行起的仓' +
          '用户永远搜不到，而界面不会告诉他还有没搜过的部分',
        timeout: 20_000,
      })
      .toBe(true)

    await page.getByTestId('repos-search').fill('')
    await expect(page.getByTestId(`repos-row-${DELTA}`)).toBeVisible()

    // --- 业务视图 ---------------------------------------------------------
    await page.getByTestId('repos-view-attention').click()
    await expect(
      page.locator('[data-testid^="repos-row-"]'),
      '「需关注」视图没有只留下真正出问题的仓 ⇒ 这个视图等于「全部」，' +
        '用户每次都得自己一行行找哪个红了',
    ).toHaveCount(1)
    await expect(
      page.getByTestId(`repos-row-${BRAVO}`),
      '子模块同步失败的仓没进「需关注」⇒ 唯一一个把坏仓捞出来的入口漏掉了它',
    ).toBeVisible()
    await expect(
      page.getByTestId(`repos-row-${ALPHA}`),
      '子模块同步成功的仓也被算进「需关注」⇒ 视图里混着一堆没事的仓，用户不再信它',
    ).toHaveCount(0)

    await page.getByTestId('repos-view-referenced').click()
    await expect(
      page.getByTestId(`repos-row-${ALPHA}`),
      '有任务引用的仓没进「被引用」⇒ 用户据此清理镜像时会删掉还在用的那一个',
    ).toBeVisible()
    await expect(
      page.locator('[data-testid^="repos-row-"]'),
      '「被引用」视图里混进了没人用的仓 ⇒ 清理时不敢下手，这个视图白做',
    ).toHaveCount(1)

    await page.getByTestId('repos-view-unused').click()
    await expect(
      page.getByTestId(`repos-row-${ALPHA}`),
      '被引用的仓出现在「闲置」里 ⇒ 用户照着这个视图批量删除，会连着任务一起废掉',
    ).toHaveCount(0)
    await expect(
      page.getByTestId(`repos-row-${DELTA}`),
      '没人引用的仓没进「闲置」⇒ 想腾磁盘的用户找不到该删的那些',
    ).toBeVisible()
    await expect
      .poll(() => listQueries.some((search) => search.includes('view=unused')), {
        message: '视图没有发给服务端 ⇒ 归类只在当前这一页里算，翻页后同一个仓会换个归属',
        timeout: 20_000,
      })
      .toBe(true)

    await page.getByTestId('repos-view-all').click()
    await expect(page.getByTestId(`repos-row-${ALPHA}`)).toBeVisible()

    // --- 高级过滤弹窗 -----------------------------------------------------
    await page.getByTestId('repos-filter-button').click()
    const dialog = page.getByTestId('repos-filter-dialog')
    await expect(
      dialog,
      '高级过滤弹窗打不开 ⇒ 子模块 / 后台保鲜这两个维度在界面上完全不可达',
    ).toBeVisible()
    await dialog
      .getByRole('radiogroup', { name: 'Submodules' })
      .getByRole('radio', {
        name: 'With',
        exact: true,
      })
      .click()
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
    await expect(dialog, '点了应用弹窗没关 ⇒ 用户看不到自己刚筛出来的结果').toHaveCount(0)

    await expect(
      page.locator('[data-testid^="repos-row-"]'),
      '「带子模块」筛完还剩别的仓 ⇒ 高级过滤没生效，用户以为自己看的是子集',
    ).toHaveCount(2)
    await expect(
      page.getByTestId(`repos-row-${CHARLIE}`),
      '明确没有子模块的仓通过了「带子模块」筛选 ⇒ 这个开关是反的或者根本没接上',
    ).toHaveCount(0)
    await expect
      .poll(() => listQueries.some((search) => search.includes('submodules=with')), {
        message: '高级过滤没有发给服务端 ⇒ 同上，只在当前页里筛',
        timeout: 20_000,
      })
      .toBe(true)
    await expect(
      page.getByTestId('repos-filter-button'),
      '筛选生效了但按钮上没有计数角标 ⇒ 用户翻不到结果时不知道自己身上还挂着一个筛选',
    ).toContainText('1')

    // 叠加第二个维度：只剩后台保鲜过、且带子模块的那一个。
    await page.getByTestId('repos-filter-button').click()
    await page
      .getByTestId('repos-filter-dialog')
      .getByRole('radiogroup', { name: 'Background refresh' })
      .getByRole('radio', { name: 'Refreshed', exact: true })
      .click()
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
    await expect(
      page.getByTestId(`repos-row-${BRAVO}`),
      '两个高级条件叠加后把唯一该留下的行也筛掉了 ⇒ 组合条件被当成互斥处理',
    ).toBeVisible()
    await expect(
      page.locator('[data-testid^="repos-row-"]'),
      '两个条件叠加后结果没有收窄 ⇒ 后加的条件被静默丢掉，用户以为自己筛过了',
    ).toHaveCount(1)

    await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expect(
      page.getByTestId(`repos-row-${CHARLIE}`),
      '「清除筛选」没把结果放回全量 ⇒ 用户被困在自己也说不清的筛选状态里',
    ).toBeVisible()
  })

  test('REPO-11 搜索无命中时给的是「无匹配 + 清除筛选」，不是首次空态', async ({ page }) => {
    await openRepos(page)
    await page.getByTestId('repos-search').fill('rfc319-no-such-repository')

    await expect(
      page.getByTestId('repos-no-matches'),
      '搜不到时没有任何空态 ⇒ 用户面对一张空表，分不清是搜没中还是加载失败',
    ).toBeVisible()
    await expect(
      page.getByTestId('repos-no-matches'),
      '「无匹配」没说清是当前筛选造成的 ⇒ 用户会以为自己的仓被删了',
    ).toContainText('No cached repositories match the current view and filters.')
    await expect(
      page.getByTestId('repos-empty'),
      '无匹配被渲染成首次空态 ⇒ 界面告诉用户「一个仓都还没有」，' +
        '而他明明刚导进去几个，只是当前搜索没命中',
    ).toHaveCount(0)

    await page
      .getByTestId('repos-no-matches')
      .getByRole('button', { name: 'Clear filters' })
      .click()
    await expect(
      page.getByTestId(`repos-row-${DELTA}`),
      '「清除筛选」出口点了没反应 ⇒ 用户唯一的退路是手动清空搜索框，或者刷新整页',
    ).toBeVisible()
    await expect(
      page.getByTestId('repos-search'),
      '清除筛选没把搜索框一并清空 ⇒ 结果回来了但输入框还留着旧词，下一次输入接在后面',
    ).toHaveValue('')
  })
})

// ===========================================================================
// REPO-10 —— 游标分页「加载更多」
// ===========================================================================

const PAGING_MARK = 'rfc319-paging'
const PAGING_ROWS = 60
const PAGE_SIZE = 50

test('REPO-10 超过一页时给出「加载更多」，按下去经游标续取而不是从头重来', async ({ page }) => {
  const base = Date.now() - 30 * 24 * 60 * 60 * 1000
  seedRepoRows(
    Array.from({ length: PAGING_ROWS }, (_, index) => ({
      id: `${PAGING_MARK}-${String(index).padStart(2, '0')}`,
      urlRedacted: `https://git.example.test/${PAGING_MARK}/repo-${String(index).padStart(
        2,
        '0',
      )}.git`,
      localPath: `/var/fixture/agent-workflow/repos/page${String(index).padStart(2, '0')}`,
      defaultBranch: 'main',
      // 严格递减，让 (last_fetched_at, id) 这把游标有全序，翻页结果可复现。
      lastFetchedAt: base - index * 1000,
      lastAutoRefreshAt: null,
      hasSubmodules: 0,
      lastSubmoduleSyncOk: null,
      lastSubmoduleSyncError: null,
    })),
    100,
  )

  const listQueries: string[] = []
  const cursorQueries: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname !== '/api/cached-repos') return
    listQueries.push(url.search)
    if (url.searchParams.has('cursor')) cursorQueries.push(url.search)
  })

  await openRepos(page)
  // 用搜索把断言收敛到这 60 行上：翻页与服务端过滤必须能叠加，
  // 而且这样断言的数字不会随本文件前面几条用例导了几个仓而漂移。
  await page.getByTestId('repos-search').fill(PAGING_MARK)

  // 等过滤真的落地再点「加载更多」。搜索有 350ms 去抖，去抖前后是**两个不同的
  // 查询键**，而 `keepPreviousData` 让旧结果继续挂在屏幕上——在这个窗口里点续取，
  // 取的是旧查询的第二页，随后被新查询整个丢掉。DELTA 是前面用例种的「最近抓取」
  // 夹具行，只有在过滤生效之后才会离开列表，拿它当落地信号。
  await expect(
    page.getByTestId(`repos-row-${DELTA}`),
    '搜索没有把不匹配的行清出去 ⇒ 服务端过滤没生效，后面的翻页断言会跑在全量集合上',
  ).toHaveCount(0)

  const loadMore = page.getByRole('button', { name: 'Load more repositories', exact: true })
  await expect(
    loadMore,
    '结果超过一页却没有「加载更多」⇒ 第 51 个仓起用户永远够不着，而界面看上去完全正常',
  ).toBeVisible()

  const setsizeOf = async (): Promise<number> => {
    const value = await page
      .locator('.repo-operations__list [role="listitem"][aria-setsize]')
      .first()
      .getAttribute('aria-setsize')
    return value === null ? -1 : Number(value)
  }
  await expect
    .poll(setsizeOf, {
      message: '首页装载的行数不是一整页 ⇒ 分页尺寸和服务端对不上，翻页会漏行或重行',
      timeout: 20_000,
    })
    .toBe(PAGE_SIZE)

  // 去抖后的那次首页请求也必须已经回来，否则 fetchNextPage 会落在一个还没有
  // 首页数据的查询上，静默变成空操作。
  await expect
    .poll(() => listQueries.some((search) => search.includes(`q=${PAGING_MARK}`)), {
      message: '带搜索词的首页请求一直没发出 ⇒ 过滤根本没有下推服务端',
      timeout: 20_000,
    })
    .toBe(true)

  cursorQueries.length = 0
  await loadMore.click()

  await expect
    .poll(setsizeOf, {
      message: '点了「加载更多」总数没长 ⇒ 后续页取不回来，用户点一下没反应，只能以为仓就这么多',
      timeout: 30_000,
    })
    .toBe(PAGING_ROWS)
  await expect(
    loadMore,
    '全部取回之后按钮还在 ⇒ 用户会一直点下去，每点一次都在白跑一次请求',
  ).toHaveCount(0)
  expect(
    cursorQueries.length,
    '续取请求没带游标 ⇒ 翻页退化成「再拉一次第一页」，用户点多少次都还是那 50 行',
  ).toBeGreaterThan(0)
  expect(
    cursorQueries.every((search) => search.includes(`q=${PAGING_MARK}`)),
    '续取时把搜索条件丢了 ⇒ 第二页突然混进不相干的仓，用户以为搜索失效了',
  ).toBe(true)

  // 第二页真的到得了：这一行的 last_fetched_at 最小，只可能在第 51 行之后。
  const last = `${PAGING_MARK}-${String(PAGING_ROWS - 1).padStart(2, '0')}`
  await page.getByTestId('repos-search').fill(`repo-${String(PAGING_ROWS - 1).padStart(2, '0')}`)
  await expect(
    page.getByTestId(`repos-row-${last}`),
    '排在最后的那个仓无论如何都够不着 ⇒ 分页边界上的行是真的丢了，不只是没渲染',
  ).toBeVisible()
})

// ===========================================================================
// REPO-33 —— 写权限门
// ===========================================================================

test('REPO-33 只有 repos:read 的账号：读得到全部镜像，四个写入口一个都不渲染、一条请求都不发', async ({
  page,
}) => {
  // `user` 预设正好是这条用例要的形状：repos:read 在用户基线里，
  // 而 repos:create/update/delete/execute 全在 manager 档（permission.ts:945 / 1083-1087）。
  const created = await req('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: LOW_PRIVILEGE_USERNAME,
      displayName: 'RFC-319 repos reader',
      role: 'user',
      password: LOW_PRIVILEGE_PASSWORD,
    }),
  })
  expect(created.status, `建低权账号失败：${await created.text()}`).toBe(201)
  const session = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: LOW_PRIVILEGE_USERNAME,
        password: LOW_PRIVILEGE_PASSWORD,
      }),
    }),
    'login low-privilege user',
  )

  const mirrorRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/api/cached-repos') || pathname.startsWith('/api/repo-groups')) {
      mirrorRequests.push(`${request.method()} ${pathname}`)
    }
  })

  await primeAuth(page, session.sessionToken)
  // 手上有一个「上次导入」的批次 id：有权限的账号在这种情况下会去读批次快照
  // （repos.tsx:352 的 canOpenBatchDialog 第二支）。没权限就该连读都不读。
  await page.addInitScript(() => {
    window.localStorage.setItem('repo-import-batch-id', 'rfc319-stale-batch-id')
  })
  await page.goto(`${daemon.baseUrl}/repos`)
  await expect(page.getByRole('heading', { name: 'Code repositories', exact: true })).toBeVisible()

  // 先证明读面是通的——否则「按钮不存在」可能只是因为整页压根没渲染出来。
  await expect(
    page.getByTestId(`repos-row-${ALPHA}`),
    '只读账号看不到任何镜像行 ⇒ 这条用例后面的「按钮不存在」全部退化成恒真断言',
  ).toBeVisible()
  await expect(
    page.getByTestId(`repos-row-${ALPHA}`),
    '只读账号连远端 URL 都读不到 ⇒ repos:read 名存实亡，这个角色在这一页上什么都干不了',
  ).toContainText(ALPHA_URL)

  await expect(
    page.getByTestId('repos-batch-import-button'),
    '没有 repos:create 却渲染了导入按钮 ⇒ 用户点下去只会撞一个 403，' +
      '看起来像系统故障而不是自己没权限',
  ).toHaveCount(0)
  await expect(
    page.getByTestId(`repos-refresh-${ALPHA}`),
    '没有 repos:execute 却渲染了刷新按钮 ⇒ 同上，一个点了必然失败的控件',
  ).toHaveCount(0)
  await expect(
    page.getByTestId(`repos-delete-${ALPHA}`),
    '没有 repos:delete 却渲染了删除按钮 ⇒ 最危险的那个控件出现在没权限的人面前',
  ).toHaveCount(0)
  await expect(
    page.getByTestId(`repos-row-${ALPHA}`).locator('.data-table__actions'),
    '无任何写权限时操作列没有给出占位 ⇒ 一列空白让人以为按钮没加载出来，会反复刷新',
  ).toHaveText('—')

  await page.getByTestId('repos-tab-groups').click()
  await expect(
    page.getByTestId('repo-groups-new'),
    '没有 repos:create 却渲染了「新建仓库组」⇒ 与导入按钮同一个门，漏了另一半',
  ).toHaveCount(0)

  // 请求面：整趟只该有 GET。尤其是那个陈旧批次 id——有权限时它会触发一次快照读，
  // 这里必须一次都没发生。
  const nonReads = mirrorRequests.filter((entry) => !entry.startsWith('GET '))
  expect(
    nonReads,
    `只读账号发出了写请求（${nonReads.join(', ')}）⇒ 界面上没有入口，代码里却还留着一条路`,
  ).toEqual([])
  expect(
    mirrorRequests.filter((entry) => entry.includes('/api/cached-repos/imports/')),
    '只读账号仍然去读了导入批次快照 ⇒ 权限门只挡住了按钮，没挡住它背后的数据获取',
  ).toEqual([])

  // 兜底：就算有人绕开界面直接打接口，服务端也必须拒。界面门与接口门是两道，
  // 只有前者的话，一个复制粘贴的 curl 就能越过去。
  const mirrorId = await mirrorIdFor(ALPHA_URL)
  for (const [what, res] of [
    [
      'batch-import',
      await req(
        '/api/cached-repos/batch-import',
        { method: 'POST', body: JSON.stringify({ urls: [ALPHA_URL] }) },
        session.sessionToken,
      ),
    ],
    [
      'refresh',
      await req(
        `/api/cached-repos/${mirrorId}/refresh`,
        { method: 'POST', body: '{}' },
        session.sessionToken,
      ),
    ],
    [
      'delete',
      await req(`/api/cached-repos/${mirrorId}`, { method: 'DELETE' }, session.sessionToken),
    ],
  ] as const) {
    expect(
      res.status,
      `只读账号直接调 ${what} 没有被拒 ⇒ 权限只画在界面上，接口对任何登录用户敞开`,
    ).toBe(403)
  }
})

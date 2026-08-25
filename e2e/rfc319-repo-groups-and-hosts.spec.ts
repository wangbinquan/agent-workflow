// RFC-319 —— 仓库组与代码平台连接的用户面 e2e
// （账本 REPO-25 / 26 / 27 / 28 / 29 / 30 / 34 / 36）。
//
// 这两块管的是「任务在什么代码上、以什么身份跑」。它们坏掉时几乎不报错，只会安静地
// 换掉执行前提——
//
//   * REPO-25 仓库组是**共享**资源（一个项目一个组，谁都能编辑）。编辑器打开时抓的是
//     那一刻的 `version`，保存时把它当栅栏送回去（RepoGroupEditor.tsx:247）。栅栏没送、
//     或服务端没比，两个人同时改就是**后写的静默吃掉先写的**——组是全量替换 nodes 的，
//     被吃掉的不是一个字段而是整棵目录树。
//   * REPO-26 组定义的五类拒绝是「保存前的最后一道」。放过任何一条，坏账都留到**启动
//     任务时**才爆：成环 / 超深度会让展平递归炸开（repoGroupLayout.ts:502-534 的遍历预算
//     就是为这个加的），挂载点冲突会让两个仓抢同一个目录，非法 subdir 是路径逃逸，
//     重名让用户在下拉里分不出该选哪个。**每一条都必须有自己可辨的原因与状态码**——
//     统一报「保存失败」等于把排障成本全丢给用户。
//   * REPO-27 页签是仓库组的唯一入口。三种空/非空状态混淆（首次空态渲染成「无匹配」、
//     或反过来）会让用户以为自己的组被删了；展开行看到的展平布局是他**启动前唯一**能
//     核对「这个组到底会给我几个仓、落在哪」的地方。
//   * REPO-28 批量加仓 / 粘贴 URL 是组装组的两条主路径。粘贴那条会**现场导入**尚未缓存
//     的远端（repoGroup.ts:388-398 的 `resolveCachedRepo`）——它静默失效的形态是「保存
//     成功但那个仓根本没进平台」，直到启动任务才发现。
//   * REPO-29 批量操作条是节点多起来之后唯一能用的编辑手段。它的五个动作里有三个是
//     **破坏性**的（摘除 / 移动 / 删除子树），任何一个作用到错误的节点集合上，用户都
//     要靠记忆把树重建一遍。
//   * REPO-30 ref / subdir / 只读是「组内单仓」的三个开关，而它们的**兑现地点在别处**
//     ——任务工作树。保存成功不等于生效：ref 掉了就在错的分支上干活，subdir 掉了就把
//     整个巨仓检出来，只读掉了就意味着 agent 的改动会被真的提交推送出去。
//   * REPO-34 代码平台连接是所有 code-host 调用与托管推送的凭据源。它有两个易错点：
//     token 只能进不能出（读面只回尾 4 位），以及「测试连接」不能拿**草稿值**的成功
//     给已保存的坏配置盖绿勾（codeHosts.ts:160-170）。
//   * REPO-36 两个 GitLab 专属选项都是安全相关：前缀集合决定「哪些 clone URL 算这套
//     凭据的」，rejectUnauthorized 决定要不要验证书。前者放进一个带凭据 / 带 query 的
//     串就等于把 token 写进设置读面，后者对 GitHub 放行就等于「保存成功但实际仍校验」
//     的假配置（connections.ts:114-117 的原话）。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check 逐条
// 请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/components/repos/RepoGroupsPane.tsx:80-127     搜索（名称∪描述）/ 首次空态 / 无匹配三分支
//   packages/frontend/src/components/repos/RepoGroupsPane.tsx:38-63      展开行的展平布局来自 /layout，失败只染自己那一行
//   packages/frontend/src/components/repos/RepoGroupEditor.tsx:241-260   保存：新建 POST、编辑 PUT + expectedVersion
//   packages/frontend/src/components/repos/RepoGroupEditor.tsx:313-332   批量加仓：优先填空目录，否则分配去重路径
//   packages/frontend/src/components/repos/RepoGroupEditor.tsx:357-389   批量条五动作 + 「跳过了几个纯目录」回执
//   packages/frontend/src/components/repos/RepoGroupEditor.tsx:495-583   勾选后工具条让位给批量条
//   packages/frontend/src/components/repos/RepoBulkAddDialog.tsx:77-89   非法行按行号点名、重复行去重
//   packages/frontend/src/components/repos/RepoBulkAddDialog.tsx:143-144 有非法行时提交按钮必须禁用
//   packages/frontend/src/components/repos/RepoLayoutTree.tsx:87-108     ref / subdir / 只读 / via 链的呈现
//   packages/backend/src/services/repoGroup.ts:492-504                   重名大小写不敏感 → 409
//   packages/backend/src/services/repoGroup.ts:553-560                   自引用 → repo-group-cycle
//   packages/backend/src/services/repoGroup.ts:562-578                   OCC 栅栏在事务内重读 version
//   packages/backend/src/services/repoGroup.ts:414-428                   subdir 走 normalizeMountPath，错误带 `subdir: ` 前缀
//   packages/shared/src/repoGroupLayout.ts:277-291                       同一定义内节点路径大小写折叠查重
//   packages/shared/src/repoGroupLayout.ts:513-534                       超深度 / 成环 / 遍历预算
//   packages/shared/src/repoGroupLayout.ts:579-593                       同一挂载点被两个仓占用
//   packages/backend/src/services/task.ts:1810-1848                      subdir → sparse checkout，且检出为空要报错
//   packages/backend/src/services/task.ts:2455-2462                      ref/subdir/readonly 落进 task_repos
//   packages/backend/src/services/scheduler.ts:2124-2143                 只读成员脏检查（每条终态路径都跑，干净写 0）
//   packages/backend/src/routes/codeHosts.ts:125-172                     测试连接回落已存值；草稿值的结果不回写
//   packages/backend/src/services/codeHost/connections.ts:118-130        rejectUnauthorized=false 仅 GitLab
//   packages/backend/src/services/codeHost/connections.ts:189-199        repositoryUrlPrefixes 仅 GitLab
//   packages/shared/src/codeHost/path.ts:104-125                         前缀归一化：小写 scheme/host、去尾斜杠、拒凭据/query
//   packages/frontend/src/components/settings/CodeHostsSection.tsx:399-408 前端把每一项归一化后再去重
//
// 与既有覆盖的关系（不重复造轮子）：
//   · `e2e/repo-group-launch.spec.ts` 覆盖的是**启动链路**（下拉里选组 → 任务按布局物化）
//     与编辑器的**草稿/脏值守卫**（dismiss / Back / 保存 pending）。本文件不碰这两块，
//     补的是它没覆盖的：并发保存、五类校验拒绝、页签三态、批量加仓与批量操作条、
//     以及 ref/subdir/只读三个开关**在工作树里的兑现**。
//   · `e2e/system-mocks.spec.ts` 已在 **API 层**打通两家 code-host 的凭据 + 探活。本文件
//     只补它没走的那一半：**设置页界面**上的保存 / 掩码 / 测试结果呈现与不回写规则。
//   · `packages/frontend/tests/rfc269-code-host-settings.test.tsx` 是 **mock 掉 api 的组件
//     单测**，锁的是请求体形状。本文件跑的是真守护进程：真密封、真探活、真落库再读回。
//   · `e2e/rfc319-repos-list-and-import.spec.ts` 锁 `/repos` 的「远端仓库」页签，本文件
//     只碰「仓库组」页签与 `/settings?tab=codeHosts`。
//
// 执行模型：本文件所有用例共用一个 daemon，playwright.config.ts 的 fullyParallel 留在默认
// false，因此文件内用例按**声明顺序串行**。顺序是判据的一部分：
//   · REPO-27 的首次空态必须第一个跑 —— 任何先跑的用例建一个组就把它变成恒假断言。
//   · REPO-36 依赖 REPO-34 已经把 GitLab 连接配好（前缀 / TLS 开关挂在已配置的那张卡上）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { SYSTEM_MOCK_CODE_HOST_TOKEN } from '@agent-workflow/system-mocks'

import { cloneBareGitRepo, initGitRepo, repoRemoteUrl, runGit } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let daemon: DaemonHandle
const scratchDirs: string[] = []

/** 三个普通夹具仓的远端 URL（REPO-28 起按需导入）。 */
let alphaUrl = ''
let bravoUrl = ''
let charlieUrl = ''
/** 已导入镜像的 id（编辑器的「附加缓存仓」下拉按 id 选）。 */
let alphaRepoId = ''
let bravoRepoId = ''

/** REPO-27 建的三个组，后续几条用例复用它们做对照。 */
let childGroupId = ''
let childGroupName = ''
let parentGroupId = ''
let parentGroupName = ''
let soloGroupName = ''

const DESC_ANCHOR = 'rfc319-desc-anchor'
const RELEASE_REF = 'release/rfc319'
const RELEASE_MARK = 'release channel\n'
const MAIN_MARK = 'main channel\n'

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

// 本文件**不注入任何 `page.route`**（全部走真实后端）。这条兜底照协议保留：将来有人
// 往这里加注入时，不必再想起 `docs/dev-gotchas.md` 里那两把锁。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// 通用夹具工具
// ---------------------------------------------------------------------------

interface ApiResult<T> {
  status: number
  code: string
  message: string
  body: T
}

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

/** 不预判成败的调用：拒绝分支要断言 status + code + message，所以三样一起带回。 */
async function call<T = unknown>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await req(path, init)
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text.length === 0 ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  const record = (
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  ) as { code?: unknown; message?: unknown }
  return {
    status: res.status,
    code: typeof record.code === 'string' ? record.code : '',
    message: typeof record.message === 'string' ? record.message : text,
    body: parsed as T,
  }
}

async function primeAuth(page: Page): Promise<void> {
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
    { baseUrl: daemon.baseUrl, sessionToken: daemon.token },
  )
}

async function openGroupsTab(page: Page): Promise<void> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/repos?tab=groups`)
  await expect(
    page.getByTestId('repos-tab-groups'),
    '/repos 的「仓库组」页签没有被 URL 选中 ⇒ 后面所有断言都只是在断言另一个页签',
  ).toHaveAttribute('aria-selected', 'true')
}

// --- git 夹具 ---------------------------------------------------------------

/** 建一个可克隆的裸仓，返回它经 system-mock smart-HTTP 网关的远端 URL。 */
function fixtureRemote(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `aw-rfc319-grp-${label}-`))
  scratchDirs.push(root)
  const working = join(root, 'src')
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'README.md'), `# rfc-319 ${label}\n`, 'utf-8')
  initGitRepo(working, { message: `rfc-319 ${label}` })
  const bare = join(root, `${label}.git`)
  cloneBareGitRepo(working, bare)
  // 一律用真远端：产品把 `file://` 判为「导得进来但启动 / 刷新都会被拒」，拿它造夹具
  // 等于让整条用户路径跑在一个产品自己判为半残的形态上（同 rfc319-repos-list-and-import）。
  return repoRemoteUrl(bare)
}

/**
 * REPO-30 的双分支夹具：`main` 与 `release/rfc319` 各有一份 `pkg/lib.txt`，内容不同；
 * 两个分支都有 `docs/`。
 *
 * 两个标记各锁一件事：`pkg/lib.txt` 的内容锁 **ref**（掉了就读到 main 的那份），
 * `docs/` 在不在锁 **subdir**（掉了整棵树都会被检出来）。
 */
function twoBranchRemote(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `aw-rfc319-grp-${label}-`))
  scratchDirs.push(root)
  const working = join(root, 'src')
  mkdirSync(join(working, 'pkg'), { recursive: true })
  mkdirSync(join(working, 'docs'), { recursive: true })
  writeFileSync(join(working, 'README.md'), `# rfc-319 ${label}\n`, 'utf-8')
  writeFileSync(join(working, 'docs', 'shared.md'), '# shared\n', 'utf-8')
  writeFileSync(join(working, 'pkg', 'lib.txt'), MAIN_MARK, 'utf-8')
  initGitRepo(working, { message: `rfc-319 ${label} main` })

  runGit(['checkout', '-q', '-b', RELEASE_REF], working)
  writeFileSync(join(working, 'pkg', 'lib.txt'), RELEASE_MARK, 'utf-8')
  writeFileSync(join(working, 'docs', 'release-note.md'), '# release\n', 'utf-8')
  runGit(['add', '.'], working)
  runGit(
    ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', 'rfc-319 release branch'],
    working,
  )
  runGit(['checkout', '-q', 'main'], working)

  const bare = join(root, `${label}.git`)
  cloneBareGitRepo(working, bare)
  return repoRemoteUrl(bare)
}

interface CachedRepoLite {
  id: string
  urlRedacted: string
}

async function listMirrors(): Promise<CachedRepoLite[]> {
  const body = await jsonOf<{ items: CachedRepoLite[] }>(
    await req('/api/cached-repos'),
    'list cached repos',
  )
  return body.items
}

/** 批量导入并等它收敛——组编辑器的「缓存仓」下拉读的就是这张表。 */
async function importMirrors(urls: readonly string[]): Promise<void> {
  const started = await jsonOf<{ batchId: string; state: string }>(
    await req('/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    }),
    'start batch import',
  )
  await expect
    .poll(
      async () => {
        const snapshot = await jsonOf<{
          state: string
          rows: Array<{ status: string; message: string | null }>
        }>(await req(`/api/cached-repos/imports/${started.batchId}`), 'batch snapshot')
        if (snapshot.state !== 'completed') return 'pending'
        return snapshot.rows.every((row) => row.status === 'done')
          ? 'done'
          : JSON.stringify(snapshot.rows)
      },
      { message: '夹具镜像没有全部导入成功 ⇒ 后面的组装配跑在一张空的缓存仓表上' },
    )
    .toBe('done')
}

async function mirrorIdFor(url: string): Promise<string> {
  const items = await listMirrors()
  const hit = items.find((row) => row.urlRedacted === url)
  expect(
    hit,
    `镜像 ${url} 不在缓存仓列表里：${JSON.stringify(items.map((row) => row.urlRedacted))}`,
  ).toBeTruthy()
  return hit!.id
}

// --- 仓库组夹具 -------------------------------------------------------------

interface RepoGroupNodeWire {
  path: string
  attachment:
    | null
    | {
        kind: 'repo'
        cachedRepoId: string
        repoUrlRedacted: string
        ref: string
        subdir: string
        readonly: boolean
      }
    | { kind: 'group'; childGroupId: string; childGroupName: string; readonly: boolean }
}

interface RepoGroupWire {
  id: string
  name: string
  description: string
  version: number
  nodes: RepoGroupNodeWire[]
  flatRepoCount: number
}

type NodeInput = { path: string; attachment?: unknown }

async function createGroup(
  name: string,
  nodes: readonly NodeInput[],
  description = '',
): Promise<RepoGroupWire> {
  return jsonOf<RepoGroupWire>(
    await req('/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({ name, description, nodes }),
    }),
    `create repo group ${name}`,
  )
}

async function getGroup(id: string): Promise<RepoGroupWire> {
  return jsonOf<RepoGroupWire>(await req(`/api/repo-groups/${id}`), `get repo group ${id}`)
}

async function listGroups(): Promise<RepoGroupWire[]> {
  const body = await jsonOf<{ items: RepoGroupWire[] }>(
    await req('/api/repo-groups'),
    'list repo groups',
  )
  return body.items
}

function nodeAt(group: RepoGroupWire, path: string): RepoGroupNodeWire {
  const hit = group.nodes.find((node) => node.path === path)
  expect(
    hit,
    `组 ${group.name} 里没有节点 '${path === '' ? '<root>' : path}'：${JSON.stringify(
      group.nodes.map((node) => node.path),
    )}`,
  ).toBeTruthy()
  return hit!
}

/** 编辑器里某个节点行的定位器（root 的 testid 后缀写 `.`）。 */
function treeNode(page: Page, path: string): Locator {
  return page.getByTestId(`repo-group-node-${path === '' ? '.' : path}`)
}

function nodeCheckbox(page: Page, path: string): Locator {
  return page.getByRole('checkbox', { name: `Select node ${path}`, exact: true })
}

const editorDialog = (page: Page): Locator => page.getByTestId('repo-group-editor-dialog')

// ===========================================================================
// REPO-27 —— 仓库组页签的四种状态（首次空态必须第一个跑）
// ===========================================================================

test('RFC-319 REPO-27: 仓库组页签的空态 / 名称与描述搜索 / 无匹配 / 展开行看展平布局，四种状态各说各的话 @nightly', async ({
  page,
}) => {
  await openGroupsTab(page)

  // --- ① 首次空态 -----------------------------------------------------------
  await expect(
    page.getByTestId('repo-groups-empty'),
    '一个组都没有时不给空态 ⇒ 用户面对一张没有任何提示的空表，不知道仓库组是干什么的',
  ).toBeVisible()
  await expect(
    page.getByTestId('repo-groups-empty'),
    '空态没说清「仓库组是什么、为什么需要它」⇒ 引导退化成一句无信息量的「暂无数据」',
  ).toContainText('No repo groups yet')
  await expect(
    page.getByTestId('repo-groups-empty').getByTestId('repo-groups-new'),
    '首次空态里没有新建入口 ⇒ 用户看得懂「还没有组」，却找不到建第一个的地方',
  ).toBeVisible()
  await expect(
    page.getByTestId('repo-groups-table'),
    '零行时仍渲染表格骨架 ⇒ 用户看到的是一张「疑似加载失败」的空表，而不是引导',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('repo-groups-no-matches'),
    '首次空态被渲染成「无匹配」⇒ 用户以为自己的组被某个筛选藏起来了，去清筛选而不是去新建',
  ).toHaveCount(0)

  // --- 夹具：两个普通仓 + 一个「父组套子组」的两层结构 -----------------------
  alphaUrl = fixtureRemote('alpha')
  bravoUrl = fixtureRemote('bravo')
  charlieUrl = fixtureRemote('charlie')
  // charlie **刻意不导入**：REPO-28 要证明粘贴 URL 会现场导入它。
  await importMirrors([alphaUrl, bravoUrl])
  alphaRepoId = await mirrorIdFor(alphaUrl)
  bravoRepoId = await mirrorIdFor(bravoUrl)

  const stamp = String(Date.now() % 1_000_000)
  childGroupName = `rfc319-child-${stamp}`
  parentGroupName = `rfc319-parent-${stamp}`
  soloGroupName = `rfc319-solo-${stamp}`

  const child = await createGroup(childGroupName, [
    { path: '', attachment: null },
    { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
  ])
  childGroupId = child.id
  const parent = await createGroup(parentGroupName, [
    { path: '', attachment: null },
    { path: 'vendor', attachment: { kind: 'group', childGroupId: child.id } },
  ])
  parentGroupId = parent.id
  await createGroup(
    soloGroupName,
    [
      { path: '', attachment: null },
      { path: 'only', attachment: { kind: 'repo', cachedRepoId: bravoRepoId } },
    ],
    `${DESC_ANCHOR} 只在描述里出现`,
  )

  await page.reload()
  await expect(
    page.getByTestId('repo-groups-table'),
    '建了三个组之后表格还没渲染 ⇒ 列表读面是断的，用户刚建完就看不见自己的组',
  ).toBeVisible()
  await expect(
    page.getByTestId('repo-groups-empty'),
    '有组之后还挂着首次空态 ⇒ 用户以为新建没生效，会一遍遍重建',
  ).toHaveCount(0)

  // 「Repos」列是展平之后的数字：父组自己一个仓都没挂，1 完全来自子组。
  await expect(
    page.getByTestId(`repo-group-row-${parentGroupId}`).locator('td').nth(1),
    '父组的仓数不是展平结果 ⇒ 用户在列表上看到 0，却会在启动时莫名其妙多出一个仓',
  ).toHaveText('1')

  // --- ② 搜索：名称 ---------------------------------------------------------
  const search = page.getByTestId('repo-groups-search')
  await search.fill(soloGroupName)
  await expect(
    page.getByTestId('repo-groups-table').locator('tbody tr'),
    '按名称搜索没有收窄结果 ⇒ 搜索框成了摆设，组多起来后这一页无法使用',
  ).toHaveCount(1)
  await expect(
    page.getByTestId(`repo-group-row-${parentGroupId}`),
    '不匹配的组还留在表里 ⇒ 同上，过滤没接上',
  ).toHaveCount(0)

  // --- ③ 搜索：描述（名称完全不含这个词）------------------------------------
  await search.fill(DESC_ANCHOR)
  await expect(
    page.getByTestId('repo-groups-table').locator('tbody tr'),
    '搜索只看名称不看描述 ⇒ 用户按「这个组是干嘛的」去搜永远搜不到，' +
      '而描述正是他给自己留的线索',
  ).toHaveCount(1)
  await expect(
    page.getByRole('row', { name: new RegExp(soloGroupName) }),
    '描述命中的那一行没有出现 ⇒ 同上',
  ).toBeVisible()

  // --- ④ 无匹配（≠ 首次空态）-----------------------------------------------
  await search.fill('rfc319-no-such-repo-group')
  await expect(
    page.getByTestId('repo-groups-no-matches'),
    '搜不到时没有任何空态 ⇒ 用户面对一张空表，分不清是搜没中还是加载失败',
  ).toBeVisible()
  await expect(
    page.getByTestId('repo-groups-no-matches'),
    '「无匹配」没说清是当前搜索造成的 ⇒ 用户会以为自己的组被删了',
  ).toContainText('No repo groups match.')
  await expect(
    page.getByTestId('repo-groups-empty'),
    '无匹配被渲染成首次空态 ⇒ 界面告诉用户「一个组都还没有」，而他明明刚建了三个',
  ).toHaveCount(0)
  await page
    .getByTestId('repo-groups-no-matches')
    .getByRole('button', { name: 'Clear filters' })
    .click()
  await expect(
    search,
    '「清除筛选」没把搜索框一并清空 ⇒ 结果回来了但输入框还留着旧词，下一次输入接在后面',
  ).toHaveValue('')
  await expect(
    page.getByTestId(`repo-group-row-${parentGroupId}`),
    '「清除筛选」点了没把全量放回来 ⇒ 用户唯一的退路是刷新整页',
  ).toBeVisible()

  // --- ⑤ 展开行 → 展平布局 --------------------------------------------------
  const expandButton = page.getByTestId(`repo-group-expand-${parentGroupId}`)
  await expect(
    expandButton,
    '展开按钮初始就是展开态 ⇒ 折叠/展开的可及性状态是假的',
  ).toHaveAttribute('aria-expanded', 'false')
  await expandButton.click()
  await expect(
    expandButton,
    '点了展开按钮 aria-expanded 没有翻 ⇒ 读屏用户不知道自己展开了什么',
  ).toHaveAttribute('aria-expanded', 'true')

  const layoutPrefix = `repo-group-layout-${parentGroupId}`
  await expect(
    page.getByTestId(`${layoutPrefix}-row-vendor/lib`),
    '子组里的仓没有出现在父组的展平布局里 ⇒ 用户看不出这个组实际会给他哪些仓，' +
      '而这是启动前唯一的核对面',
  ).toBeVisible()
  await expect(
    page.getByTestId(`${layoutPrefix}-row-vendor/lib`),
    '展平行没有回显仓的远端 URL ⇒ 一屏挂载点长得都一样，用户分不出哪个是哪个仓',
  ).toContainText(alphaUrl)
  await expect(
    page.getByTestId(`${layoutPrefix}-row-vendor/lib`),
    '展平行没有给出来源链 ⇒ 用户看到一个自己没挂过的仓，不知道它是从哪个子组继承来的',
  ).toContainText(`via ${parentGroupName} › ${childGroupName}`)
  await expect(
    page.getByTestId(`${layoutPrefix}-row-vendor`),
    '纯目录节点在展平里被吞掉 ⇒ 布局树少一层，用户以为仓直接挂在根上',
  ).toBeVisible()
})

// ===========================================================================
// REPO-28 —— 批量加仓 / 粘贴 URL 现场导入
// ===========================================================================

test('RFC-319 REPO-28: 编辑器里批量勾选缓存仓、粘贴 URL 现场导入，非法行按行号点名、重复行只算一次 @nightly', async ({
  page,
}) => {
  await openGroupsTab(page)

  // charlie 现在还不是平台里的镜像——这条前置成立，「现场导入」才有东西可证。
  const before = await listMirrors()
  expect(
    before.some((row) => row.urlRedacted === charlieUrl),
    '粘贴前 charlie 就已经在缓存仓表里 ⇒ 后面的「现场导入」断言退化成恒真',
  ).toBe(false)

  const bulkGroupName = `rfc319-bulk-${Date.now() % 1_000_000}`
  await page.getByTestId('repo-groups-new').click()
  await expect(editorDialog(page), '新建按钮没打开编辑器 ⇒ 用户建不了第二个组').toBeVisible()
  await page.getByTestId('repo-group-name').fill(bulkGroupName)

  // --- ① 批量勾选已缓存的仓 -------------------------------------------------
  await page.getByTestId('repo-group-bulk-repos').click()
  const bulk = page.getByTestId('repo-group-bulk-dialog')
  await expect(bulk, '「批量加仓」没打开弹窗 ⇒ 组装一个多仓组只能一个一个手点').toBeVisible()
  const bulkSearch = page.getByTestId('repo-group-bulk-search')
  await bulkSearch.fill(alphaUrl)
  await expect(
    page.getByTestId('repo-group-bulk-repo-list').locator('label'),
    '弹窗里的搜索没有收窄候选 ⇒ 十万仓规模下这个列表不可用',
  ).toHaveCount(1)
  await page.getByTestId('repo-group-bulk-repo-list').locator('label').first().click()
  await bulkSearch.fill(bravoUrl)
  await page.getByTestId('repo-group-bulk-repo-list').locator('label').first().click()
  await expect(
    page.getByTestId('repo-group-bulk-submit'),
    '提交按钮没回显已选数量 ⇒ 用户搜了两轮之后不知道自己一共勾了几个',
  ).toContainText('Add 2 selected')
  await page.getByTestId('repo-group-bulk-submit').click()
  await expect(bulk, '提交后弹窗没关 ⇒ 用户看不到自己刚加进树里的节点').toHaveCount(0)

  await expect(
    treeNode(page, 'alpha'),
    '批量勾选的第一个仓没有落成节点 ⇒ 「批量」只是打开了一个弹窗，什么都没加',
  ).toBeVisible()
  await expect(treeNode(page, 'bravo'), '批量勾选的第二个仓没有落成节点 ⇒ 同上').toBeVisible()
  await expect(
    editorDialog(page),
    '布局摘要没有跟着更新 ⇒ 用户不知道自己这棵树最终会展平出几个仓',
  ).toContainText('3 directory nodes · 2 repos')

  // --- ② 粘贴 URL：非法行按行号点名 ----------------------------------------
  await page.getByTestId('repo-group-paste-urls').click()
  const urls = page.getByTestId('repo-group-bulk-urls')
  await urls.fill([charlieUrl, charlieUrl, 'not-a-git-url'].join('\n'))
  await expect(
    page.getByTestId('repo-group-paste-errors'),
    '粘进去一行非法 URL 没有任何提示 ⇒ 用户以为整批都会导入，直到启动任务才发现少一个仓',
  ).toContainText('Lines 3 are not supported Git URLs')
  await expect(
    page.getByTestId('repo-group-bulk-submit'),
    '有非法行时提交按钮仍可点 ⇒ 一行打错就把整批推给服务端去 400，用户得自己二分',
  ).toBeDisabled()

  // --- ③ 重复行只算一次 -----------------------------------------------------
  await urls.fill([charlieUrl, charlieUrl].join('\n'))
  await expect(
    page.getByTestId('repo-group-paste-errors'),
    '删掉非法行之后错误提示还挂着 ⇒ 用户改对了也不知道自己改对了',
  ).toHaveCount(0)
  await expect(
    bulk,
    '重复粘贴的行没有被点明会被忽略 ⇒ 用户以为自己加了两个仓，实际只有一个',
  ).toContainText('1 duplicate URL(s) will be ignored')
  await page.getByTestId('repo-group-bulk-submit').click()

  await expect(
    treeNode(page, 'charlie'),
    '粘贴的 URL 没有落成节点 ⇒ 「粘贴 URL」这条路径整条不通',
  ).toBeVisible()
  await expect(
    treeNode(page, 'charlie'),
    '待导入的节点没有回显它自己的 URL ⇒ 用户无从确认自己粘的是不是这一个',
  ).toContainText(charlieUrl)
  await expect(
    editorDialog(page),
    '没有告知「保存时会现场导入几个仓」⇒ 保存要多花一次 clone 的时间，用户以为界面卡住了',
  ).toContainText('1 repo(s) given by URL will be imported on save')

  // --- ④ 保存 → 现场导入真的发生了 -----------------------------------------
  await expect(page.getByTestId('repo-group-save')).toBeEnabled()
  await page.getByTestId('repo-group-save').click()
  await expect(editorDialog(page), '保存后编辑器没关 ⇒ 保存到底成没成用户看不出来').toHaveCount(0)
  await expect(
    page.getByRole('row', { name: new RegExp(bulkGroupName) }),
    '保存成功但列表里没有这一行 ⇒ 用户刚建完就找不到它',
  ).toBeVisible()

  const saved = (await listGroups()).find((group) => group.name === bulkGroupName)
  expect(saved, '新组没有落库 ⇒ 界面关掉弹窗只是前端的乐观假象').toBeTruthy()
  const charlieNode = nodeAt(saved!, 'charlie')
  expect(
    charlieNode.attachment?.kind === 'repo' ? charlieNode.attachment.cachedRepoId : '',
    '粘贴 URL 的节点保存后没有拿到 cachedRepoId ⇒ 现场导入没跑，这个节点是空挂的',
  ).not.toBe('')
  expect(
    charlieNode.attachment?.kind === 'repo' ? charlieNode.attachment.repoUrlRedacted : '',
    '现场导入的节点回显的不是用户粘的那个仓 ⇒ 导错了仓比没导更危险',
  ).toBe(charlieUrl)

  const after = await listMirrors()
  expect(
    after.some((row) => row.urlRedacted === charlieUrl),
    '保存之后 charlie 仍不在缓存仓表里 ⇒ 「现场导入」只写了组定义、没真的把仓搬进平台，' +
      '启动任务时必然 404',
  ).toBe(true)
})

// ===========================================================================
// REPO-29 —— 勾选后的批量操作条
// ===========================================================================

test('RFC-319 REPO-29: 勾选仓库组节点后的批量操作条：只读 / 可写 / 摘除 / 移动到目录 / 删除子树 @nightly', async ({
  page,
}) => {
  const batchGroupName = `rfc319-batch-${Date.now() % 1_000_000}`
  const batch = await createGroup(batchGroupName, [
    { path: '', attachment: null },
    { path: 'alpha', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
    { path: 'bravo', attachment: { kind: 'repo', cachedRepoId: bravoRepoId } },
    { path: 'vendor', attachment: null },
    { path: 'vendor/deep', attachment: null },
  ])

  await openGroupsTab(page)
  await page.getByTestId(`repo-group-edit-${batch.id}`).click()
  await expect(editorDialog(page)).toBeVisible()

  const bar = page.getByTestId('repo-group-batch-bar')
  await expect(
    bar,
    '一个都没勾就已经渲染批量条 ⇒ 工具条与批量条同时在场，用户不知道动作会落到谁身上',
  ).toHaveCount(0)

  // --- ① 勾选两个仓 → 标记只读 ---------------------------------------------
  await nodeCheckbox(page, 'alpha').check()
  await nodeCheckbox(page, 'bravo').check()
  await expect(
    bar,
    '勾选之后没有出现批量操作条 ⇒ 节点多起来后只能一个一个点，这一页不可用',
  ).toBeVisible()
  await expect(bar, '批量条没有回显选中数量 ⇒ 用户不知道下一次点击会作用到几个节点').toContainText(
    '2 nodes selected',
  )
  await expect(
    page.getByTestId('repo-group-bulk-repos'),
    '进入批量态之后普通工具条还在 ⇒ 两套动作并存，「加仓」与「批量改」共用同一个目标语义会打架',
  ).toHaveCount(0)

  await bar.getByRole('button', { name: 'Read-only', exact: true }).click()
  await expect(
    editorDialog(page),
    '批量标记没有给出回执 ⇒ 用户点完看不出到底改了几个，只能自己一行行数',
  ).toContainText('Updated 2 attachment(s); skipped 0 empty directory node(s)')
  await expect(
    treeNode(page, 'alpha'),
    '批量标记只读之后第一个节点没有只读徽标 ⇒ 标记没落到节点上，保存出去的还是可写',
  ).toContainText('read-only')
  await expect(treeNode(page, 'bravo'), '第二个节点没有只读徽标 ⇒ 同上').toContainText('read-only')
  await expect(
    bar,
    '批量动作执行完没有清空选中 ⇒ 用户接着点别的动作会重复作用在同一批节点上',
  ).toHaveCount(0)

  // --- ② 标记回可写 ---------------------------------------------------------
  await nodeCheckbox(page, 'alpha').check()
  await nodeCheckbox(page, 'bravo').check()
  await bar.getByRole('button', { name: 'Writable', exact: true }).click()
  await expect(
    treeNode(page, 'alpha'),
    '「可写」没有把只读标记摘掉 ⇒ 这个动作是单向的，标错了就再也改不回来',
  ).not.toContainText('read-only')
  await expect(treeNode(page, 'bravo'), '同上：第二个节点的只读没摘掉').not.toContainText(
    'read-only',
  )

  // --- ③ 纯目录节点被跳过（回执要说清跳了几个）------------------------------
  await nodeCheckbox(page, 'alpha').check()
  await nodeCheckbox(page, 'vendor').check()
  await bar.getByRole('button', { name: 'Read-only', exact: true }).click()
  await expect(
    editorDialog(page),
    '回执没有区分「改了几个挂载」与「跳过了几个纯目录」⇒ 用户以为纯目录也被标了只读，' +
      '而只读只对仓有意义',
  ).toContainText('Updated 1 attachment(s); skipped 1 empty directory node(s)')
  await expect(
    treeNode(page, 'alpha'),
    '唯一该被标只读的节点没被标上 ⇒ 跳过逻辑把它一起跳了',
  ).toContainText('read-only')

  // --- ④ 移动到目录 ---------------------------------------------------------
  await nodeCheckbox(page, 'bravo').check()
  await expect(bar).toBeVisible()
  await bar.getByRole('combobox', { name: 'Move to directory' }).click()
  await page.getByRole('option', { name: 'vendor', exact: true }).click()
  await bar.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(
    editorDialog(page),
    '移动没有给出回执 ⇒ 树一大，用户看不出自己刚刚搬了几棵子树',
  ).toContainText('Moved 1 subtree(s)')
  await expect(
    treeNode(page, 'vendor/bravo'),
    '节点没有搬到目标目录下 ⇒ 「移动到目录」是空操作，用户只能删掉重加',
  ).toBeVisible()
  await expect(
    treeNode(page, 'bravo'),
    '搬走之后原位置还留着一份 ⇒ 同一个仓被挂了两次，启动时会撞挂载点冲突',
  ).toHaveCount(0)

  // --- ⑤ 摘除挂载（保留目录）----------------------------------------------
  await nodeCheckbox(page, 'alpha').check()
  await bar.getByRole('button', { name: 'Detach', exact: true }).click()
  await expect(
    treeNode(page, 'alpha'),
    '摘除之后节点没有回到「空目录」⇒ 摘除要么没生效，要么把整个目录一起删了',
  ).toContainText('Empty directory')
  await expect(
    treeNode(page, 'alpha'),
    '摘除之后只读徽标还挂着 ⇒ 徽标脱离了它描述的挂载，读它等于读一个不存在的设置',
  ).not.toContainText('read-only')

  // --- ⑥ 删除子树要二次确认 ------------------------------------------------
  await nodeCheckbox(page, 'vendor/deep').check()
  await bar.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirm = page.getByRole('heading', { name: 'Delete directory subtree' })
  await expect(
    confirm,
    '删除子树没有二次确认 ⇒ 一次误点就把一整棵子树连同它的挂载一起抹掉',
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Delete nodes', exact: true }),
    '确认框没有给出确认按钮 ⇒ 用户被堵在一个没有出口的对话框里',
  ).toBeVisible()
  await page.getByRole('button', { name: 'Delete nodes', exact: true }).click()
  await expect(
    treeNode(page, 'vendor/deep'),
    '确认之后节点还在 ⇒ 删除动作只画了个确认框，什么都没做',
  ).toHaveCount(0)

  // --- ⑦ 保存 → 五个动作全部落库 -------------------------------------------
  await expect(page.getByTestId('repo-group-save')).toBeEnabled()
  await page.getByTestId('repo-group-save').click()
  await expect(editorDialog(page)).toHaveCount(0)

  const persisted = await getGroup(batch.id)
  expect(
    persisted.nodes.map((node) => node.path).sort(),
    '落库的目录树与界面上编辑出来的不一致 ⇒ 批量动作只改了前端状态，保存时被丢掉',
  ).toEqual(['', 'alpha', 'vendor', 'vendor/bravo'])
  expect(
    nodeAt(persisted, 'alpha').attachment,
    '被摘除的节点保存后仍带着挂载 ⇒ 摘除没进请求体',
  ).toBeNull()
  const moved = nodeAt(persisted, 'vendor/bravo').attachment
  expect(moved?.kind, '移动后的节点丢了它的仓挂载 ⇒ 移动把挂载一起弄丢了').toBe('repo')
  expect(
    moved?.kind === 'repo' ? moved.readonly : true,
    '标记回可写的节点保存后仍是只读 ⇒ 「可写」这一步没落库，agent 的改动会被静默丢弃',
  ).toBe(false)
})

// ===========================================================================
// REPO-25 —— 保存的乐观并发
// ===========================================================================

test('RFC-319 REPO-25: 别人先保存过一次，我的仓库组保存被 409 挡下、草稿不丢、对方的改动不被覆盖 @nightly', async ({
  page,
}) => {
  const occName = `rfc319-occ-${Date.now() % 1_000_000}`
  const group = await createGroup(occName, [
    { path: '', attachment: null },
    { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
  ])
  expect(group.version, '新建的组不是 version 1 ⇒ 下面对「过期版本」的构造无从谈起').toBe(1)

  // ① 我先把编辑器打开——此刻它抓住的是 version 1。
  await openGroupsTab(page)
  const putBodies: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'PUT') return
    if (new URL(request.url()).pathname !== `/api/repo-groups/${group.id}`) return
    putBodies.push(request.postData() ?? '')
  })
  await page.getByTestId(`repo-group-edit-${group.id}`).click()
  await expect(editorDialog(page)).toBeVisible()
  await expect(page.getByTestId('repo-group-name')).toHaveValue(occName)

  // ② 另一个人在另一个标签页里改同一个组并保存 —— 这是**真**的把版本推到 2，
  //    而不是我手搓一个过期的 expectedVersion（那样锁不住 UI 有没有正确携带版本）。
  const other = await page.context().newPage()
  await primeAuth(other)
  await other.goto(`${daemon.baseUrl}/repos?tab=groups`)
  await other.getByTestId(`repo-group-edit-${group.id}`).click()
  await expect(other.getByTestId('repo-group-editor-dialog')).toBeVisible()
  await other.getByTestId('repo-group-add-description').click()
  await other.getByTestId('repo-group-desc').fill('saved by the other tab')
  await other.getByTestId('repo-group-save').click()
  await expect(
    other.getByTestId('repo-group-editor-dialog'),
    '另一个标签页的保存没成功 ⇒ 这条用例的前置（版本已经前进）不成立',
  ).toHaveCount(0)
  await other.close()

  const bumped = await getGroup(group.id)
  expect(bumped.version, '别人保存之后版本没有前进 ⇒ OCC 栅栏没有可比的东西，形同虚设').toBe(2)

  // ③ 我在自己那份陈旧的编辑器里保存。
  const conflictResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/repo-groups/${group.id}`,
  )
  await page.getByTestId('repo-group-name').fill(`${occName}-mine`)
  await page.getByTestId('repo-group-save').click()
  const response = await conflictResponse

  expect(
    response.status(),
    '陈旧的编辑器保存成功了 ⇒ 后写覆盖先写：别人刚存的整棵目录树被静默替换掉',
  ).toBe(409)
  expect(
    putBodies.map((body) => (JSON.parse(body) as { expectedVersion?: number }).expectedVersion),
    '保存请求没有携带打开编辑器时的版本 ⇒ 服务端那道 409 永远不会触发（RFC-248 实现门 P1 的原形）',
  ).toEqual([1])

  await expect(
    editorDialog(page),
    '撞了并发冲突之后编辑器直接关了 ⇒ 用户刚打的字连同冲突提示一起消失',
  ).toBeVisible()
  await expect(
    editorDialog(page),
    '冲突没有被呈现成可读提示 ⇒ 用户只看到「保存没反应」，会一直重复点保存',
  ).toContainText('The resource changed since this operation started')
  await expect(
    editorDialog(page).locator('.error-details__raw'),
    '冲突提示里没有具体的版本对照 ⇒ 排障时说不清是谁的版本旧了',
  ).toContainText('expected version 1, found 2')
  await expect(
    page.getByTestId('repo-group-name'),
    '冲突之后草稿被清掉 ⇒ 用户白打一遍，还得先去问对方改了什么',
  ).toHaveValue(`${occName}-mine`)

  // ④ 服务端仍然是对方那一版：被拒的写**一个字节都没落**。
  const final = await getGroup(group.id)
  expect(final.name, '被 409 拒掉的保存仍然改了名字 ⇒ 栅栏拦了响应却没拦住写入').toBe(occName)
  expect(final.description, '对方的描述被我这次失败的保存冲掉了 ⇒ 同上').toBe(
    'saved by the other tab',
  )
  expect(final.version, '一次被拒的保存把版本推进了 ⇒ 下一个人的栅栏也会跟着错').toBe(2)
})

// ===========================================================================
// REPO-26 —— 五类校验拒绝
// ===========================================================================

test('RFC-319 REPO-26: 仓库组定义的五类校验拒绝各有自己可辨的原因与状态码 @nightly', async ({
  page,
}) => {
  const stamp = String(Date.now() % 1_000_000)

  // --- ① 自引用成环 ---------------------------------------------------------
  const selfName = `rfc319-cycle-self-${stamp}`
  const selfGroup = await createGroup(selfName, [
    { path: '', attachment: null },
    { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
  ])
  const selfCycle = await call(`/api/repo-groups/${selfGroup.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: selfName,
      description: '',
      nodes: [
        { path: '', attachment: null },
        { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
        { path: 'me', attachment: { kind: 'group', childGroupId: selfGroup.id } },
      ],
    }),
  })
  expect(selfCycle.status, '组把自己挂进自己里被接受了 ⇒ 展平递归会当场炸开').toBe(422)
  expect(selfCycle.code, '自引用没有自己的错误码 ⇒ 用户拿到一句泛化的「保存失败」').toBe(
    'repo-group-cycle',
  )
  expect(
    selfCycle.message,
    '自引用的原因没有写清 ⇒ 用户不知道是哪一个节点把自己挂了回去',
  ).toContain('cannot reference itself')

  // --- ①b 两个组互相引用（同一码、不同现场）--------------------------------
  const ringA = await createGroup(`rfc319-ring-a-${stamp}`, [
    { path: '', attachment: null },
    { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
  ])
  const ringB = await createGroup(`rfc319-ring-b-${stamp}`, [
    { path: '', attachment: null },
    { path: 'a', attachment: { kind: 'group', childGroupId: ringA.id } },
  ])
  const mutual = await call(`/api/repo-groups/${ringA.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: ringA.name,
      description: '',
      nodes: [
        { path: '', attachment: null },
        { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
        { path: 'b', attachment: { kind: 'group', childGroupId: ringB.id } },
      ],
    }),
  })
  expect(mutual.status, 'A→B→A 的环被接受了 ⇒ 单看「不是自己」挡不住两步成环').toBe(422)
  expect(mutual.code, '互相引用成环没有走成环这条码 ⇒ 与别的失败混成一堆').toBe('repo-group-cycle')
  expect(mutual.message, '成环的现场没有回显环上的组 ⇒ 用户不知道该去解开哪一条边').toContain(
    'repo group cycle:',
  )
  const ringAAfter = await getGroup(ringA.id)
  expect(
    ringAAfter.nodes.map((node) => node.path).sort(),
    '成环的保存被拒了，节点却已经被换掉 ⇒ 事务没回滚，组被改成一个半截状态',
  ).toEqual(['', 'lib'])
  expect(ringAAfter.version, '被拒的保存仍然推进了版本 ⇒ 同上，事务没回滚').toBe(1)

  // --- ② 挂载点冲突：两个仓抢同一个目录 -------------------------------------
  const clash = await call('/api/repo-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-clash-${stamp}`,
      description: '',
      nodes: [
        // 子组会把它自己的 `lib`（挂着 alpha）展平到根前缀下，
        // 这里再往同一个 `lib` 上挂 bravo。
        { path: '', attachment: { kind: 'group', childGroupId: childGroupId } },
        { path: 'lib', attachment: { kind: 'repo', cachedRepoId: bravoRepoId } },
      ],
    }),
  })
  expect(clash.status, '两个仓挂到同一个目录被接受了 ⇒ 启动时后一个 worktree 会盖掉前一个').toBe(
    422,
  )
  expect(clash.code, '挂载点冲突没有自己的错误码 ⇒ 与成环、超深度混成同一句话').toBe(
    'repo-group-attachment-conflict',
  )
  expect(clash.message, '冲突没有点名是哪个目录 ⇒ 树一大用户根本找不到冲突点').toContain(
    "multiple repositories attach to directory 'lib'",
  )

  // --- ②b 同一份定义里两个节点路径大小写撞车 --------------------------------
  const dupPath = await call('/api/repo-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-dup-path-${stamp}`,
      description: '',
      nodes: [
        { path: '', attachment: null },
        { path: 'Vendor', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
        { path: 'vendor', attachment: { kind: 'repo', cachedRepoId: bravoRepoId } },
      ],
    }),
  })
  expect(
    dupPath.status,
    '只在大小写上不同的两个挂载点被接受了 ⇒ macOS 上它们是同一个目录，第二个 worktree 直接 fatal',
  ).toBe(422)
  expect(dupPath.code, '路径撞车没有自己的错误码 ⇒ 与挂载点冲突混成一句').toBe(
    'mount-path-duplicate',
  )
  expect(
    dupPath.message,
    '没有说清是大小写折叠之后才撞的 ⇒ 用户盯着两个"不同"的名字百思不解',
  ).toContain('collide case-insensitively')

  // --- ③ 超深度：第 6 层嵌套被拒 -------------------------------------------
  // MAX_GROUP_DEPTH = 5，所以「根组 + 5 层子组」是上限，再套一层必须拒。
  let deepest = await createGroup(`rfc319-deep-6-${stamp}`, [
    { path: '', attachment: null },
    { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
  ])
  for (let level = 5; level >= 1; level -= 1) {
    deepest = await createGroup(`rfc319-deep-${level}-${stamp}`, [
      { path: '', attachment: null },
      { path: 'inner', attachment: { kind: 'group', childGroupId: deepest.id } },
    ])
  }
  const tooDeep = await call('/api/repo-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-deep-0-${stamp}`,
      description: '',
      nodes: [
        { path: '', attachment: null },
        { path: 'inner', attachment: { kind: 'group', childGroupId: deepest.id } },
      ],
    }),
  })
  expect(tooDeep.status, '超过嵌套上限的组被接受了 ⇒ 展平在启动时才炸，而那时任务已经开跑').toBe(
    422,
  )
  expect(tooDeep.code, '超深度没有自己的错误码 ⇒ 用户不知道该去拆哪一层').toBe(
    'repo-group-depth-exceeded',
  )
  expect(tooDeep.message, '超深度没有告知上限是多少 ⇒ 用户只能一层层试').toContain(
    'exceeds 5 levels',
  )

  // --- ④ 非法 subdir --------------------------------------------------------
  for (const [subdir, code] of [
    ['../secrets', 'mount-path-traversal'],
    ['/etc/shadow', 'mount-path-absolute'],
  ] as const) {
    const badSubdir = await call('/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-subdir-${code}-${stamp}`,
        description: '',
        nodes: [
          { path: '', attachment: null },
          { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId, subdir } },
        ],
      }),
    })
    expect(
      badSubdir.status,
      `subdir '${subdir}' 被接受了 ⇒ 稀疏检出会指到仓库之外，这是一条路径逃逸`,
    ).toBe(422)
    expect(badSubdir.code, `subdir '${subdir}' 的拒绝理由没有细分 ⇒ 用户不知道该怎么改`).toBe(code)
    expect(
      badSubdir.message,
      '错误没有点明是 subdir 这个字段 ⇒ 同一个组里还有挂载路径，用户会去改错地方',
    ).toContain('subdir: ')
  }

  // --- ⑤ 重名 409（大小写不敏感）------------------------------------------
  const dupName = await call('/api/repo-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: soloGroupName.toUpperCase(),
      description: '',
      nodes: [
        { path: '', attachment: null },
        { path: 'lib', attachment: { kind: 'repo', cachedRepoId: alphaRepoId } },
      ],
    }),
  })
  expect(
    dupName.status,
    '只在大小写上不同的重名被接受了 ⇒ 启动向导的下拉里出现两个看起来一样的组，用户只能靠猜',
  ).toBe(409)
  expect(dupName.code, '重名没有走冲突码 ⇒ 前端无法把它与校验类错误区分开').toBe(
    'repo-group-name-conflict',
  )
  expect(dupName.message, '重名没有回显撞上的是哪个名字 ⇒ 用户不知道该改成什么').toContain(
    'already exists',
  )

  // --- ⑥ 界面接线：拒绝要落到用户眼前，而不是白屏 --------------------------
  await openGroupsTab(page)
  await page.getByTestId(`repo-group-edit-${selfGroup.id}`).click()
  await page.getByTestId('repo-group-node-select-lib').click()
  const settings = page.getByTestId('repo-group-node-settings-lib')
  await settings.getByLabel('Repo subdirectory', { exact: true }).fill('../escape')
  await expect(page.getByTestId('repo-group-save')).toBeEnabled()
  await page.getByTestId('repo-group-save').click()
  await expect(
    editorDialog(page),
    '服务端拒绝之后编辑器直接关了 ⇒ 用户以为存上了，实际什么都没落库',
  ).toBeVisible()
  await expect(
    editorDialog(page).locator('.error-box'),
    '服务端的拒绝没有呈现在界面上 ⇒ 用户点了保存看不到任何反应，只能反复点',
  ).toBeVisible()
  // 这里**刻意不断言横幅标题**：`mount-path-*` 这一族码不在 `i18n/errors.ts` 的任何
  // 域前缀里（`repo-` / `git-` / `path-` 都不匹配 `mount-path-`），于是它落到 `misc`，
  // 标题渲染成泛化的「Request failed」——而同一个功能的 `repo-group-*` 拒绝落在 `repo`
  // 域、渲染成「Repository action failed」。照账本/直觉写「Repository action failed」
  // 会得到一条永远红的用例（首跑实撞）。真正扛事的判据是下面这条：**服务端给出的
  // 具体原因必须原样到得了用户眼前**。
  await expect(
    editorDialog(page).locator('.error-details__raw'),
    '界面吞掉了服务端给出的具体原因 ⇒ 用户知道失败了，却不知道是 subdir 写错了',
  ).toContainText("subdir: mount path may not contain '.' or '..' segments")
  await page.getByTestId('repo-group-cancel').click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(editorDialog(page)).toHaveCount(0)
  expect(
    (await getGroup(selfGroup.id)).nodes.every(
      (node) => node.attachment?.kind !== 'repo' || node.attachment.subdir === '',
    ),
    '被拒的 subdir 还是落库了 ⇒ 界面上的错误只是装饰，写入实际发生了',
  ).toBe(true)
})

// ===========================================================================
// REPO-30 —— ref / subdir / 只读，直到任务工作树
// ===========================================================================

interface TaskRepoWire {
  repoIndex: number
  mountPath: string
  baseBranch: string
  subdir: string
  readonly: boolean
  worktreePath: string
  readonlyDirtyCount: number | null
}

interface TaskWire {
  id: string
  status: string
  repoCount: number
  worktreePath: string
  repos: TaskRepoWire[]
}

async function seedLinearWorkflow(suffix: string): Promise<string> {
  const agentName = `rfc319-grp-agent-${suffix}`
  const agent = await jsonOf<{ id: string }>(
    await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: agentName,
        description: 'repo-group worktree e2e stub',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    }),
    'seed agent',
  )
  const workflow = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-grp-workflow-${suffix}`,
        description: 'repo-group worktree e2e workflow',
        definition: {
          $schema_version: 2,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'agent_1',
              kind: 'agent-single',
              agentId: agent.id,
              agentName,
              promptTemplate: '{{topic}}',
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
    'seed workflow',
  )
  return workflow.id
}

/**
 * 等仓库投影就绪。
 *
 * RFC-287 G7 之后任务行先以占位投影落库、仓库准备随后推进，所以启动后立刻读会看到
 * 空的 `repos`——按可观察条件等，不用固定 sleep。
 */
async function readTask(taskId: string): Promise<TaskWire> {
  return jsonOf<TaskWire>(await req(`/api/tasks/${taskId}`), 'read task')
}

async function waitTaskRepos(taskId: string, expected: number): Promise<TaskWire> {
  await expect
    .poll(
      async () => {
        const task = await readTask(taskId)
        if (['failed', 'canceled'].includes(task.status)) return `ended:${task.status}`
        return task.repos.length === expected && task.worktreePath !== '' ? 'ready' : 'pending'
      },
      {
        message: `任务 ${taskId} 的仓库投影没有就绪 ⇒ 仓库组的物化在启动阶段就失败了`,
        timeout: 90_000,
      },
    )
    .toBe('ready')
  return readTask(taskId)
}

async function waitTaskTerminal(taskId: string): Promise<TaskWire> {
  await expect
    .poll(async () => (await readTask(taskId)).status, {
      message: `任务 ${taskId} 没有走到终态 ⇒ 收尾里的只读检查根本没机会跑`,
      timeout: 120_000,
    })
    .toMatch(/^(done|failed|canceled)$/)
  return readTask(taskId)
}

test('RFC-319 REPO-30: 组内单仓的 ref / subdir / 只读在界面上设完之后，一路落到任务工作树里 @nightly', async ({
  page,
}) => {
  const stamp = String(Date.now() % 1_000_000)
  const sdkUrl = twoBranchRemote('sdk')
  const appUrl = fixtureRemote('app')
  await importMirrors([sdkUrl, appUrl])
  const sdkRepoId = await mirrorIdFor(sdkUrl)
  const appRepoId = await mirrorIdFor(appUrl)

  // 先建一个**三个开关都没设**的组，再在界面上把它们逐个打开——这样断言的是
  // 「界面改出来的值」而不是「夹具直接写进去的值」。
  const groupName = `rfc319-worktree-${stamp}`
  const group = await createGroup(groupName, [
    { path: '', attachment: null },
    { path: 'app', attachment: { kind: 'repo', cachedRepoId: appRepoId } },
    { path: 'vendor', attachment: null },
    { path: 'vendor/sdk', attachment: { kind: 'repo', cachedRepoId: sdkRepoId } },
  ])

  await openGroupsTab(page)
  await page.getByTestId(`repo-group-edit-${group.id}`).click()
  await page.getByTestId('repo-group-node-select-vendor/sdk').click()
  const settings = page.getByTestId('repo-group-node-settings-vendor/sdk')
  await expect(
    settings,
    '选中一个挂了仓的节点之后没有出现它自己的设置区 ⇒ ref / subdir / 只读三个开关不可达',
  ).toBeVisible()
  await settings.getByLabel('Ref', { exact: true }).fill(RELEASE_REF)
  await settings.getByLabel('Repo subdirectory', { exact: true }).fill('pkg')
  await settings.getByRole('checkbox', { name: 'Read-only', exact: true }).check()

  // 三个设置要当场在树上可见——用户不该保存之后才知道自己设了什么。
  await expect(
    treeNode(page, 'vendor/sdk'),
    'ref 设完之后节点行没有回显它 ⇒ 一屏节点看不出哪个走的是非默认分支',
  ).toContainText(`@${RELEASE_REF}`)
  await expect(
    treeNode(page, 'vendor/sdk'),
    'subdir 设完之后节点行没有回显它 ⇒ 用户看不出这个仓只检出一棵子树',
  ).toContainText('pkg')
  await expect(
    treeNode(page, 'vendor/sdk'),
    '只读设完之后节点行没有徽标 ⇒ 用户看不出这个仓的改动会被丢弃',
  ).toContainText('read-only')

  await page.getByTestId('repo-group-save').click()
  await expect(editorDialog(page)).toHaveCount(0)

  const saved = await getGroup(group.id)
  const sdkNode = nodeAt(saved, 'vendor/sdk').attachment
  expect(sdkNode?.kind).toBe('repo')
  expect(
    sdkNode?.kind === 'repo' ? sdkNode.ref : '',
    '界面上填的 ref 没有落库 ⇒ 表单收了值、请求体里没有，任务照旧走默认分支',
  ).toBe(RELEASE_REF)
  expect(
    sdkNode?.kind === 'repo' ? sdkNode.subdir : '',
    '界面上填的 subdir 没有落库 ⇒ 巨仓会被整棵检出来',
  ).toBe('pkg')
  expect(
    sdkNode?.kind === 'repo' ? sdkNode.readonly : false,
    '界面上打开的只读没有落库 ⇒ agent 对这个仓的改动会被真的提交推送出去',
  ).toBe(true)

  // 展平布局（用户启动前唯一的核对面）也要把三个开关说清楚。
  await page.getByTestId(`repo-group-expand-${group.id}`).click()
  const layoutRow = page.getByTestId(`repo-group-layout-${group.id}-row-vendor/sdk`)
  await expect(
    layoutRow,
    '展平布局里没有回显 ref ⇒ 启动前的核对面漏掉了最容易设错的那一项',
  ).toContainText(RELEASE_REF)
  await expect(layoutRow, '展平布局里没有回显 subdir ⇒ 同上').toContainText('subdir: pkg')
  await expect(layoutRow, '展平布局里没有回显只读 ⇒ 同上').toContainText('read-only')

  // --- 真启动一个任务，看三个开关在工作树里的兑现 ---------------------------
  const workflowId = await seedLinearWorkflow(stamp)
  const task = await jsonOf<{ id: string }>(
    await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId,
        name: `rfc319-repo-group-worktree-${stamp}`,
        inputs: { topic: 'repo group settings' },
        repoGroupId: group.id,
      }),
    }),
    'start task',
  )
  const ready = await waitTaskRepos(task.id, 2)

  const byMount = new Map(ready.repos.map((repo) => [repo.mountPath, repo]))
  const sdkRepo = byMount.get('vendor/sdk')
  const appRepo = byMount.get('app')
  expect(
    [...byMount.keys()].sort(),
    '任务物化出来的挂载点与组定义不一致 ⇒ 组里排的布局在任务里被改写了',
  ).toEqual(['app', 'vendor/sdk'])
  expect(
    sdkRepo?.baseBranch,
    '组里定的 ref 没有变成任务仓的 base 分支 ⇒ agent 在错的分支上干活，改动落到错的地方',
  ).toBe(RELEASE_REF)
  expect(sdkRepo?.subdir, '组里定的 subdir 没有落进任务仓 ⇒ 稀疏检出无从谈起').toBe('pkg')
  expect(
    sdkRepo?.readonly,
    '组里定的只读没有落进任务仓 ⇒ 收尾时这个仓会被当成可写的一起提交推送',
  ).toBe(true)
  expect(
    appRepo?.readonly,
    '没有标只读的那个仓也被当成只读 ⇒ 只读被当成组级设置，用户的写入会被整组丢弃',
  ).toBe(false)

  // 工作树是最终事实：subdir 生效 ⇒ 只有 `pkg/`；ref 生效 ⇒ `pkg/lib.txt` 是 release 那一份。
  const sdkWorktree = sdkRepo!.worktreePath
  const libPath = join(sdkWorktree, 'pkg', 'lib.txt')
  expect(
    existsSync(libPath),
    `稀疏检出之后 ${libPath} 不存在 ⇒ 指定的子目录没有被检出，agent 会以为这个仓是空的`,
  ).toBe(true)
  expect(
    readFileSync(libPath, 'utf-8'),
    '子目录检出来了，内容却是默认分支那一份 ⇒ ref 被忽略，用户在错的代码上开工',
  ).toBe(RELEASE_MARK)
  expect(
    existsSync(join(sdkWorktree, 'docs')),
    'subdir 之外的目录也被检出来了 ⇒ 稀疏检出没生效，巨仓场景下工作树会大到不可用',
  ).toBe(false)
  expect(
    existsSync(join(byMount.get('app')!.worktreePath, 'README.md')),
    '没设 subdir 的那个仓反而没有完整检出 ⇒ 稀疏配置漏到了不该管的仓身上',
  ).toBe(true)

  // 只读的最终兑现：终态收尾会给只读成员写一个「丢弃了几处」的数字（干净是 0），
  // 可写成员保持 NULL。数字对不上，说明只读语义在收尾这一环丢了。
  const finished = await waitTaskTerminal(task.id)
  expect(
    finished.status,
    `按仓库组物化的任务没有正常跑完（${finished.status}）⇒ 三个开关里至少有一个把执行搞挂了`,
  ).toBe('done')
  const finishedByMount = new Map(finished.repos.map((repo) => [repo.mountPath, repo]))
  expect(
    finishedByMount.get('vendor/sdk')?.readonlyDirtyCount,
    '只读成员在终态没有被检查 ⇒ agent 改了只读仓也不会有任何提示，改动静默消失',
  ).toBe(0)
  expect(
    finishedByMount.get('app')?.readonlyDirtyCount,
    '可写成员也被当成只读检查了 ⇒ 只读判据没有逐仓生效',
  ).toBeNull()
})

// ===========================================================================
// REPO-34 —— 设置页配置代码平台连接并测试连通性
// ===========================================================================

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is unset — Playwright globalSetup must start system mocks`)
  }
  return value
}

/**
 * 从 system-mocks 包里取，而不是在本文件里再抄一份字面量：抄一份既会随 mock 改动
 * 静默漂移，也会往仓库里多埋一个「长得像凭据」的串（gitleaks 扫的是 git 历史，
 * 一旦入库就再也改不掉，见 docs/dev-gotchas.md）。`e2e/system-mocks.spec.ts` 用的
 * 就是这个导入。
 */
const MOCK_CODE_HOST_TOKEN: string = SYSTEM_MOCK_CODE_HOST_TOKEN

async function openCodeHosts(page: Page): Promise<void> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=codeHosts`)
  await expect(
    page.getByTestId('code-host-card-gitlab'),
    '设置页的「代码平台」分区没有渲染 ⇒ 后面所有断言都只是在断言一张白屏',
  ).toBeVisible()
}

interface CodeHostWire {
  provider: string
  configured: boolean
  baseUrl: string
  repositoryUrlPrefixes: string[]
  rejectUnauthorized: boolean
  tokenHint: string
  lastTest: { ok: boolean; login?: string; code?: string } | null
}

async function codeHost(provider: string): Promise<CodeHostWire> {
  const rows = await jsonOf<CodeHostWire[]>(await req('/api/code-hosts'), 'list code hosts')
  const hit = rows.find((row) => row.provider === provider)
  expect(hit, `代码平台列表里没有 ${provider}`).toBeTruthy()
  return hit!
}

test('RFC-319 REPO-34: 在设置页配置 GitLab / GitHub 连接并测试连通性，token 只进不出、草稿探活不盖已存结果 @nightly', async ({
  page,
}) => {
  const gitlabBase = requiredEnv('AW_SYSTEM_MOCK_GITLAB_API_BASE_URL')
  const githubBase = requiredEnv('AW_SYSTEM_MOCK_GITHUB_API_BASE_URL')

  await openCodeHosts(page)

  for (const [provider, baseUrl] of [
    ['gitlab', gitlabBase],
    ['github', githubBase],
  ] as const) {
    await page.getByTestId(`code-host-base-url-${provider}`).fill(baseUrl)
    await page.getByTestId(`code-host-token-${provider}`).fill(MOCK_CODE_HOST_TOKEN)
    await page.getByTestId(`code-host-save-${provider}`).click()

    // token 的三形态：写入接受明文、存储密封、读取只回尾 4 位。
    await expect(
      page.getByTestId(`code-host-token-${provider}`),
      `${provider} 保存之后 token 输入框还留着明文 ⇒ 一次投屏 / 一张截图就泄露了凭据`,
    ).toHaveValue('')
    await expect(
      page.getByTestId(`code-host-card-${provider}`),
      `${provider} 保存之后没有告知「已经存了一个 token」⇒ 用户分不清是没存上还是存上了没回显，会重复录入`,
    ).toContainText(`Stored (ends with ${MOCK_CODE_HOST_TOKEN.slice(-4)})`)

    await page.getByTestId(`code-host-test-${provider}`).click()
    await expect(
      page.getByTestId(`code-host-test-result-${provider}`),
      `${provider} 的「测试连接」没有回显探活结果 ⇒ 用户配完不知道这套凭据到底通不通，` +
        '只能等第一个真任务失败',
    ).toContainText('Connected as system-mock-user')
  }

  const gitlabRow = await codeHost('gitlab')
  expect(gitlabRow.configured, 'GitLab 保存后仍是未配置 ⇒ 界面的成功只是前端的乐观假象').toBe(true)
  expect(gitlabRow.baseUrl, 'GitLab 保存的 base URL 与用户填的不一致').toBe(gitlabBase)
  expect(
    gitlabRow.tokenHint,
    '读面回的不是 token 尾 4 位 ⇒ 要么泄露更多、要么用户完全认不出自己存的是哪个 token',
  ).toBe(MOCK_CODE_HOST_TOKEN.slice(-4))
  expect(
    gitlabRow.lastTest?.ok,
    '对着已保存的那套探活成功了，结果却没有回写 ⇒ 刷新之后这张卡又变回「从没测过」',
  ).toBe(true)
  expect((await codeHost('github')).lastTest?.login, 'GitHub 的探活结果没有回写').toBe(
    'system-mock-user',
  )

  // --- 草稿值的失败探活不能盖掉已保存那套的绿勾 ------------------------------
  await page.reload()
  const draftBase = gitlabBase.replace('/api/v4', '')
  await page.getByTestId('code-host-base-url-gitlab').fill(draftBase)
  await page.getByTestId('code-host-test-gitlab').click()
  await expect(
    page.getByTestId('code-host-test-result-gitlab'),
    '对着一个明显不是 API 根的地址探活却报成功 ⇒ 「测试连接」失去全部诊断价值',
  ).toContainText('Connection failed: The URL is not a valid API root')

  expect(
    (await codeHost('gitlab')).lastTest?.ok,
    '一次对着**草稿值**的失败探活把已保存配置的结果盖成了失败 ⇒ 反过来也一样成立：' +
      '一次对着草稿的成功会给已保存的坏配置盖上绿勾',
  ).toBe(true)
  await page.reload()
  await expect(
    page.getByTestId('code-host-test-result-gitlab'),
    '刷新之后卡片上显示的不是已保存那套的探活结果 ⇒ 用户看到的是别人（草稿）的成绩单',
  ).toContainText('Connected as system-mock-user')
  await expect(
    page.getByTestId('code-host-base-url-gitlab'),
    '刷新之后 base URL 还是那个没保存的草稿 ⇒ 用户以为自己改的已经生效了',
  ).toHaveValue(gitlabBase)

  const pageText = await page.locator('body').innerText()
  expect(
    pageText.includes(MOCK_CODE_HOST_TOKEN),
    '设置页文本里出现了明文 token ⇒ 凭据顺着读面泄露，而这条路径没有任何提示',
  ).toBe(false)
})

// ===========================================================================
// REPO-36 —— GitLab 专属的两个连接选项
// ===========================================================================

test('RFC-319 REPO-36: GitLab 专属的仓库 URL 前缀校验与 HTTPS 证书校验开关，GitHub 上既不渲染也不接受 @nightly', async ({
  page,
}) => {
  await openCodeHosts(page)

  // --- ① 两个选项只属于 GitLab ---------------------------------------------
  await expect(
    page.getByTestId('code-host-repository-url-prefixes-gitlab-input'),
    'GitLab 卡上没有仓库 URL 前缀输入 ⇒ 自建实例的备用 clone 域名无法归属到这套凭据',
  ).toBeVisible()
  await expect(
    page.getByTestId('code-host-repository-url-prefixes-github-input'),
    'GitHub 卡上也渲染了仓库 URL 前缀 ⇒ 用户会填一堆存不进去的东西',
  ).toHaveCount(0)
  const tls = page.getByTestId('code-host-reject-unauthorized-gitlab')
  await expect(tls, 'GitLab 卡上没有证书校验开关 ⇒ 内网自签场景在界面上完全不可达').toBeVisible()
  await expect(tls, '证书校验默认是关的 ⇒ 安全默认反了，所有连接默认不验证书').toBeChecked()
  await expect(
    page.getByTestId('code-host-reject-unauthorized-github'),
    'GitHub 卡上也渲染了证书校验开关 ⇒ 用户会以为自己关掉了，实际服务端根本不接受',
  ).toHaveCount(0)

  // --- ② 前缀标签校验：非 HTTP(S) / 带 query 的一律拦下 ---------------------
  const prefixInput = page.getByTestId('code-host-repository-url-prefixes-gitlab-input')
  const chipsError = page.getByTestId('code-host-card-gitlab').locator('.chips-input__error')
  for (const bad of ['ftp://mirror.example.com/team', 'https://mirror.example.com/team?token=1']) {
    await prefixInput.fill(bad)
    await prefixInput.press('Enter')
    await expect(
      chipsError,
      `非法前缀 '${bad}' 没有被拦下 ⇒ 它要么把 query 里的秘密写进设置读面，` +
        '要么让一条永远匹配不上的规则静静躺在那里',
    ).toContainText('Enter an HTTP(S) URL without credentials, query or fragment.')
    await expect(
      page.getByRole('button', { name: `Remove ${bad}`, exact: true }),
      `非法前缀 '${bad}' 仍然被加成了标签 ⇒ 校验只是画了条红字，值照样进草稿`,
    ).toHaveCount(0)
  }

  // --- ③ 合法前缀当场归一化，且归一化之后去重 ------------------------------
  const canonical = 'https://gitlab-mirror.example.com/Team'
  await prefixInput.fill('HTTPS://GitLab-Mirror.Example.COM/Team/')
  await prefixInput.press('Enter')
  await expect(
    page.getByRole('button', { name: `Remove ${canonical}`, exact: true }),
    '合法前缀没有被归一化成小写 scheme/host、去掉尾斜杠 ⇒ 同一个镜像写两种大小写就会被' +
      '当成两条规则，而 clone URL 只会匹配上其中一条',
  ).toBeVisible()
  await prefixInput.fill('https://GITLAB-MIRROR.example.com/Team')
  await prefixInput.press('Enter')
  await expect(
    page.getByTestId('code-host-card-gitlab').locator('.chip'),
    '换个大小写再填一次就多出一条规则 ⇒ 去重发生在归一化之前，等于没去重',
  ).toHaveCount(1)

  // --- ④ 关掉证书校验 + 保存，两项都要真的落库 -----------------------------
  await tls.uncheck()
  await page.getByTestId('code-host-save-gitlab').click()
  await expect
    .poll(async () => (await codeHost('gitlab')).rejectUnauthorized, {
      message:
        '关掉证书校验保存之后服务端仍是 true ⇒ 界面上写着「已关闭」，实际每次连接照旧验证书，' +
        '内网自签场景永远连不上而用户以为自己已经关过了',
    })
    .toBe(false)
  expect(
    (await codeHost('gitlab')).repositoryUrlPrefixes,
    '前缀集合没有按归一化后的形态落库 ⇒ 执行期的归属判定用的是另一套字符串',
  ).toEqual([canonical])

  await page.reload()
  await expect(
    page.getByRole('button', { name: `Remove ${canonical}`, exact: true }),
    '刷新之后前缀标签没了 ⇒ 保存看着成功，读回来是空的',
  ).toBeVisible()
  await expect(
    page.getByTestId('code-host-reject-unauthorized-gitlab'),
    '刷新之后证书校验开关又回到开启 ⇒ 同上，这一项根本没存住',
  ).not.toBeChecked()

  // --- ⑤ 服务端的 GitLab-only 门（界面门之外的第二道）----------------------
  const githubBase = requiredEnv('AW_SYSTEM_MOCK_GITHUB_API_BASE_URL')
  const tlsOnGithub = await call('/api/code-hosts/github', {
    method: 'PUT',
    body: JSON.stringify({ baseUrl: githubBase, rejectUnauthorized: false }),
  })
  expect(
    tlsOnGithub.status,
    'GitHub 也接受了关闭证书校验 ⇒ 保存成功但实际仍然校验，用户拿到一份假配置',
  ).toBe(422)
  expect(tlsOnGithub.code, '拒绝没有自己的错误码 ⇒ 前端无法解释为什么这一项存不下去').toBe(
    'code-host-tls-option-unsupported',
  )

  const prefixesOnGithub = await call('/api/code-hosts/github', {
    method: 'PUT',
    body: JSON.stringify({
      baseUrl: githubBase,
      repositoryUrlPrefixes: ['https://mirror.example.com/team'],
    }),
  })
  expect(
    prefixesOnGithub.status,
    'GitHub 也接受了仓库 URL 前缀 ⇒ 用户配的归属规则永远不会被读，静默失效',
  ).toBe(422)
  expect(prefixesOnGithub.code, '拒绝没有自己的错误码 ⇒ 同上').toBe(
    'code-host-repository-url-prefixes-unsupported',
  )
  // 刻意**不**在这里断言「GitHub 的 rejectUnauthorized 仍是 true」——非 GitLab 的读面
  // 恒为 true（connections.ts:129 的 `provider === 'gitlab' ? … : true`），那样写是一条
  // 无论产品怎么坏都成立的恒真断言。真正的判据就是上面两条 422 + 错误码。
})

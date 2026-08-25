// RFC-319 —— 设置页运维面板的用户面 e2e
// （账本 OPS-032 / OPS-033 / OPS-034 / OPS-035 / OPS-036 / OPS-037 / OPS-038 / OPS-X6）。
//
// 这一批控件是整台平台上**最不可逆**的几个按钮：一个删掉磁盘上的退役目录、一个把
// 终态任务从库里抹掉、一个把**全实例**回滚到某个备份的时间点。它们坏掉的方式高度
// 一致——不是"点了没反应"，而是"点了**直接就做了**"：
//
//   * 【OPS-034】选文件那一刻就上传 = 误点一个文件名相近的 tar.gz 就把全公司的任务
//     和资源 arm 成一次回滚，而用户以为自己只是"打开了选择框"。产品的承诺写在
//     `routes/settings.tsx:1394-1396` 的注释里（"NOTHING is uploaded before Confirm"），
//     这条用例把它变成机器判据：**确认框弹出期间与点取消之后，`/api/restore` 的
//     POST 计数必须为 0，且服务端 `GET /api/restore/pending` 必须仍是 null**。
//     只断言"确认后成功了"等于没锁住确认框——那条断言在"选文件即上传"的世界里
//     也照样绿。
//   * 【OPS-036】同形：`disk-cleanup-open` 只该开对话框，删除必须由对话框里的
//     「Delete permanently」发出。开框那一刻目录就没了，用户连"我要删的是哪个目录、
//     多大"都还没看到。
//   * 【OPS-037】更隐蔽：这个入口**天生就要发一次请求**（dry-run 预览）。所以锁的
//     不是"有没有请求"，而是**请求的形状**：确认之前只允许 `dryRun:true`，一条
//     `dryRun:false` 都不许出现；而且预览数字必须与真正会被删掉的那批对上，否则
//     用户是照着一个假数字按下不可逆的确认。
//   * 【OPS-033】备份卡片回显的路径/体积若与磁盘上的文件对不上，用户会拿着一个
//     不存在（或空）的备份当作灾备依据——直到真的需要恢复那天才发现。
//   * 【OPS-035】已 arm 的回滚必须**看得见、撤得掉**：看不见 = 下次重启莫名其妙
//     全站回到上周；撤不掉 = 误 arm 之后只能去手删 `~/.agent-workflow/.restore-pending`。
//     失败恢复的隔离目录同理——它是"上一次恢复炸了、现场还在盘上"的唯一线索。
//   * 【OPS-032】网络分区显示的必须是**当前真正在监听的**地址，而不是把 config 里
//     那份持久值再念一遍。念 config 的话，`--port` 起的实例（config 写 0 / 写别的
//     端口）会让运维照着一个错的端口去配反代。
//   * 【OPS-038】上面每一个按钮背后的端点，未授权账号既不该看得见入口，直调也必须
//     403 且**零副作用**。只挡 UI = 任何脚本/旧页面都能绕过去。
//   * 【OPS-X6】任务被熔断隔离后，详情页要说清"系统对这条任务做过什么"并给出解除
//     出口；没有这块横幅，用户看到的只是一条"不动了"的任务，无从判断是自己该重试
//     还是平台把它关在门外了。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链——外链会被 CI 的
// markdown link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/settings.tsx:1192-1274   TaskArchiveManualRun：dry-run 预览 → ConfirmDialog → dryRun:false
//   packages/frontend/src/routes/settings.tsx:1210-1213   treeCount===0 时**不弹**对话框，改出一行提示
//   packages/frontend/src/routes/settings.tsx:1307-1381   DiskReclaimCard：盘点 + 不可逆删除 + 目录不在时按钮禁用
//   packages/frontend/src/routes/settings.tsx:1386-1547   BackupCard：备份回显 / 恢复二次确认 / staged 提示 / pending 与 failed 横幅
//   packages/frontend/src/routes/settings.tsx:1394-1396   "the picked file is held here until the destructive confirmation dialog is answered"
//   packages/frontend/src/routes/settings.tsx:1173-1174   两张卡片各自的权限门（backup:run / settings:write）
//   packages/frontend/src/routes/settings.tsx:1570-1614   NetworkTab：GET /api/daemon 的有效绑定读数与「Pin current port」
//   packages/frontend/src/components/tasks/RecoverySection.tsx:74-85    recovery-events 查询 + clear-recovery-suspension 变更
//   packages/frontend/src/components/tasks/RecoverySection.tsx:44-55    RECOVERY_EVENT_KINDS 十种 kind 的中英标签映射
//   packages/backend/src/routes/backup.ts:11-31           POST /api/backup —— backup:run
//   packages/backend/src/routes/restore.ts:30-115         /api/restore 三端点 —— backup:run；无 db.sqlite 的包 400 且不 arm
//   packages/backend/src/routes/maintenanceDisk.ts:13-38  /api/maintenance/disk{,/cleanup} —— settings:write
//   packages/backend/src/routes/taskArchive.ts:39-104     POST /api/tasks/archive —— settings:write，`dryRun !== false` 即预览
//   packages/backend/src/routes/daemon.ts:14-31           GET /api/daemon —— 有效绑定来自 run-info 文件，不是 config
//   packages/backend/src/services/maintenanceDisk.ts:73-113  盘点只读 / 清理不可逆
//   packages/backend/src/services/taskArchive.ts:288-326  可归档树的判据：整树全终态 ∧ max(finishedAt) ≤ cutoff
//   packages/backend/src/services/taskArchive.ts:495-520  归档审计行（source/actor/tree_count/task_count）
//   packages/backend/src/services/pendingRestore.ts:75-105 clearPendingRestore / listFailedRestores
//
// 与既有覆盖的分工（不重复造轮子）：
//   · `e2e/rfc319-settings-sections.spec.ts` 锁的是**配置保存机制**（分区 / 校验 /
//     stale / 未保存拦截）。本文件一个配置字段都不"保存"，锁的是同一页上那些
//     **动作型**按钮。
//   · `e2e/ux-consistency.spec.ts:329-357` 只数 `.settings-card` 的张数（`['gc', 7]`），
//     卡片里的按钮按下去会发生什么，它一个字都没断言。
//   · `e2e/ops-local-recovery.spec.ts` 走的是 CLI / 本地恢复面；本文件全程走浏览器
//     + 真 HTTP API。
//
// 本文件**不用 `page.route` 拦任何 API**（因此也不需要 `unrouteAll`）：整条链路跑
// 真 daemon + 真 SQLite + 真文件系统。"有没有发这个请求"用 `page.on('request')`
// 观测，并且每一条都配一条**服务端事实**的交叉验证（pending 是不是 null、目录还在
// 不在、任务还查不查得到），免得断言退化成"只看客户端"。
//
// 执行模型：单 daemon、`mode: 'serial'`，用例按**声明顺序**跑，顺序是判据的一部分：
//   · OPS-038 必须排在 OPS-036 / OPS-037 之前 —— 它要断言"越权调用零副作用"，
//     而那两条会把退役目录和任务分别删掉，跑完就没有可供观察的副作用面了；
//   · OPS-X6 复用 OPS-037 里**因未超保留期而幸存**的那条任务；
//   · OPS-034 排最后 —— 它会重启 daemon 来证明"重启才生效"，重启之后整库回到
//     OPS-033 那次备份的时间点，前面所有用例的语料都会消失。

import { mkdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { expect, test, type Locator, type Page, type Request } from '@playwright/test'

import { querySqlite, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

// `timeout` 走 describe.configure 而不是文件级 `test.setTimeout()`：后者在本文件
// 实测不生效（OPS-034 仍按 config 的 90s 判超时），而这条用例要重启一次 daemon。
test.describe.configure({ mode: 'serial', timeout: 240_000 })

let daemon: DaemonHandle
/** 常驻 home：OPS-034 要重启 daemon，`stop()` 不能把它连锅端了。 */
let homeDir = ''
let adminUserId = ''
/** OPS-033 产出、OPS-034 消费的那个真备份。 */
let backupPath = ''

/** 备份时点就存在的代理；OPS-034 在 arm 之前删掉它，恢复后它必须回来。 */
const PRE_BACKUP_AGENT = 'rfc319-ops-pre-backup-marker'
/** 备份之后才建的代理；恢复后它必须消失。 */
const POST_BACKUP_AGENT = 'rfc319-ops-post-backup-marker'

/** 退役 runtime store 的两个夹具文件，字节数写死以便逐字比对回显的 MB。 */
const RETIRED_STORE_BYTES = 700_000 + 500_000

const DAY_MS = 86_400_000
const ARCHIVE_RETENTION_DAYS = 30

/**
 * 归档语料，四棵树。前两棵可归档（共 3 个任务），后两棵必须幸存，各自堵住
 * 保留期护栏的一半（taskArchive.ts:288-326）：
 *   · RECENT_ROOT —— 根本身就在保留期内，被**根查询**的 `finished_at ≤ cutoff` 挡掉；
 *   · MIXED_ROOT + MIXED_CHILD —— 根早已超期、子任务两小时前才结束。这一棵只能被
 *     **整树判据** `if (lastFinishedAt > cutoff) continue` 挡住；少了它，「删掉那行
 *     守卫」这个变异一条用例都咬不到（2026-08-25 实测，第一版语料就漏了这一半）。
 */
const OLD_ROOT_A = '01JRFC319OPSARCHIVEROOTA0'
const OLD_CHILD_A = '01JRFC319OPSARCHIVECHLDA0'
const OLD_ROOT_B = '01JRFC319OPSARCHIVEROOTB0'
const RECENT_ROOT = '01JRFC319OPSRECENTROOT000'
const MIXED_ROOT = '01JRFC319OPSMIXEDROOT0000'
const MIXED_CHILD = '01JRFC319OPSMIXEDCHILD000'

test.beforeAll(async () => {
  daemon = await startDaemon()
  homeDir = daemon.home

  adminUserId = (
    (await jsonOf(await api('/api/auth/me'), 'read /api/auth/me')) as { user: { id: string } }
  ).user.id

  // 备份时点的存在性标记（OPS-034 的往返判据之一）。
  await expectOk(
    await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: PRE_BACKUP_AGENT,
        description: 'rfc-319 ops backup round-trip marker',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'marker',
      }),
    }),
    `create ${PRE_BACKUP_AGENT}`,
  )

  // 退役 store 夹具：RFC-276 退役留下的零引用死数据，产品只在这里提供清理入口。
  mkdirSync(join(homeDir, 'opencode-stores', 'session-a'), { recursive: true })
  mkdirSync(join(homeDir, 'opencode-stores', 'session-b'), { recursive: true })
  writeFileSync(join(homeDir, 'opencode-stores', 'session-a', 'log.bin'), Buffer.alloc(700_000, 7))
  writeFileSync(join(homeDir, 'opencode-stores', 'session-b', 'blob.bin'), Buffer.alloc(500_000, 3))

  // 归档语料只能直连落库：产品没有"把任务的 finished_at 改到 90 天前"的用户面入口，
  // 而 `findArchivableTrees` 正是按 finished_at 相对 cutoff 判定的（taskArchive.ts:288-326）。
  const now = Date.now()
  runSqlite(
    dbPath(),
    [
      seedTaskSql({
        id: OLD_ROOT_A,
        name: 'rfc319-ops archive root A',
        finishedAt: now - 90 * DAY_MS,
      }),
      seedTaskSql({
        id: OLD_CHILD_A,
        name: 'rfc319-ops archive child A',
        finishedAt: now - 89 * DAY_MS,
        parentId: OLD_ROOT_A,
      }),
      seedTaskSql({
        id: OLD_ROOT_B,
        name: 'rfc319-ops archive root B',
        finishedAt: now - 60 * DAY_MS,
      }),
      seedTaskSql({ id: RECENT_ROOT, name: 'rfc319-ops recent root', finishedAt: now - 3_600_000 }),
      seedTaskSql({
        id: MIXED_ROOT,
        name: 'rfc319-ops mixed-age root',
        finishedAt: now - 80 * DAY_MS,
      }),
      seedTaskSql({
        id: MIXED_CHILD,
        name: 'rfc319-ops mixed-age child',
        finishedAt: now - 2 * 3_600_000,
        parentId: MIXED_ROOT,
      }),
    ].join('\n'),
  )

  await seedConfig({
    taskArchive: { enabled: false, retentionDays: ARCHIVE_RETENTION_DAYS, maxTreesPerSweep: 50 },
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  // OPS-034 重启后的那个句柄 keepHome=true，home 归本文件自己清。
  if (homeDir !== '') rmSync(homeDir, { recursive: true, force: true })
})

// --------------------------------------------------------------------------
// Helpers —— 服务端 / 磁盘上的事实优先；页面只负责"说得对不对"。
// --------------------------------------------------------------------------

function dbPath(): string {
  return join(homeDir, 'db.sqlite')
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

async function expectOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) {
    expect(res.ok, `${what}: ${res.status} ${await res.text().catch(() => '')}`).toBe(true)
  }
  return res
}

async function jsonOf(res: Response, what: string): Promise<unknown> {
  await expectOk(res, what)
  return res.json()
}

async function seedConfig(patch: Record<string, unknown>): Promise<void> {
  await expectOk(
    await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) }),
    'seed config',
  )
}

async function readConfig(): Promise<Record<string, unknown>> {
  return (await jsonOf(await api('/api/config'), 'read config')) as Record<string, unknown>
}

async function restorePending(): Promise<{
  pending: { requestedAt: number } | null
  failed: Array<{ dir: string }>
}> {
  return (await jsonOf(await api('/api/restore/pending'), 'read restore pending')) as {
    pending: { requestedAt: number } | null
    failed: Array<{ dir: string }>
  }
}

async function taskStatusCode(taskId: string): Promise<number> {
  return (await api(`/api/tasks/${taskId}`)).status
}

async function agentNames(): Promise<string[]> {
  const rows = (await jsonOf(await api('/api/agents'), 'list agents')) as Array<{ name: string }>
  return rows.map((row) => row.name)
}

/** 与 `routes/settings.tsx` 的 `formatMb` 逐字节同构——回显数字要按它比对。 */
function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function primeToken(target: Page, token: string = daemon.token): Promise<void> {
  await target.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: token },
  )
}

/** `SettingsCard` 渲染成带无障碍名的 `<section>`（SettingsCard.tsx:33-49）。 */
function card(page: Page, title: string): Locator {
  return page.getByRole('region', { name: title })
}

function confirmDialog(page: Page): Locator {
  return page.locator('.confirm-dialog[role="dialog"]')
}

/**
 * 记录页面对某条 pathname 发出的请求（含 POST body）。
 * 用 `page.on('request')` 而不是 `page.route`：本文件不注入任何响应，只做观测，
 * 也就不存在 `docs/dev-gotchas.md` 里那条 `route.fetch()` 竞态。
 */
function watchRequests(
  page: Page,
  method: string,
  pathname: string,
): { readonly all: ReadonlyArray<unknown> } {
  const seen: unknown[] = []
  page.on('request', (request: Request) => {
    if (request.method() !== method) return
    let path: string
    try {
      path = new URL(request.url()).pathname
    } catch {
      return
    }
    if (path !== pathname) return
    let body: unknown = null
    try {
      body = request.postDataJSON()
    } catch {
      body = null
    }
    seen.push(body)
  })
  return { all: seen }
}

interface SeedTask {
  id: string
  name: string
  finishedAt: number
  parentId?: string
}

/** 任务播种语句。列清单与 `e2e/rfc319-task-list-and-filters.spec.ts` 同源。 */
function seedTaskSql(row: SeedTask): string {
  const values = [
    sqlText(row.id),
    sqlText(row.name),
    sqlText('rfc319-ops-archive-workflow'),
    sqlText('{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'),
    sqlText(join(homeDir, 'fixture-repo')),
    sqlText(join(homeDir, 'worktrees', row.id)),
    sqlText('main'),
    sqlText(`agent-workflow/${row.id}`),
    sqlText('done'),
    sqlText('{}'),
    String(row.finishedAt - 60_000),
    String(row.finishedAt),
    sqlText(adminUserId),
    String(row.finishedAt - 60_000),
    sqlText(row.parentId ?? row.id),
    sqlText(row.parentId ?? null),
    row.parentId === undefined ? '0' : '1',
  ].join(', ')
  return (
    'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,' +
    ' base_branch, branch, status, inputs, started_at, finished_at, owner_user_id,' +
    ` branch_started_at, root_task_id, parent_task_id, invocation_depth) VALUES (${values});`
  )
}

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

/**
 * 手搓一个 ustar tar.gz。**故意不带 `db.sqlite`**，用来打
 * `routes/restore.ts` → `validateBackupForStage`（restore.ts:226-229）那条
 * "不是备份包"的拒绝分支——它是产品自己的校验，而不是 tar 解包失败。
 * 不调外部 `tar`：Playwright 跑在 Node 侧，Windows runner 上的 tar 形态另说。
 */
function makeTarGz(entries: ReadonlyArray<{ name: string; body: string }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.body, 'utf-8')
    chunks.push(ustarHeader(entry.name, data.length), data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(chunks))
}

function ustarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 100, 'utf-8')
  header.write('0000644\0', 100, 8, 'ascii') // mode
  header.write('0000000\0', 108, 8, 'ascii') // uid
  header.write('0000000\0', 116, 8, 'ascii') // gid
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii') // mtime
  header.write('        ', 148, 8, 'ascii') // checksum placeholder (spaces)
  header.write('0', 156, 1, 'ascii') // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

// --------------------------------------------------------------------------
// OPS-032 P3 —— 网络分区展示 daemon **当前有效**的绑定地址
// --------------------------------------------------------------------------

test('RFC-319 OPS-032：网络分区念的是 daemon 当前真在监听的端口，而不是 config 里那份持久值 @nightly', async ({
  page,
}) => {
  // 造出"持久值 ≠ 有效值"的局面：config 写 0（表示随机端口），而进程此刻绑在
  // 一个具体端口上。两者相等的话这条用例就退化成"把同一个数字念了两遍"。
  await seedConfig({ bindPort: 0 })
  const effectivePort = Number(new URL(daemon.baseUrl).port)
  expect(effectivePort, '取不到 daemon 的实际端口 ⇒ 这条用例的前提不成立').toBeGreaterThan(0)

  const info = (await jsonOf(await api('/api/daemon'), 'read /api/daemon')) as {
    host: string
    port: number
    url: string
  } | null
  expect(
    info,
    'GET /api/daemon 返回 null ⇒ run-info 文件没写出来，页面上那块读数永远是空的',
  ).not.toBeNull()
  expect(info?.port, '/api/daemon 报的端口与进程实际监听的不一致 ⇒ 运维照它去配反代会连不上').toBe(
    effectivePort,
  )
  expect(Number((await readConfig())['bindPort'] ?? -1)).toBe(0)

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=network`)
  const bindPort = page.getByTestId('settings-bind-port')
  await expect(bindPort).toBeVisible({ timeout: 30_000 })

  // ① 有效端口必须出现在页面上。它只可能来自 /api/daemon —— config 里是 0。
  await expect(
    page.getByText(`This run is using port ${effectivePort}.`, { exact: false }),
    '网络分区不显示当前有效端口 ⇒ 用 --port 起的实例上，运维只能去翻进程命令行',
  ).toBeVisible({ timeout: 20_000 })

  // ② 只是打开这个分区，不许把 section 弄脏（settings.tsx:1576-1581 的明文约定：
  //    "merely opening this tab must not make the section dirty"）。脏了的后果是
  //    用户随手在别处点一下保存，就把一个本次随机端口钉死进配置。
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(
    save,
    '打开网络分区就把 section 弄脏了 ⇒ 一次随机端口会被静默钉进 config',
  ).toBeDisabled()

  // ③ 「Pin current port」是唯一把有效端口写进草稿的路径，且写的必须是**有效端口**。
  await page.getByTestId('settings-use-effective-port').click()
  await expect(
    bindPort,
    '「Pin current port」没有把有效端口填进输入框 ⇒ 这个按钮什么也没做',
  ).toHaveValue(String(effectivePort))
  await expect(save, '钉了端口之后仍显示"无改动" ⇒ 用户点不了保存，钉了等于没钉').toBeEnabled()
  await expect(
    page.getByTestId('settings-use-effective-port'),
    '端口已经钉进草稿了还继续提示"本次运行在用某端口" ⇒ 提示与草稿自相矛盾',
  ).toHaveCount(0)

  // ④ 这是纯本地草稿动作：没点保存就不许写服务端。
  expect(
    Number((await readConfig())['bindPort'] ?? -1),
    '「Pin current port」直接写了服务端 ⇒ 一个填表动作改了守护进程配置',
  ).toBe(0)
})

// --------------------------------------------------------------------------
// OPS-033 P2 —— 备份卡片：一键创建并回显路径与体积
// --------------------------------------------------------------------------

test('RFC-319 OPS-033：点「创建备份」真的产出一个文件，回显的路径与 MB 与磁盘逐字对得上 @nightly', async ({
  page,
}) => {
  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const backupCard = card(page, 'Export backup')
  await expect(backupCard).toBeVisible({ timeout: 30_000 })

  await backupCard.getByRole('button', { name: 'Create backup', exact: true }).click()

  // ① 回执必须出现，且给出的是一条**具体路径**——"备份成功了"而不说存哪儿，
  //    等于灾备那天要满盘去找。
  const savedLine = backupCard.locator('code')
  await expect(
    savedLine,
    '点了创建备份却没有任何路径回显 ⇒ 用户不知道备份是否真的产生、在哪儿',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    backupCard.locator('.error-box'),
    '备份卡片同时给出了路径与错误 ⇒ 用户无法判断这次到底成没成',
  ).toHaveCount(0)

  backupPath = ((await savedLine.textContent()) ?? '').trim()
  expect(backupPath, '回显的路径不在本实例的 backups/ 下 ⇒ 指到了别处，恢复时找不到').toContain(
    join(homeDir, 'backups'),
  )
  expect(backupPath.endsWith('.tar.gz'), `回显的不是 tarball：${backupPath}`).toBe(true)

  // ② 那个文件必须真的在磁盘上，而且非空。回显与产物脱节是这类"回执型"UI 最
  //    常见的退化：接口报成功、文件根本没落地。
  expect(
    existsSync(backupPath),
    `界面说备份存到了 ${backupPath}，磁盘上却没有这个文件 ⇒ 灾备是假的`,
  ).toBe(true)
  const actualBytes = statSync(backupPath).size
  expect(actualBytes, '备份文件是空的 ⇒ 有文件名没有内容，恢复时才会发现').toBeGreaterThan(0)

  // ③ 体积必须是这份文件**真实**的体积，且按 MB 呈现。把 sizeBytes 当 MB 直接印，
  //    或者印成 0.00，用户都无法判断"这份备份是不是漏了东西"。
  await expect(
    backupCard.getByText(`(${formatMb(actualBytes)})`, { exact: false }),
    `回显体积与磁盘上的 ${actualBytes} 字节对不上 ⇒ 用户拿一个假数字判断备份完整性`,
  ).toBeVisible()

  // ④ 按钮回到可再次点击的常态（不是被一次成功永久锁死）。
  await expect(
    backupCard.getByRole('button', { name: 'Create backup', exact: true }),
    '备份完成后按钮没有回到常态 ⇒ 想再备份一次只能刷新页面',
  ).toBeEnabled()
})

// --------------------------------------------------------------------------
// OPS-038 P2 —— 运维端点的权限边界（backup:run / settings:write）
// --------------------------------------------------------------------------

test('RFC-319 OPS-038：只有 settings:read 的账号进得了设置页，但看不见运维入口、直调七个运维端点全 403 且零副作用 @nightly', async ({
  page,
}) => {
  // 这个账号刻意**能进设置页**（settings:read）。若造一个连页面都进不去的账号，
  // "看不见卡片"这条断言就退化成恒真——它看不见的是整个页面。
  const username = 'rfc319-ops-readonly'
  const password = 'Rfc319-Ops-ReadOnly!'
  await expectOk(
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        displayName: username,
        role: 'user',
        additionalPermissions: ['settings:read'],
        password,
      }),
    }),
    'create read-only settings user',
  )
  const readOnlyToken = (
    (await jsonOf(
      await fetch(`${daemon.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
      'login read-only user',
    )) as { sessionToken: string }
  ).sessionToken

  const me = (await jsonOf(
    await fetch(`${daemon.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${readOnlyToken}` },
    }),
    'read-only /me',
  )) as { permissions: string[] }
  expect(me.permissions, '前提不成立：这个账号进不了设置页，后面的断言全是恒真').toContain(
    'settings:read',
  )
  expect(me.permissions, '前提不成立：这个账号带着 settings:write').not.toContain('settings:write')
  expect(me.permissions, '前提不成立：这个账号带着 backup:run').not.toContain('backup:run')

  // ① 服务端边界：六个端点逐个 403。UI 藏不藏是 UX，这一层才是边界。
  const call = async (path: string, method: string, body?: unknown): Promise<number> =>
    (
      await fetch(`${daemon.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${readOnlyToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    ).status

  expect(await call('/api/backup', 'POST', {}), 'POST /api/backup 没挡住无 backup:run 的账号').toBe(
    403,
  )
  expect(await call('/api/restore/pending', 'GET'), 'GET /api/restore/pending 没挡住').toBe(403)
  // 这一条是这组里最危险的：它 arm 的是**全实例回滚**。multipart 走不了上面的
  // `call`，单独发一次。
  const intrusion = new FormData()
  intrusion.append('file', new Blob([makeTarGz([{ name: 'x.txt', body: 'x\n' }])]), 'x.tar.gz')
  expect(
    (
      await fetch(`${daemon.baseUrl}/api/restore`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${readOnlyToken}` },
        body: intrusion,
      })
    ).status,
    'POST /api/restore 没挡住 ⇒ 无 backup:run 的账号能 arm 一次全实例回滚',
  ).toBe(403)
  expect(await call('/api/restore/pending', 'DELETE'), 'DELETE /api/restore/pending 没挡住').toBe(
    403,
  )
  expect(
    await call('/api/maintenance/disk', 'GET'),
    'GET /api/maintenance/disk 没挡住 ⇒ 主机路径与目录体积泄露给只读账号',
  ).toBe(403)
  expect(
    await call('/api/maintenance/disk/cleanup', 'POST', {}),
    'POST /api/maintenance/disk/cleanup 没挡住 ⇒ 只读账号能不可逆删目录',
  ).toBe(403)
  expect(
    await call('/api/tasks/archive', 'POST', {
      retentionDays: ARCHIVE_RETENTION_DAYS,
      dryRun: false,
    }),
    'POST /api/tasks/archive 没挡住 ⇒ 只读账号能把全库终态任务批量删掉',
  ).toBe(403)

  // ② 零副作用：被拒的调用一件事都不许做成。上面那两条是**破坏性**载荷
  //    （cleanup / dryRun:false），所以这一段是"403 是真的拒绝，不是拒绝了个回执"。
  expect(
    existsSync(join(homeDir, 'opencode-stores')),
    '越权 cleanup 被判 403，退役目录却已经没了 ⇒ 拒绝发生在删除之后',
  ).toBe(true)
  for (const id of [OLD_ROOT_A, OLD_CHILD_A, OLD_ROOT_B, RECENT_ROOT, MIXED_ROOT, MIXED_CHILD]) {
    expect(await taskStatusCode(id), `越权归档被判 403，任务 ${id} 却已经被删了`).toBe(200)
  }
  expect(
    querySqlite<{ n: number }>(dbPath(), 'SELECT COUNT(*) AS n FROM task_archive_audit')[0]?.n ??
      -1,
    '越权归档被判 403 却留下了审计行 ⇒ 那次调用真的跑进去过',
  ).toBe(0)
  expect(
    (await restorePending()).pending,
    '越权 POST /api/restore 被判 403，回滚却已经 arm 上了 ⇒ 拒绝发生在 arm 之后',
  ).toBeNull()

  // ③ UI 边界：同一张 GC 分区页上，三个运维入口一个都不许渲染。
  await primeToken(page, readOnlyToken)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  await expect(
    page.getByTestId('settings-webhook-body-retention'),
    '只读账号连 GC 分区都打不开 ⇒ 这条用例观察不到"入口被藏起来"这件事',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    card(page, 'Export backup'),
    '无 backup:run 的账号看得见备份/恢复卡片 ⇒ 每个按钮都会 403，用户只会以为系统坏了',
  ).toHaveCount(0)
  await expect(
    card(page, 'Reclaimable space'),
    '无 settings:write 的账号看得见可回收空间卡片 ⇒ 主机路径与体积经 UI 泄露',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('task-archive-run'),
    '无 settings:write 的账号看得见「立即归档」⇒ 一个必然 403 的不可逆按钮摆在他面前',
  ).toHaveCount(0)
})

// --------------------------------------------------------------------------
// OPS-036 P2 —— 可回收空间：盘点 + 二次确认后才不可逆删除
// --------------------------------------------------------------------------

test('RFC-319 OPS-036：可回收空间照实盘点退役目录，开确认框不删、点取消不删，确认后目录真消失且按钮转灰 @nightly', async ({
  page,
}) => {
  const storePath = join(homeDir, 'opencode-stores')
  expect(existsSync(storePath), '夹具目录不在了 ⇒ 这条用例的前提不成立').toBe(true)

  await primeToken(page)
  const seen = watchRequests(page, 'POST', '/api/maintenance/disk/cleanup')
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const diskCard = card(page, 'Reclaimable space')
  await expect(diskCard).toBeVisible({ timeout: 30_000 })

  // ① 盘点必须照实说：体积与路径都要与磁盘对得上。数字对不上 = 用户按一个假的
  //    "能省 2.9GB"去按不可逆的删除。
  await expect(
    diskCard.getByText('Retired runtime store directory'),
    '可回收空间卡片没有报出退役目录这一行 ⇒ 盘点等于没做',
  ).toHaveText(`Retired runtime store directory: ${formatMb(RETIRED_STORE_BYTES)} · ${storePath}`, {
    timeout: 20_000,
  })

  // ② DB 内部空洞那一行：两个数字不能互换位置（换了就是"可回收比整库还大"）。
  const freelistLine = (
    (await diskCard.getByText('Reclaimable inside the database').textContent()) ?? ''
  ).trim()
  const numbers = [...freelistLine.matchAll(/([\d.]+) MB/g)].map((m) => Number(m[1]))
  expect(numbers.length, `DB 空洞那一行没有两个 MB 读数：${freelistLine}`).toBe(2)
  const [reclaimableMb, totalMb] = numbers as [number, number]
  expect(totalMb, 'DB 文件总量报成 0 ⇒ 读数没接上 PRAGMA，整行是装饰').toBeGreaterThan(0.1)
  expect(
    reclaimableMb,
    'DB 可回收量 ≥ 文件总量 ⇒ 两个占位符写反了，用户会以为整库都是空洞',
  ).toBeLessThan(totalMb)

  // ③ 开确认框这一步**不许删**。这是这条能力的核心：删除必须由对话框里那个
  //    按钮发出，而不是由"我想看看能省多少"这个动作发出。
  const openButton = diskCard.getByTestId('disk-cleanup-open')
  await expect(openButton, '目录明明存在，删除按钮却是灰的 ⇒ 可回收空间无法回收').toBeEnabled()
  await openButton.click()
  const dialog = confirmDialog(page)
  await expect(dialog).toBeVisible()
  await expect(
    dialog,
    '确认框不说清删的是哪个目录、多大 ⇒ 用户在没有信息的情况下按不可逆按钮',
  ).toContainText(storePath)
  await expect(dialog).toContainText(formatMb(RETIRED_STORE_BYTES))
  expect(seen.all.length, '刚打开确认框，删除请求就已经发出去了 ⇒ 二次确认形同虚设').toBe(0)
  expect(existsSync(storePath), '刚打开确认框，目录就已经被删了').toBe(true)

  // ④ 点取消 = 明确说"不删"。这一步之后仍有请求或目录不见了，都是产品缺陷。
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(seen.all.length, '点了取消却仍然发出了删除请求 ⇒ 取消按钮只是关了个框').toBe(0)
  expect(existsSync(storePath), '点了取消目录却没了 ⇒ 用户明确拒绝的操作反而执行了').toBe(true)

  // ⑤ 确认后才真删，而且卡片要当场翻面（不能还挂着一个已经不存在的目录）。
  await openButton.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(
    diskCard.getByText('Retired runtime store directory'),
    '删完了卡片还在报旧的体积 ⇒ 用户会以为没删掉，于是再点一次',
  ).toHaveText('Retired runtime store directory: none (directory absent)', { timeout: 20_000 })
  expect(
    existsSync(storePath),
    '界面说删掉了，目录却还在盘上 ⇒ "可回收空间"一直回收不掉，磁盘继续涨',
  ).toBe(false)
  expect(seen.all.length, `删除请求发了 ${seen.all.length} 次 ⇒ 不是"确认一次删一次"`).toBe(1)

  // ⑥ 无可回收时按钮必须禁用，且**点下去也真的不生效**（灰得对 ≠ 灰得好看，
  //    见 docs/dev-gotchas.md「要证明置灰的东西真的点不动」）。
  await expect(openButton).toBeDisabled()
  await openButton.click({ force: true })
  await expect(
    confirmDialog(page),
    '目录已不存在，强行点击仍然弹出了删除确认框 ⇒ 禁用只是画上去的',
  ).toHaveCount(0)
})

// --------------------------------------------------------------------------
// OPS-037 P2 —— 批量归档终态任务：dry-run 预览 → 二次确认 → 真删 + 审计行
// --------------------------------------------------------------------------

test('RFC-319 OPS-037：批量归档先给 dry-run 预览且一行不删，确认后才真删、留审计行，未超期的任务不受牵连 @nightly', async ({
  page,
}) => {
  await primeToken(page)
  const seen = watchRequests(page, 'POST', '/api/tasks/archive')
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const archiveCard = card(page, 'Settled-task archive (removes tasks from the UI)')
  await expect(archiveCard).toBeVisible({ timeout: 30_000 })

  // ① 预览：数字必须与真正会被删掉的那批对上（两棵树 / 三个任务），而且
  //    这一步一行都不许删。数字错了，用户就是照着一个假数字按不可逆的确认。
  await archiveCard.getByTestId('task-archive-run').click()
  const dialog = confirmDialog(page)
  await expect(dialog, '点「立即归档」没有任何二次确认 ⇒ 一次误点就不可逆删任务').toBeVisible({
    timeout: 20_000,
  })
  await expect(
    dialog,
    '确认框里的树/任务数与实际可归档的对不上 ⇒ 用户按的是一个假数字',
  ).toContainText('exports 2 task tree(s)')
  await expect(dialog).toContainText(
    `3 task(s) settled more than ${ARCHIVE_RETENTION_DAYS} days ago`,
  )

  expect(seen.all, '预览阶段就发出了 dryRun:false ⇒ 还没确认，任务已经被删了').toEqual([
    { retentionDays: ARCHIVE_RETENTION_DAYS, dryRun: true },
  ])
  for (const id of [OLD_ROOT_A, OLD_CHILD_A, OLD_ROOT_B, RECENT_ROOT, MIXED_ROOT, MIXED_CHILD]) {
    expect(await taskStatusCode(id), `预览阶段任务 ${id} 就已经不见了`).toBe(200)
  }

  // ② 取消 = 什么都没发生。
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(seen.all.length, '点了取消却又发了一次归档请求').toBe(1)
  expect(await taskStatusCode(OLD_ROOT_A), '点了取消，超期任务却已经被归档').toBe(200)

  // ③ 确认后才真删，并给出与预览一致的完成回执。
  await archiveCard.getByTestId('task-archive-run').click()
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Archive and delete', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(
    archiveCard.getByText('Archived 2 task tree(s), 3 task(s) in total.'),
    '归档跑完没有回执（或数字与预览不一致）⇒ 用户不知道到底删了什么',
  ).toBeVisible({ timeout: 30_000 })

  // 到这里一共三次：预览 → （取消后）再预览 → 执行。**只有最后一次**允许带
  // dryRun:false；前两次里出现任何一条 dryRun:false，都意味着"还没确认就删了"。
  expect(seen.all.length, '确认之后归档请求的次数不是 3（2 次预览 + 1 次执行）').toBe(3)
  expect(seen.all[1], '第二次预览竟然带了 dryRun:false ⇒ 打开确认框这一步就把任务删了').toEqual({
    retentionDays: ARCHIVE_RETENTION_DAYS,
    dryRun: true,
  })
  expect(seen.all[2], '执行那次没有显式带 dryRun:false ⇒ 服务端会把它当成又一次预览').toEqual({
    retentionDays: ARCHIVE_RETENTION_DAYS,
    dryRun: false,
  })

  // ④ 归档 == 删除：前台 404 与不存在同形；而**未超保留期**的那条必须原样活着
  //    ——保留期是这条不可逆操作唯一的护栏，失灵就是"刚跑完的任务被一起卷走"。
  for (const id of [OLD_ROOT_A, OLD_CHILD_A, OLD_ROOT_B]) {
    expect(await taskStatusCode(id), `超期任务 ${id} 归档后仍然查得到 ⇒ 归档没有真的出库`).toBe(404)
  }
  expect(
    await taskStatusCode(RECENT_ROOT),
    '刚结束 1 小时的任务被一起归档了 ⇒ 保留期护栏失灵，不可逆地删掉了在用的数据',
  ).toBe(200)
  // 整树判据的另一半：根早已超期、但树里有一个两小时前才结束的子任务 ⇒ 整棵树不动。
  // 归档的单位是整棵树，一旦只看根的 finished_at，用户昨天刚跑完的子任务会跟着
  // 一棵老树一起被不可逆删除。
  for (const id of [MIXED_ROOT, MIXED_CHILD]) {
    expect(
      await taskStatusCode(id),
      `树里还有刚结束的子任务，整棵树却被归档了（${id}）⇒ 整树判据失灵`,
    ).toBe(200)
  }

  // ⑤ 落盘的归档目录是唯一的考古入口，manifest 必须在。
  for (const rootId of [OLD_ROOT_A, OLD_ROOT_B]) {
    const manifest = join(homeDir, 'archive', 'tasks', rootId, 'manifest.json')
    expect(existsSync(manifest), `${rootId} 从库里删了，盘上却没有归档目录 ⇒ 数据直接蒸发`).toBe(
      true,
    )
  }
  const manifestA = JSON.parse(
    readFileSync(join(homeDir, 'archive', 'tasks', OLD_ROOT_A, 'manifest.json'), 'utf-8'),
  ) as { taskIds: string[] }
  expect(
    [...manifestA.taskIds].sort(),
    '整棵树只导出了根任务 ⇒ 子任务被删掉却没进归档，无法追溯',
  ).toEqual([OLD_CHILD_A, OLD_ROOT_A].sort())

  // ⑥ 审计行必须留下且归因到人（它比被删的任务活得久，是"谁删了什么"的唯一凭据）。
  const audit = querySqlite<{
    source: string
    actor_user_id: string | null
    retention_days: number
    tree_count: number
    task_count: number
  }>(
    dbPath(),
    'SELECT source, actor_user_id, retention_days, tree_count, task_count FROM task_archive_audit',
  )
  expect(audit.length, '手动归档没有留下审计行 ⇒ 谁删了多少任务无从追查').toBe(1)
  expect(audit[0]).toEqual({
    source: 'manual',
    actor_user_id: adminUserId,
    retention_days: ARCHIVE_RETENTION_DAYS,
    tree_count: 2,
    task_count: 3,
  })

  // ⑦ 无可归档时**不弹**确认框（settings.tsx:1210-1213）——"确认删除 0 棵树"
  //    是个无事可确认的对话框，训练用户闭眼点确认。
  await archiveCard.getByTestId('task-archive-run').click()
  await expect(
    archiveCard.getByText(
      `No task tree is old enough to archive (retention: ${ARCHIVE_RETENTION_DAYS} days).`,
    ),
    '没有可归档的树时既不弹框也不给提示 ⇒ 用户点了按钮什么反馈都没有',
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    confirmDialog(page),
    '没有任何可归档的树，却仍然弹出「确认删除」⇒ 用户被训练成闭眼点确认',
  ).toHaveCount(0)
  expect(seen.all.length, '最后一次点击没有发出新的预览请求 ⇒ 提示可能是缓存的旧结果').toBe(4)
  expect(seen.all[3], '空结果那次也不该带 dryRun:false').toEqual({
    retentionDays: ARCHIVE_RETENTION_DAYS,
    dryRun: true,
  })
})

// --------------------------------------------------------------------------
// OPS-X6 P3 —— 任务详情页的「系统恢复」审计横幅 + 解除隔离
// --------------------------------------------------------------------------

test('RFC-319 OPS-X6：被熔断隔离的任务在详情页亮出恢复横幅、展开列出可读的事件，点「解除隔离」后翻回普通历史 @nightly', async ({
  page,
}) => {
  // 隔离标记与恢复事件都只由**系统内部**的熔断器写（services/recoveryBreaker.ts:60-80），
  // 没有任何用户面入口能造出来，只能直连落库。
  const now = Date.now()
  runSqlite(
    dbPath(),
    [
      `UPDATE tasks SET auto_recovery_suspended = 1, auto_recovery_attempts = 4 WHERE id = '${RECENT_ROOT}';`,
      'INSERT INTO recovery_events (id, task_id, actor, kind, reason, created_at) VALUES ' +
        `('01JRFC319OPSRECOVEV00001', '${RECENT_ROOT}', 'system', 'auto-resume', 'resumed after boot', ${now - 120_000});`,
      'INSERT INTO recovery_events (id, task_id, actor, kind, reason, created_at) VALUES ' +
        `('01JRFC319OPSRECOVEV00002', '${RECENT_ROOT}', 'system', 'quarantine', 'attempts 4 exceeded 3', ${now - 60_000});`,
    ].join('\n'),
  )

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/tasks/${RECENT_ROOT}`)
  const banner = page.getByTestId('task-recovery')

  // ① 隔离态必须是**告警**级并说清后果。降级成普通历史条 = 用户看到一条"不动了"
  //    的任务，完全不知道平台已经把它排除在自动恢复之外。
  await expect(
    banner,
    '任务被隔离了，详情页却什么都不说 ⇒ 用户只看到一条卡住的任务，无从判断原因',
  ).toBeVisible({ timeout: 30_000 })
  await expect(banner, '隔离横幅不是 alert ⇒ 读屏用户完全收不到这条状态').toHaveAttribute(
    'role',
    'alert',
  )
  await expect(banner).toContainText('Auto-recovery paused')
  await expect(banner, '只说"暂停"不说为什么 ⇒ 用户不知道这是熔断而不是平台故障').toContainText(
    'quarantined by the circuit-breaker',
  )

  // ② 展开后每一条事件都要是**人话**，而不是裸的 enum。
  await expect(page.getByTestId('task-recovery-list'), '恢复历史默认就展开了').toHaveCount(0)
  await banner.getByTestId('task-recovery-toggle').click()
  const list = page.getByTestId('task-recovery-list')
  await expect(list).toBeVisible()
  await expect(
    list,
    '恢复事件把裸 kind 直接怼给用户（或缺了这条）⇒ 界面泄露内部枚举、用户读不懂',
  ).toContainText('Auto-resumed from the last checkpoint')
  await expect(list).toContainText('Paused auto-recovery after repeated failures')
  await expect(
    list.locator('li'),
    '恢复历史的条数与实际事件数对不上 ⇒ 审计漏了行（或多画了行）',
  ).toHaveCount(2)

  // ③ 「解除隔离」必须真的解除——服务端标记清零、界面当场翻面。
  await banner.getByTestId('task-recovery-clear').click()
  await expect(
    banner.getByTestId('task-recovery-clear'),
    '点了「解除隔离」按钮还在 ⇒ 用户无法判断解除成功没有，只能反复点',
  ).toHaveCount(0, { timeout: 20_000 })
  await expect(banner, '解除之后横幅还挂着告警级 ⇒ 一条已经恢复的任务永远显示告警').toHaveAttribute(
    'role',
    'status',
  )
  await expect(
    banner,
    '解除隔离顺手把恢复历史也抹了 ⇒ "系统对这条任务做过什么"的审计消失',
  ).toContainText('The system auto-recovered this task 2 time(s)')

  const events = (await jsonOf(
    await api(`/api/tasks/${RECENT_ROOT}/recovery-events`),
    'read recovery events',
  )) as { events: unknown[]; suspended: boolean }
  expect(events.suspended, '界面说解除了，服务端仍然是隔离态 ⇒ 自动恢复照旧不会碰它').toBe(false)
  expect(events.events.length, '解除隔离把审计事件一起删了').toBe(2)
  expect(
    querySqlite<{ n: number }>(
      dbPath(),
      `SELECT auto_recovery_attempts AS n FROM tasks WHERE id = '${RECENT_ROOT}'`,
    )[0]?.n,
    '解除隔离没有把熔断计数清零 ⇒ 下一次尝试立刻又被熔断',
  ).toBe(0)
})

// --------------------------------------------------------------------------
// OPS-035 P3 —— 已 arm 的 staged restore 可见且撤得掉 / 失败恢复的隔离目录
// --------------------------------------------------------------------------

test('RFC-319 OPS-035：已 arm 的回滚在设置页亮成告警条并能两击撤销，失败恢复的隔离目录照实列出 @nightly', async ({
  page,
}) => {
  expect(backupPath, 'OPS-033 没有产出备份文件 ⇒ 这条用例没有东西可 arm').not.toBe('')

  // 直接经产品自己的 API arm 一次（这条用例锁的是"arm 之后怎么办"，
  // "怎么 arm"由 OPS-034 从 UI 走一遍）。
  const form = new FormData()
  form.append('file', new Blob([readFileSync(backupPath)]), 'staged.tar.gz')
  const armed = await fetch(`${daemon.baseUrl}/api/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}` },
    body: form,
  })
  expect(
    (await jsonOf(armed, 'arm restore')) as { status: string },
    'POST /api/restore 没有把备份 arm 成 staged',
  ).toMatchObject({ status: 'staged' })

  // 失败恢复的隔离现场：上一次 boot 的 apply 炸了，目录被改名留在盘上
  // （services/pendingRestore.ts:205-212）。它是运维找回现场的唯一线索。
  const quarantineDir = join(homeDir, '.restore-pending.failed-1750000000000')
  mkdirSync(quarantineDir, { recursive: true })
  writeFileSync(
    join(quarantineDir, 'error.txt'),
    'quick_check failed: page 12 malformed\n',
    'utf-8',
  )

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const backupCard = card(page, 'Export backup')
  await expect(backupCard).toBeVisible({ timeout: 30_000 })

  // ① 已 arm 必须**看得见**。看不见的后果最恶劣：下一次重启全站莫名回到上周。
  const pendingBanner = page.getByTestId('restore-pending-banner')
  await expect(
    pendingBanner,
    '已经 arm 了一次全实例回滚，设置页却只字不提 ⇒ 下次重启全站数据无预警回退',
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    pendingBanner,
    '告警条不说清"重启后整实例回滚" ⇒ 用户不知道这条横幅的分量',
  ).toContainText('the whole instance rolls back')

  // ② 失败恢复的隔离目录要照实列出（路径 + 原因），否则现场只能靠 ls 去找。
  const failedBanner = page.getByTestId('restore-failed-banner')
  await expect(
    failedBanner,
    '上一次恢复失败留下的隔离目录没有任何呈现 ⇒ 现场留在盘上却没人知道',
  ).toBeVisible()
  await expect(failedBanner, '隔离条不给目录路径 ⇒ 运维无从找回现场').toContainText(quarantineDir)
  await expect(
    failedBanner,
    '隔离条不给失败原因 ⇒ 用户只知道"失败了"，不知道下一步该做什么',
  ).toContainText('quick_check failed: page 12 malformed')

  // ③ 撤销是**两击**的：第一击只换文案，不发请求。第一击就 DELETE 掉，
  //    等于误点一下就把一次经过深思的 arm 抹了。
  const cancelButton = pendingBanner.getByRole('button', { name: 'Cancel staged restore' })
  await cancelButton.click()
  await expect(
    pendingBanner.getByRole('button', { name: 'Confirm?' }),
    '撤销按钮第一击没有进入确认态 ⇒ 它是个一击生效的按钮',
  ).toBeVisible()
  expect(
    (await restorePending()).pending,
    '撤销按钮第一击就把 staged restore 删了 ⇒ 二次确认形同虚设',
  ).not.toBeNull()

  // ④ 第二击才真撤，且界面当场翻面。
  await pendingBanner.getByRole('button', { name: 'Confirm?' }).click()
  await expect(
    page.getByTestId('restore-pending-banner'),
    '撤销之后告警条还挂着 ⇒ 用户不知道到底撤掉没有，只能重启试试看',
  ).toHaveCount(0, { timeout: 20_000 })
  expect(
    (await restorePending()).pending,
    '界面说撤销了，服务端仍然 arm 着 ⇒ 下次重启照样回滚',
  ).toBeNull()
  expect(
    existsSync(join(homeDir, '.restore-pending')),
    '撤销之后 staged 目录仍留在盘上 ⇒ 下一次 arm 会撞上 409',
  ).toBe(false)

  // 隔离目录是本用例自己造的现场，用完清掉，免得污染 OPS-034 的页面。
  rmSync(quarantineDir, { recursive: true, force: true })
})

// --------------------------------------------------------------------------
// OPS-034 P2 —— 恢复：选文件 → 二次确认后才上传 → staged → 重启才生效
//
// 排在最后：它会重启 daemon，重启后整库回到 OPS-033 那次备份的时间点。
// --------------------------------------------------------------------------

test('RFC-319 OPS-034：选备份文件不上传、取消不上传，确认后才 staged；坏包被拒不 arm；重启才真正生效 @nightly', async ({
  page,
}) => {
  // 这条用例要走一次完整的 graceful shutdown（30s 预算）+ 带 restore 的冷启动，
  // 90s 的默认预算不够；`test.setTimeout` 在用例体内才确定生效。
  test.setTimeout(240_000)
  expect(backupPath, 'OPS-033 没有产出备份文件 ⇒ 这条用例没有东西可恢复').not.toBe('')

  // 往返判据：备份**之后**才建的代理必须在恢复后消失；备份**之前**就有、
  // 现在被删掉的那个必须回来。两个方向都要，只验一个方向的话
  //「什么都没发生」也能过其中一半。
  await expectOk(
    await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: POST_BACKUP_AGENT,
        description: 'created after the backup — must be gone after the restore',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'marker',
      }),
    }),
    `create ${POST_BACKUP_AGENT}`,
  )
  const preBackupAgentId = (
    (
      (await jsonOf(await api('/api/agents'), 'list agents')) as Array<{ id: string; name: string }>
    ).find((row) => row.name === PRE_BACKUP_AGENT) ?? { id: '' }
  ).id
  expect(preBackupAgentId, '找不到备份时点的标记代理 ⇒ 往返判据的一半立不住').not.toBe('')
  // 删除走产品自己的写接口，因此要凑齐 RFC-222 的 type-to-confirm（回抄名字）
  // 与 RFC-231 的双 revision fence（routes/agents.ts:311-320）。
  const preBackupAgent = (await jsonOf(
    await api(`/api/agents/${preBackupAgentId}`),
    'read pre-backup agent',
  )) as { updatedAt: number; aclRevision: number }
  await expectOk(
    await api(`/api/agents/${preBackupAgentId}`, {
      method: 'DELETE',
      body: JSON.stringify({
        confirm: PRE_BACKUP_AGENT,
        expectedUpdatedAt: preBackupAgent.updatedAt,
        expectedAclRevision: preBackupAgent.aclRevision,
      }),
    }),
    `delete ${PRE_BACKUP_AGENT}`,
  )
  expect(await agentNames()).not.toContain(PRE_BACKUP_AGENT)

  await primeToken(page)
  const uploads = watchRequests(page, 'POST', '/api/restore')
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const backupCard = card(page, 'Export backup')
  await expect(backupCard).toBeVisible({ timeout: 30_000 })

  const fileInput = page.getByTestId('restore-file-input')
  const dialog = confirmDialog(page)
  const backupBytes = statSync(backupPath).size

  // ① 选中文件只该**开确认框**。产品在 settings.tsx:1394-1396 明文承诺
  //    "NOTHING is uploaded before Confirm"——这里把它变成机器判据。
  await fileInput.setInputFiles(backupPath)
  await expect(dialog, '选了备份文件却没有任何确认框 ⇒ 误点一次就 arm 了全实例回滚').toBeVisible({
    timeout: 20_000,
  })
  await expect(
    dialog,
    '确认框不说清用的是哪个文件、多大 ⇒ 选错一个相邻的 tar.gz 也看不出来',
  ).toContainText(backupPath.split(/[\\/]/).pop() ?? '')
  await expect(dialog).toContainText(formatMb(backupBytes))
  expect(uploads.all.length, '刚选中文件就上传了 ⇒ 二次确认根本没发生').toBe(0)
  expect((await restorePending()).pending, '刚选中文件就 arm 了一次全实例回滚').toBeNull()

  // ② 取消 = 一个字节都不上传。
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(uploads.all.length, '点了取消仍然上传了备份 ⇒ 取消按钮只是关了个框').toBe(0)
  expect((await restorePending()).pending, '点了取消却 arm 了回滚').toBeNull()

  // ③ 不是备份包的 tarball：确认框**保持打开**并报错，而且绝不许 arm——
  //    arm 一个坏包等于给下一次 boot 埋一个必炸的地雷。
  const notABackup = makeTarGz([{ name: 'readme.txt', body: 'this tarball has no db.sqlite\n' }])

  // 服务端这一侧先取证：它**确实**说得清是哪儿不对（restore.ts:226-229）。
  // 下面浏览器那一侧只断言"报了错、没 arm"，不断言具体文案——因为二者今天对不上，
  // 那是一个真实缺陷（见本文件顶部的分工说明与交付报告 §5）：`POST /api/restore`
  // 的失败体是裸 `{error}`，不是全站统一的 `{ok,code,message}` 信封，于是前端的
  // describeApiError 只能显示一句泛泛的 "Bad request"。这里**故意不**把那句泛泛
  // 文案写进断言——写进去就等于把缺陷锁成契约。
  const probe = new FormData()
  probe.append('file', new Blob([notABackup]), 'not-a-backup.tar.gz')
  const serverRefusal = await fetch(`${daemon.baseUrl}/api/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}` },
    body: probe,
  })
  expect(serverRefusal.status, '一个不含 db.sqlite 的包竟然被服务端接受了').toBe(400)
  expect(
    ((await serverRefusal.json()) as { error?: string }).error ?? '',
    '服务端拒绝时连"缺 db.sqlite"都不说 ⇒ 调用方无从判断该换哪个文件',
  ).toContain('db.sqlite')
  expect((await restorePending()).pending, '一个被判 400 的包竟然还是 arm 上了').toBeNull()

  await fileInput.setInputFiles({
    name: 'not-a-backup.tar.gz',
    mimeType: 'application/gzip',
    buffer: notABackup,
  })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Confirm restore', exact: true }).click()
  await expect(
    dialog.locator('.error-box'),
    '坏包被服务端拒了，界面却什么都不显示 ⇒ 用户以为 arm 成功了，重启才发现什么都没发生',
  ).toBeVisible({ timeout: 20_000 })
  await expect(dialog, '坏包被拒后确认框自己关了 ⇒ 用户失去"换一个文件"的上下文').toBeVisible()
  expect((await restorePending()).pending, '一个不含 db.sqlite 的包竟然被 arm 了').toBeNull()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // ④ 真备份 + 确认 = staged。注意"staged"不等于"已恢复"：此刻库必须原封不动。
  await fileInput.setInputFiles(backupPath)
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Confirm restore', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(
    backupCard.getByText('Staged — restart the daemon to apply'),
    '上传成功却不说"要重启才生效" ⇒ 用户以为已经回滚完了，直接去验数据',
  ).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('restore-pending-banner')).toBeVisible()
  expect(uploads.all.length, `上传次数是 ${uploads.all.length}，不是"确认一次上传一次"`).toBe(2)
  expect((await restorePending()).pending, '界面说 staged 了，服务端却没 arm').not.toBeNull()

  // ⑤ 只 arm 不热切：此刻活着的库仍然是**当前**这一代。热切的后果是正在跑的
  //    任务脚下的数据被换掉。
  expect(
    await agentNames(),
    'arm 之后运行中的库就被换成了备份那一代 ⇒ 发生了热切换，产品承诺的是"never hot-swaps"',
  ).toContain(POST_BACKUP_AGENT)
  expect(await agentNames()).not.toContain(PRE_BACKUP_AGENT)

  // ⑥ 重启才生效：同一个 home 上重起一个 daemon，boot 时 apply。
  await daemon.requestGracefulShutdown()
  daemon = await startDaemon({ home: homeDir })

  const afterRestart = await agentNames()
  expect(
    afterRestart,
    '重启之后 staged restore 没有被 apply ⇒ 用户按提示重启了，数据却纹丝不动',
  ).toContain(PRE_BACKUP_AGENT)
  expect(
    afterRestart,
    '恢复之后备份时点还不存在的代理仍然在 ⇒ 库没有真的回到那个时间点',
  ).not.toContain(POST_BACKUP_AGENT)
  expect(
    (await restorePending()).pending,
    '恢复已经 apply 了，pending 标记却还在 ⇒ 下一次重启会再回滚一遍',
  ).toBeNull()
})

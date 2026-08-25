// RFC-319 —— 插件的 npm registry 全链（RES-30 / RES-32 / RES-33）+ 若干运维 / 工作组缺口。
//
// 为什么这批用例此前一条都没有：`services/pluginInstaller.ts:274-289` spawn 的是**真的**
// `npm install`，环境直接继承 daemon 的 `process.env`（同文件 `runCommand`）。system-mock
// 套件早就带了一台 npm registry（`packages/system-mocks/src/registry/server.ts:70-125`
// 提供 packument + tarball，`suite.ts:426` 把它的 URL 发成 `AW_SYSTEM_MOCK_NPM_REGISTRY_URL`），
// 但 npm 只认 `npm_config_*` —— 少了这一步翻译，任何走 npm 源的用例都会去打真实的
// registry.npmjs.org。`e2e/harness.ts` 的 `mockNpmRegistryEnv()` 就是补上的那一步；
// 它只在 mock 套件在跑时才产出变量，其余调用方拿到的 env 逐字节不变。
//
// 本文件锁住的生产判据（每条都能指到行）：
//   packages/backend/src/services/pluginInstaller.ts:122-141  inferSourceKind：裸包名 ⇒ 'npm'
//   packages/backend/src/services/pluginInstaller.ts:274-289  真 `npm install <spec>`（含版本钉）
//   packages/backend/src/services/pluginInstaller.ts:291-296  npm 源装完读不出版本 ⇒ 安装失败
//   packages/backend/src/services/pluginInstaller.ts:298-317  每次安装写一份不可变 generation manifest
//   packages/backend/src/services/pluginInstaller.ts:500-534  checkForUpdate：探针装到旁路目录后比
//                                                            sourceIdentity；manifest 对不上 ⇒ 'unknown'
//   packages/backend/src/routes/plugins.ts:331-343            upgrade：known ∧ !available ⇒ 原地不动，
//                                                            否则真的 reinstall
//   packages/frontend/src/routes/plugins.detail.tsx:212-217   三种检查结果 ⇒ 三条互斥通知
//   packages/frontend/src/routes/plugins.detail.tsx:437-460   canRebaseline 决定按钮文案与可用性
//
// 执行模型：全文件共用一个 daemon（stub 模式，不跑任何任务），管理员会话直连。每条 test 自己
// seed 自己那一份**唯一命名**的 npm 包，互不依赖，因此可以整批注入变异后按「红了哪几条」逐条
// 归因（故不用 `test.describe.configure({ mode: 'serial' })`）。一次 `page.route` 都不注入：
// 所有分支都由真的动作产生——真 npm、真 registry、真 tarball、真事务。

import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import AxeBuilder from '@axe-core/playwright'
import type { WorkgroupDetail } from '@agent-workflow/shared'
import { SystemMockClient } from '@agent-workflow/system-mocks'

import { developmentEmployeeTypePackage } from '../packages/backend/src/modules/development-automation/composition/employeeTypePackage'
import { describeBlocking } from './axe-blocking'
import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

let daemon: DaemonHandle
let daemonHome: string
let fixtureDir: string
let mocks: SystemMockClient
let leadAgentId = ''
let workerAgentId = ''
let sequence = 0

const PLUGIN_GENERATION_MANIFEST = '.agent-workflow-plugin-generation.json'

/** 内置开发类型包的 exact ref —— 硬抄的版本号必然过期，从生产 descriptor 取。 */
const DEVELOPMENT_TYPE_REF = (
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
    readonly typeRef: { readonly typeId: string; readonly revision: number }
  }
).typeRef
const DEVELOPMENT_TYPE_PATH = `${DEVELOPMENT_TYPE_REF.typeId}%40${DEVELOPMENT_TYPE_REF.revision}`

interface PluginRow {
  id: string
  name: string
  spec: string
  sourceKind: 'npm' | 'git' | 'file'
  resolvedVersion: string | null
  cachedPath: string
  operationConfigHash: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`e2e: ${name} is not set`)
  return value
}

function nextSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

async function rawGet(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  return { status: response.status, body: await response.text() }
}

async function json<T>(path: string, what: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await response.text()
  expect(response.status < 400, `${what}: HTTP ${response.status} ${body}`).toBe(true)
  return (body === '' ? undefined : JSON.parse(body)) as T
}

function errorCodeOf(body: string): string {
  try {
    return (JSON.parse(body) as { code?: string }).code ?? '<no code>'
  } catch {
    return `<not json: ${body.slice(0, 80)}>`
  }
}

interface SeedMember {
  memberType: 'agent' | 'human'
  agentId?: string
  userId?: string
  displayName: string
}

async function seedWorkgroup(name: string, members: SeedMember[]): Promise<WorkgroupDetail> {
  return json<WorkgroupDetail>('/api/workgroups', `seed workgroup ${name}`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 B108 fixture',
      instructions: 'base instructions',
      mode: 'leader_worker',
      leaderDisplayName: members[0]?.displayName,
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 8,
      completionGate: false,
      clarifyBudget: 0,
      fanOut: false,
      members: members.map((member) => ({ roleDesc: '', ...member })),
    }),
  })
}

function readWorkgroup(id: string): Promise<WorkgroupDetail> {
  return json<WorkgroupDetail>(`/api/workgroups/${encodeURIComponent(id)}`, `read workgroup ${id}`)
}

const RESTRICTED_PASSWORD = 'Rfc319B108Pass!1'

/**
 * 一个**只**够建事件自动化规则、但没有开工许可的主体。
 *
 * `development-missions:launch` 在 user/manager/admin 三档基线里都有
 * （`shared/schemas/permission.ts` 的 USER_EXECUTE 组），所以只有从 guest 起步
 * 再逐项补权限，才能造出「建得了规则、开不了工」这个差分。
 */
async function seedRestrictedActor(username: string): Promise<string> {
  await json('/api/users', `seed ${username}`, {
    method: 'POST',
    body: JSON.stringify({
      username,
      displayName: username,
      role: 'guest',
      password: RESTRICTED_PASSWORD,
      additionalPermissions: [
        'event-automation-rules:read',
        'event-automation-rules:create',
        'tasks:execute',
      ],
    }),
  })
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: RESTRICTED_PASSWORD }),
  })
  const body = await login.text()
  expect(login.ok, `login ${username}: ${login.status} ${body}`).toBe(true)
  return (JSON.parse(body) as { sessionToken: string }).sessionToken
}

async function postAs(
  token: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.text() }
}

/**
 * 一个自带的、**解析过软链**的 daemon home。
 *
 * 解析软链的理由见 `beforeAll`（npm 的 package-lock 键按 realpath 算）；这里为了
 * 与本文件其余部分保持同一形状，一并解析。
 */
function freshDaemonHome(tag: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `aw-rfc319-b108-${tag}-`)))
}

function jobTemplatesPath(): string {
  return `/api/digital-employee-types/${encodeURIComponent(`${DEVELOPMENT_TYPE_REF.typeId}@${DEVELOPMENT_TYPE_REF.revision}`)}/job-templates`
}

/**
 * 造一个可以被别人「协同」的数字员工。
 *
 * 协作绑定要求 `getEmployeeDefinitionRevision(targetEmployeeRef)` 能取到
 * （`authoringService.ts` 的 `#validateCollaborationBinding`），所以目标必须是
 * 一个**真的建出来**的员工：先用平台自带的已发布工具凑一份可发布的岗位模板，
 * 发布后再建员工。全程零真实任务。
 */
async function seedCollaborationTargetEmployee(
  name: string,
): Promise<{ id: string; revision: number }> {
  const tools = await json<{
    items: Array<{ id: string; publishedRevision: number; state: string; origin: string }>
  }>(
    `/api/digital-employee-types/${encodeURIComponent(`${DEVELOPMENT_TYPE_REF.typeId}@${DEVELOPMENT_TYPE_REF.revision}`)}/work-items/analyze-implement/tools`,
    'list platform tools',
  )
  const platformTool = tools.items.find(
    (tool) => tool.origin === 'platform' && tool.state === 'published',
  )
  expect(
    platformTool,
    '类型包里一个已发布的平台工具都没有 ⇒ 没法凑出一份可发布的岗位模板',
  ).toBeDefined()
  const job = await json<{ id: string }>(jobTemplatesPath(), `seed job template for ${name}`, {
    method: 'POST',
    body: JSON.stringify({
      name: `${name}-job`,
      description: '',
      defaultToolBindings: [
        {
          workItemRef: 'analyze-implement',
          slotRef: 'default',
          registrationRef: { id: platformTool!.id, revision: platformTool!.publishedRevision },
        },
      ],
      defaultAdapterBindings: [],
      defaultCollaborationBindings: [],
      orderedDispatchConfigurations: [],
      reactionLaneOrder: [],
    }),
  })
  const published = await json<{ ref: { id: string; revision: number } }>(
    `/api/digital-employee-job-templates/${encodeURIComponent(job.id)}/publish`,
    `publish job template for ${name}`,
    { method: 'POST', body: '{}' },
  )
  return json<{ id: string; revision: number }>(
    `/api/digital-employee-types/${encodeURIComponent(`${DEVELOPMENT_TYPE_REF.typeId}@${DEVELOPMENT_TYPE_REF.revision}`)}/employees`,
    `seed employee ${name}`,
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        jobTemplateRef: published.ref,
        workScope: { kind: 'task' },
        toolOverrides: [],
        adapterOverrides: [],
        collaborationOverrides: [],
      }),
    },
  )
}

/** 详情页 header 的 More 弹窗——导出 / 权限 / 删除都住在里面。 */
async function openWorkgroupActions(page: Page): Promise<Locator> {
  await page.getByTestId('workgroup-more-actions').click()
  const actions = page.getByTestId('workgroup-actions-dialog')
  await expect(actions, 'More 弹窗没打开 ⇒ 后面每一条断言都换了前提').toBeVisible({
    timeout: 30_000,
  })
  return actions
}

async function primeAdmin(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

function waitForResponseOn(page: Page, method: string, pathname: string, timeout = 90_000) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === pathname,
    { timeout },
  )
}

/** 通过界面把一个 npm 源插件装出来，返回落库的行。 */
async function createNpmPluginViaUi(page: Page, name: string, spec: string): Promise<PluginRow> {
  await page.goto(`${daemon.baseUrl}/plugins/new`)
  await page.locator('#plugin-field-name').fill(name)
  await page.locator('#plugin-field-spec').fill(spec)
  const created = waitForResponseOn(page, 'POST', '/api/plugins')
  await page.getByTestId('plugin-save-button').click()
  const response = await created
  const body = await response.text()
  expect(response.status(), `安装 ${spec} 应当成功落库，实际 ${response.status()} ${body}`).toBe(
    201,
  )
  const row = JSON.parse(body) as PluginRow
  await expect(page).toHaveURL(new RegExp(`/plugins/${row.id}$`))
  return row
}

/** 这个插件当前有几代 generation 目录（升级 / 重装会新增一代）。 */
function generationDirs(pluginId: string): string[] {
  const root = join(daemon.home, 'plugins', pluginId, 'generations')
  return existsSync(root) ? readdirSync(root).sort() : []
}

/**
 * 把当前这一代的 manifest 删掉 —— 模拟「RFC-271 之前装出来的老代次」。
 * `readGenerationManifestForCachedPath` 读不到就把身份判成 unknown
 * （`pluginInstaller.ts:520-526`），这正是第三种检查结果的唯一入口。
 */
function stripGenerationManifest(pluginId: string): void {
  const dirs = generationDirs(pluginId)
  expect(dirs.length, '一代 generation 都没有 ⇒ 后面删 manifest 的动作是空操作').toBeGreaterThan(0)
  for (const dir of dirs) {
    const manifest = join(
      daemon.home,
      'plugins',
      pluginId,
      'generations',
      dir,
      PLUGIN_GENERATION_MANIFEST,
    )
    if (existsSync(manifest)) rmSync(manifest)
  }
}

/** 打开某个插件详情页的 Updates 页签。 */
async function openUpdatesTab(page: Page, pluginId: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/plugins/${pluginId}`)
  await page.getByTestId('plugin-tab-updates').click()
  await expect(
    page.getByTestId('plugin-panel-updates'),
    'Updates 面板没渲染 ⇒ 下面所有的通知断言都是恒真的',
  ).toBeVisible()
}

/** 点一次「检查更新」并等服务端真的答完。 */
async function runCheck(page: Page, pluginId: string): Promise<void> {
  const done = waitForResponseOn(page, 'POST', `/api/plugins/${pluginId}/check-update`)
  await page.getByTestId('plugin-check-update').click()
  const response = await done
  expect(response.status(), `检查更新被拒了：${response.status()} ${await response.text()}`).toBe(
    200,
  )
}

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  // ⚠️ home 必须是**解析过软链**的真实路径。默认的 `mkdtemp(os.tmpdir())` 在 macOS 上
  // 落在 `/var/folders/…`，而 `/var` 是 `/private/var` 的软链：npm 把 package-lock 的
  // `packages` 键按 realpath 相对根目录算，于是键变成 `../../../../../../private/var/…`，
  // 而 `pluginInstaller.ts:454-459` 只认 `node_modules/<name>`，安装一律以
  // `installed package is missing from package-lock` 收场。生产默认的
  // `~/.agent-workflow` 没有这层软链，所以这是**测试环境**的坑，不是产品行为——
  // 详见回报的产品观察一节。
  daemonHome = realpathSync(mkdtempSync(join(tmpdir(), 'aw-rfc319-b108-')))
  // 刻意**不**调用 `mocks.reset()`：一套 system-mock 服务所有 Playwright worker
  // （`e2e/global-setup.ts`），全局清空会抹掉隔壁 spec 刚 seed 的东西。隔离靠
  // 每条用例一个唯一包名，断言也只按这个包名过滤请求日志。
  daemon = await startDaemon({ home: daemonHome })
  fixtureDir = mkdtempSync(join(tmpdir(), 'rfc319-b108-fixtures-'))
  for (const name of ['rfc319b108lead', 'rfc319b108worker']) {
    const agent = await json<{ id: string }>('/api/agents', `seed agent ${name}`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 B108 fixture',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: '',
      }),
    })
    if (name === 'rfc319b108lead') leadAgentId = agent.id
    else workerAgentId = agent.id
  }
})

test.afterEach(async ({ page }) => {
  // 本文件一条 page.route 都不注入，但仍按 docs/dev-gotchas.md §「page.route 两把锁」
  // 的锁 B 无条件摘一次，省得将来有人加注入时忘了补。
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  // `home` 是自己给的 ⇒ harness 不会清（`keepHome`），自己收尾。
  if (daemonHome !== undefined) rmSync(daemonHome, { recursive: true, force: true })
  if (fixtureDir !== undefined) rmSync(fixtureDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// RES-30 —— 从 npm registry 安装插件（真实 registry 协议）
// ---------------------------------------------------------------------------

test('RFC-319 RES-30: 从 npm registry 装插件——真的取了 packument 与那一版的 tarball，钉死的版本压过 latest 落进 resolvedVersion @nightly', async ({
  page,
}) => {
  const pkg = nextSlug('rfc319-res30-pkg')
  // 仓库里同时存在两版，且 latest 是 2.0.0（registry/server.ts:112 取最后写入的那个）。
  // 用例钉 1.0.0，于是「装到 1.0.0」既证明 spec 里的版本被真的送进了 npm，也把
  // 「随便拿 latest 充数」这种实现挡在外面——判据能区分「变了」和「算对了」。
  await mocks.seedNpm({ name: pkg, version: '1.0.0' })
  await mocks.seedNpm({ name: pkg, version: '2.0.0' })

  await primeAdmin(page)
  const row = await createNpmPluginViaUi(page, nextSlug('rfc319-res30'), `${pkg}@1.0.0`)

  expect(row.sourceKind, '裸包名被判成 npm 之外的源 ⇒ 整条 registry 链路根本没走').toBe('npm')
  expect(
    row.resolvedVersion,
    '钉了 1.0.0 却落库成别的版本 ⇒ 用户以为自己锁住了版本，实际装的是仓库里最新的那个',
  ).toBe('1.0.0')

  // 真的经过了 registry 协议：packument 一次 + 恰好那一版的 tarball 一次。
  const npmRequests = (await mocks.requests('npm')).filter((r) => r.path.includes(pkg))
  const paths = npmRequests.map((r) => r.path)
  expect(
    paths.some((p) => p === `/npm/${pkg}`),
    `registry 上没有出现 /npm/${pkg} 的元数据请求 ⇒ 这次安装没走 registry 协议（实际打到的路径：${paths.join(', ')}）`,
  ).toBe(true)
  expect(
    paths.some((p) => p === `/npm/${pkg}/-/${pkg}-1.0.0.tgz`),
    `没有取 1.0.0 的 tarball ⇒ 装出来的东西不是 registry 发的那一份（实际：${paths.join(', ')}）`,
  ).toBe(true)
  expect(
    paths.filter((p) => p.endsWith('-2.0.0.tgz')),
    '钉了 1.0.0 却把 2.0.0 的包也拉了下来 ⇒ 版本钉根本没送到 npm',
  ).toEqual([])

  // 界面上也得说清是哪一版 —— 落库对了但界面显示成别的，用户一样会误判。
  await openUpdatesTab(page, row.id)
  await expect(
    page.locator('.plugin-updates__row code'),
    'Updates 面板显示的版本与落库的版本不一致 ⇒ 用户据以决定要不要升级的那个数字是假的',
  ).toHaveText('1.0.0')
})

// ---------------------------------------------------------------------------
// RES-32 —— 检查更新的三种结果
// ---------------------------------------------------------------------------

test('RFC-319 RES-32: 插件检查更新的三种结果——已是最新 / 有新版且点名版本号 / 基线身份未知，三条通知互斥且各自决定升级按钮的文案与可用性 @nightly', async ({
  page,
}) => {
  const pkg = nextSlug('rfc319-res32-pkg')
  await mocks.seedNpm({ name: pkg, version: '1.0.0' })

  await primeAdmin(page)
  const row = await createNpmPluginViaUi(page, nextSlug('rfc319-res32'), pkg)
  expect(row.resolvedVersion, '不钉版本时应当装到当时的 latest').toBe('1.0.0')

  const panel = page.getByTestId('plugin-panel-updates')
  const upgradeButton = page.getByTestId('plugin-upgrade')
  await openUpdatesTab(page, row.id)

  // 检查之前：空态在，三条结论通知一条都不该在。
  await expect(
    page.getByTestId('plugin-update-empty'),
    '没检查过就直接给结论 ⇒ 用户会把陈旧判断当成刚查过的结果',
  ).toBeVisible()

  // ① 已是最新 —— registry 里还是 1.0.0。
  await runCheck(page, row.id)
  await expect(
    panel.getByText('This saved plugin is up to date.', { exact: true }),
    '仓库里没有新版，却没给出「已是最新」的结论',
  ).toBeVisible()
  await expect(
    panel.getByText('Update ready', { exact: true }),
    '同时给出「已是最新」和「有新版」两条结论 ⇒ 三态不互斥，用户不知道该信哪条',
  ).toHaveCount(0)
  await expect(
    upgradeButton,
    '已经是最新了升级按钮却可点 ⇒ 用户会去点一次什么都不会发生的升级',
  ).toBeDisabled()

  // ② 有新版 —— 往 registry 里放 2.0.0，结论必须点名这个版本号。
  await mocks.seedNpm({ name: pkg, version: '2.0.0' })
  await runCheck(page, row.id)
  await expect(
    panel.getByText('Version 2.0.0 is available for this exact saved plugin.', { exact: true }),
    '有新版时没有把版本号写进结论（或写成了别的版本）⇒ 用户不知道自己将升到哪一版',
  ).toBeVisible()
  await expect(
    panel.getByText('This saved plugin is up to date.', { exact: true }),
    '「有新版」与「已是最新」同时在场 ⇒ 三态不互斥',
  ).toHaveCount(0)
  await expect(upgradeButton, '查出有新版，升级按钮却点不动').toBeEnabled()
  await expect(
    upgradeButton,
    '有新版时按钮应当是 Upgrade，写成 Reinstall baseline ⇒ 把升级说成了重装',
  ).toHaveText('Upgrade')

  // ③ 身份未知 —— 抹掉不可变代次的 manifest，比对失去基线。
  stripGenerationManifest(row.id)
  await runCheck(page, row.id)
  await expect(
    panel.getByText('Update baseline is unknown', { exact: true }),
    '基线没了却仍按「有新版 / 已是最新」下结论 ⇒ 这个判断没有任何依据',
  ).toBeVisible()
  await expect(
    panel.getByText('Version 2.0.0 is available for this exact saved plugin.', { exact: true }),
    '身份未知时还留着上一次「有新版」的结论 ⇒ 用户会照着一条已经失效的判断去升级',
  ).toHaveCount(0)
  await expect(
    upgradeButton,
    '身份未知时按钮仍写 Upgrade ⇒ 用户以为自己在升版本，实际做的是重建基线',
  ).toHaveText('Reinstall baseline')
})

// ---------------------------------------------------------------------------
// RES-33 —— 升级 / 重装基线
// ---------------------------------------------------------------------------

test('RFC-319 RES-33: 插件升级换到新的不可变代次并把版本推进，身份未知时的「重装基线」装完真的把基线补回来 @nightly', async ({
  page,
}) => {
  const pkg = nextSlug('rfc319-res33-pkg')
  await mocks.seedNpm({ name: pkg, version: '1.0.0' })

  await primeAdmin(page)
  const row = await createNpmPluginViaUi(page, nextSlug('rfc319-res33'), pkg)
  const firstGeneration = generationDirs(row.id)
  expect(firstGeneration, '安装完却没有留下不可变代次目录').toHaveLength(1)

  const panel = page.getByTestId('plugin-panel-updates')
  await openUpdatesTab(page, row.id)

  // ① 真的有新版 ⇒ 升级换代次、换版本号。
  await mocks.seedNpm({ name: pkg, version: '2.0.0' })
  await runCheck(page, row.id)
  const upgraded = waitForResponseOn(page, 'POST', `/api/plugins/${row.id}/upgrade`)
  await page.getByTestId('plugin-upgrade').click()
  expect((await upgraded).status(), '升级请求被拒').toBe(200)
  await expect(
    panel.getByText('Upgrade published a new immutable plugin generation.', { exact: true }),
    '升级完没有给出成功结论 ⇒ 用户不知道这一次到底成没成',
  ).toBeVisible()
  await expect(
    page.locator('.plugin-updates__row code'),
    '升级完面板上的版本还停在旧版 ⇒ 用户会重复点升级',
  ).toHaveText('2.0.0')

  const afterUpgrade = await json<PluginRow>(`/api/plugins/${row.id}`, 'read plugin after upgrade')
  expect(afterUpgrade.resolvedVersion, '界面说升到 2.0.0，落库的却不是').toBe('2.0.0')
  const secondGeneration = generationDirs(row.id)
  expect(
    secondGeneration.length,
    '升级没有产生新的一代 ⇒ 说明是就地覆盖，不是不可变代次',
  ).toBeGreaterThan(firstGeneration.length)
  expect(
    afterUpgrade.cachedPath.includes(firstGeneration[0]!),
    '升级后 cachedPath 还指着老代次 ⇒ 运行时用的仍是旧代码',
  ).toBe(false)

  // ② 已是最新 ⇒ 升级按钮不可点（不是「点了什么都不发生」，是根本点不动）。
  await runCheck(page, row.id)
  await expect(
    page.getByTestId('plugin-upgrade'),
    '已经在最新版了升级按钮还可点 ⇒ 用户会去点一次注定无事发生的升级',
  ).toBeDisabled()

  // ③ 基线丢了 ⇒ 「重装基线」得真的把基线补回来：重装之后再查一次必须回到「已是最新」。
  stripGenerationManifest(row.id)
  await runCheck(page, row.id)
  await expect(
    panel.getByText('Update baseline is unknown', { exact: true }),
    '抹掉 manifest 之后仍认为基线已知 ⇒ 这条「重装基线」分支根本不可达',
  ).toBeVisible()
  const rebaselined = waitForResponseOn(page, 'POST', `/api/plugins/${row.id}/upgrade`)
  await page.getByTestId('plugin-upgrade').click()
  expect((await rebaselined).status(), '重装基线请求被拒').toBe(200)

  const afterRebaseline = await json<PluginRow>(
    `/api/plugins/${row.id}`,
    'read plugin after rebaseline',
  )
  expect(
    generationDirs(row.id).length,
    '重装基线没有产生新的一代 ⇒ 那个没有 manifest 的代次还在被用',
  ).toBeGreaterThan(secondGeneration.length)
  expect(
    existsSync(
      join(
        daemon.home,
        'plugins',
        row.id,
        'generations',
        generationDirs(row.id).at(-1)!,
        PLUGIN_GENERATION_MANIFEST,
      ),
    ),
    '重装完新代次里仍然没有 manifest ⇒ 基线没补回来，下次检查还会是 unknown',
  ).toBe(true)
  expect(afterRebaseline.resolvedVersion, '重装基线把版本改了 ⇒ 它不该是一次升级').toBe('2.0.0')

  await runCheck(page, row.id)
  await expect(
    panel.getByText('This saved plugin is up to date.', { exact: true }),
    '重装基线之后再查仍不是「已是最新」⇒ 基线并没有真的建立起来',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// WG-06 —— 导出工作组资源包（expectedVersion fence + 脏/忙禁用）
// ---------------------------------------------------------------------------

test('RFC-319 WG-06: 导出工作组资源包——干净时带着当前版本 fence 真的落一份 zip，陈旧与畸形 fence 各自被拒，半截草稿下按钮点不动也发不出请求 @nightly', async ({
  page,
}) => {
  const group = await seedWorkgroup(nextSlug('rfc319-wg06'), [
    { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead' },
  ])
  await primeAdmin(page)
  const exportPath = `/api/workgroups/${group.id}/export-package`
  const exportRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === exportPath) exportRequests.push(url.search)
  })

  await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')

  // ---- 1) 干净时：真的下来一份 zip，且 fence 是**当前**版本 ----
  await openWorkgroupActions(page)
  const exportButton = page.getByTestId('export-package-workgroup')
  await expect(exportButton, '干净的工作组导不出去 ⇒ 这条能力整个不可达').toBeEnabled()
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()])
  const savedTo = join(fixtureDir, 'rfc319-wg06.awpkg.zip')
  await download.saveAs(savedTo)
  expect(
    download.suggestedFilename(),
    '导出的文件名没点名这是哪个工作组的包 ⇒ 一次导多个就分不清了',
  ).toBe(`workgroup-${group.name}.awpkg.zip`)
  expect(
    readFileSync(savedTo).subarray(0, 2).toString('latin1'),
    '落盘的不是 zip ⇒ 用户拿到一个导入侧根本认不出的文件',
  ).toBe('PK')
  expect(
    exportRequests,
    `导出请求没有带上当前版本的 fence ⇒ 「所见即所导」的保护是画上去的（实际 query：${exportRequests.join(' | ')}）`,
  ).toEqual([`?expectedVersion=${group.version}`])

  // ---- 2) fence 本身真的被服务端校验：陈旧 409、畸形 422 ----
  const stale = await rawGet(`${exportPath}?expectedVersion=${group.version + 1}`)
  expect(
    [stale.status, errorCodeOf(stale.body)],
    '陈旧 fence 也照导 ⇒ 用户导出的是自己没看过的那一版',
  ).toEqual([409, 'package-root-changed'])
  const malformed = await rawGet(`${exportPath}?expectedVersion=`)
  expect(
    [malformed.status, errorCodeOf(malformed.body)],
    '空 fence 被当成「不做保护」放行 ⇒ 静默降级比报错糟得多',
  ).toEqual([422, 'package-invalid'])

  // ---- 3) 半截成员草稿：按钮不可点，且强行点也发不出请求 ----
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workgroup-actions-dialog')).toHaveCount(0)
  await page.getByTestId('workgroup-add-agent-member').click()
  await page.getByTestId('workgroup-member-displayname-input').fill('HalfTyped')
  await expect(
    page.getByTestId('workgroup-draft-phase'),
    '半截草稿时仍显示已保存 ⇒ 后面的「禁用」断言就换了个前提',
  ).toHaveText('Waiting for corrections')

  await openWorkgroupActions(page)
  const dirtyExport = page.getByTestId('export-package-workgroup')
  await expect(
    dirtyExport,
    '草稿没保存也能导 ⇒ 导出的内容与用户屏幕上看到的不是同一份',
  ).toBeDisabled()
  await expect(
    dirtyExport,
    '禁用了却不说为什么 ⇒ 用户只看到一个点不动的按钮，不知道该先做什么',
  ).toContainText('Save the current changes before exporting.')
  const before = exportRequests.length
  await dirtyExport.click({ force: true }).catch(() => undefined)
  // 给「置灰只是画上去的、点了照样发请求」一个真实的发送机会：先做一次真的往返当同步点。
  await rawGet(`/api/workgroups/${group.id}`)
  expect(
    exportRequests.length,
    '按钮画成灰的，强行点下去仍然把请求发了出去 ⇒ 禁用只是视觉效果',
  ).toBe(before)
})

// ---------------------------------------------------------------------------
// WG-X2 —— 成员画廊 ↔ 上下文面板的三态选择
// ---------------------------------------------------------------------------

test('RFC-319 WG-X2: 成员画廊与右侧面板的三态互斥——默认 config、点卡进成员、加成员进草稿态；面板内 Esc 归位并把焦点还给触发它的那张卡；保存把成员 id 全换了一遍，选中仍钉在同一张卡上 @nightly', async ({
  page,
}) => {
  const group = await seedWorkgroup(nextSlug('rfc319-wgx2'), [
    { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead' },
    { memberType: 'agent', agentId: workerAgentId, displayName: 'Builder' },
  ])
  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')

  const configEntry = page.getByTestId('workgroup-config-entry')
  const builderCard = page.getByTestId('workgroup-card-open-Builder')
  const leadCard = page.getByTestId('workgroup-card-open-Lead')

  // ---- ① 默认态 = config，且没有任何一张成员卡是选中的 ----
  await expect(
    configEntry,
    '打开工作组时右侧面板不是配置态 ⇒ 用户第一眼看到的是一个不知从何而来的成员编辑器',
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(builderCard).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('workgroup-field-instructions')).toBeVisible()

  // ---- ② 点卡 ⇒ 进 member 态，且与 config 互斥 ----
  await builderCard.click()
  await expect(
    builderCard,
    '点了成员卡它自己却没进选中态 ⇒ 用户看不出右边编辑的到底是哪一位',
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(
    configEntry,
    '成员卡选中了配置入口还亮着 ⇒ 两个「当前选中」同时在场，用户无从判断面板归谁',
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('workgroup-member-displayname-input')).toHaveValue('Builder')
  await expect(page.getByTestId('workgroup-field-instructions')).toHaveCount(0)

  // ---- ③ 面板内 Esc ⇒ 回 config，并把焦点还给触发它的那张卡 ----
  await page.getByTestId('workgroup-member-displayname-input').press('Escape')
  await expect(
    configEntry,
    '面板里按 Esc 没有归位 ⇒ 键盘用户没有任何办法退出成员编辑器',
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(builderCard).toHaveAttribute('aria-expanded', 'false')
  await expect(
    builderCard,
    'Esc 之后焦点掉回了页面开头 ⇒ 键盘用户得从头 Tab 一遍才能回到刚才那张卡',
  ).toBeFocused()

  // ---- ④ 加成员 ⇒ 进 add 草稿态，三态仍互斥 ----
  await page.getByTestId('workgroup-add-agent-member').click()
  await expect(page.getByTestId('workgroup-panel-add')).toBeVisible()
  await expect(configEntry, '进了「新增成员」草稿态配置入口还亮着 ⇒ 三态不互斥').toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(builderCard).toHaveAttribute('aria-expanded', 'false')
  await expect(leadCard).toHaveAttribute('aria-expanded', 'false')
  await page.getByTestId('workgroup-panel-close').click()
  await expect(configEntry).toHaveAttribute('aria-expanded', 'true')

  // ---- ⑤ 保存会把成员 id 全部重铸；选中锚在本地 key 上，不能跟着 id 一起丢 ----
  const idsBefore = (await readWorkgroup(group.id)).members.map((m) => m.id).sort()
  await builderCard.click()
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/workgroups/${group.id}`,
  )
  await page.getByTestId('workgroup-member-role-input').fill('reviews the diff')
  const receipt = await saved
  expect(receipt.ok(), `自动保存被拒：${receipt.status()}`).toBe(true)

  const idsAfter = (await readWorkgroup(group.id)).members.map((m) => m.id).sort()
  // 这一条是上面那条断言的**前提**：服务端哪天改成保留成员 id，「保持选中」就变成恒真的了。
  expect(
    idsAfter,
    '保存后成员 id 没变 ⇒ 「id 重铸后仍保持选中」这条判据失去了对象，下面的断言恒真',
  ).not.toEqual(idsBefore)
  await expect(
    page.getByTestId('workgroup-card-open-Builder'),
    '一次自动保存就把选中弄丢了 ⇒ 改一个字段，右侧面板就跳回配置态，用户得重新找回刚才那位成员',
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(
    page.getByTestId('workgroup-member-role-input'),
    '保存后面板还在，但编辑的已经不是刚才那位 ⇒ 接着敲的字会落到别人身上',
  ).toHaveValue('reviews the diff')
})

// ---------------------------------------------------------------------------
// EVENT-20 —— 事件自动化的四类启动目标
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-20: 事件自动化的四类启动目标——工作流 / Agent / 工作组 / 数字员工各自的分支字段都真的落库读得回来，只有数字员工那一类额外要一张启动许可；界面上四选一会把不属于本类的字段整块换掉 @nightly', async ({
  page,
}) => {
  const workflow = await json<{ id: string }>('/api/workflows', 'seed workflow', {
    method: 'POST',
    body: JSON.stringify({
      name: nextSlug('rfc319-evt20-wf'),
      description: 'RFC-319 B108 fixture',
      definition: { $schema_version: 1, nodes: [], edges: [] },
    }),
  })
  const group = await seedWorkgroup(nextSlug('rfc319-evt20-wg'), [
    { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead' },
  ])

  const event = { id: 'code-host.branch.pushed', revision: 1 }
  const targets = {
    workflow: {
      kind: 'workflow',
      refId: workflow.id,
      nameTemplate: 'push on {{trigger.code_host.branch}}',
      inputs: { repo: '{{trigger.code_host.repo_path}}' },
    },
    agent: {
      kind: 'agent',
      refId: leadAgentId,
      nameTemplate: 'triage {{trigger.code_host.branch}}',
      descriptionTemplate: 'look at {{trigger.code_host.repo_path}}',
      inputs: { brief: '{{trigger.code_host.branch}}' },
    },
    workgroup: {
      kind: 'workgroup',
      refId: group.id,
      nameTemplate: 'review {{trigger.code_host.branch}}',
      goalTemplate: 'decide whether {{trigger.code_host.repo_path}} needs a fix',
    },
    'digital-employee': {
      kind: 'digital-employee',
      refId: 'rfc319-b108-employee',
      intakeKind: 'body',
      target: { repositoryId: '{{trigger.code_host.repo_path}}' },
      valueTemplate: 'handle {{trigger.code_host.branch}}',
    },
  } as const

  // ---- 1) 四类各建一条：分支字段一个不漏地落库，读回来还是那一类 ----
  const createdIds: Record<string, string> = {}
  for (const [kind, target] of Object.entries(targets)) {
    const created = await json<{ id: string; target: Record<string, unknown> }>(
      '/api/event-center/response-rules',
      `create ${kind} rule`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: nextSlug(`rfc319-evt20-${kind}`),
          enabled: true,
          eventTypeRef: event,
          subjectMatch: 'prefix',
          subjectPattern: 'rfc319/',
          target,
        }),
      },
    )
    createdIds[kind] = created.id
  }
  const listed = await json<{
    items: Array<{ id: string; target: Record<string, unknown> }>
  }>('/api/event-center/response-rules', 'list response rules')
  const byId = new Map(listed.items.map((rule) => [rule.id, rule.target]))
  for (const [kind, target] of Object.entries(targets)) {
    expect(
      byId.get(createdIds[kind]!),
      `${kind} 这一类启动目标读回来时字段变了 ⇒ 事件真的来了会按一份走样的定义开工`,
    ).toEqual(target)
  }

  // ---- 2) 只有「数字员工」那一类多一道启动许可；另外三类不受它影响 ----
  const restricted = await seedRestrictedActor('rfc319b108evt20')
  for (const kind of ['workflow', 'agent', 'workgroup'] as const) {
    const allowed = await postAs(restricted, '/api/event-center/response-rules', {
      name: nextSlug(`rfc319-evt20-ok-${kind}`),
      enabled: true,
      eventTypeRef: event,
      subjectMatch: 'all',
      subjectPattern: null,
      target: targets[kind],
    })
    expect(
      allowed.status,
      `${kind} 这一类也被启动许可挡住了 ⇒ 权限门套到了不该套的三类目标上（${allowed.body}）`,
    ).toBe(201)
  }
  const refused = await postAs(restricted, '/api/event-center/response-rules', {
    name: nextSlug('rfc319-evt20-denied'),
    enabled: true,
    eventTypeRef: event,
    subjectMatch: 'all',
    subjectPattern: null,
    target: targets['digital-employee'],
  })
  expect(
    [refused.status, errorCodeOf(refused.body)],
    '没有开工许可的人也能建「派给数字员工」的自动化规则 ⇒ 谁能建规则谁就能替平台开工',
  ).toEqual([403, 'forbidden'])
  expect(refused.body, '拒了却不说缺哪一项权限 ⇒ 用户不知道该找谁要什么').toContain(
    'development-missions:launch',
  )

  // ---- 3) 界面上四选一：每一类只留自己的字段 ----
  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/events?tab=subscriptions`)
  await page.getByTestId('event-response-rule-new').click()
  const kindPicker = page.getByTestId('event-response-target-kind')
  await expect(
    kindPicker.getByRole('radio'),
    '执行方式不是四选一 ⇒ 有一类启动目标在界面上根本选不到',
  ).toHaveCount(4)

  const nameTemplate = page.getByTestId('event-response-name-template')
  const agentDescription = page.getByTestId('event-response-agent-description')
  const workgroupGoal = page.getByTestId('event-response-workgroup-goal')

  await page.getByTestId('event-response-target-kind-workflow').click()
  await expect(nameTemplate, '选了工作流却没有任务名称模板').toBeVisible()
  await expect(agentDescription, '工作流分支里混进了 Agent 专属的任务说明').toHaveCount(0)
  await expect(workgroupGoal, '工作流分支里混进了工作组专属的工作目标').toHaveCount(0)

  await page.getByTestId('event-response-target-kind-agent').click()
  await expect(agentDescription, '选了 Agent 却没有本轮任务说明').toBeVisible()
  await expect(workgroupGoal, 'Agent 分支里混进了工作组专属的工作目标').toHaveCount(0)

  await page.getByTestId('event-response-target-kind-workgroup').click()
  await expect(workgroupGoal, '选了工作组却没有工作目标输入').toBeVisible()
  await expect(agentDescription, '工作组分支里还留着上一类的任务说明').toHaveCount(0)

  await page.getByTestId('event-response-target-kind-digital-employee').click()
  await expect(
    nameTemplate,
    '派给数字员工时还让人填任务名称 ⇒ 那个值最终没人用，纯粹是误导',
  ).toHaveCount(0)
  await expect(workgroupGoal, '数字员工分支里还留着工作组的工作目标').toHaveCount(0)
  await expect(agentDescription, '数字员工分支里还留着 Agent 的任务说明').toHaveCount(0)
})

// ---------------------------------------------------------------------------
// DE-44 —— 数字员工各页面的可访问性
// ---------------------------------------------------------------------------

test('RFC-319 DE-44: 数字员工的四张工作面（类型列表 / 员工 / 岗位模板 / 工具箱）逐张过 axe，critical 与 serious 一条都不许有 @nightly', async ({
  page,
}) => {
  await primeAdmin(page)
  const surfaces: Array<{ url: string; ready: () => Promise<void> }> = [
    {
      url: `${daemon.baseUrl}/digital-employees`,
      ready: async () => {
        await expect(
          page.getByTestId('digital-employee-type-list'),
          '类型列表没渲染 ⇒ 这一轮扫的是一张空页面，零违规是恒真的',
        ).toBeVisible()
      },
    },
    ...(['employees', 'jobs', 'toolbox'] as const).map((view) => ({
      url: `${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}?view=${view}`,
      ready: async () => {
        await expect(
          page.getByRole('tab', { selected: true }),
          `${view} 页签没被选中 ⇒ 扫描发生在页面还没落位的时候`,
        ).toBeVisible()
      },
    })),
  ]

  for (const surface of surfaces) {
    await page.goto(surface.url)
    await surface.ready()
    const scan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      // 画布内部（xyflow 的拖拽把手 / 边标签）是第三方 SVG，自带另一套 a11y 叙事；
      // 与既有 a11y spec 保持同一条排除线，扫的是它周围的页面骨架。
      .exclude('.react-flow__renderer')
      .exclude('.react-flow__attribution')
      .analyze()
    expect(
      describeBlocking(scan),
      `${surface.url} 上有 critical/serious 级可访问性违规 ⇒ 读屏 / 键盘用户在这一页会卡住`,
    ).toEqual([])
  }
})

// ---------------------------------------------------------------------------
// DE-X2 —— 岗位模板的员工协作绑定与 dispatch 节点「工具 ↔ 员工协作」切换
// ---------------------------------------------------------------------------

test('RFC-319 DE-X2: 岗位模板把一条 dispatch 路由派给数字员工——协作路由不许绑工具、工具路由不许缺工具、协作绑定的工作项/契约/目标员工三层各自拦得住；界面上「处理方式」一切换，工具选择器与员工选择器整块互换 @nightly', async ({
  page,
}) => {
  const employee = await seedCollaborationTargetEmployee(nextSlug('rfc319-dex2-target'))
  const collaborationRoute = {
    routeRef: 'rfc319-delegate',
    displayName: 'Hand it to another employee',
    description: '',
    destinationWorkItemRef: 'delegate',
    registrationRef: null,
    fallback: true,
  }
  const collaborationBinding = {
    workItemRef: 'delegate',
    memberRef: 'primary',
    targetEmployeeRef: { id: employee.id, revision: employee.revision },
    invocationContractId: 'development.cross-repository-work',
    joinMode: 'all',
    quorum: null,
  }
  const baseBody = {
    name: nextSlug('rfc319-dex2-job'),
    description: '',
    defaultToolBindings: [],
    defaultAdapterBindings: [],
    defaultCollaborationBindings: [collaborationBinding],
    orderedDispatchConfigurations: [
      { classifierWorkItemRef: 'classify-pipeline', routes: [collaborationRoute] },
    ],
    reactionLaneOrder: [],
  }

  // ---- 1) 正向：协作路由与协作绑定原样落库 ----
  const created = await json<{ id: string }>(jobTemplatesPath(), 'create job template', {
    method: 'POST',
    body: JSON.stringify(baseBody),
  })
  const listed = await json<{
    items: Array<{
      id: string
      draft: {
        defaultCollaborationBindings: unknown[]
        orderedDispatchConfigurations: Array<{ routes: unknown[] }>
      }
    }>
  }>(jobTemplatesPath(), 'list job templates')
  const stored = listed.items.find((item) => item.id === created.id)
  expect(stored, '刚建的岗位模板在列表里找不到').toBeDefined()
  expect(
    stored!.draft.orderedDispatchConfigurations[0]?.routes,
    '派给数字员工的那条路由没有原样落库（尤其 registrationRef 必须是 null）⇒ 事件真到了会走一条走样的分派',
  ).toEqual([collaborationRoute])
  expect(
    stored!.draft.defaultCollaborationBindings,
    '协作绑定没有原样落库 ⇒ 岗位模板说好的协同对象在执行时对不上',
  ).toEqual([collaborationBinding])

  // ---- 2) 五条拒绝分支各自点名不同的原因 ----
  const rejections: Array<[string, unknown, string]> = [
    [
      '协作路由却绑了工具',
      {
        ...baseBody,
        name: nextSlug('rfc319-dex2-bad'),
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [{ ...collaborationRoute, registrationRef: { id: 'whatever', revision: 1 } }],
          },
        ],
      },
      'employee-ordered-dispatch-tool-invalid',
    ],
    [
      '工具路由却没带工具',
      {
        ...baseBody,
        name: nextSlug('rfc319-dex2-bad'),
        orderedDispatchConfigurations: [
          {
            classifierWorkItemRef: 'classify-pipeline',
            routes: [{ ...collaborationRoute, destinationWorkItemRef: 'repair-pipeline' }],
          },
        ],
      },
      'employee-ordered-dispatch-tool-missing',
    ],
    [
      '把协作绑定挂在一个不是协作节点的工作项上',
      {
        ...baseBody,
        name: nextSlug('rfc319-dex2-bad'),
        defaultCollaborationBindings: [{ ...collaborationBinding, workItemRef: 'repair-pipeline' }],
      },
      'employee-collaboration-binding-invalid',
    ],
    [
      '调用契约写错',
      {
        ...baseBody,
        name: nextSlug('rfc319-dex2-bad'),
        defaultCollaborationBindings: [
          { ...collaborationBinding, invocationContractId: 'development.not-a-contract' },
        ],
      },
      'employee-collaboration-contract-invalid',
    ],
    [
      '目标员工的那一版取不到',
      {
        ...baseBody,
        name: nextSlug('rfc319-dex2-bad'),
        defaultCollaborationBindings: [
          {
            ...collaborationBinding,
            targetEmployeeRef: { id: employee.id, revision: employee.revision + 99 },
          },
        ],
      },
      'employee-collaboration-target-unavailable',
    ],
  ]
  for (const [what, body, code] of rejections) {
    const response = await fetch(`${daemon.baseUrl}${jobTemplatesPath()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    expect(
      [response.status >= 400, errorCodeOf(text)],
      `${what} 没有被拦住（或拦住了却说成别的原因）⇒ 一份自相矛盾的岗位模板会一路走到执行期才炸`,
    ).toEqual([true, code])
  }

  // ---- 3) 界面：这条路由被画成「协同」，节点编辑器给的是员工选择器 ----
  await primeAdmin(page)
  await page.goto(
    `${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}?view=jobs&jobTemplateId=${created.id}`,
  )
  const editor = page.getByTestId('employee-job-template-editor')
  await expect(editor, '岗位模板编辑器没打开 ⇒ 下面的断言全部换了前提').toBeVisible()
  const routeCard = page.locator('[data-dispatch-route-key]').first()
  await expect(
    routeCard,
    '派给数字员工的路由在职责地图上仍被标成 Tool ⇒ 用户看不出这一格其实是交给别人做',
  ).toContainText('Collaboration')
  await expect(routeCard).toHaveClass(/employee-toolbox-card--collaboration/)

  await routeCard.click()
  const nodeEditor = page.getByTestId('employee-dispatch-node-editor')
  await expect(nodeEditor, 'dispatch 节点编辑器打不开').toBeVisible()
  const employeeField = nodeEditor
    .locator('label.form-field')
    .filter({ hasText: 'Employee for this failure type' })
  const toolField = nodeEditor
    .locator('label.form-field')
    .filter({ hasText: 'Tool for this failure type' })
  await expect(
    employeeField,
    '协作节点没有给出员工选择器 ⇒ 这条路由永远填不上协同对象',
  ).toBeVisible()
  await expect(
    toolField,
    '协作节点上还摆着工具选择器 ⇒ 用户会去选一个后端明确拒收的工具',
  ).toHaveCount(0)

  // ---- 4) 切到「自动修复工具」：两个选择器整块互换 ----
  await nodeEditor
    .locator('label.form-field')
    .filter({ hasText: 'Handler' })
    .getByRole('combobox')
    .click()
  await page.getByRole('option').filter({ hasText: 'Automated repair tool' }).first().click()
  await expect(
    toolField,
    '切到「自动修复工具」后没有出现工具选择器 ⇒ 这个切换只改了文案，没换掉输入面',
  ).toBeVisible()
  await expect(
    employeeField,
    '切到工具之后员工选择器还在 ⇒ 两类处理方式同时可填，落库时必然自相矛盾',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// OPS-X7 —— dev watcher 的单实例边界
// ---------------------------------------------------------------------------

function databaseFileOf(home: string): string {
  return join(home, 'db.sqlite')
}

async function cancelTask(handle: DaemonHandle, taskId: string): Promise<void> {
  const response = await fetch(`${handle.baseUrl}/api/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  expect(
    response.status < 400,
    `cancel ${taskId}: ${response.status} ${await response.text()}`,
  ).toBe(true)
}

async function taskWorkspaceState(
  handle: DaemonHandle,
  taskId: string,
): Promise<{ id: string; workspaceState?: string }> {
  const response = await fetch(`${handle.baseUrl}/api/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  })
  const body = await response.text()
  expect(response.status, `read task ${taskId}: ${body}`).toBe(200)
  return JSON.parse(body) as { id: string; workspaceState?: string }
}

/** 这一代 daemon 的 loopback 控制端点还在不在（在 = 它还活着并且没被请去排空）。 */
function controlEndpointPresent(home: string): boolean {
  return existsSync(join(home, '.daemon.control'))
}

test('RFC-319 OPS-X7: 同一个 home 上再起一个 dev 代次——在位的是手工启动的普通 daemon 时它一根汗毛都不许动，在位的是 dev 代次时才会被请去排空 @nightly', async () => {
  const devEnv = { AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS: '20000' }

  // ---- ① 在位的是**普通** daemon：新来的 dev 代次自己退出，且不许碰它 ----
  const normalHome = freshDaemonHome('normal')
  const incumbent = await startDaemon({ home: normalHome })
  try {
    await expect(
      startDaemon({ home: normalHome, extraEnv: devEnv }),
      'dev 代次把一台手工启动的 daemon 顶掉了 ⇒ 开发机上跑着的正式实例会被 --watch 静默换掉',
    ).rejects.toThrow(/another daemon is already running/)
    expect(
      controlEndpointPresent(normalHome),
      '普通 daemon 被那次接管请去排空了 ⇒ 「只有 dev 代次可以被替换」这条边界没生效',
    ).toBe(true)
    const stillServing = await fetch(`${incumbent.baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${incumbent.token}` },
    })
    expect(
      stillServing.status,
      '在位的普通 daemon 在那次失败的接管之后答不了请求了 ⇒ 拒绝顶替只做了一半',
    ).toBe(200)
  } finally {
    await incumbent.stop()
    rmSync(normalHome, { recursive: true, force: true })
  }

  // ---- ② 在位的**也是 dev**：这一代才允许被请去排空 ----
  //
  // ⚠️ 这里刻意**只**断言「上一代被请去排空了」，不断言「新一代接管成功」。
  //    本机实测（macOS + Bun 1.3.13，连跑三次同结果）新一代在收到 202 之前就把
  //    连接读成了不可达并以退出码 1 收场——上一代确实排空了、新一代却没起来，
  //    于是一个 daemon 都不剩。那是一条真实缺陷（见交付回报的产品观察一节），
  //    按协议不把缺陷现状写成断言；这条判据在缺陷修好之后依然成立。
  const devHome = freshDaemonHome('dev')
  const previous = await startDaemon({ home: devHome, extraEnv: devEnv })
  let replacement: DaemonHandle | undefined
  try {
    expect(
      controlEndpointPresent(devHome),
      'dev 代次没有公布 loopback 控制端点 ⇒ 交接根本无从发起',
    ).toBe(true)
    try {
      replacement = await startDaemon({ home: devHome, extraEnv: devEnv })
    } catch {
      // 见上：新一代起没起来不是这条用例的判据。
    }
    await expect
      .poll(
        async () => {
          try {
            await fetch(`${previous.baseUrl}/api/config`, {
              headers: { Authorization: `Bearer ${previous.token}` },
            })
            return 'still-serving'
          } catch {
            return 'drained'
          }
        },
        {
          timeout: 30_000,
          intervals: [200],
          message:
            '上一代 dev daemon 在下一代来敲门之后仍在端口上服务 ⇒ `bun --watch` 每次改代码都会卡在「端口还被上一代占着」',
        },
      )
      .toBe('drained')
  } finally {
    if (replacement !== undefined) await replacement.stop()
    await previous.stop()
    rmSync(devHome, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// EVENT-X5 —— Webhook 任务工作区自动清理
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-X5: webhook 起的任务终态后自动清工作区——开关关着一个字节都不动；开着之后只清「webhook 起的 + 一次性空间」那一类，手工任务与常驻本地仓一个都不许碰 @nightly', async () => {
  const home = freshDaemonHome('wsclean')
  const daemonForCleanup = await startDaemon({ home })
  try {
    const seeded = ['off', 'on', 'manual', 'local'].map((tag) => {
      const id = `RFC319B108WS${tag.toUpperCase()}`
      const worktree = join(home, `ws-${tag}`)
      mkdirSync(worktree, { recursive: true })
      writeFileSync(join(worktree, 'marker.txt'), tag, 'utf-8')
      return { tag, id, worktree }
    })
    for (const row of seeded) {
      runSqlite(
        databaseFileOf(home),
        `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
           base_branch, branch, status, inputs, started_at, running_ms, space_kind, repo_count,
           webhook_trigger_id)
         VALUES ('${row.id}', '${row.id}', 'rfc319-b108-wf',
           '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
           '${join(home, 'fixture-repo')}', '${row.worktree}',
           'main', 'agent-workflow/${row.id}', 'pending', '{}', ${Date.now()}, 0,
           '${row.tag === 'local' ? 'local' : 'scratch'}', 1,
           ${row.tag === 'manual' ? 'NULL' : `'rfc319-b108-trigger'`});`,
      )
    }
    // `runSqlite` 走 `bun:sqlite` 的多语句 exec，约束错误不抛异常（见
    // docs/dev-gotchas.md）——种完必须回读自证，否则下面全是对空气断言。
    const seenIds = await Promise.all(
      seeded.map(async (row) => (await taskWorkspaceState(daemonForCleanup, row.id)).id),
    )
    expect(seenIds.sort(), '四行任务没有全部落库 ⇒ 后面的对照组是空的').toEqual(
      seeded.map((row) => row.id).sort(),
    )

    // ---- ① 开关关着（默认）：webhook 起的一次性工作区也一个字节都不动 ----
    const offRow = seeded.find((row) => row.tag === 'off')!
    await cancelTask(daemonForCleanup, offRow.id)
    expect(
      (await taskWorkspaceState(daemonForCleanup, offRow.id)).workspaceState ?? 'available',
      '开关关着却把工作区清了 ⇒ 用户没打开的功能替他做了不可逆的删除',
    ).toBe('available')
    expect(
      existsSync(join(offRow.worktree, 'marker.txt')),
      '开关关着，盘上的工作区文件却已经没了',
    ).toBe(true)

    // ---- ② 打开开关（热读，不重启）----
    const applied = await fetch(`${daemonForCleanup.baseUrl}/api/config`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${daemonForCleanup.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ webhookTaskWorkspaceAutoCleanup: true }),
    })
    expect(applied.status, '打开自动清理开关被拒').toBe(200)

    const onRow = seeded.find((row) => row.tag === 'on')!
    await cancelTask(daemonForCleanup, onRow.id)
    expect(
      (await taskWorkspaceState(daemonForCleanup, onRow.id)).workspaceState,
      'webhook 起的一次性工作区在终态后没有被清 ⇒ 这个开关打开了也不做事',
    ).toBe('pruned')
    expect(
      existsSync(onRow.worktree),
      '状态说清了，盘上的目录还在 ⇒ 用户以为磁盘被回收了，其实没有',
    ).toBe(false)

    // ---- ③ 同一个开关下，两类不该动的照样不动 ----
    for (const [tag, why] of [
      ['manual', '手工发起的任务也被清了 ⇒ 用户自己开的任务凭空丢了工作区'],
      ['local', '常驻本地仓被当成一次性空间清掉了 ⇒ 删的是用户自己的工作副本'],
    ] as const) {
      const row = seeded.find((candidate) => candidate.tag === tag)!
      await cancelTask(daemonForCleanup, row.id)
      expect(
        (await taskWorkspaceState(daemonForCleanup, row.id)).workspaceState ?? 'available',
        why,
      ).toBe('available')
      expect(existsSync(join(row.worktree, 'marker.txt')), why).toBe(true)
    }
  } finally {
    await daemonForCleanup.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

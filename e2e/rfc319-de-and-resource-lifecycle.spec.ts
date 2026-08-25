// RFC-319 —— 数字员工工作台 + 技能/MCP 资源生命周期的用户面 e2e。
//
// 覆盖能力账本九行：RES-04、RES-06、RES-19、RES-20、RES-46、DE-02、DE-10、DE-21、DE-43
// （`architecture/e2e-capability-ledger.json` 里全部 `status: 'gap'`）。九条的 `tier`
// 全是 `nightly`，所以每条 test 标题末尾都带 ` @nightly`——PR 腿跑
// `--grep-invert '@nightly'`，这些只在夜跑全量腿上跑；账本守卫的 `tierWiringMismatches`
// 会逐字核对这个 tag 与 `tier` 字段一致。RES-46 由两条 test 承担（Intent 挂载入口 /
// 从技能发起融合），两条 tag 一致。
//
// ## 每条锁的是「用户会遭遇什么」
//
//   * RES-04 —— 选文件阶段的两条**纯本地**校验是用户在上传 64 MiB 之前唯一的护栏。
//     它若坍缩成一条（两种原因同一句文案），用户拿到「不行」却不知道是后缀错了还是太大了；
//     它若干脆不拦，一个 200 MB 的 mp4 会被整包 POST 上去，等到服务端拒绝时用户已经等了两分钟。
//     所以这条**同时**断言两句文案互不相同、被拒的文件不会留在 dropzone 里、
//     并且**一个 parse 请求都没发出去**——只断言「显示了错误」是恒真的（任何一句红字都满足）。
//   * RES-06 —— 提交是这条流程里唯一会写库的一步，也是唯一会失败的一步。失败若把人踢回选文件阶段，
//     用户逐行做过的决策（哪些跳过、哪些改名、改成什么）全部作废，得从选 ZIP 重来；
//     而这份决策正是导入的全部工作量。所以这条断言「停在审阅页 + 文件名还在 + 那一行的决策还在
//     + 改一处再提交真的落库」，四件事缺一不可。
//   * RES-19 —— 「探测通了」是用户把一台 MCP 交给代理之前唯一的凭据。stdio 那条路
//     `rfc319-mcp-management.spec.ts` 已有正向覆盖，**Streamable HTTP 那条从来没有**：
//     全仓 e2e 里没有任何一条对 `AW_SYSTEM_MOCK_MCP_URL` 发过探测（既有的 remote 夹具要么指
//     127.0.0.1:1，要么指 `${GITHUB_API_BASE}/mcp`——后者按 `suite.ts:467` 的 `serviceFor`
//     根本路由到 code-host mock，不是 MCP mock）。这条把两条传输放在同一个断言里，并用
//     **回执里的 `serverInfo.name`** 指认真正握手的是哪一台（HTTP 那台自报
//     `system-mock-mcp-http`、stdio 那台自报 `system-mock-mcp-stdio`，见
//     `packages/system-mocks/src/mcp/server.ts:20/45` 与 `mcp/stdio.ts:17`）——
//     只断言 `status==='ok'` 分不出「真握手了」与「拿了另一台的旧结果」。
//   * RES-20 —— 远端 MCP 的两条传输是**有序回退**的（`mcpProbe.ts:531-536` 先 Streamable HTTP
//     再 SSE）。回退若被删掉，只支持 SSE 的服务器一律探成 connect-failed，而用户在界面上得到的
//     结论是「这台 MCP 不可用」——一条完全可用的服务器被判了死刑。这条把 URL 指到只应答 GET 的
//     `/mcp/sse`（POST 一律 404，即 Streamable HTTP 必失败），于是「探通了」这件事**本身**
//     就等价于「回退真的发生了」，再用 `serverInfo.name === 'system-mock-mcp-sse'` 二次指认。
//   * RES-46 —— 「用 Intent 修改」是三类资源详情页里唯一把当前资源**带进** AI 会话的入口。
//     挂载目标若丢了（或者带成了上一次访问的那一个），用户描述完需求、会话开起来，AI 手里
//     是一份空白工作集或者别人的资源——而这件事在界面上没有任何提示。既有的
//     `rfc319-intent-access-boundaries.spec.ts:806-846` 只锁了「这颗按钮按 intent:write 收放」，
//     **没有任何一条 e2e 点过它**，更没有验证过挂载目标。融合那半同理：
//     `rfc319-intent-fusion-and-gates.spec.ts:695` 只验证了无权时按钮不在，
//     全仓所有真正发起过融合的用例（`fusion-lifecycle` / `fusion-review-surface` /
//     `rfc319-memory-fusion-and-badges`）走的都是 `/memory` 的 `memory-fuse-button`
//     那个入口，**技能详情页这个入口从未被点过**。
//   * DE-02 —— 分类工作台的三个页签共享一份 URL search。切页签时该保留什么、该清空什么是
//     刻意设计的（`digital-employees.$typeRef.tsx:206-215`）：去工具箱要**带着**用户正在配的
//     那个职责与工具槽，回员工/岗位则一律清空——否则一个陈旧的 `workItem` 会在用户下次
//     点回工具箱时凭空弹出一个配置弹窗。这条同时锁两个方向，并且用「弹窗真的按那一对
//     toolRole/toolSlot 打开了」来证明保留下来的参数**生效了**，而不只是留在地址栏里。
//   * DE-10 —— 泳道顺序就是事件处理优先级（`P1/P2/…` 直接印在泳道头上）。重排若不落库，
//     用户以为自己把「流水线失败」提到了「评论反馈」前面，员工实际仍按旧序动作，而且**没有
//     任何提示**。这条把键盘（ArrowUp/ArrowDown）与指针拖拽两条路都跑一遍，并断言拖拽过程中
//     先给出**临时目标序**（松手前就能看到会落到哪儿）——没有临时序的拖拽等于盲拖。
//   * DE-21 —— `canUpdate = usePermission(...) ∧ resourceAccess.canEdit`
//     （`code.config.detail.tsx:93-94`）是一个**合取门**。`rfc319-de-config-and-policies.spec.ts`
//     的 DE-35 已经掐死了右腿（行级授权档），**左腿（方法级权限点）没有任何浏览器覆盖**。
//     这条把资源**转让给**低权账号，于是右腿恒真、只剩左腿说话：一个「东西是我的、但我这个
//     角色没有这类资源的写权限点」的账号，四个写入口一个都不该渲染，接口也必须同口径 403
//     ——界面藏了按钮而接口放行，等于门控只是一层装饰。
//   * DE-43 —— 上手引导是新用户第一次进来时唯一的「现在该干嘛」。它若不随实际进度前移
//     （或者每一步给的都是同一个链接），用户在第二步就会被送回第一步的页面，然后放弃。
//     这条把四个阶段真的走一遍（没有员工 → 有草稿但不可发布 → 可发布 → 已发布未指派 → 已指派），
//     逐格断言序号、去处链接与已完成步数——只断言「投影变了」不够，得断言**算对了**。
//
// ## 与既有 e2e 的分工（刻意不重叠）
//
//   * `e2e/skill-import.spec.ts` —— 同为 ZIP 导入，但它走的是**成功**路（真 ZIP → 审阅 → 结果）
//     加响应式/焦点/axe 契约。本文件补的是它一条都没碰的两条**失败**路：选文件阶段的本地校验
//     （RES-04，根本到不了 parse）与提交阶段的失败回退（RES-06）。
//   * `e2e/rfc319-mcp-management.spec.ts` —— 探测的失败面（connect-failed / handshake-failed /
//     auth-required / partial / timeout）与草稿基准选择。本文件只补它没有的**成功面第二条传输**
//     （RES-19 的 remote）与**回退**（RES-20）。stdio 成功路在那份文件里已有，本文件把它与
//     remote 放在同一条用例里做对照组——少了对照组，一个「所有探测都回 ok」的实现同样能过。
//   * `e2e/rfc319-de-config-and-policies.spec.ts` —— DE-35 覆盖行级授权三档（read/write/govern）。
//     本文件的 DE-21 只打方法级权限点这条腿，两者互为补集，不重复。
//   * `e2e/rfc310-zero-config-onboarding.spec.ts` —— 岗位模板从零建到发布。本文件的 DE-10
//     不重复建模板（直接按已发布的工具注册播种），只做它一次都没碰的**泳道优先级重排**。
//   * `e2e/rfc319-intent-access-boundaries.spec.ts` —— 六个 Intent 入口的**可见性**。
//     本文件的 RES-46 点下去，看挂载目标。
//
// ## 源码锚点（纯文本引用，勿改成外链——外链会被 CI 的 markdown link check 逐条请求，
// 见 CLAUDE.md §opencode 源码自取规则）
//
//   packages/frontend/src/lib/skill-zip-import.ts:197-201            两条本地校验（后缀 / 体积）
//   packages/frontend/src/components/skills/ImportZipPanel.tsx:145-165  校验失败：清空 file + 两句不同文案
//   packages/frontend/src/components/skills/ImportZipPanel.tsx:216-245  commit 失败：留在 review + commitError
//   packages/frontend/src/components/skills/ImportZipPanel.tsx:387-396  parse 按钮在 file===null 时禁用
//   packages/backend/src/services/mcpProbe.ts:531-556                 remote 传输顺序 + 回退
//   packages/backend/src/services/mcpProbe.ts:565-575                 serverInfo / protocolVersion 出处
//   packages/system-mocks/src/mcp/server.ts:20/45/82-108              三台 mock 各自的自报名与工具清单
//   packages/system-mocks/src/suite.ts:424-425/467                    /mcp 与 /mcp/sse 的 URL 与路由归属
//   packages/frontend/src/components/IntentEntryButton.tsx:38-51      入口把 mount 编进 /intent 的 search
//   packages/frontend/src/routes/intent.tsx:220-223/264               search → dialogMount → 组件 key
//   packages/frontend/src/components/intent/IntentCreateComposer.tsx:80-83  mounts 进 POST body
//   packages/frontend/src/components/fusion/FuseDialog.tsx:45-63      from-skill 入口的 seed 与重开
//   packages/frontend/src/components/fusion/FuseDialog.tsx:111-121    needSkill / needMemories 本地拦截
//   packages/frontend/src/routes/digital-employees.$typeRef.tsx:71-84 search 归一（view / workItem / 成对的 toolRole+toolSlot）
//   packages/frontend/src/routes/digital-employees.$typeRef.tsx:203-217  切页签时的保留 / 清空
//   packages/frontend/src/components/digital-employees/EmployeeCapabilityPanorama.tsx:368-376  临时目标序
//   packages/frontend/src/components/digital-employees/EmployeeCapabilityPanorama.tsx:386-409  落手提交 / 键盘换位
//   packages/frontend/src/routes/code.config.detail.tsx:93-95         canUpdate / canArchive 的合取门
//   packages/frontend/src/routes/code.config.tsx:122/151-160          canCreate 决定新建入口
//   packages/backend/src/modules/development-automation/domain/journeyProjection.ts:126-247  四阶段投影
//   packages/backend/src/routes/developmentConfig.ts:674-742          /api/code/setup-journey 选谁 + canXxx
//
// ## 执行模型
//
//   * 两个 daemon：主 daemon 承载八条用例；DE-43 需要一份**一个数字员工都没有**的库才能看到
//     第一阶段，所以单独起 `journeyDaemon`。
//   * 只有 RES-06 用了一次 `page.route`：提交失败在产品里没有可复跑的自然触发点
//     （逐条候选的失败会以 200 + `failed[]` 回来并进入结果页，见
//     `packages/backend/src/routes/skills.ts:179-182`），唯一的 HTTP 级失败是传输层。
//     handler 里**只有一次 `route.fulfill`**、URL 谓词精确到单条 pathname、且只吞第一发，
//     没有 `route.fetch()`（`docs/dev-gotchas.md` §「page.route 两把锁」的锁 A）。
//     `test.afterEach` 统一 `unrouteAll({ behavior: 'wait' })`（锁 B）。
//   * 不用 `test.describe.configure({ mode: 'serial' })`：`playwright.config.ts` 的
//     `fullyParallel` 已是 false，同文件内本就按声明顺序串行；不加 serial 是为了让某一条红
//     不会把其余条目变成 `did not run`，变异验证才归因得出来。每条用例的前置都自带。

import { expect, test, type Page, type Route } from '@playwright/test'
import { zipSync } from 'fflate'
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 零依赖叶子模块（整文件没有一条 import），并且由
// `packages/frontend/tests/code-policy-pages.test.tsx:95` 的
// `expect(defaultPolicyTemplate()).toEqual(defaultAutomationPolicyContent())` 与后端 domain
// 逐字段钉住。手抄一份默认策略会在后端默认值演进的那天把本文件红在「策略发不出去」上——
// 与被测行为无关的失败。
import { defaultPolicyTemplate } from '../packages/frontend/src/data/policyFactCatalog'
import { defaultSystemMockToolPath, startDaemon, type DaemonHandle } from './harness'

/** 同一次运行内的唯一后缀：技能 / MCP / 配置资源的名字都有唯一约束。 */
const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** 内建开发类数字员工分类；`@` 在路径里要转义（同 rfc310-zero-config-onboarding）。 */
const TYPE_ID = 'development'
const TYPE_REVISION = 10
const TYPE_REF = `${TYPE_ID}@${TYPE_REVISION}`
const TYPE_PATH = `${TYPE_ID}%40${TYPE_REVISION}`

/** `SKILL_ZIP_LIMITS.totalBytes`（packages/shared/src/skill-zip.ts:24）。 */
const SKILL_ZIP_TOTAL_BYTES = 64 * 1024 * 1024

test.setTimeout(240_000)

let daemon: DaemonHandle
let journeyDaemon: DaemonHandle
let systemMockTool: string
let fixtureDir: string

interface ExactRef {
  id: string
  revision: number
}

interface HttpResult {
  status: number
  text: string
  json: unknown
}

interface WorkItem {
  workItemRef: string
  nodeKind: string
  toolRoleGroups: Array<{
    roleRef: string
    bindingSlots: Array<{ slotRef: string; required: boolean }>
  }>
}

interface TypePackage {
  authoringManifest: { workItems: WorkItem[] }
  reactionRules: Array<{ priority: number }>
}

interface ToolRegistration {
  id: string
  state: string
  publishedRevision: number | null
  content: { roleRef: string }
}

interface JobTemplateRow {
  id: string
  name: string
  publishedRevision: number | null
  draft: { reactionLaneOrder: string[] }
}

interface McpProbeReceipt {
  status: 'ok' | 'error'
  errorCode: string | null
  errorMessage: string | null
  serverInfo: { name: string; version?: string } | null
  protocolVersion: string | null
  capabilities: Record<string, unknown> | null
  tools: Array<{ name: string }> | null
  resources: Array<{ uri: string }> | null
  prompts: Array<{ name: string }> | null
}

interface JourneyProjection {
  current: { key: string; ordinal: number; total: number }
  next: { key: string; href: string | null; available: boolean }
  steps: Array<{ key: string; state: string }>
}

// --------------------------------------------------------------------- helpers

function bearer(token: string, hasBody: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  }
}

/** 原样回执（含状态码与正文），负向断言用——不得把 4xx 变成异常。 */
async function rawCall(
  baseUrl: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: bearer(token, init.body !== undefined),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: response.status, text, json: parsed }
}

/** 成功路：非 2xx 直接抛，夹具搭建失败要停在原因上而不是下游断言上。 */
async function call<T>(
  baseUrl: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const result = await rawCall(baseUrl, token, path, init)
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${result.status}: ${result.text}`)
  }
  return result.json as T
}

/** 主 daemon + 管理员会话。 */
function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return call<T>(daemon.baseUrl, daemon.token, path, init)
}

/** DE-43 专用的空 daemon + 管理员会话。 */
function journeyApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return call<T>(journeyDaemon.baseUrl, journeyDaemon.token, path, init)
}

async function primeAuth(
  target: { addInitScript: Page['addInitScript'] },
  baseUrl: string,
  token: string,
): Promise<void> {
  await target.addInitScript(
    ({ base, tok }) => {
      localStorage.setItem('agent-workflow.baseUrl', base)
      localStorage.setItem('agent-workflow.token', tok)
      localStorage.setItem('aw-language', 'en-US')
    },
    { base: baseUrl, tok: token },
  )
}

interface SeededUser {
  username: string
  userId: string
  token: string
}

async function createUserAndLogin(
  username: string,
  role: 'admin' | 'user' | 'manager' | 'guest',
  additionalPermissions: string[] = [],
): Promise<SeededUser> {
  // 与 e2e/rfc099-ownership-acl.spec.ts 用同一个显然是夹具的口令字面量：gitleaks 的
  // git 模式扫的是历史 patch，一个长得像真密钥的夹具串入库就永远在那儿。
  const password = 'longEnoughPassword'
  const created = await api<{ id: string }>('/api/users', {
    method: 'POST',
    body: { username, displayName: username, role, password, additionalPermissions },
  })
  const login = await api<{ sessionToken: string }>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  return { username, userId: created.id, token: login.sessionToken }
}

function skillMarkdown(name: string, description: string): Uint8Array {
  return new TextEncoder().encode(
    `---\nname: ${name}\ndescription: ${description}\n---\nBody for ${name}.\n`,
  )
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  expect(value, `${name} 未注入 —— system mock 套件没起来，本文件的 MCP 夹具无从谈起`).toBeTruthy()
  return value as string
}

async function seedRemoteMcp(slug: string, url: string): Promise<{ id: string; hash: string }> {
  const row = await api<{ id: string; operationConfigHash: string }>('/api/mcps', {
    method: 'POST',
    body: {
      name: slug,
      description: 'RFC-319 transport fixture',
      type: 'remote',
      config: { url, timeoutMs: 20_000, oauth: false },
      enabled: true,
    },
  })
  return { id: row.id, hash: row.operationConfigHash }
}

async function seedLocalMcp(
  slug: string,
  command: string[],
): Promise<{ id: string; hash: string }> {
  const row = await api<{ id: string; operationConfigHash: string }>('/api/mcps', {
    method: 'POST',
    body: {
      name: slug,
      description: 'RFC-319 transport fixture',
      type: 'local',
      config: { command, timeoutMs: 20_000 },
      enabled: true,
    },
  })
  return { id: row.id, hash: row.operationConfigHash }
}

/** 在浏览器里点「重新探测」，返回服务端的那份回执（而不是界面复述的版本）。 */
async function reprobeInBrowser(page: Page, mcpId: string): Promise<McpProbeReceipt> {
  await page.goto(`${daemon.baseUrl}/mcps/${mcpId}`)
  await page.getByTestId('mcp-tab-probe').click()
  const settled = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/mcps/${mcpId}/probe`,
    { timeout: 90_000 },
  )
  await page.getByTestId(`mcp-inventory-reprobe-${mcpId}`).click()
  return (await (await settled).json()) as McpProbeReceipt
}

/** 一份能通过 `digitalEmployeeContentSchema`、但闭包校验必然拦下的员工说明书。 */
function unpublishableEmployeeDraft(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    description: 'RFC-319 DE-43 fixture: references that resolve to nothing.',
    supportedRepositoryFacts: [],
    steps: [
      {
        stepId: 'implement',
        displayName: 'Implement the change',
        description: '',
        when: [],
        producer: { kind: 'agent', implementationRef: { id: 'ghost-template', revision: 1 } },
        input: { kind: 'mission-requirement' },
        onSuccess: 'complete',
        join: null,
        onFailure: {
          retry: { sameScene: 0, freshScene: 0 },
          onExhausted: 'block',
          onRejected: null,
          onExpired: null,
        },
      },
    ],
    capabilityRoutes: [
      {
        capabilityId: 'change.implement',
        rules: [],
        fallbackTemplateRef: { id: 'ghost-template', revision: 1 },
      },
    ],
    requirementSources: [],
    pipelineProviders: [],
    defaultPolicyRef: { id: 'ghost-policy', revision: 1 },
  }
}

/** 同一份说明书，把两处引用换成真的——这一版必须发得出去。 */
function publishableEmployeeDraft(template: ExactRef, policy: ExactRef): Record<string, unknown> {
  const base = unpublishableEmployeeDraft()
  return {
    ...base,
    description: 'RFC-319 DE-43 fixture: every reference resolved.',
    steps: [
      {
        ...(base.steps as Array<Record<string, unknown>>)[0],
        producer: { kind: 'agent', implementationRef: template },
      },
    ],
    capabilityRoutes: [
      { capabilityId: 'change.implement', rules: [], fallbackTemplateRef: template },
    ],
    defaultPolicyRef: policy,
  }
}

/** 读当前页面上每条可排序泳道的 `laneId → P 序号`。 */
async function lanePriorities(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    for (const lane of document.querySelectorAll<HTMLElement>('[data-capability-lane-id]')) {
      const badge = lane.querySelector<HTMLElement>('.employee-toolbox-lane__priority')
      const laneId = lane.dataset.capabilityLaneId
      if (badge === null || laneId === undefined) continue
      out[laneId] = (badge.textContent ?? '').trim()
    }
    return out
  })
}

/** `laneId → P 序号` 反解成按优先级排好的 laneId 列表。 */
function orderOf(priorities: Record<string, string>): string[] {
  return Object.entries(priorities)
    .sort(([, left], [, right]) => Number(left.slice(1)) - Number(right.slice(1)))
    .map(([laneId]) => laneId)
}

// ------------------------------------------------------------------- lifecycle

test.beforeAll(async () => {
  daemon = await startDaemon()
  journeyDaemon = await startDaemon()
  systemMockTool = defaultSystemMockToolPath()
  fixtureDir = mkdtempSync(join(tmpdir(), `aw-rfc319-lifecycle-${RUN_TAG}-`))
})

test.afterAll(async () => {
  await daemon?.stop()
  await journeyDaemon?.stop()
})

test.afterEach(async ({ page }) => {
  // 先摘掉全部 handler，再趁 page 还活着把在飞的等完（`docs/dev-gotchas.md` §「page.route
  // 两把锁」的锁 B）。必须是 'wait' 而不是 'ignoreErrors'——后者只是把错吞掉。
  await page.unrouteAll({ behavior: 'wait' })
})

// ------------------------------------------------------------------------ RES-04

test('RFC-319 RES-04: 选文件阶段的两条本地校验各说各话，被拒的文件既不留在选择区也不会发出一次 parse @nightly', async ({
  page,
}) => {
  await primeAuth(page, daemon.baseUrl, daemon.token)

  // 唯一的判据：这条流程里 parse 是第一次网络往返。本地校验若失效，它一定会被打出去。
  let parseRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/skills/import-zip/parse') parseRequests += 1
  })

  await page.goto(`${daemon.baseUrl}/skills/new`)
  await page.getByTestId('skills-tab-zip').click()
  const select = page.getByTestId('zip-select-phase')
  await expect(select).toBeVisible()
  const parseButton = page.getByTestId('zip-parse-button')
  await expect(
    parseButton,
    '还没选文件，「检查 ZIP 内容」就是可点的 ⇒ 用户点了只会得到一次空转',
  ).toBeDisabled()

  // ① 后缀不对：一个 .txt。文案必须说的是「后缀」，不是「太大」。
  await page.getByTestId('zip-file-input').setInputFiles({
    name: 'not-an-archive.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('这不是一个 ZIP。'),
  })
  const wrongType = 'Choose a file whose name ends in .zip.'
  const tooLarge = `This archive is larger than ${SKILL_ZIP_TOTAL_BYTES / 1024 / 1024} MiB.`
  await expect(
    select.getByText(wrongType, { exact: true }),
    '选了 .txt 却没有指出后缀问题 ⇒ 用户只知道「不行」，不知道该改什么',
  ).toBeVisible()
  await expect(
    select.getByText(tooLarge, { exact: true }),
    '后缀错误被报成体积超限 ⇒ 两条校验坍缩成一条，用户会去压缩一个根本不是 ZIP 的文件',
  ).toHaveCount(0)
  await expect(
    select.getByText('not-an-archive.txt', { exact: false }),
    '被拒的文件还留在选择区里 ⇒ 用户以为它已被接受，只是「有个警告」',
  ).toHaveCount(0)
  await expect(
    parseButton,
    '被拒之后检查按钮仍可点 ⇒ 本地校验只是贴了张红字，没有真的挡住下一步',
  ).toBeDisabled()

  // ② 体积超限：一个 64 MiB + 1 字节的稀疏文件（真 .zip 后缀，只有体积不合格）。
  //    走磁盘路径而不是 Buffer：64 MiB 的 buffer 要经 CDP 传一遍，纯属浪费。
  const oversized = join(fixtureDir, 'oversized.zip')
  writeFileSync(oversized, '')
  truncateSync(oversized, SKILL_ZIP_TOTAL_BYTES + 1)
  await page.getByTestId('zip-file-input').setInputFiles(oversized)
  await expect(
    select.getByText(tooLarge, { exact: true }),
    '超过 64 MiB 的包没被本地拦下 ⇒ 用户要等整包传完才被服务端拒绝',
  ).toBeVisible()
  await expect(
    select.getByText(wrongType, { exact: true }),
    '体积超限被报成后缀不对 ⇒ 用户会去改文件名，改完还是传不上去',
  ).toHaveCount(0)
  await expect(parseButton).toBeDisabled()

  // ③ 合格的包必须放行——没有这条正向对照，一个「什么都拒」的实现同样能让上面两段全绿。
  const good = zipSync({
    [`res04-ok-${RUN_TAG}/SKILL.md`]: skillMarkdown(
      `res04-ok-${RUN_TAG}`,
      'A legal archive that must clear both local checks.',
    ),
  })
  await page.getByTestId('zip-file-input').setInputFiles({
    name: 'legit.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(good),
  })
  await expect(
    select.getByText(wrongType, { exact: true }),
    '换成合格 ZIP 之后旧的错误还挂着 ⇒ 用户看着红字不敢点下一步',
  ).toHaveCount(0)
  await expect(select.getByText(tooLarge, { exact: true })).toHaveCount(0)
  await expect(
    parseButton,
    '合格的 ZIP 选上了检查按钮却仍然禁用 ⇒ 本地校验把正常路径也一并挡死了',
  ).toBeEnabled()

  expect(
    parseRequests,
    '本地校验阶段发出过 parse 请求 ⇒ 「不合格的文件不上传」这条承诺不成立',
  ).toBe(0)
})

// ------------------------------------------------------------------------ RES-06

test('RFC-319 RES-06: 提交失败后停在审阅页——文件与逐行决策一字不丢，改一处再提交真的落库 @nightly', async ({
  page,
}) => {
  const freshName = `res06-fresh-${RUN_TAG}`
  const takenName = `res06-taken-${RUN_TAG}`
  const renamedName = `res06-renamed-${RUN_TAG}`
  await api('/api/skills', {
    method: 'POST',
    body: {
      name: takenName,
      description: 'Existing skill so the second candidate arrives as a conflict.',
      bodyMd: 'Original body that must survive a skipped decision.',
    },
  })

  const archive = zipSync({
    [`${freshName}/SKILL.md`]: skillMarkdown(freshName, 'A fresh candidate with no conflict.'),
    [`${takenName}/SKILL.md`]: skillMarkdown(
      takenName,
      'Deliberately conflicts with a live skill.',
    ),
  })

  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/skills/new`)
  await page.getByTestId('skills-tab-zip').click()
  await page.getByTestId('zip-file-input').setInputFiles({
    name: 'res06-pack.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(archive),
  })
  await page.getByTestId('zip-parse-button').click()
  const review = page.getByTestId('zip-review-phase')
  await expect(review).toBeVisible()
  await expect(page.getByTestId(`zip-row-${freshName}`)).toBeVisible()
  await expect(page.getByTestId(`zip-row-${takenName}`)).toBeVisible()

  // 冲突那一行改成「改名」——这就是用户投入的那份工作量，失败之后必须还在。
  await page.getByTestId(`zip-action-${takenName}`).click()
  await page.getByRole('option', { name: 'Rename' }).click()
  await page.getByTestId(`zip-rename-${takenName}`).fill(renamedName)

  // 提交失败在产品里没有可复跑的自然触发点：逐条候选的失败是 200 + failed[]，会进结果页
  // （packages/backend/src/routes/skills.ts:179-182）。唯一的 HTTP 级失败是传输层，所以
  // 这里只吞第一发 commit，之后原样放行——handler 里只有一次 fulfill，没有 route.fetch()。
  let swallowed = 0
  await page.route(
    (url) => url.pathname === '/api/skills/import-zip/commit',
    async (route: Route) => {
      if (swallowed > 0) {
        await route.continue()
        return
      }
      swallowed += 1
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'upstream-unavailable', message: 'try again' } }),
      })
    },
  )

  await page.getByTestId('zip-commit-button').click()
  await expect
    .poll(() => swallowed, { message: '第一发 commit 没有被注入拦到，本条用例的前提不成立' })
    .toBe(1)

  // ① 停在审阅页——不是被踢回选文件、也不是跳进结果页。
  await expect(
    review,
    '提交失败把人送去了别的阶段 ⇒ 逐行做过的决策全部作废，只能从选 ZIP 重来',
  ).toBeVisible()
  await expect(page.getByTestId('zip-select-phase')).toHaveCount(0)
  // ② 失败要说出来。只断言「停在原地」不够——一个什么都不显示的实现同样满足。
  await expect(
    review.locator('.error-box').first(),
    '提交失败没有任何提示 ⇒ 用户点完按钮什么都没变，会以为自己没点中',
  ).toBeVisible()
  // ③ 文件与那一行的决策必须原样还在。
  await expect(
    review.getByText('res06-pack.zip', { exact: false }),
    '失败后连选的哪个包都不显示了 ⇒ 审阅上下文已经丢了',
  ).toBeVisible()
  await expect(
    page.getByTestId(`zip-rename-${takenName}`),
    '失败后改名输入框消失 ⇒ 那一行的决策被重置成默认，用户的选择白做',
  ).toHaveValue(renamedName)

  // ④ 就地改一处（把没冲突的那条从「导入」改成「跳过」），再提交——这一发放行，必须真的落库。
  await page.getByTestId(`zip-action-${freshName}`).click()
  await page.getByRole('option', { name: 'Skip' }).click()
  const committed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/skills/import-zip/commit',
    { timeout: 60_000 },
  )
  await page.getByTestId('zip-commit-button').click()
  expect((await committed).status(), '重试那一发提交仍然失败 ⇒ 注入没有只吞第一发').toBe(200)

  const skills = await api<Array<{ id: string; name: string }>>('/api/skills')
  const names = skills.map((skill) => skill.name)
  expect(names, '改名那条没有落库 ⇒ 重试并没有真的把决策提交出去').toContain(renamedName)
  expect(
    names,
    '被改成「跳过」的那条还是建出来了 ⇒ 重试用的是第一次那份决策，用户的修改没被采纳',
  ).not.toContain(freshName)
  const taken = skills.find((skill) => skill.name === takenName)
  expect(taken, '被改名让路的那条原技能消失了 ⇒ rename 把原来那条顶掉了').toBeDefined()
  const original = await api<{ bodyMd: string }>(
    `/api/skills/${encodeURIComponent(taken!.id)}/content`,
  )
  expect(
    original.bodyMd,
    '改名之后原技能的正文被覆盖了 ⇒ rename 走成了 overwrite，用户丢了原来那份',
  ).toContain('Original body that must survive a skipped decision.')
})

// ------------------------------------------------------------------------ RES-19

test('RFC-319 RES-19: Streamable HTTP 与 stdio 各自真握手——回执里的 serverInfo 指认用的正是那条传输 @nightly', async ({
  page,
}) => {
  await primeAuth(page, daemon.baseUrl, daemon.token)
  const httpMcp = await seedRemoteMcp(
    `rfc319-res19-http-${RUN_TAG}`,
    requiredEnv('AW_SYSTEM_MOCK_MCP_URL'),
  )
  const stdioMcp = await seedLocalMcp(`rfc319-res19-stdio-${RUN_TAG}`, [
    systemMockTool,
    'mcp-stdio',
  ])

  const expectedTools = ['echo', 'fail', 'ping', 'query']
  for (const { mcp, transport, serverName } of [
    { mcp: httpMcp, transport: 'Streamable HTTP', serverName: 'system-mock-mcp-http' },
    { mcp: stdioMcp, transport: 'stdio', serverName: 'system-mock-mcp-stdio' },
  ]) {
    const receipt = await reprobeInBrowser(page, mcp.id)
    expect(
      { status: receipt.status, code: receipt.errorCode },
      `${transport} 探测没成功（${receipt.errorMessage ?? '无错误信息'}）⇒ 这条传输的握手在产品里根本走不通`,
    ).toEqual({ status: 'ok', code: null })
    // serverInfo 只可能来自 initialize 的应答（mcpProbe.ts:565-575），所以它是「真握手过」
    // 的唯一凭据，也是「用的是哪一条传输」的唯一凭据——两台 mock 自报的名字不同。
    expect(
      receipt.serverInfo?.name,
      `${transport} 的回执没有指认到那台服务器 ⇒ 结果可能来自别的传输或上一次的缓存`,
    ).toBe(serverName)
    // 协议版本按**当前实现**只对 HTTP 传输存在：`mcpProbe.ts:568-571` 从
    // `activeTransport.protocolVersion` 取，而 SDK 的 `StdioClientTransport` 上没有这个字段。
    // 这是形状差异不是缺陷，所以只在 HTTP 那条上断言，且断言的是「有」而不是某个具体版本号
    // ——写死版本号会在 SDK 升级那天把这条与被测行为无关地变红。
    if (transport === 'Streamable HTTP') {
      expect(
        receipt.protocolVersion,
        `${transport} 探通了却没有协议版本 ⇒ initialize 的应答没有被读进来`,
      ).not.toBeNull()
    }
    expect(
      Object.keys(receipt.capabilities ?? {}).sort(),
      `${transport} 的能力集不是服务器声明的那三项 ⇒ 界面上的「这台 MCP 能干什么」是编的`,
    ).toEqual(['prompts', 'resources', 'tools'])

    // 清单三段都要真的枚举过：只有 tools 一段被读，用户就会以为这台 MCP 没有资源/提示词。
    expect(
      (receipt.tools ?? []).map((tool) => tool.name).sort(),
      `${transport} 列出的工具不是这台服务器实际提供的四个 ⇒ 代理拿到的工具面与用户看到的不一致`,
    ).toEqual(expectedTools)
    expect(
      (receipt.resources ?? []).map((resource) => resource.uri),
      `${transport} 没有枚举出资源 ⇒ resources/list 这一段没跑`,
    ).toEqual(['file:///system-mock/README.md'])
    expect(
      (receipt.prompts ?? []).map((prompt) => prompt.name),
      `${transport} 没有枚举出提示词 ⇒ prompts/list 这一段没跑`,
    ).toEqual(['summarize'])

    // 界面这一侧：四条工具逐条成行，Online 徽标出现在列表卡片上。
    for (const tool of expectedTools) {
      await expect(
        page.getByTestId(`mcp-tool-row-${tool}`),
        `${transport} 探通了但工具 ${tool} 没有出现在面板里 ⇒ 用户无法确认这台 MCP 给了什么`,
      ).toBeVisible()
    }
    await expect(
      page.getByTestId(`split-card-${mcp.id}`).getByTestId('mcp-probe-status-ok'),
      `${transport} 探通了列表里却不显示 Online ⇒ 用户在列表上看不出哪台是活的`,
    ).toBeVisible()
  }
})

// ------------------------------------------------------------------------ RES-20

test('RFC-319 RES-20: Streamable HTTP 打不通时降级到 SSE——探通了，而且回执指认的是 SSE 那台 @nightly', async ({
  page,
}) => {
  await primeAuth(page, daemon.baseUrl, daemon.token)
  const base = requiredEnv('AW_SYSTEM_MOCK_MCP_URL')
  const sseUrl = `${base}/sse`

  // 前提自证：`/mcp/sse` 只应答 GET（system-mocks/src/mcp/server.ts:44），POST 一律 404。
  // 也就是说 Streamable HTTP 在这个地址上**必然**失败——「探通了」等价于「回退发生了」。
  const streamableAttempt = await fetch(sseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  expect(
    streamableAttempt.status,
    'SSE 端点居然接受了 Streamable HTTP 的 POST ⇒ 这条用例分辨不出回退有没有发生，判据无效',
  ).toBe(404)

  const mcp = await seedRemoteMcp(`rfc319-res20-sse-${RUN_TAG}`, sseUrl)
  const receipt = await reprobeInBrowser(page, mcp.id)
  expect(
    { status: receipt.status, code: receipt.errorCode },
    `只支持 SSE 的服务器被判成探不通（${receipt.errorMessage ?? '无错误信息'}）⇒ ` +
      '回退没有发生，一台完全可用的 MCP 会被用户当成坏的',
  ).toEqual({ status: 'ok', code: null })
  expect(
    receipt.serverInfo?.name,
    '探通了但握手到的不是 SSE 那台 ⇒ 结果不是从这条回退路径来的',
  ).toBe('system-mock-mcp-sse')
  expect(
    (receipt.tools ?? []).map((tool) => tool.name).sort(),
    '回退之后没有把工具清单枚举出来 ⇒ 回退只连上了，后面的 list 调用没接上',
  ).toEqual(['echo', 'fail', 'ping', 'query'])
  await expect(
    page.getByTestId('mcp-tool-row-ping'),
    '回退成功的探测没有把工具渲染出来 ⇒ 用户看不到这台 MCP 已经可用',
  ).toBeVisible()
})

// ------------------------------------------------------------------------ RES-46

test('RFC-319 RES-46: 技能 / MCP / 插件详情的「用 Intent 修改」各自带着自己的挂载目标进会话 @nightly', async ({
  page,
}) => {
  const skill = await api<{ id: string }>('/api/skills', {
    method: 'POST',
    body: {
      name: `res46-skill-${RUN_TAG}`,
      description: 'RFC-319 RES-46 mount fixture',
      bodyMd: 'Body.',
    },
  })
  const mcp = await seedLocalMcp(`rfc319-res46-mcp-${RUN_TAG}`, [systemMockTool, 'mcp-stdio'])
  const plugin = await api<{ id: string }>('/api/plugins', {
    method: 'POST',
    body: {
      name: `res46-plugin-${RUN_TAG}`,
      spec: daemon.stubOpencode,
      description: 'RFC-319 RES-46 mount fixture',
      enabled: true,
    },
  })

  await primeAuth(page, daemon.baseUrl, daemon.token)

  const surfaces = [
    { label: '技能', path: `/skills/${skill.id}`, testid: 'skill-intent-entry', type: 'skill' },
    { label: 'MCP', path: `/mcps/${mcp.id}`, testid: 'mcp-intent-entry', type: 'mcp' },
    {
      label: '插件',
      path: `/plugins/${plugin.id}`,
      testid: 'plugin-intent-entry',
      type: 'plugin',
    },
  ] as const
  const idOf: Record<string, string> = { skill: skill.id, mcp: mcp.id, plugin: plugin.id }
  const labelOf: Record<string, string> = { skill: 'Skill', mcp: 'MCP', plugin: 'Plugin' }

  for (const surface of surfaces) {
    await page.goto(`${daemon.baseUrl}${surface.path}`)
    await page.getByTestId(surface.testid).click()
    await expect(page).toHaveURL(/\/intent\?/)
    const search = new URL(page.url()).searchParams
    expect(
      { mountType: search.get('mountType'), mountId: search.get('mountId') },
      `${surface.label}详情的入口没有把「改的是哪一个」带进 /intent ⇒ 会话建起来时工作集是空的`,
    ).toEqual({ mountType: surface.type, mountId: idOf[surface.type] })

    // 弹窗必须是「修改」形态：挂载说明在场、类型说的是这一类；而选类型的那组卡片必须消失
    // ——`IntentCreateComposer.tsx:237-256` 是二选一，两个都在就说明挂载目标其实没生效。
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByTestId('intent-modify-target'),
      `${surface.label}进来的会话没有显示挂载目标 ⇒ 用户不知道 AI 手里到底有没有这份资源`,
    ).toContainText(`Modify target: ${labelOf[surface.type]}`)
    await expect(
      dialog.getByTestId('intent-create-hint-workflow'),
      `${surface.label}进来的会话还在问「你要建什么类型」⇒ 挂载目标没有被组件收到`,
    ).toHaveCount(0)
  }

  // 最后一站（插件）走完整一次创建：URL 与弹窗都对，还得证明**真的发出了**带 mounts 的请求，
  // 并且服务端把它当成了这次会话的挂载根。
  const posted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/intent-sessions',
    { timeout: 60_000 },
  )
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/intent-sessions',
    { timeout: 60_000 },
  )
  await page
    .getByRole('dialog')
    .getByTestId('intent-create-message')
    .fill('Tighten this plugin configuration.')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Start building', exact: true })
    .click()
  expect(
    (await posted).postDataJSON(),
    '创建会话的请求里没有挂载目标 ⇒ 入口只是把参数写进了地址栏，没进请求',
  ).toMatchObject({ mounts: [{ resourceType: 'plugin', resourceId: plugin.id }] })
  const session = (await (await created).json()) as { id: string }
  const context = await api<{
    mounts: Array<{ resourceType: string; resourceId: string }>
  }>(`/api/intent-sessions/${session.id}`)
  expect(
    context.mounts.map((mount) => ({ t: mount.resourceType, i: mount.resourceId })),
    '服务端这边这次会话一个挂载根都没有 ⇒ 请求发出去了但没被采纳，AI 仍然看不到这份资源',
  ).toEqual([{ t: 'plugin', i: plugin.id }])
})

test('RFC-319 RES-46: 从技能详情发起融合——目标锁死在这一条技能，没选记忆时一个请求都不发 @nightly', async ({
  page,
}) => {
  const skill = await api<{ id: string }>('/api/skills', {
    method: 'POST',
    body: {
      name: `res46-fuse-${RUN_TAG}`,
      description: 'RFC-319 RES-46 fusion fixture',
      bodyMd: 'Body.',
    },
  })
  // 同时造一条**别的**托管技能：目标若不是被 from-skill 入口锁死的，另一条就有机会被选中。
  await api('/api/skills', {
    method: 'POST',
    body: {
      name: `res46-decoy-${RUN_TAG}`,
      description: 'RFC-319 RES-46 decoy skill',
      bodyMd: 'Body.',
    },
  })
  const memoryTitle = `RFC-319 RES-46 memory ${RUN_TAG}`
  const memory = await api<{ memory: { id: string } }>('/api/memories', {
    method: 'POST',
    body: { scopeType: 'global', scopeId: null, title: memoryTitle, bodyMd: 'Prefer tabs.' },
  })
  await api(`/api/memories/${memory.memory.id}/promote`, {
    method: 'POST',
    body: { action: 'approve' },
  })

  await primeAuth(page, daemon.baseUrl, daemon.token)
  let fusionPosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/fusions') {
      fusionPosts += 1
    }
  })

  await page.goto(`${daemon.baseUrl}/skills/${skill.id}`)
  await page.getByRole('button', { name: 'Fuse memories', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Fuse memories into a skill' })
  await expect(dialog).toBeVisible()
  // from-skill 入口整块不渲染「目标技能」（FuseDialog.tsx:160-186 只在 from-memories 时渲染）。
  // 它若出现，说明入口没有把技能钉住，用户可以在这里把融合结果写进另一条技能。
  // ⚠️ 这里断言的是**这块字段在不在**，不是「那个下拉在不在」：`getByLabel` 只认可标注的
  // 表单控件，而这块字段在没有可写技能时渲染的是一段 `<p>`（fusion.noManagedSkills）——
  // 用 `getByLabel` 写就会漏掉「字段渲染了但里面是空态」这一整类回归（实测：把渲染条件
  // 改成恒真，`getByLabel` 版本照样全绿）。
  await expect(
    dialog.getByText('Target skill', { exact: false }),
    '从技能详情进来还让人选目标技能 ⇒ 入口没有锁定目标，融合可能写进别的技能',
  ).toHaveCount(0)
  await expect(
    dialog.getByTestId('fusion-memory-picker'),
    '从技能详情进来没有记忆选择器 ⇒ 这条入口点开了也没法用',
  ).toBeVisible()

  // ① 一条记忆都没选就提交：必须被本地拦下，且**一个请求都不发**。
  await dialog.getByRole('button', { name: 'Start fusion', exact: true }).click()
  await expect(
    dialog.getByText('Select at least one memory.', { exact: true }),
    '没选记忆就提交却没有任何提示 ⇒ 用户点了按钮什么都没发生',
  ).toBeVisible()
  expect(
    fusionPosts,
    '没选记忆也把融合请求发出去了 ⇒ 本地拦截形同虚设，用户会拿到一次服务端 4xx',
  ).toBe(0)

  // ② 选上那条记忆再提交：真的发起，并落到这条技能上。
  await dialog.getByTestId('fusion-memory-picker').getByRole('checkbox').first().check()
  await dialog.getByTestId('fusion-intent').fill('Merge this preference into the skill.')
  const launched = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/fusions',
    { timeout: 60_000 },
  )
  await dialog.getByRole('button', { name: 'Start fusion', exact: true }).click()
  const response = await launched
  expect(response.status(), '从技能详情发起的融合被服务端拒绝了').toBe(201)
  const fusion = (await response.json()) as { id: string; skillId: string; memoryIds: string[] }
  expect(
    { skillId: fusion.skillId, memoryIds: fusion.memoryIds },
    '融合落到了别的技能 / 别的记忆上 ⇒ 入口带过来的目标没有被采纳',
  ).toEqual({ skillId: skill.id, memoryIds: [memory.memory.id] })
  await expect(
    page,
    '发起成功后没有跳到这次融合的详情页 ⇒ 用户不知道它去哪儿了、也无从审批',
  ).toHaveURL(new RegExp(`/fusions/${fusion.id}$`))
})

// ------------------------------------------------------------------------- DE-02

test('RFC-319 DE-02: 分类工作台切页签——去工具箱保留职责与工具槽，回员工 / 岗位一律清空 @nightly', async ({
  page,
}) => {
  // 用真的 workItemRef + 真的 (roleRef, slotRef)：只有它们成立，保留下来的参数才会
  // 「生效」成一个打开的配置弹窗——这是判定「参数真的被用了」而不是「只留在地址栏」的唯一办法。
  const pkg = await api<TypePackage>(`/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}`)
  const item = pkg.authoringManifest.workItems.find(
    (candidate) => candidate.workItemRef === 'analyze-implement',
  )
  expect(item, '内建开发分类里没有 analyze-implement 职责 ⇒ 本条用例的夹具前提不成立').toBeDefined()
  const role = item!.toolRoleGroups[0]
  expect(
    role,
    'analyze-implement 没有任何工具角色 ⇒ 无法构造成对的 toolRole/toolSlot',
  ).toBeDefined()
  const slot = role!.bindingSlots[0]
  expect(slot, '工具角色下没有绑定槽 ⇒ 无法构造成对的 toolRole/toolSlot').toBeDefined()

  const carrying =
    `${daemon.baseUrl}/digital-employees/${TYPE_PATH}` +
    `?view=jobs&workItem=analyze-implement` +
    `&toolRole=${encodeURIComponent(role!.roleRef)}&toolSlot=${encodeURIComponent(slot!.slotRef)}`

  await primeAuth(page, daemon.baseUrl, daemon.token)

  // ① 清空方向：岗位页签上带着三个参数，切到「员工」必须只剩 view。
  await page.goto(carrying)
  await expect(page.getByRole('tab', { name: 'Job templates', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(
    page.getByTestId('digital-employee-definitions'),
    '岗位页签上却渲染了员工面板 ⇒ 页签与面板对不上，后面的断言分辨不出切换有没有发生',
  ).toHaveCount(0)

  await page.getByRole('tab', { name: 'Employees', exact: true }).click()
  await expect(
    page.getByTestId('digital-employee-definitions'),
    '切到「员工」页签后员工面板没出来 ⇒ 页签只改了地址栏，没换面板',
  ).toBeVisible()
  expect(
    Object.fromEntries(new URL(page.url()).searchParams),
    '切回员工页签时把职责 / 工具槽一起带过来了 ⇒ 下次点回工具箱会凭空弹出一个配置弹窗',
  ).toEqual({ view: 'employees' })

  // ② 保留方向：同样三个参数，切到「工具箱」必须**原样带过去**，并且真的按那一对槽打开弹窗。
  await page.goto(carrying)
  await page.getByRole('tab', { name: 'Toolbox', exact: true }).click()
  expect(
    Object.fromEntries(new URL(page.url()).searchParams),
    '去工具箱时把用户正在配的职责 / 工具槽丢了 ⇒ 用户点「去工具箱」会落到一张空的全景图上',
  ).toEqual({
    view: 'toolbox',
    workItem: 'analyze-implement',
    toolRole: role!.roleRef,
    toolSlot: slot!.slotRef,
  })
  const duty = page.getByTestId('employee-toolbox-duty-dialog')
  await expect(
    duty,
    '带过去的职责参数没有打开配置弹窗 ⇒ 参数只是留在地址栏里，并没有生效',
  ).toBeVisible()
  await expect(
    duty,
    '打开的不是那一对工具槽对应的配置面 ⇒ 保留下来的 toolRole/toolSlot 被忽略了',
  ).toContainText('Configure tools')

  // ③ 关掉弹窗（Dialog 的 onClose 会把 search 收回到只剩 view），再切回岗位——同样只剩 view。
  await page.keyboard.press('Escape')
  await expect(duty).toHaveCount(0)
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ view: 'toolbox' })
  await expect(
    page.getByTestId('employee-toolbox-responsibility-map'),
    '工具箱页签上没有渲染职责全景图 ⇒ 面板与页签对不上',
  ).toBeVisible()

  await page.getByRole('tab', { name: 'Job templates', exact: true }).click()
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ view: 'jobs' })
  await expect(
    page.getByTestId('employee-toolbox-responsibility-map'),
    '切到岗位页签后全景图还在 ⇒ 三个页签共用了同一块面板',
  ).toHaveCount(0)
  await expect(page.getByTestId('digital-employee-definitions')).toHaveCount(0)
})

// ------------------------------------------------------------------------- DE-10

test('RFC-319 DE-10: 泳道优先级键盘与拖拽都能重排，拖动中先给临时目标序，落手后落库且刷新仍在 @nightly', async ({
  page,
}) => {
  const tools = await api<{ items: ToolRegistration[] }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/analyze-implement/tools`,
  )
  const usable = tools.items.find(
    (tool) => tool.state === 'published' && tool.publishedRevision !== null,
  )
  expect(
    usable,
    'analyze-implement 下没有任何已发布工具 ⇒ 建不出一个「完整」到能保存的岗位模板',
  ).toBeDefined()

  const jobName = `RFC-319 DE-10 lanes ${RUN_TAG}`
  const job = await api<{ id: string }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
    {
      method: 'POST',
      body: {
        name: jobName,
        description: 'RFC-319 DE-10 lane priority fixture',
        defaultToolBindings: [
          {
            workItemRef: 'analyze-implement',
            slotRef: 'default',
            registrationRef: { id: usable!.id, revision: usable!.publishedRevision! },
          },
        ],
        defaultAdapterBindings: [],
        defaultCollaborationBindings: [],
      },
    },
  )

  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=jobs`)
  const card = page.locator('.employee-summary-card').filter({ hasText: jobName })
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByTestId('employee-job-template-editor')
  await expect(editor).toBeVisible()

  const initial = await lanePriorities(page)
  const initialOrder = orderOf(initial)
  expect(
    initialOrder.length,
    '可排序的事件泳道少于两条 ⇒ 重排在这个分类上无从谈起，本条用例的前提不成立',
  ).toBeGreaterThanOrEqual(2)

  const handleFor = (laneId: string) =>
    page.locator(`[data-capability-lane-id="${laneId}"] .employee-toolbox-lane__drag-handle`)

  // ① 键盘：把 P1 那条按一次 ArrowDown，它与 P2 必须**互换**，其余一条都不许动。
  const first = initialOrder[0]!
  const second = initialOrder[1]!
  await handleFor(first).focus()
  await handleFor(first).press('ArrowDown')
  const swapped = { ...initial, [first]: initial[second]!, [second]: initial[first]! }
  await expect
    .poll(() => lanePriorities(page), {
      message:
        '键盘换位没有生效，或者顺手改动了别的泳道 ⇒ 用户按一次方向键会得到一份自己没要的优先级',
      timeout: 15_000,
    })
    .toEqual(swapped)

  // ② 拖拽：抓住现在排第一的那条，一路拖到最后一条的下方。
  //    `updatePointerDrag` 在 `slotBoundaries` 全部越过后落到最后一格
  //    （EmployeeCapabilityPanorama.tsx:378-388），所以「拖到很下面」是确定性的落点。
  const afterKeyboard = orderOf(await lanePriorities(page))
  const dragged = afterKeyboard[0]!
  const lastLane = page.locator(
    `[data-capability-lane-id="${afterKeyboard[afterKeyboard.length - 1]!}"]`,
  )
  const handleBox = await handleFor(dragged).boundingBox()
  const lastBox = await lastLane.boundingBox()
  expect(handleBox, '拖动把手不在视口里 ⇒ 拿不到坐标，拖拽无从发起').not.toBeNull()
  expect(lastBox, '最后一条泳道不在视口里 ⇒ 拿不到落点坐标').not.toBeNull()

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
  await page.mouse.down()
  const targetY = lastBox!.y + lastBox!.height + 240
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y + (targetY - handleBox!.y) * step,
      { steps: 6 },
    )
  }
  // **松手之前**就要看到临时目标序——没有它的拖拽是盲拖，用户只能松手之后再看结果。
  const expectedAfterDrag = [...afterKeyboard.slice(1), dragged]
  await expect
    .poll(() => lanePriorities(page).then(orderOf), {
      message: '拖动过程中优先级序号没有跟着变 ⇒ 没有临时目标序，用户在松手前看不出会落到哪儿',
      timeout: 15_000,
    })
    .toEqual(expectedAfterDrag)
  await page.mouse.up()
  await expect
    .poll(() => lanePriorities(page).then(orderOf), {
      message: '松手之后落回了拖动前的顺序 ⇒ 拖拽的结果没有被提交',
      timeout: 15_000,
    })
    .toEqual(expectedAfterDrag)

  // ③ 落库 + 刷新仍在。只到「界面上变了」为止的话，用户下次进来看到的仍是旧优先级。
  await page.getByRole('button', { name: /^Save and publish/ }).click()
  await expect(editor).toHaveCount(0)
  const persisted = await api<{ items: JobTemplateRow[] }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
  )
  expect(
    persisted.items.find((row) => row.id === job.id)?.draft.reactionLaneOrder,
    '服务端存的仍是旧顺序 ⇒ 界面上的重排只活在本地状态里，刷新即回退',
  ).toEqual(expectedAfterDrag)

  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=jobs`)
  await page
    .locator('.employee-summary-card')
    .filter({ hasText: jobName })
    .getByRole('button', { name: 'Edit', exact: true })
    .click()
  await expect(editor).toBeVisible()
  await expect
    .poll(() => lanePriorities(page).then(orderOf), {
      message: '重新打开编辑器后顺序回到了默认 ⇒ 保存下来的优先级没有被读回编辑态',
      timeout: 15_000,
    })
    .toEqual(expectedAfterDrag)
})

// ------------------------------------------------------------------------- DE-21

test('RFC-319 DE-21: 没有数字员工写权限点的账号——哪怕东西是他的，新建 / 编辑 / 发布 / 归档四个入口一个都不渲染，接口同口径 403 @nightly', async ({
  browser,
}) => {
  // guest 预设里没有任何 `digital-employees:*`；只补两个**读侧**能力：
  //   * `digital-employees:read` —— 否则连列表端点都进不去；
  //   * `resource-acl:private`  —— guest 预设不带它，于是**私有行一律不可见，哪怕是自己的**
  //     （`services/resourceAccessPolicy.ts:57` / `resourceAcl.ts:400`）。少了它这条用例会
  //     红在「所有者看不到自己的资源」上，而那与写权限点无关。
  // 写权限点（create / update / archive）一个都不补——这才是本条要单独掐死的那条腿。
  const reader = await createUserAndLogin(`de21-reader-${RUN_TAG}`, 'guest', [
    'digital-employees:read',
    'resource-acl:private',
  ])

  const employeeName = `RFC-319 DE-21 employee ${RUN_TAG}`
  const employee = await api<{ id: string }>('/api/code/digital-employees', {
    method: 'POST',
    body: { name: employeeName, draft: unpublishableEmployeeDraft() },
  })

  const adminCtx = await browser.newContext()
  await primeAuth(adminCtx, daemon.baseUrl, daemon.token)
  const adminPage = await adminCtx.newPage()
  const readerCtx = await browser.newContext()
  await primeAuth(readerCtx, daemon.baseUrl, reader.token)
  const readerPage = await readerCtx.newPage()

  try {
    // 把这条资源**转让**给低权账号：行级授权档（canEdit / canManage）从此恒真，
    // 剩下唯一还能说话的就是方法级权限点这条腿。
    const acl = await api<{ aclRevision: number }>(`/api/code/digital-employees/${employee.id}/acl`)
    await api(`/api/code/digital-employees/${employee.id}/acl`, {
      method: 'PUT',
      body: {
        ownerUserId: reader.userId,
        expectedResourceId: employee.id,
        expectedAclRevision: acl.aclRevision,
      },
    })
    const afterTransfer = await api<{ ownerUserId: string }>(
      `/api/code/digital-employees/${employee.id}/acl`,
    )
    expect(
      afterTransfer.ownerUserId,
      '转让没生效 ⇒ 下面「东西是他的却还是不能改」的判据不成立，会退化成一条普通的 ACL 用例',
    ).toBe(reader.userId)

    // 对照组：同一条资源、同一时刻，管理员那边四个入口全在。少了它，一个把整页锁死的实现
    // 同样能让下面的反向断言全绿。
    await adminPage.goto(`${daemon.baseUrl}/code/config/employees`)
    await expect(adminPage.getByTestId('config-create-open')).toBeVisible()
    await adminPage.goto(`${daemon.baseUrl}/code/config/employees/${employee.id}`)
    await expect(adminPage.getByRole('heading', { name: employeeName })).toBeVisible()
    for (const testid of [
      'config-edit-open',
      'config-publish',
      'config-acl-open',
      'config-archive-open',
    ]) {
      await expect(
        adminPage.getByTestId(testid),
        `管理员那边 ${testid} 也不在 ⇒ 这条资源本身就没有写入口，反向断言失去意义`,
      ).toBeVisible()
    }

    // 低权账号：列表里看得见这一行（证明可见性没问题），但新建入口不在。
    await readerPage.goto(`${daemon.baseUrl}/code/config/employees`)
    await expect(
      readerPage.getByTestId(`config-row-${employee.id}`),
      '转让之后所有者自己都看不到这一行 ⇒ 可见性出了问题，写入口的断言无从谈起',
    ).toHaveCount(1)
    await expect(
      readerPage.getByTestId('config-create-open'),
      '没有 digital-employees:create 却渲染了新建入口 ⇒ 用户填完整个表单才会吃一个 403',
    ).toHaveCount(0)

    // 详情页：页面打得开（名字在），四个写入口一个都不在。
    await readerPage.goto(`${daemon.baseUrl}/code/config/employees/${employee.id}`)
    await expect(
      readerPage.getByRole('heading', { name: employeeName }),
      '所有者打不开自己那条资源的详情页 ⇒ 缺的是可见性而不是写权限，判据错位',
    ).toBeVisible()
    for (const [testid, harm] of [
      ['config-edit-open', '编辑入口'],
      ['config-publish', '发布入口'],
      ['config-acl-open', '权限入口'],
      ['config-archive-open', '归档入口'],
    ] as const) {
      await expect(
        readerPage.getByTestId(testid),
        `没有对应写权限点却渲染了${harm} ⇒ 门控只是一层装饰，点下去只能吃 403`,
      ).toHaveCount(0)
    }

    // 接口层同门：界面藏了按钮而后端放行，等于把整条边界降级成 UI 装饰。
    const write = await rawCall(
      daemon.baseUrl,
      reader.token,
      `/api/code/digital-employees/${employee.id}/playbook`,
      { method: 'PUT', body: { playbook: unpublishableEmployeeDraft() } },
    )
    expect(write.status, '没有 update 权限点的所有者仍能改说明书 ⇒ 界面门控是唯一的门').toBe(403)
    const archive = await rawCall(
      daemon.baseUrl,
      reader.token,
      `/api/code/digital-employees/${employee.id}/archive`,
      { method: 'POST', body: {} },
    )
    expect(archive.status, '没有 archive 权限点的所有者仍能归档 ⇒ 归档这一档没有方法级门').toBe(403)
    const create = await rawCall(daemon.baseUrl, reader.token, '/api/code/digital-employees', {
      method: 'POST',
      body: { name: `de21-sneak-${RUN_TAG}`, draft: unpublishableEmployeeDraft() },
    })
    expect(create.status, '没有 create 权限点的账号仍能新建 ⇒ 新建这一档没有方法级门').toBe(403)

    const still = await api<{ archivedAt: number | null; publishedRevision: number | null }>(
      `/api/code/digital-employees/${employee.id}`,
    )
    expect(
      { archivedAt: still.archivedAt, publishedRevision: still.publishedRevision },
      '被拒的那几次调用还是改到了库 ⇒ 拒绝发生在写之后',
    ).toEqual({ archivedAt: null, publishedRevision: null })
  } finally {
    await adminCtx.close()
    await readerCtx.close()
  }
})

// ------------------------------------------------------------------------- DE-43

test('RFC-319 DE-43: 上手引导的「下一步」随四个阶段逐格前移，每一步给的都是这一步该去的地方 @nightly', async ({
  page,
}) => {
  await primeAuth(page, journeyDaemon.baseUrl, journeyDaemon.token)

  const readProjection = async (): Promise<JourneyProjection> => {
    await page.goto(`${journeyDaemon.baseUrl}/code/assignments`)
    const section = page.getByTestId('journey-next-action')
    await expect(
      section,
      '指派页上没有渲染上手引导 ⇒ 新用户在这一屏得不到「现在该干嘛」',
    ).toBeVisible()
    return journeyApi<JourneyProjection>('/api/code/setup-journey')
  }

  const hrefOnScreen = async (): Promise<string | null> =>
    page.getByTestId('journey-next-link').getAttribute('href')
  const doneSteps = async (): Promise<number> =>
    page.locator('.journey-next-action__step--done').count()

  // ① 一个员工都没有：第 1 格，去处是「新建员工」。
  const empty = await readProjection()
  expect(
    { key: empty.next.key, ordinal: empty.current.ordinal, total: empty.current.total },
    '空库时的下一步不是「新建员工」⇒ 新用户第一屏就被指去了一个还不存在的东西',
  ).toEqual({ key: 'createEmployee', ordinal: 1, total: 4 })
  expect(
    await hrefOnScreen(),
    '界面上的去处与服务端投影对不上 ⇒ 用户点的按钮和引导说的不是一回事',
  ).toBe('/code/config/employees?create=1')
  expect(await doneSteps(), '一步都还没做，进度条上却已经有已完成的格子').toBe(0)

  // ② 有一个引用悬空的草稿：第 2 格，去处变成这个员工自己的编辑页。
  const employeeName = `RFC-319 DE-43 employee ${RUN_TAG}`
  const employee = await journeyApi<{ id: string }>('/api/code/digital-employees', {
    method: 'POST',
    body: { name: employeeName, draft: unpublishableEmployeeDraft() },
  })
  const drafted = await readProjection()
  expect(
    { key: drafted.next.key, ordinal: drafted.current.ordinal },
    '有了草稿之后引导没有前移 ⇒ 用户建完人回来，屏幕还在让他再建一个',
  ).toEqual({ key: 'configureAndPublish', ordinal: 2 })
  expect(
    await hrefOnScreen(),
    '第二步的去处不是这个员工的编辑页 ⇒ 用户被送回列表，自己找刚建的那一条',
  ).toBe(`/code/config/employees/${employee.id}`)
  expect(await doneSteps(), '刚建完草稿，「定义」这一格应当且仅当已完成一格').toBe(1)

  // ③ 引用补齐但还没发布：仍是第 2 格，但下一步从「继续填」变成「发布」。
  //    这两档若坍缩成一档，用户填完了也不知道自己已经可以发布了。
  const template = await journeyApi<{ id: string }>('/api/code/action-templates', {
    method: 'POST',
    body: {
      name: `RFC-319 DE-43 template ${RUN_TAG}`,
      capabilityId: 'change.implement',
      draft: {
        schemaVersion: 1,
        capabilityId: 'change.implement',
        capabilityContractVersion: 1,
        labels: [],
        compatibility: [],
        executor: { kind: 'agent', agentRef: `rfc319-de43-agent-${RUN_TAG}` },
        runtimeProfileRef: 'default',
        promptSupplement: '',
        skillRefs: [],
        mcpRefs: [],
        readOnlyResourceRefs: [],
        contextProfileRef: null,
        writablePathPolicyRef: null,
        additionalProtectedPathClasses: [],
        verificationProfileRef: `rfc319-de43-profile-${RUN_TAG}`,
        retryDefaults: { sameSession: 1, freshSession: 1 },
      },
    },
  })
  const templateRef: ExactRef = {
    id: template.id,
    revision: (
      await journeyApi<{ revision: number }>(`/api/code/action-templates/${template.id}/publish`, {
        method: 'POST',
        body: {},
      })
    ).revision,
  }
  const policy = await journeyApi<{ id: string }>('/api/code/automation-policies', {
    method: 'POST',
    body: { name: `RFC-319 DE-43 policy ${RUN_TAG}`, draft: defaultPolicyTemplate() },
  })
  const policyRef: ExactRef = {
    id: policy.id,
    revision: (
      await journeyApi<{ revision: number }>(`/api/code/automation-policies/${policy.id}/publish`, {
        method: 'POST',
        body: {},
      })
    ).revision,
  }
  await journeyApi(`/api/code/digital-employees/${employee.id}/playbook`, {
    method: 'PUT',
    body: { playbook: publishableEmployeeDraft(templateRef, policyRef) },
  })
  const ready = await readProjection()
  expect(
    { key: ready.next.key, ordinal: ready.current.ordinal },
    '说明书已经补齐了，引导仍让人「继续填」⇒ 用户不知道自己已经可以发布',
  ).toEqual({ key: 'publishEmployee', ordinal: 2 })

  // ④ 发布之后：第 3 格，去处是带着这个员工 id 的新建指派。
  const employeeRevision = (
    await journeyApi<{ revision: number }>(`/api/code/digital-employees/${employee.id}/publish`, {
      method: 'POST',
      body: {},
    })
  ).revision
  const published = await readProjection()
  expect(
    { key: published.next.key, ordinal: published.current.ordinal },
    '发布之后引导没有走到「设定服务范围」⇒ 用户发布完就断线了',
  ).toEqual({ key: 'assignRepository', ordinal: 3 })
  expect(
    await hrefOnScreen(),
    '第三步的去处没有带上这个员工 ⇒ 用户到了指派页还得自己再选一遍人',
  ).toBe(`/code/assignments?employee=${employee.id}&create=1`)
  expect(await doneSteps(), '发布完应当有「定义」「发布」两格已完成').toBe(2)

  // ⑤ 指派之后：第 4 格，去处是给这个员工派第一件活。
  await journeyApi('/api/code/repository-assignments', {
    method: 'PUT',
    body: {
      scopeKind: 'global-default',
      scopeRef: null,
      employee: { id: employee.id, revision: employeeRevision },
      selectionPolicy: null,
      executionPolicy: null,
      defaultRequirementSourceKey: null,
    },
  })
  const assigned = await readProjection()
  expect(
    { key: assigned.next.key, ordinal: assigned.current.ordinal },
    '指派之后引导没有走到「派第一件活」⇒ 配置全做完了，屏幕还在让人再配一遍',
  ).toEqual({ key: 'launchFirstMission', ordinal: 4 })
  expect(
    await hrefOnScreen(),
    '第四步的去处没有带上这个员工 ⇒ 用户到了发起页还得自己再选一遍人',
  ).toBe(`/code/missions/new?employee=${employee.id}`)
  expect(await doneSteps(), '走到最后一格时前三格都应当已完成').toBe(3)
  expect(
    assigned.steps.map((step) => step.state),
    '进度条的四格状态不是「三格已完成 + 当前格」⇒ 用户看不出自己走到哪儿了',
  ).toEqual(['done', 'done', 'done', 'current'])
})

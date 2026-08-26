// RFC-319 —— 数字员工域「配置资源 / 策略 / 指派 / 能力模板」的用户面 e2e。
//
// 覆盖能力账本 DE-32、DE-33、DE-34、DE-35、DE-36、DE-37、DE-38、DE-45 八行
// （`architecture/e2e-capability-ledger.json` 里全部是 `status: 'gap'`）。八条**全部**是
// P2 / P3、`tier: 'nightly'`，所以每条 test 标题末尾都带 ` @nightly`——PR 腿跑的是
// `--grep-invert '@nightly'`，这些用例只在夜跑的全量腿上跑；账本守卫的
// `tierWiringMismatches` 会逐字核对这个 tag 与 `tier` 是否一致。
//
// ## 为什么这批用例值得存在（每条锁的是**用户会遭遇什么**，不是断言在做什么）
//
//   * DE-32 —— `/code/config/{kind}` 是三族配置资源的唯一列表入口。空态若三族共用一句话，
//     第一次进来的用户看不出「员工」和「动作模板」是两件事；创建对话框若把 kind 特有的必填项
//     漏掉（动作模板的 capability），后端会以 422 回绝，而用户已经把名字填完了才被告知。
//     员工那一族更狠：**没有已发布的规则集时根本不该让人建出员工**——建出来也跑不起来，
//     而「跑不起来」要等到发起第一个任务时才暴露。
//   * DE-33 —— 发布是把草稿冻成不可变修订的那一步。闭包校验会同时抓到好几处问题（缺模板、
//     缺策略、缺 adapter、步骤指向不存在的下一步……），**逐条列出**是用户唯一能据以逐个修的
//     依据。退化成「只显示第一条」或「一句校验失败」，用户就得改一处、点一次、再等一次，
//     或者干脆放弃。这是这一批里最值钱的一格，所以夹具刻意造出**五种不同 code**的违规。
//   * DE-34 —— 归档没有回收站（`archiveXxx` 只写 `archived_at`，UI 没有反向入口）。二次确认
//     若形同虚设，用户在详情页手滑一次就把一份线上配置移出了所有选择器。所以这条**不只**断言
//     「确认后成功」，还要断言「**不确认就一个请求都不发**」——只断言成功路等于没锁住确认框。
//   * DE-35 —— 「未授权用户完全不可见」是产品对外的 ACL 承诺。正向断言（授权后看得见）
//     单独存在时是**假绿**：一个彻底失效的可见性过滤同样让它通过。所以这里必须有**无权账号的
//     反向对照**：列表里没有、详情页与「这个 id 根本不存在」逐字同形、直调接口 404 而不是 403
//     （403 本身就是存在性信号）。RFC-324 之后还多一层：`read` 授权只给看，`write` 才给改，
//     **归档始终留给所有者**——三档若坍缩成一档，一个被授权「看」的人就能归档别人的配置。
//   * DE-36 —— 规则集是「first match wins」，**列表顺序就是求值优先级**。顺序改动若保存不下去
//     或刷新后回弹，用户以为自己调整了优先级，实际数字员工仍按旧顺序动作。发布被拦时的
//     violations 同 DE-33：一句「校验失败」等于让用户去 JSON 里大海捞针。
//   * DE-37 —— 模拟器是发布前唯一能回答「这套规则到底会选哪个动作」的地方。它若不随**当前
//     编辑中的规则**变化（例如读的是服务端已保存的那份），用户会拿着一份看起来正确的模拟结果
//     发布一套完全不同的规则。所以这条**固定事实夹具、只改规则**，断言判决跟着变。
//   * DE-38 —— 三级指派（仓库 > 仓库组 > 全局）在准入时定案。删除若不带 scopeRef 或带错，
//     用户点「删除这个仓库的指派」会**连带删掉别的 scope**，而页面上没有任何提示；引用若不钉
//     已发布修订，指派会指向一个跑不起来的草稿。
//   * DE-45 —— 复制是团队之间共享能力模板的唯一方式。副本若继承了源的 public 可见性，一次复制
//     就把还没改完的模板publish给了全员；上游合并若把**本地已改过的字段**也覆盖掉，用户当初
//     复制的理由就被这次「更新」抹掉了。而合并会把 `scripts` 带过来、脚本以 daemon 身份运行，
//     所以没有 `scripts:author` 的人必须被直接拒绝——否则「从上游更新」就是一条绕过脚本授权的路。
//
// ## 与既有 e2e 的分工（刻意不重叠）
//
//   * `e2e/rfc319-digital-employee-p1.spec.ts` —— 同为数字员工域，但它整份文件都在
//     `/digital-employees/{typeRef}`（RFC-310 之后的**员工 OS** 面）与任务向导上：工具停用、
//     作用域选择、员工编辑回填、评审开关、阻塞恢复。本文件一次都不去那些页面，只做
//     `/code/config/*`、`/code/policies*`、`/code/assignments` 三张**配置面**页面。
//   * `e2e/rfc099-ownership-acl.spec.ts` —— ACL 面板的浏览器接线只覆盖 **agent / workflow**
//     两类；`/code/config/*` 那五类配置资源在整个 `e2e/` 里从未被授权过一次。本文件的 DE-35
//     补的正是这一族，并且补上 rfc099 那条用例没有的两件事：**接口层的 404 同形**与
//     **RFC-324 的 read / write / govern 三档分野**。
//   * `e2e/visual-regression.spec.ts:1446-1655` —— `/code/config/*` 与 `/code/policies` 在
//     e2e 里此前**只有截图**，而且其中大部分跑在 `routeCodeSurfaceFixtures` 的假 API 上
//     （`e2e/code-surface-fixtures.ts:304-340` 把 `/api/code/*` 的 GET 全换成假数据），
//     整个 describe 还被 `RUN_VISUAL_REGRESSION` 关着。本文件**不引入任何 fixture 路由**，
//     全程真 daemon、真 SQLite、真 HTTP。
//   * `packages/frontend/tests/code-config-pages.test.tsx` / `code-policy-pages.test.tsx` /
//     `code-assignments-page.test.tsx` —— 组件层覆盖，`fetch` 是 mock 的：它们能证明
//     「点了按钮会发出这个形状的请求」，不能证明「服务端接受这个形状」，也不能证明
//     「服务端的回执被正确呈现」。本文件补的正是这两半之间的接线。
//
// ## 源码锚点（可复跑核对，纯文本引用；禁 GitHub 外链见 CLAUDE.md §opencode 源码自取规则）
//
//   packages/frontend/src/routes/code.config.tsx:93-103          `?create=1` 三形状解析（数字 1 也认）
//   packages/frontend/src/routes/code.config.tsx:172-196          三族各自的空态文案 + 空态里的创建按钮
//   packages/frontend/src/routes/code.config.tsx:355              员工创建：没有已发布规则集则 submit 恒 disabled
//   packages/frontend/src/routes/code.config.tsx:385-398          `noRuleSet` 横幅取代规则集下拉
//   packages/frontend/src/routes/code.config.tsx:466-476          只有 action-templates 渲染 capability 必填项
//   packages/frontend/src/routes/code.config.detail.tsx:72-83     publish 422 的 violations 透传谓词
//   packages/frontend/src/routes/code.config.detail.tsx:212-222   `config-publish-violations` 逐条 `<li>`
//   packages/frontend/src/routes/code.config.detail.tsx:93-95     canUpdate / canArchive = 权限点 ∧ 行级授权档
//   packages/frontend/src/routes/code.config.detail.tsx:283-291   归档走 ConfirmDialog（描述里带资源名）
//   packages/frontend/src/routes/code.policies.$id.tsx:236-243    publish 在 dirty 时禁用（必须先保存）
//   packages/frontend/src/routes/code.policies.$id.tsx:259-273    `policy-violations` 逐条 `<li>`
//   packages/frontend/src/routes/code.policies.$id.tsx:339        Simulate 页签渲染 PolicySimulator(actionRules)
//   packages/frontend/src/components/code/PolicyRuleBuilder.tsx:242-249  move：列表顺序即求值优先级
//   packages/frontend/src/components/code/PolicyRuleBuilder.tsx:361-377  add-rule 的确定性默认值
//   packages/frontend/src/components/code/PolicySimulator.tsx:84-105     preview 用的是**编辑中**的规则
//   packages/frontend/src/routes/code.assignments.tsx:137-145      DELETE 的 scopeRef 走 query
//   packages/frontend/src/routes/code.assignments.tsx:242-299      SCOPE_ORDER 分组渲染
//   packages/frontend/src/routes/code.assignments.tsx:338-366      publishedOnly + revisionOf：钉已发布修订
//   packages/backend/src/routes/developmentConfig.ts:253-263       requireVisible：不可见与不存在同一个 404 载荷
//   packages/backend/src/routes/developmentConfig.ts:282-303       requireEditable / requireGovernable 两档
//   packages/backend/src/modules/development-automation/domain/digitalEmployee.ts:349-701  发布闭包检查
//   packages/backend/src/modules/development-automation/domain/automationPolicy.ts:219-272 策略发布检查
//   packages/backend/src/routes/capabilityTemplates.ts:179-200     copy
//   packages/backend/src/routes/capabilityTemplates.ts:242-277     upstream/merge + scripts-forbidden
//   packages/backend/src/services/capabilityTemplates.ts:376-411   copyTemplate：私有 + 记基线快照
//   packages/backend/src/modules/code-capability/application/templateUpstreamStatus.ts:156-215  三方合并
//
// ## 执行模型
//
//   * 主体共用一个 daemon（默认 `basic` stub，本文件不跑任何任务）。DE-32 需要一份**真空**的
//     三族列表来分辨「一条都没有」与「被过滤掉了」，所以它单独起第二个 daemon（`emptyDaemon`）。
//   * 本文件**一次 `page.route` 都没有**（没有任何注入需求：所有分支都能用真数据造出来），
//     因此也不存在 `docs/dev-gotchas.md` §「`page.route` 两把锁」里那个 `route.fetch()` 竞态。
//     `test.afterEach` 里仍然按定式 `unrouteAll({ behavior: 'wait' })` 收口，作为将来有人加注入
//     时的既有护栏。
//   * DE-45 的两条用例**不开浏览器**：`TemplateUpstreamPanel.tsx` 是全仓零调用方的组件
//     （`grep -rn TemplateUpstreamPanel packages/ e2e/` 只命中它自己的定义），能力模板在
//     今天的产品里**没有任何界面入口**，唯一的用户面是 HTTP API。照账本文案去写一条浏览器
//     用例只能得到一条永远红的用例，所以这两条落在编译后 daemon 的接口面上，并在报告里点名。
//   * 不用 `test.describe.configure({ mode: 'serial' })`：`playwright.config.ts` 的
//     `fullyParallel` 已经是 false，同文件内本就按声明顺序串行；不加 serial 是为了让**某一条红
//     不会把其余条目变成 `did not run`**，变异验证才归因得出来。每条用例的前置都自带，互不依赖。

import { expect, test, type Locator, type Page, type Request } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 零依赖叶子模块（整文件没有一条 import），并且由
// `packages/frontend/tests/code-policy-pages.test.tsx:95` 的
// `expect(defaultPolicyTemplate()).toEqual(defaultAutomationPolicyContent())` 与后端
// domain 逐字段钉住。手抄一份默认策略内容会在后端默认值演进的那天把整份 spec 红在
// 「发布被拦」上——与被测行为无关的失败。
import { defaultPolicyTemplate } from '../packages/frontend/src/data/policyFactCatalog'
import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

/** 同一次运行内的唯一后缀：配置资源的名字在库里有唯一约束。 */
const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

interface ExactRef {
  id: string
  revision: number
}

interface IdentityRow {
  id: string
  name: string
  publishedRevision: number | null
  visibility: 'private' | 'public'
  archivedAt: number | null
}

interface ApiResponse {
  status: number
  text: string
  json: unknown
}

test.setTimeout(180_000)

let daemon: DaemonHandle
let emptyDaemon: DaemonHandle

/** 已发布的动作模板（capabilityId = change.implement），员工闭包与路由都指它。 */
let templateRef: ExactRef = { id: '', revision: 0 }
/** 已发布的自动化策略，员工的 defaultPolicyRef 与指派的选择策略都指它。 */
let policyRef: ExactRef = { id: '', revision: 0 }
let policyName = ''
/** 只有草稿、从未发布的策略：指派对话框里不得出现。 */
let draftPolicyName = ''
let publishedEmployeeId = ''
let publishedEmployeeName = ''
let publishedEmployeeRevision = 0
/** 只有草稿、从未发布的员工：指派对话框里不得出现。 */
let draftEmployeeName = ''
let repoA = { id: '', url: '' }
let repoB = { id: '', url: '' }

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
): Promise<ApiResponse> {
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

/** 成功路：非 2xx 直接抛，夹具搭建失败要当场停在原因上而不是下游断言上。 */
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
async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return call<T>(daemon.baseUrl, daemon.token, path, init)
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

async function createUserAndLogin(username: string, role: 'admin' | 'user'): Promise<SeededUser> {
  // 与 e2e/rfc099-ownership-acl.spec.ts 用同一个显然是夹具的口令字面量：
  // gitleaks 的 git 模式扫的是历史 patch，一个长得像真密钥的夹具串入库就永远在那儿。
  const password = 'longEnoughPassword'
  const created = await api<{ id: string }>('/api/users', {
    method: 'POST',
    body: { username, displayName: username, role, password },
  })
  const login = await call<{ sessionToken: string }>(
    daemon.baseUrl,
    daemon.token,
    '/api/auth/login',
    {
      method: 'POST',
      body: { username, password },
    },
  )
  return { username, userId: created.id, token: login.sessionToken }
}

/**
 * 打开一个 `Select` 并选中给定选项。
 *
 * `Select` 在选项数 ≥ `SELECT_SEARCH_THRESHOLD`(8) 时自动变成 searchable
 * （`packages/frontend/src/components/Select.tsx:195`），焦点落到搜索框上；此时直接点行
 * 会在 portaled listbox 还在滚动时命中过期坐标，所以走组件自己的键盘契约，并先确认
 * 高亮行就是要选的那一行（同 `e2e/rfc319-digital-employee-p1.spec.ts:123-150`）。
 */
async function pickSelectOption(
  page: Page,
  trigger: Locator,
  optionName: string | RegExp,
  query?: string,
): Promise<void> {
  await trigger.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  const option = page.getByRole('option', {
    name: optionName,
    exact: typeof optionName === 'string',
  })
  const search = listbox.getByRole('textbox').first()
  if ((await search.count()) === 0) {
    await expect(option).toBeVisible()
    await option.click()
    await expect(listbox).toHaveCount(0)
    return
  }
  await search.fill(query ?? (typeof optionName === 'string' ? optionName : ''))
  await expect(option).toBeVisible()
  const optionId = await option.getAttribute('id')
  expect(optionId).not.toBeNull()
  await expect(listbox).toHaveAttribute('aria-activedescendant', optionId!)
  await page.keyboard.press('Enter')
  await expect(listbox).toHaveCount(0)
}

/** 打开一个 `Select` 只为读它的选项清单，然后原样关掉（不改变任何值）。 */
async function readSelectOptions(page: Page, trigger: Locator): Promise<string[]> {
  await trigger.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  const labels = await page.getByRole('option').allInnerTexts()
  await page.keyboard.press('Escape')
  await expect(listbox).toHaveCount(0)
  return labels.map((label) => label.trim())
}

/** 一份**可发布**的动作模板内容（`actionTemplateContentSchema` 的最小完整形态）。 */
function publishableTemplateDraft(capabilityId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    capabilityId,
    capabilityContractVersion: 1,
    labels: [],
    compatibility: [],
    executor: { kind: 'agent', agentRef: `rfc319-agent-${RUN_TAG}` },
    runtimeProfileRef: 'default',
    promptSupplement: '',
    skillRefs: [],
    mcpRefs: [],
    readOnlyResourceRefs: [],
    contextProfileRef: null,
    writablePathPolicyRef: null,
    additionalProtectedPathClasses: [],
    verificationProfileRef: `rfc319-profile-${RUN_TAG}`,
    retryDefaults: { sameSession: 1, freshSession: 1 },
  }
}

/**
 * 一份 schema 合法、但**闭包校验会同时抓到五处不同问题**的员工说明书。
 *
 * 五条各自 code / where / detail 三元组都不同，所以「逐条列出」这件事可以逐条断言，
 * 而不是只能数个数。对照见
 * `packages/backend/src/modules/development-automation/domain/digitalEmployee.ts:349-701`。
 */
function fiveViolationEmployeeDraft(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    description: 'RFC-319 DE-33 fixture: five independent closure violations at once.',
    supportedRepositoryFacts: [],
    steps: [
      {
        stepId: 'implement',
        displayName: 'Implement the change',
        description: '',
        when: [],
        producer: { kind: 'agent', implementationRef: { id: 'ghost-template', revision: 1 } },
        input: { kind: 'mission-requirement' },
        onSuccess: 'ghost-step',
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
        fallbackTemplateRef: { id: 'ghost-route-template', revision: 1 },
      },
    ],
    requirementSources: [
      { sourceKey: 'jira', adapterRef: { id: 'ghost-adapter', revision: 1 }, isDefault: true },
    ],
    pipelineProviders: [],
    defaultPolicyRef: { id: 'ghost-policy', revision: 1 },
  }
}

/** 同一份说明书，把五处引用全部补齐——这一版必须发得出去。 */
function repairedEmployeeDraft(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    description: 'RFC-319 DE-33 fixture: every reference resolved.',
    supportedRepositoryFacts: [],
    steps: [
      {
        stepId: 'implement',
        displayName: 'Implement the change',
        description: '',
        when: [],
        producer: { kind: 'agent', implementationRef: templateRef },
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
      { capabilityId: 'change.implement', rules: [], fallbackTemplateRef: templateRef },
    ],
    requirementSources: [],
    pipelineProviders: [],
    defaultPolicyRef: policyRef,
  }
}

async function seedPublishedTemplate(name: string, capabilityId: string): Promise<ExactRef> {
  const created = await api<{ id: string }>('/api/code/action-templates', {
    method: 'POST',
    body: { name, capabilityId, draft: publishableTemplateDraft(capabilityId) },
  })
  const receipt = await api<{ revision: number }>(
    `/api/code/action-templates/${encodeURIComponent(created.id)}/publish`,
    { method: 'POST', body: {} },
  )
  return { id: created.id, revision: receipt.revision }
}

async function seedPolicy(
  name: string,
  publish: boolean,
): Promise<{ id: string; ref: ExactRef | null }> {
  const created = await api<{ id: string }>('/api/code/automation-policies', {
    method: 'POST',
    body: { name, draft: defaultPolicyTemplate() },
  })
  if (!publish) return { id: created.id, ref: null }
  const receipt = await api<{ revision: number }>(
    `/api/code/automation-policies/${encodeURIComponent(created.id)}/publish`,
    { method: 'POST', body: {} },
  )
  return { id: created.id, ref: { id: created.id, revision: receipt.revision } }
}

async function importFixtureRepos(count: number): Promise<Array<{ id: string; url: string }>> {
  const urls: string[] = []
  for (let index = 0; index < count; index += 1) {
    const dir = mkdtempSync(join(tmpdir(), `aw-rfc319-cfg-${index}-`))
    writeFileSync(join(dir, 'README.md'), `# RFC-319 config fixture repo ${index}\n`)
    initGitRepo(dir)
    urls.push(repoRemoteUrl(dir))
  }
  let batch = await api<{ batchId: string; state: string; rows: Array<{ status: string }> }>(
    '/api/cached-repos/batch-import',
    { method: 'POST', body: { urls } },
  )
  const deadline = Date.now() + 60_000
  while (batch.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    batch = await api(`/api/cached-repos/imports/${batch.batchId}`)
  }
  if (batch.state !== 'completed' || batch.rows.some((row) => row.status !== 'done')) {
    throw new Error(`fixture repository import failed: ${JSON.stringify(batch.rows)}`)
  }
  const listed = await api<{ items: Array<{ id: string; urlRedacted: string | null }> }>(
    '/api/cached-repos',
  )
  return urls.map((url) => {
    const found = listed.items.find((candidate) => candidate.urlRedacted === url)
    if (found === undefined) throw new Error(`imported repository is missing: ${url}`)
    return { id: found.id, url }
  })
}

// ------------------------------------------------------------------- lifecycle

test.beforeAll(async () => {
  daemon = await startDaemon()
  emptyDaemon = await startDaemon()

  templateRef = await seedPublishedTemplate(
    `Implementation template ${RUN_TAG}`,
    'change.implement',
  )

  policyName = `Baseline rule set ${RUN_TAG}`
  const published = await seedPolicy(policyName, true)
  policyRef = published.ref!
  draftPolicyName = `Draft-only rule set ${RUN_TAG}`
  await seedPolicy(draftPolicyName, false)

  publishedEmployeeName = `Published employee ${RUN_TAG}`
  const employee = await api<{ id: string }>('/api/code/digital-employees', {
    method: 'POST',
    body: { name: publishedEmployeeName, draft: repairedEmployeeDraft() },
  })
  publishedEmployeeId = employee.id
  const employeeReceipt = await api<{ revision: number }>(
    `/api/code/digital-employees/${encodeURIComponent(publishedEmployeeId)}/publish`,
    { method: 'POST', body: {} },
  )
  publishedEmployeeRevision = employeeReceipt.revision

  draftEmployeeName = `Draft-only employee ${RUN_TAG}`
  await api('/api/code/digital-employees', {
    method: 'POST',
    body: { name: draftEmployeeName, draft: repairedEmployeeDraft() },
  })

  const repos = await importFixtureRepos(2)
  repoA = repos[0]!
  repoB = repos[1]!
})

test.afterAll(async () => {
  await daemon?.stop()
  await emptyDaemon?.stop()
})

test.afterEach(async ({ page }) => {
  // 本文件目前一条注入都没有，这一句是给将来加注入的人留的护栏：先摘掉全部 handler，
  // 再趁 page 还活着把在飞的等完（`docs/dev-gotchas.md` §「page.route 两把锁」的锁 B）。
  // 必须是 'wait' 而不是 'ignoreErrors'——后者只是把错吞掉。
  await page.unrouteAll({ behavior: 'wait' })
})

// ------------------------------------------------------------------------ DE-32

test('RFC-319 DE-32: /code/config 三族配置资源的空态各说各话，创建对话框只对动作模板要能力、对员工在没有已发布规则集时拒绝放行 @nightly', async ({
  page,
}) => {
  await primeAuth(page, emptyDaemon.baseUrl, emptyDaemon.token)

  // ---- action-templates：空态 → `?create=1` 自动开窗 → 能力必填 → 建出来落表 ----
  await page.goto(`${emptyDaemon.baseUrl}/code/config/action-templates`)
  // 空态文案必须是「技术资源」那一族的，不是员工那一族的。两族共用一句话时，第一次进来的
  // 用户看不出这两张列表装的是不同的东西。
  await expect(page.getByTestId('empty-state')).toContainText('Nothing configured yet')
  await expect(page.getByTestId('config-list')).toHaveCount(0)

  // `?create=1` 经 TanStack 的默认解析会变成**数字 1**（code.config.tsx:93-103）。少认这一种，
  // `/code` 首屏主动作点进来只会落到列表页、对话框不开，而且不报错。
  await page.goto(`${emptyDaemon.baseUrl}/code/config/action-templates?create=1`)
  const templateDialog = page.getByRole('dialog')
  await expect(templateDialog).toBeVisible()
  await expect(templateDialog.getByRole('heading', { name: /Create/ })).toBeVisible()
  // capability 是这一族**独有**的必填项：漏了它后端在 create 期就回
  // `action-template-capability-required`，而用户已经把名字填完了才被告知。
  await expect(templateDialog.getByTestId('config-create-capability')).toBeVisible()
  await expect(templateDialog.getByTestId('config-create-submit')).toBeDisabled()

  const templateName = `Empty-daemon template ${RUN_TAG}`
  await templateDialog.getByTestId('config-create-name').fill(templateName)
  await pickSelectOption(
    page,
    templateDialog.getByTestId('config-create-capability'),
    'change.review',
  )
  await expect(templateDialog.getByTestId('config-create-submit')).toBeEnabled()
  const templateCreated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/code/action-templates',
  )
  await templateDialog.getByTestId('config-create-submit').click()
  const templateResponse = await templateCreated
  expect(templateResponse.status()).toBe(201)
  // 载荷由 shared 的共用契约产出；capability 若没随请求上行，建出来的模板没有能力归属，
  // 之后在任何一条能力路由里都选不出来。
  expect(templateResponse.request().postDataJSON()).toMatchObject({
    name: templateName,
    capabilityId: 'change.review',
  })
  const templateId = ((await templateResponse.json()) as { id: string }).id
  // 成功创建后必须落到详情页：停在列表页等于用户不知道自己该去哪儿继续配置。
  await page.waitForURL(`**/code/config/action-templates/${templateId}`)

  await page.goto(`${emptyDaemon.baseUrl}/code/config/action-templates`)
  const templateRow = page.getByTestId(`config-row-${templateId}`)
  await expect(templateRow).toHaveCount(1)
  // 新建的资源只有草稿：列表必须如实标「Draft only」，否则用户以为它已经可用了。
  await expect(templateRow).toContainText('Draft only')
  // 「Kind detail」列对动作模板显示的是 capabilityId——这是列表上唯一能区分两条模板的信息。
  await expect(templateRow).toContainText('change.review')

  // ---- verification-profiles：同一张骨架，但**不得**出现能力必填项 ----
  await page.goto(`${emptyDaemon.baseUrl}/code/config/verification-profiles`)
  await expect(page.getByTestId('empty-state')).toContainText('Nothing configured yet')
  await page.getByTestId('config-create-open').click()
  const profileDialog = page.getByRole('dialog')
  await expect(profileDialog).toBeVisible()
  // 验证 profile 没有 capability。多渲染一格不是多余的 UI，是会往请求体里塞一个后端会
  // strict-reject 的键。
  await expect(profileDialog.getByTestId('config-create-capability')).toHaveCount(0)

  const profileName = `Empty-daemon profile ${RUN_TAG}`
  await profileDialog.getByTestId('config-create-name').fill(profileName)
  const profileCreated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/code/verification-profiles',
  )
  await profileDialog.getByTestId('config-create-submit').click()
  const profileResponse = await profileCreated
  expect(profileResponse.status()).toBe(201)
  const profileId = ((await profileResponse.json()) as { id: string }).id
  await page.waitForURL(`**/code/config/verification-profiles/${profileId}`)
  await page.goto(`${emptyDaemon.baseUrl}/code/config/verification-profiles`)
  await expect(page.getByTestId(`config-row-${profileId}`)).toHaveCount(1)

  // ---- employees：空态文案不同，且**没有已发布规则集时根本建不出来** ----
  await page.goto(`${emptyDaemon.baseUrl}/code/config/employees`)
  await expect(page.getByTestId('empty-state')).toContainText('No digital employees yet')
  await page.getByTestId('config-create-open').click()
  const employeeDialog = page.getByRole('dialog')
  await expect(employeeDialog).toBeVisible()
  // 规则集决定「下一步做什么」；没有它，建出来的员工接到活也不会动。这条横幅是用户
  // 唯一被告知「先去发布一个规则集」的地方。
  await expect(employeeDialog).toContainText('Publish a business rule set first')
  await employeeDialog.getByTestId('config-create-name').fill(`Doomed employee ${RUN_TAG}`)
  // 名字填满之后按钮仍然不可点——这一格若失效，用户会建出一个**永远不会开始工作**的员工，
  // 而且要到发起第一个任务时才发现。
  await expect(employeeDialog.getByTestId('config-create-submit')).toBeDisabled()
})

// ------------------------------------------------------------------------ DE-33

test('RFC-319 DE-33: 员工发布被闭包校验拦下时五条违规各自成行、code/位置/详情都在，补齐引用后同一颗按钮发出 v1 @nightly', async ({
  page,
}) => {
  const brokenName = `Publish-blocked employee ${RUN_TAG}`
  const broken = await api<{ id: string }>('/api/code/digital-employees', {
    method: 'POST',
    body: { name: brokenName, draft: fiveViolationEmployeeDraft() },
  })

  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/code/config/employees/${broken.id}`)
  await expect(page.getByTestId('config-summary-employee')).toBeVisible()
  // 进页面就该看见「有几处要处理」。这一格若恒显示 ready，用户会一路点到发布才知道不行。
  await expect(page.getByTestId('config-summary-employee')).toContainText('5 items need attention')

  const blocked = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/code/digital-employees/${broken.id}/publish`,
  )
  await page.getByTestId('config-publish').click()
  expect((await blocked).status()).toBe(422)

  const violations = page.getByTestId('config-publish-violations')
  await expect(violations).toBeVisible()
  const rows = violations.locator('li')
  // **这是这一批最值钱的一格**：五处互不相干的问题必须各自成行。退化成「只渲染第一条」或
  // 「汇总成一句」时，下面的逐条断言里至少四条会红，而计数断言把「多列了别的东西」也一并挡住。
  await expect(rows).toHaveCount(5)
  const expected: ReadonlyArray<{ code: string; where: string; detail: string }> = [
    { code: 'step-target-missing', where: 'steps/implement', detail: 'ghost-step' },
    {
      code: 'step-implementation-missing',
      where: 'steps/implement/producer',
      detail: 'ghost-template@1',
    },
    {
      code: 'template-missing',
      where: 'capabilityRoutes/change.implement',
      detail: 'ghost-route-template@1',
    },
    { code: 'adapter-missing', where: 'requirementSources/jira', detail: 'ghost-adapter@1' },
    { code: 'policy-missing', where: 'defaultPolicyRef', detail: 'ghost-policy@1' },
  ]
  for (const violation of expected) {
    // 三元组一起断言：只断言 code 的话，一个把每条 detail 都渲染成同一句话的退化实现照样绿，
    // 而用户拿到的仍然是「知道有五个问题、不知道是哪五个」。
    const row = rows.filter({ hasText: violation.code })
    await expect(row, `violation ${violation.code} must be listed on its own line`).toHaveCount(1)
    await expect(row).toContainText(violation.where)
    await expect(row).toContainText(violation.detail)
  }

  // 补齐五处引用之后，**同一颗按钮**必须能把它发出去——违规列表若不随新草稿消失，
  // 用户会以为自己没修好而反复改。
  await api(`/api/code/digital-employees/${encodeURIComponent(broken.id)}/playbook`, {
    method: 'PUT',
    body: { playbook: repairedEmployeeDraft() },
  })
  await page.reload()
  await expect(page.getByTestId('config-summary-employee')).toContainText(
    'Rules validate and are ready to publish',
  )
  const published = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/code/digital-employees/${broken.id}/publish`,
  )
  await page.getByTestId('config-publish').click()
  expect((await published).status()).toBe(200)
  await expect(page.getByTestId('config-publish-violations')).toHaveCount(0)
  // 页头的修订徽标是「这份配置已经可以被指派引用」的唯一信号。
  await expect(page.locator('.page__meta')).toContainText('v1')

  const stored = await api<IdentityRow>(
    `/api/code/digital-employees/${encodeURIComponent(broken.id)}`,
  )
  // 落库的 publishedRevision 才是指派与任务真正读的那份；只断言界面会漏掉「前端自己
  // 画了个 v1、服务端什么都没写」这一类失败。
  expect(stored.publishedRevision).toBe(1)
})

// ------------------------------------------------------------------------ DE-34

test('RFC-319 DE-34: 归档要二次确认——取消时一个归档请求都不发，确认后详情页与列表同时标记已归档且归档入口消失 @nightly', async ({
  page,
}) => {
  const profileName = `Archivable profile ${RUN_TAG}`
  const profile = await api<{ id: string }>('/api/code/verification-profiles', {
    method: 'POST',
    body: {
      name: profileName,
      draft: { schemaVersion: 1, steps: [], stopPolicy: 'first-failure' },
    },
  })
  const archivePath = `/api/code/verification-profiles/${profile.id}/archive`

  let archiveRequests = 0
  const countArchive = (request: Request): void => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === archivePath) {
      archiveRequests += 1
    }
  }
  page.on('request', countArchive)

  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/code/config/verification-profiles/${profile.id}`)
  await expect(page.getByTestId('config-summary-profile')).toBeVisible()
  await expect(page.getByTestId('config-archive-open')).toBeVisible()

  await page.getByTestId('config-archive-open').click()
  const confirm = page.getByRole('dialog')
  await expect(confirm).toBeVisible()
  await expect(confirm.getByRole('heading', { name: 'Archive this resource?' })).toBeVisible()
  // 确认框必须说清**归档的是哪一个**：详情页上同时躺着好几份配置的入口，一句泛泛的
  // 「确定要归档吗」在用户点错资源时给不出任何纠错线索。
  await expect(confirm).toContainText(profileName)

  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // 「取消」必须是真的什么都没发生。只断言「确认后成功」等于根本没锁住确认框——
  // 一个把 onConfirm 接到打开按钮上的退化实现照样能通过那一半。
  expect(archiveRequests, 'cancelling the confirmation must not send an archive request').toBe(0)
  const afterCancel = await api<IdentityRow>(
    `/api/code/verification-profiles/${encodeURIComponent(profile.id)}`,
  )
  expect(afterCancel.archivedAt).toBeNull()

  await page.getByTestId('config-archive-open').click()
  const archived = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === archivePath,
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click()
  expect((await archived).status()).toBe(200)
  expect(archiveRequests).toBe(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  page.off('request', countArchive)

  // 归档后页头必须换标记、并且归档入口消失——按钮还在意味着用户会再点一次，
  // 而第二次归档对一个已归档资源是静默 no-op，用户永远得不到「已经归过了」的反馈。
  await expect(page.locator('.page__meta')).toContainText('Archived')
  await expect(page.getByTestId('config-archive-open')).toHaveCount(0)

  await page.goto(`${daemon.baseUrl}/code/config/verification-profiles`)
  await expect(page.getByTestId(`config-row-${profile.id}`)).toContainText('Archived')
  const stored = await api<IdentityRow>(
    `/api/code/verification-profiles/${encodeURIComponent(profile.id)}`,
  )
  expect(stored.archivedAt).not.toBeNull()
})

// ------------------------------------------------------------------------ DE-35

test('RFC-319 DE-35: 私有配置资源对未授权账号既不在列表也不在详情，接口回的 404 与「这个 id 从来不存在」逐字同形 @nightly', async ({
  browser,
}) => {
  const alice = await createUserAndLogin(`alice-de35-${RUN_TAG}`, 'user')
  const carol = await createUserAndLogin(`carol-de35-${RUN_TAG}`, 'user')

  const secretName = `Alice private profile ${RUN_TAG}`
  const secret = await call<{ id: string; visibility: string }>(
    daemon.baseUrl,
    alice.token,
    '/api/code/verification-profiles',
    {
      method: 'POST',
      body: {
        name: secretName,
        draft: { schemaVersion: 1, steps: [], stopPolicy: 'first-failure' },
      },
    },
  )
  // RFC-231：受支持的新建路径一律「创建者 owner + private + 零 grants」。默认若翻成 public，
  // 下面每一条不可见断言都会红——这正是它们该做的事。
  expect(secret.visibility).toBe('private')

  const aliceCtx = await browser.newContext()
  await primeAuth(aliceCtx, daemon.baseUrl, alice.token)
  const alicePage = await aliceCtx.newPage()
  const carolCtx = await browser.newContext()
  await primeAuth(carolCtx, daemon.baseUrl, carol.token)
  const carolPage = await carolCtx.newPage()

  // 所有者自己看得见，并且能打开权限面板——这是下面所有「看不见」断言的对照组：
  // 少了它，一个把整张列表都过滤空的实现同样会让反向断言全绿。
  await alicePage.goto(`${daemon.baseUrl}/code/config/verification-profiles`)
  await expect(alicePage.getByTestId(`config-row-${secret.id}`)).toHaveCount(1)
  await alicePage.goto(`${daemon.baseUrl}/code/config/verification-profiles/${secret.id}`)
  await alicePage.getByTestId('config-acl-open').click()
  await expect(alicePage.getByTestId('acl-panel')).toBeVisible()
  await expect(alicePage.getByTestId('acl-owner-row')).toContainText(alice.username)

  // 陌生人：列表里既没有那一行，也不该出现资源名（名字本身就是信息）。
  await carolPage.goto(`${daemon.baseUrl}/code/config/verification-profiles`)
  await expect(carolPage.getByTestId(`config-row-${secret.id}`)).toHaveCount(0)
  await expect(carolPage.getByText(secretName)).toHaveCount(0)

  // 直链详情：呈现出来的东西必须与「这个 id 根本不存在」**逐字相同**。一旦不同——哪怕只
  // 泄露一个名字、或者把 404 换成 403（403 本身就是「这个 id 存在」的信号）——存在性就漏了。
  const denialShownTo = async (id: string): Promise<string> => {
    await carolPage.goto(`${daemon.baseUrl}/code/config/verification-profiles/${id}`)
    const banner = carolPage.locator('.error-box').first()
    await expect(banner).toBeVisible()
    await expect(carolPage.getByText(secretName)).toHaveCount(0)
    return (await banner.innerText()).trim()
  }
  const hiddenButReal = await denialShownTo(secret.id)
  const neverExisted = await denialShownTo('01JZZZZZZZZZZZZZZZZZZZZZZZ')
  expect(hiddenButReal, '私有配置资源的详情页必须与「这个 id 从来不存在」逐字同形').toBe(
    neverExisted,
  )

  // 接口层同样：绕开界面直接打也必须是同一份 404 载荷。界面挡住了而接口没挡，
  // 等于把整条边界降级成一层 UI 装饰。
  const apiHidden = await rawCall(
    daemon.baseUrl,
    carol.token,
    `/api/code/verification-profiles/${secret.id}`,
  )
  const apiMissing = await rawCall(
    daemon.baseUrl,
    carol.token,
    '/api/code/verification-profiles/01JZZZZZZZZZZZZZZZZZZZZZZZ',
  )
  expect(apiHidden.status).toBe(404)
  expect(apiHidden.text).toBe(apiMissing.text)
  // 写面也一样是 404 而不是 403：用 405/403 区分开等于回答了「它存在吗」。
  const apiWrite = await rawCall(
    daemon.baseUrl,
    carol.token,
    `/api/code/verification-profiles/${secret.id}`,
    { method: 'PUT', body: { draft: { schemaVersion: 1, steps: [], stopPolicy: 'collect-all' } } },
  )
  expect(apiWrite.status).toBe(404)

  await aliceCtx.close()
  await carolCtx.close()
})

test('RFC-319 DE-35: ACL 面板授 read 只给只读、升 write 才给编辑与发布，归档始终留给所有者 @nightly', async ({
  browser,
}) => {
  const alice = await createUserAndLogin(`alice-de35b-${RUN_TAG}`, 'user')
  const carol = await createUserAndLogin(`carol-de35b-${RUN_TAG}`, 'user')

  const sharedName = `Alice shared profile ${RUN_TAG}`
  const shared = await call<{ id: string }>(
    daemon.baseUrl,
    alice.token,
    '/api/code/verification-profiles',
    {
      method: 'POST',
      body: {
        name: sharedName,
        draft: { schemaVersion: 1, steps: [], stopPolicy: 'first-failure' },
      },
    },
  )

  const aliceCtx = await browser.newContext()
  await primeAuth(aliceCtx, daemon.baseUrl, alice.token)
  const alicePage = await aliceCtx.newPage()
  const carolCtx = await browser.newContext()
  await primeAuth(carolCtx, daemon.baseUrl, carol.token)
  const carolPage = await carolCtx.newPage()

  const openAcl = async (): Promise<void> => {
    await alicePage.goto(`${daemon.baseUrl}/code/config/verification-profiles/${shared.id}`)
    await alicePage.getByTestId('config-acl-open').click()
    await expect(alicePage.getByTestId('acl-panel')).toBeVisible()
  }

  // (1) alice 通过 UserPicker 授 carol —— 新加的人一律落 `read`（AclPanel.tsx:409 的安全默认）。
  await openAcl()
  await alicePage.getByTestId('acl-members-input').click()
  await alicePage.getByTestId('acl-members-input').fill(carol.username)
  await alicePage.getByTestId(`acl-members-option-${carol.username}`).click()
  await expect(alicePage.getByTestId(`acl-level-read-${carol.userId}`)).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await alicePage.getByTestId('acl-save').click()
  // 保存成功会关掉弹窗（用户反馈：保存后弹窗不能杵在那儿）。
  await expect(alicePage.getByTestId('acl-panel')).toHaveCount(0)

  // (2) read 档：看得见、进得去，但**一个写入口都没有**。三颗按钮任意一颗漏掉门控，
  //     就是把「授权给他看」悄悄变成「授权给他改」。
  await carolPage.goto(`${daemon.baseUrl}/code/config/verification-profiles/${shared.id}`)
  await expect(carolPage.getByRole('heading', { name: sharedName })).toBeVisible()
  await expect(carolPage.getByTestId('config-edit-open')).toHaveCount(0)
  await expect(carolPage.getByTestId('config-publish')).toHaveCount(0)
  await expect(carolPage.getByTestId('config-acl-open')).toHaveCount(0)
  await expect(carolPage.getByTestId('config-archive-open')).toHaveCount(0)
  // 接口层同门：界面藏了按钮而后端放行，等于门控只是一层装饰。
  const readGrantWrite = await rawCall(
    daemon.baseUrl,
    carol.token,
    `/api/code/verification-profiles/${shared.id}`,
    { method: 'PUT', body: { draft: { schemaVersion: 1, steps: [], stopPolicy: 'collect-all' } } },
  )
  expect(readGrantWrite.status).toBe(403)

  // (3) 升到 write：内容可改、可发布，但**归档仍然不可以**——归档与删除同级、归治理档，
  //     编辑授权不覆盖它（developmentConfig.ts:293-303）。三档若坍缩成一档，一个被授权
  //     「改内容」的人就能把别人的配置整份移出所有选择器。
  await openAcl()
  await alicePage.getByTestId(`acl-level-write-${carol.userId}`).click()
  await alicePage.getByTestId('acl-save').click()
  await expect(alicePage.getByTestId('acl-panel')).toHaveCount(0)

  await carolPage.reload()
  await expect(carolPage.getByTestId('config-edit-open')).toBeVisible()
  await expect(carolPage.getByTestId('config-publish')).toBeVisible()
  await expect(carolPage.getByTestId('config-archive-open')).toHaveCount(0)

  const writeGrantWrite = await rawCall(
    daemon.baseUrl,
    carol.token,
    `/api/code/verification-profiles/${shared.id}`,
    { method: 'PUT', body: { draft: { schemaVersion: 1, steps: [], stopPolicy: 'collect-all' } } },
  )
  expect(writeGrantWrite.status).toBe(200)
  const writeGrantArchive = await rawCall(
    daemon.baseUrl,
    carol.token,
    `/api/code/verification-profiles/${shared.id}/archive`,
    { method: 'POST', body: {} },
  )
  expect(writeGrantArchive.status).toBe(403)
  const stillLive = await call<IdentityRow>(
    daemon.baseUrl,
    alice.token,
    `/api/code/verification-profiles/${shared.id}`,
  )
  expect(stillLive.archivedAt).toBeNull()

  await aliceCtx.close()
  await carolCtx.close()
})

// ------------------------------------------------------------------------ DE-36

test('RFC-319 DE-36: 从列表新建规则集后，规则构建器里的顺序改动经保存与刷新仍在，发布后列表与页头同时给出 rev 1 @nightly', async ({
  page,
}) => {
  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/code/policies`)
  // 既有的种子策略已经在表里：这条断言顺带证明列表读的是真后端而不是空壳。
  await expect(page.getByTestId('policy-list')).toContainText(policyName)

  const newPolicyName = `Reordered rule set ${RUN_TAG}`
  await page.getByTestId('policy-create-open').click()
  const createDialog = page.getByRole('dialog')
  await expect(createDialog.getByTestId('policy-create-submit')).toBeDisabled()
  await createDialog.getByTestId('policy-create-name').fill(newPolicyName)
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/code/automation-policies',
  )
  await createDialog.getByTestId('policy-create-submit').click()
  const createdResponse = await created
  expect(createdResponse.status()).toBe(201)
  const policyId = ((await createdResponse.json()) as { id: string }).id
  await page.waitForURL(`**/code/policies/${policyId}`)
  // 新建的规则集从未发布：页头必须如实说「missions 还 pin 不到它」。
  await expect(page.locator('.page__subtitle')).toContainText('Never published')

  // 平台默认模板带两条动作规则，顺序就是求值优先级（first match wins）。
  await expect(page.getByTestId('policy-action-rule-0-id')).toHaveValue('default-analyze')
  await expect(page.getByTestId('policy-action-rule-1-id')).toHaveValue('default-implement')
  // 第一条不能上移、最后一条不能下移——边界按钮若可点，用户会点下去然后什么都不发生。
  await expect(page.getByTestId('policy-action-rule-0-up')).toBeDisabled()
  await expect(page.getByTestId('policy-action-rule-1-down')).toBeDisabled()

  await page.getByTestId('policy-action-rule-0-down').click()
  await expect(page.getByTestId('policy-action-rule-0-id')).toHaveValue('default-implement')
  await expect(page.getByTestId('policy-action-rule-1-id')).toHaveValue('default-analyze')

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/code/automation-policies/${policyId}`,
  )
  await page.getByTestId('policy-save').click()
  const savedResponse = await saved
  expect(savedResponse.status()).toBe(200)
  // 序列化下去的必须是**新顺序**：只断言界面换了位置会漏掉「拖动只改了本地状态」这一类失败。
  const savedBody = savedResponse.request().postDataJSON() as {
    draft: { actionPriority: { rules: Array<{ ruleId: string }> } }
  }
  expect(savedBody.draft.actionPriority.rules.map((rule) => rule.ruleId)).toEqual([
    'default-implement',
    'default-analyze',
  ])

  await page.reload()
  // 刷新之后顺序还在，才说明服务端真的收下了。回弹意味着用户以为自己调整了优先级，
  // 而数字员工仍按旧顺序动作。
  await expect(page.getByTestId('policy-action-rule-0-id')).toHaveValue('default-implement')
  await expect(page.getByTestId('policy-save')).toBeDisabled()

  const publishedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/code/automation-policies/${policyId}/publish`,
  )
  await page.getByTestId('policy-publish').click()
  expect((await publishedResponse).status()).toBe(200)
  await expect(page.locator('.page__subtitle')).toContainText('Published revision 1')

  await page.goto(`${daemon.baseUrl}/code/policies`)
  const row = page.getByTestId('policy-list').locator('tr').filter({ hasText: newPolicyName })
  await expect(row).toHaveCount(1)
  // 列表上的 rev 徽标是「这条规则集可以被指派引用了」的唯一信号。
  await expect(row).toContainText('rev 1')
})

test('RFC-319 DE-36: 规则集发布被拦时三类违规逐条可读，而不是一句「校验失败」 @nightly', async ({
  page,
}) => {
  const brokenName = `Publish-blocked rule set ${RUN_TAG}`
  const broken = await seedPolicy(brokenName, false)

  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/code/policies/${broken.id}`)
  await expect(page.getByTestId('policy-fixed-guards')).toBeVisible()

  // ① 两条规则同名 ⇒ duplicate-rule-id。first-match 语义下重名规则是真事故：
  //    第二条永远不会被求值，而用户以为自己写了两条不同的分支。
  await page.getByTestId('policy-action-rule-1-id').fill('default-analyze')

  await page
    .getByRole('radiogroup', { name: 'Policy sections' })
    .getByRole('radio', {
      name: 'Settings',
    })
    .click()
  // ② 两个流水线关卡同 key ⇒ duplicate-gate-key。
  await page.getByTestId('policy-gate-add').click()
  await page.getByTestId('policy-gate-add').click()
  await page.getByTestId('policy-gate-1').getByRole('textbox', { name: 'Gate key' }).fill('gate-1')
  // ③ readiness 引用了一个不存在的关卡 ⇒ readiness-gate-unknown。这条最阴：任务会永远
  //    停在「等一个不存在的关卡通过」。
  await page.getByPlaceholder('gate-key').fill('never-declared-gate')
  await page.getByPlaceholder('gate-key').press('Enter')

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/code/automation-policies/${broken.id}`,
  )
  await page.getByTestId('policy-save').click()
  expect((await saved).status()).toBe(200)

  const blocked = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/code/automation-policies/${broken.id}/publish`,
  )
  await page.getByTestId('policy-publish').click()
  expect((await blocked).status()).toBe(422)

  const violations = page.getByTestId('policy-violations')
  await expect(violations).toBeVisible()
  const rows = violations.locator('li')
  await expect(rows).toHaveCount(3)
  for (const [code, where, detail] of [
    ['duplicate-rule-id', 'actionPriority', 'default-analyze'],
    ['duplicate-gate-key', 'pipeline.gates', 'gate-1'],
    ['readiness-gate-unknown', 'readiness.additionalRequiredGateKeys', 'never-declared-gate'],
  ] as const) {
    const row = rows.filter({ hasText: code })
    await expect(row, `violation ${code} must be listed on its own line`).toHaveCount(1)
    await expect(row).toContainText(where)
    await expect(row).toContainText(detail)
  }
  // 被拦下来的发布不得留下修订：产出了 rev 1 就意味着一份非法内容被冻成了不可变版本。
  const stored = await api<IdentityRow>(
    `/api/code/automation-policies/${encodeURIComponent(broken.id)}`,
  )
  expect(stored.publishedRevision).toBeNull()
})

// ------------------------------------------------------------------------ DE-37

test('RFC-319 DE-37: 同一份事实夹具下，模拟器的判决随编辑中的规则而变——命中、改成不命中、再换能力 @nightly', async ({
  page,
}) => {
  const simPolicy = await seedPolicy(`Simulated rule set ${RUN_TAG}`, false)

  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/code/policies/${simPolicy.id}`)
  await expect(page.getByTestId('policy-fixed-guards')).toBeVisible()

  // 把默认模板的两条规则清掉，换成一条完全确定的规则：
  // `rule-1` = boolean-is(requirement.bundleComplete, true) → change.implement
  // （`PolicyRuleBuilder.tsx:361-377` 的 add-rule 默认值）。
  await page.getByTestId('policy-action-rule-0-remove').click()
  await page.getByTestId('policy-action-rule-0-remove').click()
  await expect(page.getByTestId('policy-action-rule-0-id')).toHaveCount(0)
  await page.getByTestId('policy-action-add-rule').click()
  await expect(page.getByTestId('policy-action-rule-0-id')).toHaveValue('rule-1')

  const tabs = page.getByRole('radiogroup', { name: 'Policy sections' })
  /**
   * 回到「规则」页签并展开第一条规则的谓词面。
   *
   * `PolicyRuleBuilder` 的 `expanded` 是组件内部 state，而页签切走时整棵规则树被卸载
   * （`code.policies.$id.tsx:286-325` 是条件渲染），所以每次回来都要重新展开——
   * 少这一下，谓词行根本不在 DOM 里。
   */
  const reopenPredicates = async (): Promise<void> => {
    await tabs.getByRole('radio', { name: 'Rules' }).click()
    await expect(page.getByTestId('policy-action-rule-0-pred-0-value')).toHaveCount(0)
    await page.getByTestId('policy-action-rule-0-toggle').click()
    await expect(page.getByTestId('policy-action-rule-0-pred-0-value')).toBeVisible()
  }
  const runSimulation = async (): Promise<void> => {
    await tabs.getByRole('radio', { name: 'Simulate' }).click()
    await expect(page.getByTestId('policy-simulator')).toBeVisible()
    const previewed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/code/automation-policies/preview-decision',
    )
    await page.getByTestId('sim-run').click()
    expect((await previewed).status()).toBe(200)
    await expect(page.getByTestId('sim-trace')).toBeVisible()
  }

  // ---- ① 命中。事实夹具是模拟器自带的默认（requirement.bundleComplete = true）。 ----
  await runSimulation()
  // 守卫全过之后才轮到规则。守卫栏若出现 stop，下面的「无匹配」就分不清是规则没命中
  // 还是守卫拦停——这两件事在生产里的处置完全不同。
  await expect(page.getByTestId('sim-guard-trace').locator('li')).toHaveCount(10)
  await expect(page.getByTestId('sim-guard-trace')).not.toContainText('stop')
  await expect(page.getByTestId('sim-selected')).toContainText('run-agent-action (rule: rule-1)')
  await expect(page.getByTestId('sim-selected')).toContainText('"capabilityId": "change.implement"')
  await expect(page.getByTestId('sim-rule-trace')).toContainText('matched')

  // ---- ② 只改规则、不改事实：谓词取反后必须变成 no-match ----
  await reopenPredicates()
  await pickSelectOption(page, page.getByTestId('policy-action-rule-0-pred-0-value'), 'false')
  await runSimulation()
  // no-match 是一条明确诊断，不是空白：它就是生产里 mission 会 block('no-policy-match') 的形态。
  // 这一格若不随规则变化（例如读的是服务端已保存的那份规则），用户会拿着一份看起来正确的
  // 模拟结果发布一套完全不同的规则。
  await expect(page.getByTestId('sim-selected')).toContainText('no-match')
  await expect(page.getByTestId('sim-selected')).not.toContainText('run-agent-action')
  await expect(page.getByTestId('policy-simulator')).toContainText(
    'Guards all passed but no rule matched',
  )
  await expect(page.getByTestId('sim-rule-trace')).toContainText('miss')

  // ---- ③ 谓词改回命中、但把动作换成另一项能力：判决必须跟着换 ----
  await reopenPredicates()
  await pickSelectOption(page, page.getByTestId('policy-action-rule-0-pred-0-value'), 'true')
  await pickSelectOption(
    page,
    page.getByTestId('policy-action-rule-0-capability'),
    'problem.classify',
  )
  await runSimulation()
  await expect(page.getByTestId('sim-selected')).toContainText('run-agent-action (rule: rule-1)')
  await expect(page.getByTestId('sim-selected')).toContainText('"capabilityId": "problem.classify"')
  await expect(page.getByTestId('sim-selected')).not.toContainText('change.implement')

  // 全程一次都没保存过：模拟器读的必须是**编辑中的**规则。这条断言把「模拟器其实在读
  // 服务端草稿」这一类失败也挡住了——那种实现下三次模拟会给出同一个结果。
  const stored = await api<{ draft: { actionPriority: { rules: unknown[] } } }>(
    `/api/code/automation-policies/${encodeURIComponent(simPolicy.id)}`,
  )
  expect(stored.draft.actionPriority.rules).toHaveLength(2)
})

// ------------------------------------------------------------------------ DE-38

test('RFC-319 DE-38: 指派按 scope 分组呈现、编辑钉住已发布修订、删除只带走被点的那一条 @nightly', async ({
  page,
}) => {
  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/code/assignments`)
  await expect(page.getByTestId('code-assignments-page')).toBeVisible()
  await expect(page.getByTestId('empty-state')).toContainText('No assignments yet')

  const createAssignment = async (input: {
    scope: 'repository' | 'global-default'
    scopeLabel?: string
    employee?: string
    selectionPolicy?: string
  }): Promise<Record<string, unknown>> => {
    await page.getByTestId('assignment-create').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await pickSelectOption(
      page,
      dialog.getByTestId('assignment-scope-kind'),
      input.scope === 'repository' ? 'Repository' : 'Global default',
    )
    if (input.scope === 'repository') {
      await pickSelectOption(page, dialog.getByTestId('assignment-scope-ref'), input.scopeLabel!)
    } else {
      // 全局档没有 scopeRef 可选——多渲染一个下拉就是让用户以为全局指派还能再挑个仓库。
      await expect(dialog.getByTestId('assignment-scope-ref')).toHaveCount(0)
    }
    if (input.employee !== undefined) {
      await pickSelectOption(page, dialog.getByTestId('assignment-employee'), input.employee)
    }
    if (input.selectionPolicy !== undefined) {
      await pickSelectOption(
        page,
        dialog.getByTestId('assignment-selection-policy'),
        input.selectionPolicy,
      )
    }
    const upserted = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/code/repository-assignments',
    )
    await dialog.getByTestId('assignment-save').click()
    const response = await upserted
    expect(response.status()).toBe(200)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    return response.request().postDataJSON() as Record<string, unknown>
  }

  // 第一条：仓库 A。顺带核对下拉里**只有已发布**的资源——把一个只有草稿的员工指派上去，
  // 任务准入时会解析到一个跑不起来的修订，而页面上没有任何提示。
  await page.getByTestId('assignment-create').click()
  const probeDialog = page.getByRole('dialog')
  const employeeOptions = await readSelectOptions(
    page,
    probeDialog.getByTestId('assignment-employee'),
  )
  expect(employeeOptions).toContain(publishedEmployeeName)
  expect(employeeOptions).not.toContain(draftEmployeeName)
  const policyOptions = await readSelectOptions(
    page,
    probeDialog.getByTestId('assignment-selection-policy'),
  )
  expect(policyOptions).toContain(policyName)
  expect(policyOptions).not.toContain(draftPolicyName)
  await probeDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const firstBody = await createAssignment({
    scope: 'repository',
    scopeLabel: repoA.url,
    employee: publishedEmployeeName,
    selectionPolicy: policyName,
  })
  // 引用一律钉**已发布修订**：写成 revision 1 的兜底值时，一个已经发到 v3 的员工会被
  // 指派解析成它早已作废的第一版。
  expect(firstBody).toMatchObject({
    scopeKind: 'repository',
    scopeRef: repoA.id,
    employee: { id: publishedEmployeeId, revision: publishedEmployeeRevision },
    selectionPolicy: { id: policyRef.id, revision: policyRef.revision },
  })

  await createAssignment({
    scope: 'repository',
    scopeLabel: repoB.url,
    employee: publishedEmployeeName,
  })
  await createAssignment({ scope: 'global-default', employee: publishedEmployeeName })

  // 分组：三级解析的顺序（全局 < 仓库组 < 仓库）在页面上体现为分组的呈现顺序。
  // 分组若乱了或塌成一张表，用户读不出「哪一条会赢」。
  await expect(page.locator('.page__section h3')).toHaveText(['Global default', 'Repository'])
  const repoTable = page.getByTestId('assignments-repository')
  const globalTable = page.getByTestId('assignments-global-default')
  await expect(repoTable.locator('tbody tr')).toHaveCount(2)
  await expect(globalTable.locator('tbody tr')).toHaveCount(1)
  await expect(page.getByTestId('assignments-repository-group')).toHaveCount(0)
  // 范围列显示仓库地址而不是一串 ULID——数据本页已经取到了，显示 id 等于让用户自己去比对。
  await expect(repoTable).toContainText(repoA.url)
  await expect(repoTable).toContainText(repoB.url)

  // ---- 编辑：改默认需求源 key，落到同一条（每个 scope 至多一行） ----
  const rowA = repoTable.locator('tbody tr').filter({ hasText: repoA.url })
  await rowA.getByRole('button', { name: 'Edit', exact: true }).click()
  const editDialog = page.getByRole('dialog')
  await expect(editDialog).toBeVisible()
  await editDialog.getByTestId('assignment-source-key').fill('jira-main')
  const edited = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/code/repository-assignments',
  )
  await editDialog.getByTestId('assignment-save').click()
  expect((await edited).status()).toBe(200)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(rowA).toContainText('jira-main')
  // 编辑是 upsert 到同一 scope，不是新增一条：多出来的一行会让三级解析读到两条候选。
  await expect(repoTable.locator('tbody tr')).toHaveCount(2)

  // ---- 删除：URL 必须带上这一条的 scopeRef，且只有这一条消失 ----
  const deleted = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' &&
      new URL(request.url()).pathname.startsWith('/api/code/repository-assignments/'),
  )
  await rowA.getByRole('button', { name: 'Delete', exact: true }).click()
  const deleteUrl = new URL((await deleted).url())
  // scopeKind 在路径上、scopeRef 在查询串上（code.assignments.tsx:137-145）。scopeRef 丢了
  // 就变成「删这个 scope 里随便一条」——用户点的是仓库 A 那一行，走掉的可能是仓库 B。
  expect(deleteUrl.pathname).toBe('/api/code/repository-assignments/repository')
  expect(deleteUrl.searchParams.get('scopeRef')).toBe(repoA.id)

  await expect(repoTable.locator('tbody tr')).toHaveCount(1)
  await expect(repoTable).toContainText(repoB.url)
  await expect(repoTable).not.toContainText(repoA.url)
  // 其它 scope 一根汗毛都不能少：这正是审计点名的那条缺失预言。
  await expect(globalTable.locator('tbody tr')).toHaveCount(1)

  const remaining = await api<{
    items: Array<{ scopeKind: string; scopeRef: string | null }>
  }>('/api/code/repository-assignments')
  expect(
    remaining.items.map((item) => `${item.scopeKind}:${item.scopeRef ?? 'null'}`).sort(),
  ).toEqual([`global-default:null`, `repository:${repoB.id}`].sort())
})

// ------------------------------------------------------------------------ DE-45
//
// 这两条**不开浏览器**：能力模板在今天的产品里没有任何界面入口——`TemplateUpstreamPanel.tsx`
// 是全仓零调用方的组件，`/code/executors` 已在 RFC-323 里退成一条重定向。唯一的用户面是
// HTTP API（两条端点都是 `tokenAccess: 'allow'`，PAT 也打得到），所以断言落在编译后
// daemon 的接口面上。详见文件头「执行模型」与最终报告里的产品缺陷登记。

interface TemplateWire {
  id: string
  name: string
  description: string | null
  visibility: 'private' | 'public'
  ownerUserId: string | null
  builtin: boolean
  scripts?: Record<string, unknown>
  scriptsRedacted: boolean
  promptBySlot: Record<string, string>
  params: Record<string, unknown>
  updatedAt: number
  upstream: { upstreamId: string; upstreamVersion: number; baseDigest: string } | null
}

function templateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `RFC-319 upstream template ${RUN_TAG}`,
    description: 'the original',
    capability: 'mr-review',
    scripts: {
      collect: { language: 'bash', script: 'echo original-collect' },
    },
    hooks: [],
    paramSchema: [],
    paramDefaults: {},
    agentBySlot: {},
    promptBySlot: { review: 'original prompt' },
    params: { threshold: 1 },
    stageContractVer: 1,
    visibility: 'public',
    ...overrides,
  }
}

test('RFC-319 DE-45: 复制能力模板产出私有副本并记下上游链接，脚本随副本带走但对没有 scripts:author 的复制者仍然脱敏 @nightly', async () => {
  const bob = await createUserAndLogin(`bob-de45a-${RUN_TAG}`, 'user')
  const carol = await createUserAndLogin(`carol-de45a-${RUN_TAG}`, 'user')

  const source = await api<TemplateWire>('/api/capability-templates', {
    method: 'POST',
    body: templateBody({ name: `Source template A ${RUN_TAG}` }),
  })
  expect(source.scriptsRedacted).toBe(false)

  // bob 没有 `scripts:author`：他看得到模板、看不到脚本正文。缺席（undefined）而不是空对象
  // ——空对象是一句「这个模板没有脚本」的假话，会让人以为模板是坏的。
  const bobSeesSource = await call<TemplateWire>(
    daemon.baseUrl,
    bob.token,
    `/api/capability-templates/${source.id}`,
  )
  expect(bobSeesSource.scriptsRedacted).toBe(true)
  expect(bobSeesSource.scripts).toBeUndefined()

  const copyName = `Bob copy of A ${RUN_TAG}`
  const copy = await call<TemplateWire>(
    daemon.baseUrl,
    bob.token,
    `/api/capability-templates/${source.id}/copy`,
    { method: 'POST', body: { name: copyName } },
  )
  expect(copy.name).toBe(copyName)
  expect(copy.ownerUserId).toBe(bob.userId)
  // 副本**必须**私有，与源的可见性无关：继承 public 就等于把一份还没改完的模板当场发给全员。
  expect(copy.visibility).toBe('private')
  // 内置标记不得随复制带走，否则副本一出生就是只读的——而复制的全部意义就是拿去改。
  expect(copy.builtin).toBe(false)
  // 上游链接是「这两份出自同一处」的唯一记录；丢了它，一次上游修复就再也传不到副本。
  expect(copy.upstream?.upstreamId).toBe(source.id)
  expect(copy.upstream?.upstreamVersion).toBe(source.updatedAt)
  expect(copy.scriptsRedacted).toBe(true)
  expect(copy.scripts).toBeUndefined()

  // 脚本字节确实被带过来了（复制不要求 scripts:author，复制者也改不动它们）。
  // 只断言 bob 那份的话，「复制时把脚本悄悄丢了」与「复制时脱敏」长得一模一样。
  const adminSeesCopy = await api<TemplateWire>(`/api/capability-templates/${copy.id}`)
  expect(adminSeesCopy.scripts).toEqual(source.scripts)

  // 反向对照：第三个人对这份私有副本既列不到也读不到，且 404 与不存在同形。
  const carolList = await call<TemplateWire[]>(
    daemon.baseUrl,
    carol.token,
    '/api/capability-templates',
  )
  expect(carolList.map((row) => row.id)).not.toContain(copy.id)
  const carolHidden = await rawCall(
    daemon.baseUrl,
    carol.token,
    `/api/capability-templates/${copy.id}`,
  )
  const missingId = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
  const carolMissing = await rawCall(
    daemon.baseUrl,
    carol.token,
    `/api/capability-templates/${missingId}`,
  )
  expect(carolHidden.status).toBe(404)
  // 这条端点的 404 正文里回显**调用方自己给的 id**
  // （`capabilityTemplates.ts:64` 的 `template '${id}' not found`），所以两次回执不可能逐字
  // 相同——把各自的 id 归一掉之后必须相同。归一后仍然相同这件事挡住了真正的泄露形态：
  // 换成 403（403 本身就是「这个 id 存在」）、换一个 code、或者在消息里多说一句
  // 「你没有权限」/ 带出模板名字，任意一种都会让下面这句红。
  expect(carolHidden.text.replace(copy.id, '<id>')).toBe(
    carolMissing.text.replace(missingId, '<id>'),
  )
  expect(carolHidden.text).not.toContain(copyName)
})

test('RFC-319 DE-45: 上游更新只合并「本地没动过」的字段，冲突原样留给人，没有 scripts:author 的人一律拒绝合并 @nightly', async () => {
  const bob = await createUserAndLogin(`bob-de45b-${RUN_TAG}`, 'user')

  const source = await api<TemplateWire>('/api/capability-templates', {
    method: 'POST',
    body: templateBody({ name: `Source template B ${RUN_TAG}` }),
  })
  const copy = await call<TemplateWire>(
    daemon.baseUrl,
    bob.token,
    `/api/capability-templates/${source.id}/copy`,
    { method: 'POST', body: { name: `Bob copy of B ${RUN_TAG}` } },
  )

  // 原件前进：`upstreamVersion` 是 `updatedAt`，同一毫秒内的两次写会让「上游动过没有」判成
  // 没动。这里等它真的往前走一格，而不是靠运气——判据本身与被测行为无关。
  let updatedSource = source
  for (
    let attempt = 0;
    attempt < 10 && updatedSource.updatedAt <= copy.upstream!.upstreamVersion;
    attempt += 1
  ) {
    updatedSource = await api<TemplateWire>(`/api/capability-templates/${source.id}`, {
      method: 'PUT',
      body: templateBody({
        name: source.name,
        description: 'upstream moved',
        promptBySlot: { review: 'upstream prompt' },
      }),
    })
  }
  expect(updatedSource.updatedAt).toBeGreaterThan(copy.upstream!.upstreamVersion)

  // 副本这边：`params` 只有本地改过（上游没动）⇒ keep-local；`description` 两边都改过 ⇒ conflict。
  await api<TemplateWire>(`/api/capability-templates/${copy.id}`, {
    method: 'PUT',
    body: templateBody({
      name: copy.name,
      // 副本保持私有：这次写只为造出「本地改过」的现场，不该顺手改它的可见性。
      visibility: 'private',
      description: 'local rewrite',
      promptBySlot: { review: 'original prompt' },
      params: { threshold: 42 },
    }),
  })

  const conflictedReport = await call<{
    status: { state: string }
    baseRecorded: boolean
    fields: Array<{ field: string; action: string }>
  }>(daemon.baseUrl, bob.token, `/api/capability-templates/${copy.id}/upstream`)
  expect(conflictedReport.baseRecorded).toBe(true)
  expect(conflictedReport.status.state).toBe('conflicted')
  const actionOf = (field: string): string | undefined =>
    conflictedReport.fields.find((entry) => entry.field === field)?.action
  // 三种判定必须分得开。全判成 take-upstream 是危险方向：一次「更新」会把本地改动全抹掉；
  // 全判成 conflict 则是无用方向：什么都不敢合。
  expect(actionOf('promptBySlot')).toBe('take-upstream')
  expect(actionOf('params')).toBe('keep-local')
  expect(actionOf('description')).toBe('conflict')

  // 合并会把上游的 `scripts` 带过来，而脚本以 daemon 身份运行。没有 `scripts:author` 的人
  // 若能合并，「从上游更新」就成了一条绕过脚本授权的安装通道。
  const bobMerge = await rawCall(
    daemon.baseUrl,
    bob.token,
    `/api/capability-templates/${copy.id}/upstream/merge`,
    { method: 'POST', body: {} },
  )
  expect(bobMerge.status).toBe(403)
  expect((bobMerge.json as { code?: string }).code).toBe('capability-template-scripts-forbidden')

  const merged = await api<{
    applied: string[]
    keptLocal: string[]
    stillConflicted: string[]
  }>(`/api/capability-templates/${copy.id}/upstream/merge`, { method: 'POST', body: {} })
  expect(merged.applied).toEqual(['promptBySlot'])
  expect(merged.keptLocal).toEqual(['params'])
  expect(merged.stillConflicted).toEqual(['description'])

  const afterMerge = await api<TemplateWire>(`/api/capability-templates/${copy.id}`)
  // 只有「本地没动过」的那一格被换掉。回执说对了而落库没照做，是这类三方合并最常见的形态。
  expect(afterMerge.promptBySlot).toEqual({ review: 'upstream prompt' })
  expect(afterMerge.params).toEqual({ threshold: 42 })
  expect(afterMerge.description).toBe('local rewrite')

  // 还有一处冲突没人裁决，所以副本**不能**被判成「已是最新」——判成 current 会让那面徽标
  // 消失，而那正是用户下次会来处理这条分歧的唯一入口。
  const afterReport = await call<{ status: { state: string } }>(
    daemon.baseUrl,
    bob.token,
    `/api/capability-templates/${copy.id}/upstream`,
  )
  expect(afterReport.status.state).toBe('conflicted')
})

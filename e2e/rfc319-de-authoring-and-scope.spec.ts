// RFC-319 —— 数字员工域「编排/发布 + 作用域 + 兼容入口」8 条能力的用户面 e2e。
//
// 覆盖 `architecture/e2e-capability-ledger.json` 里这几行 `status: 'gap'`：
// DE-16b（P1 / tier=pr）、DE-31b（P1 / tier=pr）、DE-08、DE-14、DE-15、DE-X4、DE-X5、
// DE-40、DE-42（后七条 P2/P3 / tier=nightly）。
//
// P1 两条**不带** `@nightly`（进 PR 腿），其余每条标题末尾都带 ` @nightly`——PR 腿跑的是
// `--grep-invert '@nightly'`；账本守卫 `tierWiringMismatches` 会逐字核对这个 tag 与 `tier`。
//
// ## 每条锁的是「用户会遭遇什么」
//
//   * DE-16b —— 新建员工时**不碰**作用域下拉是最常见的一次点击路径。默认档若从「任务启动时
//     指定仓库」滑成列表里的第一个变体（`repository`），用户会造出一个绑死在某个仓库上的
//     员工却毫不知情：他以为「每次任务再选仓库」，实际所有任务都被钉在同一个仓库上，
//     而这件事要等到发起第二个任务、发现仓库选择器是灰的时候才暴露。判据只有一处
//     （`digital-employees.$typeRef.tsx:3864-3868` 的 `taskLaunchVariant ?? firstVariant`），
//     而整套 e2e 从来没有断言过 `POST /employees` 的 `workScope`。
//   * DE-31b —— 统一任务列表的类别过滤是「这一屏在说谁的事」的开关。既有用例
//     （`rfc319-task-list-and-filters.spec.ts` 的 TASK-X5）只有 Agent / 工作流 / 工作组三档，
//     且**那个 daemon 里一条数字员工案例都没有**：过滤器退化成「返回全量」时它照样全绿。
//     这条补的是排他性——选了「数字员工」就不能再看见 Agent 任务，反向亦然。
//   * DE-08 —— 非 Agent 执行体是两条完全不同的路。program 会以 daemon 身份跑脚本，
//     所以写它必须有 `scripts:author`；这道门若失守，任何普通用户都能通过「给员工加个工具」
//     在服务器上执行任意代码。workflow 不需要那道门，但要过合同闭包校验——闭包判据若松掉，
//     用户会把一个跑不起来的工作流绑进岗位模板，直到第一个任务炸在运行时才知道。
//   * DE-14 —— 岗位模板发布出去以后还要改（换工具、改配置）。发布新版本若不递增修订，
//     或者**在岗员工被这次编辑顺带改掉**，用户就失去了「先在新版本上验证、再把员工挪过去」
//     的唯一手段——一次编辑当场改变所有在岗员工的行为，且没有回退点。
//   * DE-15 —— 岗位名称/说明是员工创建对话框里唯一的识别依据。编辑态改不动它，
//     用户就只能靠「新建一个再删旧的」来改名，而删除会带走已发布修订。
//   * DE-X4 —— 上传文件有两种落点：随 MR 入库（进 Git 提交）和临时材料（只给执行体读）。
//     两个入库文件撞同一个路径时，后写的会覆盖前一个——用户看到的是「我传了两个文件，
//     MR 里只有一个」。所以撞路径必须在**发起之前**拦下，而不是发出去以后再解释。
//     体积上限则必须**前后端同一个数**：界面放行、服务端拒收 = 用户填完整张表单才被打回。
//   * DE-X5 —— 员工的负责范围决定发起任务时能选哪些仓库。仓库组范围若不收窄清单，
//     用户会把工作交给一个组外仓库，而这名员工的岗位配置（连接、策略）根本不适用于它；
//     任务范围若不给选择器，那名「每次再选仓库」的员工就发不出任何任务。
//   * DE-40 / DE-42 —— 单写切换之后老 URL 还散落在书签、文档和聊天记录里。它们要么把人
//     送到今天真正在用的那一屏，要么在提交处**说清楚去哪儿**。变成 404 或者静默失败，
//     用户只会得出「这个功能没了」的结论。
//
// ## 与既有 e2e 的分工（刻意不重叠）
//
//   * `e2e/rfc319-digital-employee-p1.spec.ts` DE-17 锁的是**主动选**仓库/仓库组两个变体
//     （点开下拉、选中、断言 workScope），DE-18 锁编辑回填。本文件 DE-16b 锁的是**不点**
//     那个下拉时的默认档，两者互补：DE-17 全绿而默认档滑走的情形今天没有任何用例会红。
//   * `e2e/rfc319-de-case-and-wizard.spec.ts` DE-25 锁的是上传的**补偿删除**（发起失败后把
//     staged 文件删干净）。本文件 DE-X4 一次都不制造失败，锁的是发起**之前**的三条校验：
//     落点切换、重复入库路径、体积上限前后端一致。
//   * 同文件 DE-20 已锁「仓库范围员工的选择器是冻结的」。本文件 DE-X5 只碰它没碰的另外两档：
//     仓库组范围（清单收窄到组内）与任务范围（清单是全量且必须真的选一个）。
//   * `e2e/rfc310-digital-employee-journey.spec.ts` 的
//     「RFC-323 DE-18/39: employee Adapter override and restore live in the lane while retired
//     URLs redirect」已经锁了 `/code/executors` 与两条 adapter 深链（即账本 DE-39）。
//     本文件 DE-42 只补它没碰的四条：`/code`、`/code/outcomes`、`/outcomes`、`/code/missions`。
//   * `e2e/rfc319-task-list-and-filters.spec.ts` TASK-X5 锁范围三档与类别的前三档。
//     本文件 DE-31b 只补第四档（数字员工）及其排他性，并且是**同一个 daemon 里同时存在
//     两类任务**——那是排他性唯一能被证伪的现场。
//
// ## 三条取舍，写在这里免得下一个人重新踩
//
//  1. **本文件不用 `test.describe.configure({ mode: 'serial' })`**。`playwright.config.ts` 的
//     `fullyParallel: false` 已经保证同文件内按声明顺序串行；不加 serial 是为了让一次批量
//     变异注入能同时看清「哪几条红」——serial 下第一条红之后其余全是 `did not run`，
//     归因不出来（`docs/dev-gotchas.md` 同名教训）。每条用例的前置都自带或来自 `beforeAll`。
//  2. **本文件不用 `page.route` 拦任何 API**（因此也不需要 `unrouteAll`）：全程真 daemon、
//     真 SQLite、真 HTTP。所有夹具走产品自己的写接口；唯一的直连落库是 DE-31b 的那条
//     Agent 任务——平台没有任何「凭空造一条已完成 Agent 任务」的用户面入口，而这条用例
//     要的只是「列表里存在一条非数字员工任务」这个现场（同
//     `rfc319-task-list-and-filters.spec.ts:307-358` 的做法）。
//  3. **DE-08 的两半分别落在 UI 与接口面**：program 的编辑器（语言、程序内容、契约夹具
//     实跑）只有浏览器能走完；而「没有 `scripts:author` 的人被挡住」需要第二个身份，
//     `actorForToolAuthoring`（`routes/digitalEmployees.ts:51-64`）是 transport 层的判据，
//     接口面就是它的完整用户面。

import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { developmentEmployeeTypePackage } from '../packages/backend/src/modules/development-automation/composition/employeeTypePackage'
import { initGitRepo, querySqlite, repoRemoteUrl, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

/**
 * 内置 development 类型包的**当前**引用，从生产 descriptor 派生。
 *
 * 手抄 `development@10` 会在内置包升版的那天把整份 spec 红在「找不到类型」上——
 * 与被测行为无关的失败。同 `e2e/rfc319-digital-employee-p1.spec.ts:30-44`。
 */
const DEVELOPMENT_TYPE_REF = (
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
    readonly typeRef: { readonly typeId: string; readonly revision: number }
  }
).typeRef
const TYPE_REF = `${DEVELOPMENT_TYPE_REF.typeId}@${DEVELOPMENT_TYPE_REF.revision}`
const TYPE_PATH = `${DEVELOPMENT_TYPE_REF.typeId}%40${DEVELOPMENT_TYPE_REF.revision}`

/** 同一次运行内的唯一后缀，避免并行 worker / 重跑之间撞名。 */
const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/**
 * 材料准备工具用的确定性脚本（node 运行时）。
 *
 * 输出形状必须逐字符合 `development.prepare-materials.result.v2`——发布前平台会**真的跑
 * 一遍**这个脚本并校验它的 stdout（`taskExecutionAdapter.ts:265-281` 的
 * `program-fixture-exact-output`）。同 `e2e/rfc319-de-case-and-wizard.spec.ts:66`。
 */
const PROGRAM_FIXTURE = `process.stdout.write(JSON.stringify({ outcome: 'completed' }))`

interface ExactRef {
  id: string
  revision: number
}

interface EmployeeRow {
  id: string
  name: string
  revision: number
  configuration: {
    displayName: string
    jobTemplateRef: ExactRef
    workScope: Record<string, unknown>
  }
  definition: {
    workScopeSummary: string
    exactToolBindings: Array<{
      workItemRef: string
      slotRef: string
      registrationRef: ExactRef
    }>
  }
}

interface ToolRow {
  id: string
  state: string
  publishedRevision: number | null
  content: { displayName: string; implementation: { kind: string } }
}

interface JobTemplateRow {
  id: string
  name: string
  publishedRevision: number | null
  draft: {
    description: string
    defaultToolBindings: Array<{
      workItemRef: string
      slotRef: string
      registrationRef: ExactRef
    }>
  }
}

interface ApiResponse {
  status: number
  text: string
  json: unknown
}

test.setTimeout(240_000)

let daemon: DaemonHandle
let adminUserId = ''
/** 两个仓库：alpha 进仓库组，beta 只有全量清单里才有。DE-X5 的排他性靠这一对。 */
let repoAlpha = { id: '', url: '' }
let repoBeta = { id: '', url: '' }
let groupAlphaOnly = { id: '', name: '' }
let implAgentRef: ExactRef = { id: '', revision: 0 }
/** 两个可选的实现工具：DE-14 把岗位模板从第一个换到第二个再发 v2。 */
let implToolRef: ExactRef = { id: '', revision: 0 }
let implToolName = ''
let altToolRef: ExactRef = { id: '', revision: 0 }
let altToolName = ''
let baseJobRef: ExactRef = { id: '', revision: 0 }
let employeeOnAlphaId = ''
let employeeOnAlphaName = ''
let employeeOnGroupId = ''
let employeeOnGroupName = ''
let employeeOnTaskId = ''
let employeeOnTaskName = ''

// --------------------------------------------------------------------- helpers

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

function bearer(token: string, hasBody: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  }
}

/** 成功路：非 2xx 直接抛，夹具失败要停在原因上而不是下游断言上。 */
async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: bearer(init.token ?? daemon.token, init.body !== undefined),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`)
  }
  return (text === '' ? undefined : JSON.parse(text)) as T
}

/** 原样回执（含状态码与正文），负向断言用——不得把 4xx 变成异常。 */
async function rawCall(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<ApiResponse> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: bearer(init.token ?? daemon.token, init.body !== undefined),
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

/** 原始字节上传（`POST /api/digital-employee-input-uploads` 收的是裸 body）。 */
async function uploadBytes(byteLength: number, name: string): Promise<ApiResponse> {
  const response = await fetch(`${daemon.baseUrl}/api/digital-employee-input-uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}`, 'x-upload-name': name },
    body: new Uint8Array(byteLength),
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
  const login = await api<{ sessionToken: string }>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  return { username, userId: created.id, token: login.sessionToken }
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

/**
 * 打开一个 `Select` 并选中给定选项。
 *
 * `Select` 在选项数 ≥ `SELECT_SEARCH_THRESHOLD`(8) 时自动变成 searchable，焦点落到搜索框上；
 * 此时直接点行会在 portaled listbox 还在滚动时命中过期坐标，所以走组件自己的键盘契约，
 * 并先确认高亮行就是要选的那一行（同 `e2e/rfc319-digital-employee-p1.spec.ts:123-150`）。
 */
async function pickSelectOption(
  page: Page,
  trigger: Locator,
  optionName: string | RegExp,
): Promise<void> {
  await trigger.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  const option = page.getByRole('option', { name: optionName })
  const search = listbox.getByRole('textbox').first()
  if ((await search.count()) === 0) {
    await expect(option).toBeVisible()
    await option.click()
    await expect(listbox).toHaveCount(0)
    return
  }
  await search.fill(typeof optionName === 'string' ? optionName : '')
  await expect(option).toBeVisible()
  const optionId = await option.getAttribute('id')
  expect(optionId).not.toBeNull()
  await expect(listbox).toHaveAttribute('aria-activedescendant', optionId!)
  await page.keyboard.press('Enter')
  await expect(listbox).toHaveCount(0)
}

/** 导入一个本机夹具仓库并返回它在平台里的 id + 脱敏 URL。 */
async function importRepository(label: string): Promise<{ id: string; url: string }> {
  const repoDir = mkdtempSync(join(tmpdir(), `aw-rfc319-de-${label}-`))
  writeFileSync(join(repoDir, 'README.md'), `# RFC-319 ${label} fixture\n`)
  initGitRepo(repoDir)
  const remote = repoRemoteUrl(repoDir)
  let batch = await api<{ batchId: string; state: string; rows: Array<{ status: string }> }>(
    '/api/cached-repos/batch-import',
    { method: 'POST', body: { urls: [remote] } },
  )
  const deadline = Date.now() + 60_000
  while (batch.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    batch = await api(`/api/cached-repos/imports/${batch.batchId}`)
  }
  if (batch.state !== 'completed' || batch.rows.some((row) => row.status !== 'done')) {
    throw new Error(`fixture repository import failed: ${JSON.stringify(batch.rows)}`)
  }
  const repositories = await api<{ items: Array<{ id: string; urlRedacted: string | null }> }>(
    '/api/cached-repos',
  )
  const repository = repositories.items.find((candidate) => candidate.urlRedacted === remote)
  if (repository === undefined) throw new Error(`fixture repository ${label} is missing`)
  return { id: repository.id, url: repository.urlRedacted ?? repository.id }
}

const toolsPath = (workItemRef: string): string =>
  `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(workItemRef)}/tools`

async function seedAgentTool(input: {
  workItemRef: string
  roleRef: string
  displayName: string
  agentRef: ExactRef
}): Promise<ExactRef> {
  const draft = await api<{ id: string }>(toolsPath(input.workItemRef), {
    method: 'POST',
    body: {
      displayName: input.displayName,
      description: 'RFC-319 DE authoring fixture',
      roleRef: input.roleRef,
      implementation: { kind: 'agent', agentRef: input.agentRef },
    },
  })
  const published = await api<{ ref: ExactRef }>(
    `${toolsPath(input.workItemRef)}/${encodeURIComponent(draft.id)}/publish`,
    { method: 'POST', body: {} },
  )
  return published.ref
}

async function listTools(workItemRef: string): Promise<ToolRow[]> {
  const listed = await api<{ items: ToolRow[] }>(toolsPath(workItemRef))
  return listed.items
}

async function seedPublishedJob(
  name: string,
  bindings: ReadonlyArray<{ workItemRef: string; slotRef: string; registrationRef: ExactRef }>,
): Promise<{ id: string; ref: ExactRef }> {
  const draft = await api<{ id: string }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
    {
      method: 'POST',
      body: {
        name,
        description: 'RFC-319 DE authoring fixture',
        defaultToolBindings: bindings,
        defaultAdapterBindings: [],
        defaultCollaborationBindings: [],
      },
    },
  )
  const published = await api<{ ref: ExactRef }>(
    `/api/digital-employee-job-templates/${encodeURIComponent(draft.id)}/publish`,
    { method: 'POST', body: {} },
  )
  return { id: draft.id, ref: published.ref }
}

async function seedEmployee(input: {
  name: string
  jobTemplateRef: ExactRef
  workScope: Record<string, unknown>
}): Promise<EmployeeRow> {
  return api<EmployeeRow>(`/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`, {
    method: 'POST',
    body: {
      name: input.name,
      jobTemplateRef: input.jobTemplateRef,
      workScope: input.workScope,
      toolOverrides: [],
      adapterOverrides: [],
      collaborationOverrides: [],
    },
  })
}

async function getEmployee(employeeId: string): Promise<EmployeeRow> {
  return api<EmployeeRow>(`/api/digital-employees/${encodeURIComponent(employeeId)}`)
}

/**
 * 把一个真实案例静置下来。
 *
 * OS worker 每秒一跳，案例在后台会继续推进；本文件的用例只关心「发起这一步」，
 * 让它继续跑只会给后续用例制造无关噪声。这里把 inbox / round / outbox 一起收干净、
 * 把续作指针清空，`planOneReaction` 因此不会再碰它。
 * 同 `e2e/rfc319-de-case-and-wizard.spec.ts:305-350`。
 */
async function forceQuietCase(caseId: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = Date.now()
    runSqlite(
      dbPath(),
      `UPDATE employee_os_outbox
          SET state = 'completed', claimed_by = NULL, claim_expires_at = NULL, updated_at = ${now}
        WHERE case_id = '${caseId}' AND state IN ('pending', 'claimed');
       UPDATE employee_reaction_rounds
          SET state = 'obsolete', settled_at = ${now}, updated_at = ${now}
        WHERE case_id = '${caseId}' AND state IN ('planned', 'running', 'settling');
       UPDATE employee_case_inbox
          SET state = 'obsolete', settled_at = ${now}
        WHERE case_id = '${caseId}' AND state IN ('pending', 'claimed');
       UPDATE employee_cases
          SET state = 'blocked',
              block_reason = 'rfc319-de-fixture: quiesced for a stable browser assertion',
              active_round_id = NULL,
              current_work_item_ref = NULL,
              revision = revision + 1,
              updated_at = ${now}
        WHERE id = '${caseId}';`,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const [row] = querySqlite<{ state: string; active_round_id: string | null; pending: number }>(
      dbPath(),
      `SELECT c.state AS state,
              c.active_round_id AS active_round_id,
              (SELECT count(*) FROM employee_os_outbox o
                WHERE o.case_id = c.id AND o.state IN ('pending', 'claimed'))
              + (SELECT count(*) FROM employee_case_inbox i
                  WHERE i.case_id = c.id AND i.state IN ('pending', 'claimed'))
              + (SELECT count(*) FROM employee_reaction_rounds r
                  WHERE r.case_id = c.id AND r.state IN ('planned', 'running', 'settling'))
              AS pending
         FROM employee_cases c WHERE c.id = ?`,
      [caseId],
    )
    if (row?.state === 'blocked' && row.active_round_id === null && row.pending === 0) return
  }
  throw new Error(`case ${caseId} never settled into a stable quiet fixture`)
}

// ------------------------------------------------------------------- fixtures

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'development' })

  adminUserId = (await api<{ user: { id: string } }>('/api/auth/me')).user.id

  repoAlpha = await importRepository('alpha')
  repoBeta = await importRepository('beta')

  groupAlphaOnly = {
    id: '',
    name: `RFC-319 DE scope group ${RUN_TAG}`,
  }
  const group = await api<{ id: string }>('/api/repo-groups', {
    method: 'POST',
    body: {
      name: groupAlphaOnly.name,
      description: '',
      nodes: [{ path: '', attachment: { kind: 'repo', cachedRepoId: repoAlpha.id } }],
    },
  })
  groupAlphaOnly.id = group.id

  const agents = await api<
    Array<{
      id: string
      updatedAt: number
      frontmatterExtra: { executionContracts?: Array<{ contractId: string; version: number }> }
    }>
  >('/api/agents/builtins/digital-employee-templates')
  const findAgent = (contractId: string): ExactRef => {
    const found = agents.find((candidate) =>
      candidate.frontmatterExtra.executionContracts?.some(
        (declared) => declared.contractId === contractId,
      ),
    )
    if (found === undefined) throw new Error(`no built-in Agent declares ${contractId}`)
    return { id: found.id, revision: found.updatedAt }
  }

  implAgentRef = findAgent('development.implement-change')
  implToolName = `Implementation executor ${RUN_TAG}`
  implToolRef = await seedAgentTool({
    workItemRef: 'analyze-implement',
    roleRef: 'primary',
    displayName: implToolName,
    agentRef: implAgentRef,
  })
  altToolName = `Alternate implementation executor ${RUN_TAG}`
  altToolRef = await seedAgentTool({
    workItemRef: 'analyze-implement',
    roleRef: 'primary',
    displayName: altToolName,
    agentRef: implAgentRef,
  })

  const baseJob = await seedPublishedJob(`Delivery baseline ${RUN_TAG}`, [
    { workItemRef: 'analyze-implement', slotRef: 'default', registrationRef: implToolRef },
  ])
  baseJobRef = baseJob.ref

  employeeOnAlphaName = `Alpha repository employee ${RUN_TAG}`
  const onAlpha = await seedEmployee({
    name: employeeOnAlphaName,
    jobTemplateRef: baseJobRef,
    workScope: { kind: 'repository', repositoryId: repoAlpha.id },
  })
  employeeOnAlphaId = onAlpha.id

  employeeOnGroupName = `Group scoped employee ${RUN_TAG}`
  const onGroup = await seedEmployee({
    name: employeeOnGroupName,
    jobTemplateRef: baseJobRef,
    workScope: { kind: 'repository-group', repositoryGroupId: groupAlphaOnly.id },
  })
  employeeOnGroupId = onGroup.id

  employeeOnTaskName = `Task scoped employee ${RUN_TAG}`
  const onTask = await seedEmployee({
    name: employeeOnTaskName,
    jobTemplateRef: baseJobRef,
    workScope: { kind: 'task' },
  })
  employeeOnTaskId = onTask.id
})

test.afterAll(async () => {
  await daemon?.stop()
})

// ------------------------------------------------------------------- DE-16b

test('RFC-319 DE-16b: 新建数字员工时不碰作用域下拉，落库的就是「任务启动时指定仓库」而不是列表里的头一个仓库', async ({
  page,
}) => {
  const employeeName = `Default scope employee ${RUN_TAG}`
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=employees`)

  await page.getByRole('button', { name: 'Create employee', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Create digital employee' })).toBeVisible()

  // ① 对话框一打开，作用域下拉的**当前值**就必须是任务档。这里读的是控件自己念出来的
  //    那句话——它若显示的是某个仓库 URL，用户不点开就不会发现自己正在把员工绑死。
  const scopePicker = dialog.getByTestId('employee-scope-picker')
  await expect(
    scopePicker,
    '新建对话框的负责范围默认不是「任务启动时指定仓库」⇒ 用户按默认一路点下去会造出一个' +
      '绑死在某个仓库上的员工，而界面从头到尾没提示过这件事',
  ).toContainText('Choose repository when starting a task')
  await expect(
    scopePicker,
    '默认档滑到了仓库变体（workScopeAuthoring.variants[0] 就是 repository）⇒ ' +
      '默认值退化成「列表里的头一个」，与产品意图相反',
  ).not.toContainText(repoAlpha.url)

  await dialog.getByRole('textbox', { name: 'Employee name' }).fill(employeeName)
  await pickSelectOption(
    page,
    dialog.locator('label.form-field').filter({ hasText: 'Job template' }).getByRole('combobox'),
    `Delivery baseline ${RUN_TAG}`,
  )

  const createRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname ===
        `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`,
  )
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  const created = await createRequest

  // ② 请求体逐字段比对。`toMatchObject` 在这里不够：多带一个 `repositoryId: ''` 同样是错的
  //    （服务端会把空串当成一个仓库 id 存下来），所以用 toEqual 钉死整个对象。
  expect(
    (created.postDataJSON() as { workScope: unknown }).workScope,
    'POST /employees 的 workScope 不是 {kind:"task"} ⇒ 界面显示的默认档和真正发出去的' +
      '不是同一件事，用户以为自己建的是「每次再选仓库」的员工',
  ).toEqual({ kind: 'task' })

  // ③ 服务端也要真的按任务档存下来。只断言请求体的话，「服务端收下了却按仓库档解释」
  //    这类失败照样绿。
  const employees = await api<{ items: EmployeeRow[] }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`,
  )
  const persisted = employees.items.find((row) => row.name === employeeName)
  expect(persisted, '新建的员工没有落库 ⇒ 创建对话框的成功状态是假的').toBeDefined()
  expect(
    persisted!.configuration.workScope,
    '落库的 workScope 不是纯任务档 ⇒ 这名员工发起任务时会被钉在某个仓库上',
  ).toEqual({ kind: 'task' })

  // ④ 卡片上不能出现任何仓库 URL：任务档员工的摘要若念出一个具体仓库，用户会据此
  //    以为它已经绑定好了。
  const card = page.locator('.employee-summary-card--employee').filter({ hasText: employeeName })
  await expect(card).toHaveCount(1)
  await expect(
    card,
    '任务档员工的卡片摘要里出现了具体仓库 ⇒ 摘要在说一件与作用域相反的事',
  ).not.toContainText(repoAlpha.url)
})

// ------------------------------------------------------------------- DE-31b

test('RFC-319 DE-31b: 统一任务列表选「数字员工」类别后只剩员工案例，Agent 任务必须消失，反向亦然', async ({
  page,
}) => {
  // 现场：一条真实的员工案例 + 一条 Agent 任务。两类同时在库里，排他性才可能被证伪。
  const launched = await api<{ case: { id: string } }>(
    `/api/digital-employees/${encodeURIComponent(employeeOnAlphaId)}/cases`,
    {
      method: 'POST',
      body: {
        name: `Employee case for the unified list ${RUN_TAG}`,
        kind: 'body',
        target: { repositoryId: repoAlpha.id },
        body: 'RFC-319 DE-31b: this case must be the only row under the digital-employee filter.',
        externalId: null,
        uploads: [],
        executionOptions: {},
        idempotencyKey: `rfc319-de31b-${RUN_TAG}`,
      },
    },
  )
  const caseId = launched.case.id
  await forceQuietCase(caseId)

  const agentTaskId = `rfc319de31b${RUN_TAG}`.slice(0, 26)
  const startedAt = Date.now() - 60_000
  runSqlite(
    dbPath(),
    'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,' +
      ' base_branch, branch, status, inputs, started_at, finished_at, owner_user_id,' +
      ' branch_started_at, root_task_id, parent_task_id, invocation_depth, source_agent_name,' +
      ` source_agent_id) VALUES ('${agentTaskId}', 'RFC-319 DE-31b agent task', ` +
      `'rfc319-de31b-workflow', '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',` +
      ` '/tmp/rfc319-de31b/repo', '/tmp/rfc319-de31b/worktree', 'main', 'agent-workflow/de31b',` +
      ` 'done', '{}', ${startedAt}, ${startedAt + 30_000}, '${adminUserId}', ${startedAt},` +
      ` '${agentTaskId}', NULL, 0, 'rfc319-de31b-agent', 'rfc319-de31b-agent-id');`,
  )
  // `runSqlite` 走 `db.exec()`，多语句脚本里的约束错误**不会抛**（事务回滚、零行落库、
  // 调用方看到成功）。种完必须回读自证，否则下面的断言在一个空现场上照样能绿。
  const seeded = querySqlite<{ n: number }>(
    dbPath(),
    `SELECT count(*) AS n FROM tasks WHERE id = '${agentTaskId}'`,
  )
  expect(seeded[0]?.n, 'Agent 任务没有真的落库 ⇒ 下面的排他性断言零预言力').toBe(1)

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks`)

  // 前置复核：不过滤时两类任务都在。这一步不成立的话，后面的「消失了」什么也证明不了。
  await expect(
    page.getByTestId(`task-row-${caseId}`),
    '不过滤时员工案例不在统一列表里 ⇒ 数字员工的运行根本没有进入这一屏',
  ).toBeVisible()
  await expect(
    page.getByTestId(`task-row-${agentTaskId}`),
    '不过滤时 Agent 任务不在列表里 ⇒ 前置现场不成立',
  ).toBeVisible()

  const openFilters = async () => {
    await page.getByTestId('tasks-filter-button').click()
    const dialog = page.getByTestId('tasks-filter-dialog').getByRole('dialog')
    await expect(dialog, '筛选弹窗打不开 ⇒ 类别过滤对用户完全不可达').toBeVisible()
    return dialog
  }

  // --- 类别：数字员工 -----------------------------------------------------------
  let dialog = await openFilters()
  await dialog
    .getByRole('radiogroup', { name: 'Task type' })
    .getByRole('radio', { name: 'Digital employee', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Apply filters' }).click()

  await expect(page, '类别没有写进 URL ⇒ 这一屏发不出去也刷不回来').toHaveURL(
    /[?&]type=digital-employee(?:&|$)/,
  )
  await expect(
    page.getByTestId(`task-row-${caseId}`),
    '选了「数字员工」却看不到员工案例 ⇒ 这条任务对按类别找它的用户彻底消失了',
  ).toBeVisible()
  await expect(
    page.getByTestId(`task-row-${agentTaskId}`),
    'Agent 任务出现在「数字员工」类别下 ⇒ 类别过滤退化成了「返回全量」，' +
      '而这正是只做正向存在断言时永远发现不了的那一格',
  ).toHaveCount(0)
  await expect(
    page.locator('.task-operations__item[data-depth="0"]'),
    '「数字员工」类别下的行数不是 1 ⇒ 过滤没有把这一屏收敛到单一执行源',
  ).toHaveCount(1)

  // --- 反向：Agent ---------------------------------------------------------------
  dialog = await openFilters()
  await dialog
    .getByRole('radiogroup', { name: 'Task type' })
    .getByRole('radio', { name: 'Agent', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Apply filters' }).click()

  await expect(page, '切到 Agent 类别没有写进 URL').toHaveURL(/[?&]type=agent(?:&|$)/)
  await expect(
    page.getByTestId(`task-row-${agentTaskId}`),
    '选了 Agent 却看不到 Agent 任务 ⇒ 反向过滤同样失效',
  ).toBeVisible()
  await expect(
    page.getByTestId(`task-row-${caseId}`),
    '员工案例出现在 Agent 类别下 ⇒ 两个执行源的行被混在一起，用户没法按类处置',
  ).toHaveCount(0)
})

// ------------------------------------------------------------------- DE-08

test('RFC-319 DE-08: program 工具要 scripts:author 才能写，workflow 工具不要——两条非 Agent 路各自能发布 @nightly', async () => {
  // 一个普通账号：有 digital-employees:update（USER_BASELINE），没有 scripts:author
  // （那是 MANAGER_EXTRA，permission.ts:1065-1075）。
  const author = await createUserAndLogin(`de08-author-${RUN_TAG}`, 'user')

  const programBody = {
    displayName: `Materials program ${RUN_TAG}`,
    description: 'RFC-319 DE-08 program executor',
    roleRef: 'primary',
    implementation: {
      kind: 'program',
      runtimeKind: 'node',
      source: PROGRAM_FIXTURE,
      runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
    },
  }

  // ① 没有 scripts:author 的人写 program ⇒ 403，且机器码逐字可读。
  //    这道门失守 = 任何普通用户都能通过「给员工加个工具」在 daemon 上执行任意代码。
  const refused = await rawCall(toolsPath('prepare-materials'), {
    method: 'POST',
    body: programBody,
    token: author.token,
  })
  expect(
    { status: refused.status, code: (refused.json as { code?: string } | undefined)?.code },
    '没有 scripts:author 的账号写 ProgramTool 没有被 403 挡住 ⇒ 脚本授权门形同虚设',
  ).toEqual({ status: 403, code: 'scripts-author-required' })
  expect(
    (await listTools('prepare-materials')).some(
      (tool) => tool.content.displayName === programBody.displayName,
    ),
    '被拒的 program 草稿还是落库了 ⇒ 拒绝只发生在回执上，数据已经写进去了',
  ).toBe(false)

  // ② 同一个人写 workflow 工具**不该**被那道门挡住——工具本身不携带脚本正文，判据是合同闭包。
  //    合同工作流本体由 admin 建并公开：工作流里的 script 节点是**另一道**
  //    `scripts:author` 字段门（`services/scriptAuthorGate.ts:46`），与本条要证的
  //    「工具类型门」无关；混在一起会让下面那句「不需要 scripts:author」失去指向。
  //    闭合判据是 text 输入 `prompt` + 输出端口 `agent-result`
  //    （`taskExecutionAdapter.ts:39-86` 的三条）。
  const workflow = await api<{ id: string; version: number }>('/api/workflows', {
    method: 'POST',
    body: {
      name: `RFC-319 DE-08 contract workflow ${RUN_TAG}`,
      description: 'Closed execution-contract workflow',
      definition: {
        $schema_version: 3,
        inputs: [{ key: 'prompt', kind: 'text', label: 'prompt' }],
        nodes: [
          {
            id: 'contract_script',
            kind: 'script',
            language: 'bash',
            script: 'printf "%s" "{{prompt}}"',
            outputs: [{ name: 'agent-result' }],
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        outputs: [
          { name: 'agent-result', bind: { nodeId: 'contract_script', portName: 'agent-result' } },
        ],
      },
    },
  })
  await api(`/api/workflows/${encodeURIComponent(workflow.id)}/acl`, {
    method: 'PUT',
    body: { visibility: 'public', expectedResourceId: workflow.id, expectedAclRevision: 0 },
  })
  expect(
    (await api<Array<{ id: string }>>('/api/workflows', { token: author.token })).some(
      (candidate) => candidate.id === workflow.id,
    ),
    '普通账号在工作流库里看不到这条合同工作流 ⇒ 下面这步在界面上根本走不到',
  ).toBe(true)
  const workflowToolName = `Materials workflow ${RUN_TAG}`
  const workflowDraft = await api<{
    id: string
    validationReceipt: { status: string; checks: Array<{ code: string; ok: boolean }> }
  }>(toolsPath('prepare-materials'), {
    method: 'POST',
    body: {
      displayName: workflowToolName,
      description: 'RFC-319 DE-08 workflow executor',
      roleRef: 'primary',
      implementation: {
        kind: 'workflow',
        workflowRef: { id: workflow.id, revision: workflow.version },
      },
    },
    token: author.token,
  })
  expect(
    workflowDraft.validationReceipt.checks.filter((check) => !check.ok),
    '闭合的合同工作流没有通过校验 ⇒ 非 Agent 的另一条路对普通用户是死的',
  ).toEqual([])
  const workflowPublished = await api<{ ref: ExactRef }>(
    `${toolsPath('prepare-materials')}/${encodeURIComponent(workflowDraft.id)}/publish`,
    { method: 'POST', body: {}, token: author.token },
  )
  expect(workflowPublished.ref.revision, 'workflow 工具首发不是 v1').toBe(1)

  // ③ 有 scripts:author 的人（admin）写同一份 program ⇒ 发布前平台真的跑一遍夹具脚本。
  const programDraft = await api<{
    id: string
    validationReceipt: {
      status: string
      checks: Array<{ code: string; ok: boolean; detail: string }>
    }
  }>(toolsPath('prepare-materials'), { method: 'POST', body: programBody })
  expect(
    programDraft.validationReceipt.checks.find(
      (check) => check.code === 'program-fixture-exact-output',
    )?.ok,
    '发布前没有实跑契约夹具（program-fixture-exact-output 不为真）⇒ ' +
      '一个输出形状不对的脚本会被放进工具箱，直到第一个任务炸掉才知道',
  ).toBe(true)
  const programPublished = await api<{ ref: ExactRef }>(
    `${toolsPath('prepare-materials')}/${encodeURIComponent(programDraft.id)}/publish`,
    { method: 'POST', body: {} },
  )
  expect(programPublished.ref.revision).toBe(1)

  // ④ 两个工具都以「已发布 + 各自的执行方式」出现在同一个职责的工具列表里。
  const tools = await listTools('prepare-materials')
  const summary = tools
    .filter((tool) =>
      [workflowToolName, programBody.displayName].includes(tool.content.displayName),
    )
    .map((tool) => ({
      name: tool.content.displayName,
      kind: tool.content.implementation.kind,
      state: tool.state,
      published: tool.publishedRevision,
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind))
  expect(
    summary,
    '两条非 Agent 路发布后没有各自以正确的执行方式出现在工具箱里 ⇒ ' +
      '岗位模板挑不到它们，前面的发布等于白做',
  ).toEqual([
    { name: programBody.displayName, kind: 'program', state: 'published', published: 1 },
    { name: workflowToolName, kind: 'workflow', state: 'published', published: 1 },
  ])

  // ⑤ 没有 scripts:author 的人**改**一个已存在的 program 工具同样要被挡住——
  //    只守 POST 而不守 PUT，等于留了一条改写脚本正文的旁路。
  const updateRefused = await rawCall(
    `${toolsPath('prepare-materials')}/${encodeURIComponent(programDraft.id)}`,
    {
      method: 'PUT',
      body: { ...programBody, description: 'rewritten by an account without scripts:author' },
      token: author.token,
    },
  )
  expect(
    {
      status: updateRefused.status,
      code: (updateRefused.json as { code?: string } | undefined)?.code,
    },
    '没有 scripts:author 的账号能改写已发布 program 工具 ⇒ 脚本正文有一条绕过授权的写入路径',
  ).toEqual({ status: 403, code: 'scripts-author-required' })
})

// ------------------------------------------------------------------- DE-14

test('RFC-319 DE-14: 改一个已发布岗位模板并发布 v2，已在岗的员工仍钉在 v1 的工具上 @nightly', async ({
  page,
}) => {
  const jobName = `Revisable job ${RUN_TAG}`
  const job = await seedPublishedJob(jobName, [
    { workItemRef: 'analyze-implement', slotRef: 'default', registrationRef: implToolRef },
  ])
  const pinnedEmployee = await seedEmployee({
    name: `Pinned to v1 ${RUN_TAG}`,
    jobTemplateRef: job.ref,
    workScope: { kind: 'task' },
  })
  expect(job.ref.revision, '夹具岗位模板的首发不是 v1').toBe(1)

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=jobs`)

  const card = page.locator('.employee-summary-card').filter({ hasText: jobName })
  await expect(card).toHaveCount(1)
  await expect(
    card.getByText('Published · v1', { exact: true }),
    '已发布岗位模板的卡片没有念出它的可用修订 ⇒ 用户看不出线上跑的是哪一版',
  ).toBeVisible()
  await card.getByRole('button', { name: 'Edit', exact: true }).click()

  const editor = page.getByTestId('employee-job-template-editor')
  await expect(editor).toBeVisible()
  // 已发布模板的提交按钮必须换成「发新版本」的措辞——它和草稿的「保存并发布」是两件事：
  // 前者会产生一个新的不可变修订，后者是首发。
  const publishButton = page.getByRole('button', { name: 'Save and publish new revision' })
  await expect(
    publishButton,
    '编辑一个已发布模板时按钮仍写着首发文案 ⇒ 用户不知道自己这一下会造出新版本',
  ).toBeVisible()

  // 换掉「实现变更」职责的默认工具。
  await page.locator('#job-duty-analyze-implement').click()
  const dutyDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(dutyDialog).toBeVisible()
  const slot = dutyDialog.locator('label.form-field').filter({ hasText: 'Default tool' })
  const slotSelect = slot.getByRole('combobox')
  await expect(
    slotSelect,
    '编辑器没有回填 v1 已绑定的工具 ⇒ 用户每次改模板都要把所有槽位重选一遍',
  ).toContainText(implToolName)
  await pickSelectOption(page, slotSelect, altToolName)
  await expect(slotSelect).toContainText(altToolName)
  await dutyDialog.getByRole('button', { name: 'Done', exact: true }).click()

  await publishButton.click()
  await expect(editor).toHaveCount(0)
  await expect(
    card.getByText('Published · v2', { exact: true }),
    '发布新版本后卡片仍显示 v1 ⇒ 要么修订没有递增，要么列表没刷新，' +
      '用户会以为自己的修改没保存而重复发布',
  ).toBeVisible()

  // 服务端逐字段对账：v2 的绑定换成了新工具。
  const jobs = await api<{ items: JobTemplateRow[] }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
  )
  const updated = jobs.items.find((row) => row.id === job.id)
  expect(updated?.publishedRevision, '岗位模板的已发布修订没有变成 2').toBe(2)
  expect(
    updated?.draft.defaultToolBindings.find(
      (binding) => binding.workItemRef === 'analyze-implement' && binding.slotRef === 'default',
    )?.registrationRef,
    'v2 的默认工具绑定没有换成新工具 ⇒ 这次编辑发布了一个和 v1 一模一样的版本',
  ).toEqual(altToolRef)

  // 最要紧的一格：已在岗的员工仍然钉在 v1 上。
  const pinned = await getEmployee(pinnedEmployee.id)
  expect(
    pinned.configuration.jobTemplateRef,
    '已在岗员工的岗位引用被这次发布顺带改成了 v2 ⇒ 一次编辑当场改变所有在岗员工的行为，' +
      '用户失去了「先验证新版本再挪员工」的唯一手段',
  ).toEqual({ id: job.id, revision: 1 })
  expect(
    pinned.definition.exactToolBindings.find(
      (binding) => binding.workItemRef === 'analyze-implement' && binding.slotRef === 'default',
    )?.registrationRef,
    '已在岗员工冻结的工具跟着模板改了 ⇒ 「不可变修订」这个承诺不成立',
  ).toEqual(implToolRef)
})

// ------------------------------------------------------------------- DE-15

test('RFC-319 DE-15: 编辑态改岗位模板的名称与说明，保存后列表与员工创建下拉里都是新名字 @nightly', async ({
  page,
}) => {
  const originalName = `Renamable job ${RUN_TAG}`
  const renamed = `Renamed job ${RUN_TAG}`
  const newDescription = `Rewritten description ${RUN_TAG}`
  const job = await seedPublishedJob(originalName, [
    { workItemRef: 'analyze-implement', slotRef: 'default', registrationRef: implToolRef },
  ])

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=jobs`)
  const card = page.locator('.employee-summary-card').filter({ hasText: originalName })
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByTestId('employee-job-template-editor')).toBeVisible()

  await page.getByRole('button', { name: 'Basic information', exact: true }).click()
  const identity = page.getByTestId('employee-job-identity-dialog')
  await expect(identity).toBeVisible()
  const nameInput = identity.getByRole('textbox', { name: 'Template name' })
  await expect(
    nameInput,
    '基本信息对话框没有回填当前名称 ⇒ 用户改一个字要把整串重打一遍，且很容易改错对象',
  ).toHaveValue(originalName)
  await nameInput.fill(renamed)
  await identity.getByRole('textbox', { name: 'Description' }).fill(newDescription)
  await identity.getByRole('button', { name: 'Save information', exact: true }).click()
  await expect(identity).toBeHidden()

  // 基本信息对话框只改编辑态；真正落库要靠编辑器的提交按钮。这一步不做的话，
  // 用户会以为「保存基本信息」就已经存下了。
  await expect(
    page.getByRole('heading', { name: `Configure job template: ${renamed}` }),
    '改完基本信息后编辑器页头没有跟着变 ⇒ 用户无法确认自己改的是哪一个模板',
  ).toBeVisible()
  await page.getByRole('button', { name: 'Save and publish new revision' }).click()
  await expect(page.getByTestId('employee-job-template-editor')).toHaveCount(0)

  const renamedCard = page.locator('.employee-summary-card').filter({ hasText: renamed })
  await expect(renamedCard, '列表里没有出现新名字 ⇒ 改名没落库，或者列表没刷新').toHaveCount(1)
  await expect(renamedCard, '说明没有跟着改 ⇒ 基本信息对话框只保存了一半字段').toContainText(
    newDescription,
  )
  await expect(
    page.locator('.employee-summary-card').filter({ hasText: originalName }),
    '旧名字还在列表里 ⇒ 改名变成了「再建一个」，用户会看到两份同样的岗位',
  ).toHaveCount(0)

  const jobs = await api<{ items: JobTemplateRow[] }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
  )
  const persisted = jobs.items.find((row) => row.id === job.id)
  expect(
    { name: persisted?.name, description: persisted?.draft.description },
    '服务端存的仍是旧的名称/说明 ⇒ 界面显示的是本地状态，刷新后就回退了',
  ).toEqual({ name: renamed, description: newDescription })

  // 岗位名称是员工创建对话框里唯一的识别依据：改完名字，那份下拉必须跟着改。
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=employees`)
  await page.getByRole('button', { name: 'Create employee', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await pickSelectOption(
    page,
    dialog.locator('label.form-field').filter({ hasText: 'Job template' }).getByRole('combobox'),
    renamed,
  )
  await expect(
    dialog.locator('label.form-field').filter({ hasText: 'Job template' }).getByRole('combobox'),
    '员工创建下拉里选不到改名后的岗位 ⇒ 改名把这个岗位从建人流程里弄丢了',
  ).toContainText(renamed)
})

// ------------------------------------------------------------------- DE-X4

test('RFC-319 DE-X4: 上传文件的落点二选一、两个入库文件撞路径必须当场拦下，体积上限前后端是同一个数 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=digital-employee&employeeId=${employeeOnAlphaId}`,
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-task-name').fill(`Upload placement task ${RUN_TAG}`)
  await page.getByRole('radio', { name: 'Upload files', exact: true }).click()

  await page.locator('input[type="file"]').setInputFiles([
    {
      name: 'acceptance.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Acceptance\nThe committed requirement document.\n'),
    },
    {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('analysis notes\n'),
    },
  ])
  const cards = page.locator('.employee-case-upload-list .card')
  await expect(cards).toHaveCount(2)

  // ① 默认落点是「随 MR 入库」，且入库路径预填成文件名——用户不填也能得到一个合法路径。
  const firstPath = page.getByRole('textbox', { name: 'Repository target path' }).first()
  await expect(firstPath, '入库路径没有按文件名预填 ⇒ 每个文件都要用户自己打一遍路径').toHaveValue(
    'acceptance.md',
  )
  await expect(
    page.getByTestId('stepper-next'),
    '两个默认路径互不相同时下一步仍不可用 ⇒ 正常的上传被卡住了',
  ).toBeEnabled()

  // ② 两个入库文件撞同一个路径 ⇒ 当场拦下。放行的话 MR 里只会留下后写的那个文件，
  //    而用户以为两个都提交了。
  const secondPath = page.getByRole('textbox', { name: 'Repository target path' }).nth(1)
  await secondPath.fill('acceptance.md')
  await expect(
    page.getByTestId('stepper-next'),
    '两个文件写同一个入库路径时仍能继续 ⇒ 后写的会覆盖前一个，用户传了两份只进去一份',
  ).toBeDisabled()

  // ③ 第二个文件改走「仅作临时材料」⇒ 入库路径输入框让位给平台分配的落点说明，
  //    重复路径的冲突随之消失（临时材料不进 Git，本来就不占仓库路径）。
  await page.getByRole('radio', { name: 'Temporary material', exact: true }).nth(1).click()
  await expect(
    page.getByRole('textbox', { name: 'Repository target path' }),
    '切成临时材料后仍要求填入库路径 ⇒ 两种落点被混成了一种',
  ).toHaveCount(1)
  await expect(
    cards.nth(1),
    '临时落点没有告诉用户文件会被放到哪里 ⇒ 用户无法在提示词里引用它',
  ).toContainText('.agent-workflow/inputs/requirements/')
  await expect(
    page.getByTestId('stepper-next'),
    '只剩一个入库路径后仍不可继续 ⇒ 重复路径的判据把临时材料也算了进去',
  ).toBeEnabled()

  // ④ 发起：两种落点各自以正确的形状上行（临时材料的 targetPath 必须是 null，
  //    否则服务端会试图把它提交进 Git）。
  const launchRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/digital-employees/${employeeOnAlphaId}/cases`,
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-launch').click()
  const launched = await launchRequest
  const uploads = (
    launched.postDataJSON() as {
      uploads: Array<{ uploadRef: string; placement: string; targetPath: string | null }>
    }
  ).uploads
  expect(
    uploads.map((upload) => ({ placement: upload.placement, targetPath: upload.targetPath })),
    '两个文件的落点/路径没有按用户的选择上行 ⇒ 界面上的二选一没有接到请求里',
  ).toEqual([
    { placement: 'repository', targetPath: 'acceptance.md' },
    { placement: 'temporary', targetPath: null },
  ])

  await page.waitForURL(/\/tasks\/employee-cases\/[0-9A-Z]+$/)
  const caseId = page.url().split('/').at(-1)!
  const claimed = querySqlite<{ original_name: string; state: string }>(
    dbPath(),
    `SELECT original_name, state FROM employee_input_uploads
      WHERE claimed_by_case_id = '${caseId}' ORDER BY original_name`,
  )
  expect(claimed, '两个文件没有被这个案例认领 ⇒ 上传只停在暂存区，执行体读不到它们').toEqual([
    { original_name: 'acceptance.md', state: 'claimed' },
    { original_name: 'notes.txt', state: 'claimed' },
  ])
  await forceQuietCase(caseId)

  // ⑤ 体积上限必须是前后端同一个数：界面按 descriptor 里的 maxFileBytes 放行，
  //    服务端按自己的常量收；两者不一致时用户会填完整张表单才被打回（或者反过来，
  //    界面拦下了服务端本来能收的文件）。
  const descriptor = await api<{
    workIntakeAuthoring: { files: { maxFileBytes: number; maxFiles: number } }
  }>(`/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}`)
  const maxFileBytes = descriptor.workIntakeAuthoring.files.maxFileBytes
  const oversize = await uploadBytes(maxFileBytes + 1, 'oversize.bin')
  expect(
    { status: oversize.status, code: (oversize.json as { code?: string } | undefined)?.code },
    '比界面声明的上限大 1 字节的上传被服务端收下了 ⇒ 界面的体积校验和服务端不是同一个数',
  ).toEqual({ status: 422, code: 'employee-upload-too-large' })
  const accepted = await uploadBytes(1_024, 'within-limit.bin')
  expect(
    accepted.status,
    '正常大小的上传也被拒了 ⇒ 上限判据把所有文件都拦下了，上传入口整条不可用',
  ).toBe(201)
})

// ------------------------------------------------------------------- DE-X5

test('RFC-319 DE-X5: 仓库组范围的员工只能选组内仓库，任务范围的员工在全量清单里选一个并随 launch 上行 @nightly', async ({
  page,
}) => {
  await primeAuth(page)

  // --- 仓库组范围：清单收窄到组内 -------------------------------------------------
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=digital-employee&employeeId=${employeeOnGroupId}`,
  )
  await expect(page.getByTestId('stepper-step-space')).toHaveAttribute('aria-current', 'step')
  const groupPicker = page.getByTestId('repo-source-recent-urls-0')
  await expect(
    groupPicker,
    '仓库组范围的员工没有拿到可用的仓库选择器 ⇒ 这名员工发不出任何任务',
  ).toBeEnabled()
  await groupPicker.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  await expect(
    listbox.getByRole('option', { name: repoAlpha.url }),
    '组内仓库不在清单里 ⇒ 仓库组范围的员工连自己负责的仓库都选不到',
  ).toBeVisible()
  await expect(
    listbox.getByRole('option', { name: repoBeta.url }),
    '组外仓库出现在清单里 ⇒ 作用域没有收窄，用户会把工作交给一个这名员工的配置' +
      '（连接、策略）根本不适用的仓库',
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(listbox).toHaveCount(0)

  // --- 任务范围：全量清单，且必须真的选一个 ---------------------------------------
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=digital-employee&employeeId=${employeeOnTaskId}`,
  )
  await expect(page.getByTestId('stepper-step-space')).toHaveAttribute('aria-current', 'step')
  await expect(
    page.getByTestId('stepper-next'),
    '任务范围的员工还没选仓库就能进下一步 ⇒ 目标仓库会以空值发出去',
  ).toBeDisabled()
  const taskPicker = page.getByTestId('repo-source-recent-urls-0')
  await taskPicker.click()
  const taskListbox = page.getByRole('listbox')
  await expect(taskListbox).toBeVisible()
  for (const repository of [repoAlpha, repoBeta]) {
    await expect(
      taskListbox.getByRole('option', { name: repository.url }),
      '任务范围的员工看不到全部仓库 ⇒ 「每次任务再选仓库」这档作用域被谁收窄了',
    ).toBeVisible()
  }
  await taskListbox.getByRole('option', { name: repoBeta.url }).click()
  await expect(taskListbox).toHaveCount(0)
  await expect(taskPicker).toContainText(repoBeta.url)
  await expect(
    page.getByTestId('stepper-next'),
    '选完仓库后仍不能进下一步 ⇒ 选择没有被记住',
  ).toBeEnabled()

  const taskName = `Task scoped launch ${RUN_TAG}`
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-task-name').fill(taskName)
  await page
    .getByLabel('Requirement or problem body')
    .fill('RFC-319 DE-X5: the repository is chosen at launch, not on the employee.')

  const launchRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/digital-employees/${employeeOnTaskId}/cases`,
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-launch').click()
  const launched = await launchRequest
  expect(
    (launched.postDataJSON() as { target: Record<string, string> }).target,
    '本次选择的仓库没有随 launch 上行 ⇒ 任务会落到别的仓库上（或者根本没有仓库）',
  ).toEqual({ repositoryId: repoBeta.id })

  await page.waitForURL(/\/tasks\/employee-cases\/[0-9A-Z]+$/)
  const caseId = page.url().split('/').at(-1)!
  const [context] = querySqlite<{ state_json: string }>(
    dbPath(),
    `SELECT state_json FROM employee_context_records WHERE case_id = '${caseId}'`,
  )
  expect(
    (JSON.parse(context?.state_json ?? '{}') as { repositoryRef?: string }).repositoryRef,
    '案例的工作上下文没有按本次选择的仓库落库 ⇒ 服务端收下了请求却按别的仓库解释，' +
      '后续所有职责都会在错误的仓库上动作',
  ).toBe(repoBeta.id)
  await forceQuietCase(caseId)
})

// ------------------------------------------------------------------- DE-42

test('RFC-319 DE-42: 四条老 URL 各自把人送到今天真正在用的那一屏，而不是 404 @nightly', async ({
  page,
}) => {
  await primeAuth(page)

  for (const legacyPath of ['/code', '/code/outcomes', '/outcomes']) {
    await page.goto(`${daemon.baseUrl}${legacyPath}`)
    await expect(page, `${legacyPath} 没有把人送到数字员工总览 ⇒ 这条书签今天是一个死链`).toHaveURL(
      `${daemon.baseUrl}/digital-employees`,
    )
    await expect(
      page.getByTestId('digital-employee-type-list'),
      `${legacyPath} 落地后没有渲染员工分类列表 ⇒ 地址栏对了，页面还是空的`,
    ).toBeVisible()
    await expect(
      page.getByTestId(`digital-employee-type-${DEVELOPMENT_TYPE_REF.typeId}`),
      `${legacyPath} 落地页里没有可进入的员工分类 ⇒ 用户到了终点却无路可走`,
    ).toBeVisible()
  }

  // 老的 Mission 收件箱换成了统一任务列表的一个过滤视图——不带那个过滤就等于把人
  // 丢进全量列表，他要自己想起来「数字员工的运行现在叫任务」。
  await page.goto(`${daemon.baseUrl}/code/missions`)
  await expect(
    page,
    '/code/missions 没有落到带数字员工过滤的统一任务列表 ⇒ 老收件箱的语义在这次搬家中丢了',
  ).toHaveURL(`${daemon.baseUrl}/tasks?type=digital-employee`)
  await page.getByTestId('tasks-filter-button').click()
  const dialog = page.getByTestId('tasks-filter-dialog').getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(
    dialog
      .getByRole('radiogroup', { name: 'Task type' })
      .getByRole('radio', { name: 'Digital employee', exact: true }),
    '落地后筛选弹窗里的类别不是「数字员工」⇒ URL 上写着过滤，界面上并没有生效',
  ).toBeChecked()
})

// ------------------------------------------------------------------- DE-40

test('RFC-319 DE-40: 遗留发起向导仍打得开，平台在提交处给出机器码与去处而不是无声失败 @nightly', async ({
  page,
}) => {
  await primeAuth(page)

  // ① 这条 URL 仍然可达：老文档、老书签里还有它，打开必须是一张真实的表单，
  //    而不是白屏或 404。
  await page.goto(`${daemon.baseUrl}/code/missions/new`)
  await expect(page, '/code/missions/new 被重定向走了 ⇒ 本条锁的前提（它可达）不再成立').toHaveURL(
    `${daemon.baseUrl}/code/missions/new`,
  )
  await expect(
    page.locator('.page--mission-wizard'),
    '遗留发起向导打不开 ⇒ 用户点进老书签只看到一张白屏，连「这条路废了」都读不到',
  ).toBeVisible()
  await expect(
    page.getByTestId('stepper-step-repository'),
    '向导的步骤条没有渲染 ⇒ 页面在半路就崩了',
  ).toBeVisible()

  // ② 而平台在**提交处**给出的是一条可读的去处，不是 500、不是空正文。
  //    这条断言锁的是「它把人指向哪儿」，不是「它必须失败」：
  //    平台若哪天重新放开遗留受理，这一格会红，而那时账本这一行本来也该重写。
  const refused = await rawCall('/api/code/missions', {
    method: 'POST',
    body: {
      idempotencyKey: `rfc319-de40-${RUN_TAG}`,
      repositoryId: repoAlpha.id,
      submissionKind: 'direct',
      title: 'RFC-319 DE-40 legacy launch probe',
      body: 'probe',
    },
  })
  const payload = refused.json as { code?: string; message?: string } | undefined
  expect(
    { status: refused.status, code: payload?.code },
    '遗留发起端点没有以专门的机器码回绝 ⇒ 用户（和接手的人）无法把这次失败和' +
      '「这条路已经换了」联系起来',
  ).toEqual({ status: 409, code: 'legacy-mission-admission-retired' })
  expect(
    payload?.message ?? '',
    '回绝正文没有指出新的去处 ⇒ 用户只知道失败了，不知道该去哪儿重来一次',
  ).toContain('Digital Employee')

  // ③ 它指的那个去处必须真的存在——否则这句提示本身就是另一条死链。
  const sources = await api<{
    sources: Array<{ id: string; catalogPath: string; detailPath: string }>
  }>('/api/task-catalog/sources')
  expect(
    sources.sources.find((source) => source.id === 'digital-employee'),
    '提示里指向的数字员工入口不在任务源注册表里 ⇒ 平台把人指向了一个不存在的地方',
  ).toMatchObject({ catalogPath: '/digital-employees' })
})

// ------------------------------------------------------------------- DE-41

/**
 * 播一行**排干期的遗留 Mission**。
 *
 * 为什么要直接写库：新建那道门在生产里是焊死的——`cli/start.ts:798` 调
 * `activateDigitalEmployeeOsWriter(db, legacyMissionDrain)` 不传 options，
 * `writerCutover.ts:64` 于是取 `legacyAdmissionsEnabled = false`，全仓再无第二个
 * 开关，`POST /api/code/missions` 永远 409（DE-40 锁的就是那道门）。所以任何全新
 * daemon 里都不可能「正常地」造出一条 Mission。
 *
 * 但**运维动作不在那道门后面**：整个 `routes/developmentMissions.ts` 里
 * `legacyAdmissionsEnabled()` 只出现一次，就在创建那处；`/:id` 之下的 20 个端点
 * （cancel / retry / handoff / attach-mr / resume / source-refresh / answers /
 * decision-trace / …）一个都没被挡。这是刻意的：**升级上来的部署里，存量 Mission
 * 必须还能被排干**——排不干就意味着它们永远卡在 `legacy-draining`，
 * `refreshDigitalEmployeeWriterState` 的 `legacyOpenMissionCount` 永远不归零，
 * 单写切换就永远完不成。所以这条排干路径是活的产品面，只是入口被封了。
 *
 * `getMissionDetail`（missionReadModels.ts:287-317）只读 mission 行 + sources 行，
 * `summaryOf` 是恒等函数、不做任何 join，所以一行就够把详情页开起来。
 */
function seedDrainingMission(input: {
  readonly id: string
  readonly status: string
  readonly automationMode?: 'active' | 'tracking-only'
  readonly repositoryId: string
}): void {
  const now = Date.now()
  runSqlite(
    dbPath(),
    `INSERT INTO development_missions
       (id, status, automation_mode, repository_id, source_kind, delivery_kind,
        created_at, updated_at)
     VALUES ('${input.id}', '${input.status}', '${input.automationMode ?? 'active'}',
             '${input.repositoryId}', 'direct', 'create-merge-request', ${now}, ${now})`,
  )
}

function missionRow(id: string): {
  status: string
  automation_mode: string
  mr_claim_id: string | null
} {
  const rows = querySqlite<{
    status: string
    automation_mode: string
    mr_claim_id: string | null
  }>(
    dbPath(),
    'SELECT status, automation_mode, mr_claim_id FROM development_missions WHERE id = ?',
    [id],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`播下的 mission ${id} 不见了`)
  return row
}

test('RFC-319 DE-41: 排干期遗留任务的运维动作——交接/取消按状态各归各位，下一步动作随终态翻面，每一次拒绝都带机器码 @nightly', async ({
  page,
}) => {
  await primeAuth(page)

  const drainId = `01DE41DRAIN${RUN_TAG.slice(0, 10).toUpperCase().padEnd(10, '0')}A`.slice(0, 24)
  seedDrainingMission({ id: drainId, status: 'blocked', repositoryId: repoAlpha.id })

  // ── ① 详情页开得起来，且给出的是「现在该做什么」而不只是一堆字段 ──
  await page.goto(`${daemon.baseUrl}/code/missions/${drainId}`)
  await expect(
    page.getByTestId('mission-cancel'),
    '排干期的 Mission 详情页打不开（或没有取消入口）⇒ 升级上来的部署里存量 Mission ' +
      '再也没有人工出口，legacyOpenMissionCount 永不归零，单写切换永远完不成',
  ).toBeVisible()
  await expect(
    page.getByTestId('mission-handoff'),
    'automationMode=active 的在途 Mission 没有「交接」⇒ 卡住时没有转人工的路',
  ).toBeVisible()

  // 阻塞态的下一步动作是「重试」，而且它是**可点的命令**而非死链。
  const nextCommand = page.getByTestId('journey-next-command')
  await expect(
    nextCommand,
    'blocked 的 Mission 没有给出可执行的下一步 ⇒ 运维只看到「卡住了」，看不到怎么往下走',
  ).toBeVisible()

  // ── ② 交接：自动化让位给人，库与界面同步翻面 ──
  await page.getByTestId('mission-handoff').click()
  await expect
    .poll(() => missionRow(drainId).automation_mode, {
      timeout: 20_000,
      message: '点了「交接」但库里的 automation_mode 没翻 ⇒ 界面在自说自话，刷新就打回原形',
    })
    .toBe('tracking-only')
  await expect(
    page.getByTestId('mission-handoff'),
    '已经交接过了还留着「交接」⇒ 重复点会把同一条 Mission 反复摘牌',
  ).toHaveCount(0, { timeout: 20_000 })
  await expect(
    page.getByTestId('mission-cancel'),
    '交接之后连「取消」也没了 ⇒ 转人工反而把最后的出口关掉了',
  ).toBeVisible()

  // ── ③ 关联 MR：这台 daemon 的仓库没绑代码宿主，所以必须**明说为什么**，
  //    既不能静默吞掉，也不能假装挂上了。
  const attachRefusal = await rawCall(`/api/code/missions/${drainId}/attach-mr`, {
    method: 'POST',
    body: { mrIid: '4217' },
  })
  expect(
    {
      status: attachRefusal.status,
      code: (attachRefusal.json as { code?: string } | undefined)?.code,
    },
    '关联 MR 失败时没有专门的机器码 ⇒ 运维只知道「没成功」，不知道是缺代码宿主绑定',
  ).toEqual({ status: 409, code: 'mr-observe-unavailable' })
  expect(
    missionRow(drainId).mr_claim_id,
    '关联失败却已经把 mr_claim_id 写下去了 ⇒ 这条 Mission 认领了一个它根本观察不到的 MR',
  ).toBeNull()

  // ── ④ 续跑：把自动化交回平台 ──
  const resumed = await rawCall(`/api/code/missions/${drainId}/resume`, {
    method: 'POST',
    body: {},
  })
  expect(
    {
      status: resumed.status,
      mode: (resumed.json as { automationMode?: string } | undefined)?.automationMode,
    },
    '交接出去的 Mission 收不回来 ⇒ 人工介入完成后没有回到自动化的路',
  ).toEqual({ status: 200, mode: 'active' })
  await page.reload()
  await expect(
    page.getByTestId('mission-handoff'),
    '续跑之后「交接」没回来 ⇒ 这条 Mission 再也交不出去了',
  ).toBeVisible()

  // ── ⑤ 取消：进终态，两个运维入口**一起**消失，下一步动作从「命令」翻成「去处」──
  await page.getByTestId('mission-cancel').click()
  await expect
    .poll(() => missionRow(drainId).status, {
      timeout: 20_000,
      message: '点了「取消」但库里状态没进终态',
    })
    .toBe('canceled')
  await expect(
    page.getByTestId('mission-cancel'),
    '取消之后「取消」还在 ⇒ 终态的 Mission 仍摆着可点的运维入口，点下去只会 409',
  ).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByTestId('mission-handoff')).toHaveCount(0)
  await expect(
    page.getByTestId('journey-next-command'),
    '终态之后仍然给出可执行命令 ⇒ 平台在建议一件它自己会拒绝的事',
  ).toHaveCount(0)
  // 终态之后下一步变成一条「去处」链接。这里只断言**它存在**，刻意不断言它指向哪儿：
  // 当前它指向 `/code/missions/new`，而那道门在单写切换后永远 409（DE-40 已锁）——
  // 也就是说排干完一条 Mission 之后，平台给出的下一步是一条死路。这是一条已记录的
  // 产品缺口（docs/audit-backlog.md），把 href 写进断言等于让 CI 帮着守住这个缺陷，
  // 所以留给修的人去改，不留给测试去固化。
  await expect(
    page.getByTestId('journey-next-link'),
    '终态之后没有任何下一步 ⇒ 用户走到这里就断了',
  ).toBeVisible()

  // ── ⑥ 重试：只对 blocked 成立，拒绝要带机器码 ──
  const retryAfterTerminal = await rawCall(`/api/code/missions/${drainId}/retry`, {
    method: 'POST',
    body: {},
  })
  expect(
    {
      status: retryAfterTerminal.status,
      code: (retryAfterTerminal.json as { code?: string } | undefined)?.code,
    },
    '对已终态的 Mission 重试没有被专门回绝 ⇒ 排干期最容易发生的误操作没有护栏',
  ).toEqual({ status: 409, code: 'mission-command-not-blocked' })

  const retryId = `${drainId.slice(0, 19)}RETRY`
  seedDrainingMission({ id: retryId, status: 'blocked', repositoryId: repoAlpha.id })
  const retried = await rawCall(`/api/code/missions/${retryId}/retry`, { method: 'POST', body: {} })
  expect(
    {
      status: retried.status,
      next: (retried.json as { status?: string } | undefined)?.status,
    },
    'blocked 的 Mission 重试不动 ⇒ 排干路上每一次阻塞都成了死结',
  ).toEqual({ status: 200, next: 'working' })

  // ── ⑦ 需求刷新 / 反问作答 / 证据浏览：正向路径要一整套外部适配器与流水线证据才走得到；
  //    排干期真正要保证的是**不会 500、不会静默**——运维点下去总能读到「为什么不行」。
  const refresh = await rawCall(`/api/code/missions/${retryId}/source-refresh/preview`, {
    method: 'POST',
    body: {},
  })
  expect(
    { status: refresh.status, code: (refresh.json as { code?: string } | undefined)?.code },
    'direct 来源的 Mission 去刷新需求，没有给出「它本来就没有外部来源」这个机器码',
  ).toEqual({ status: 422, code: 'not-external-source' })

  const answers = await rawCall(`/api/code/missions/${retryId}/answers`, {
    method: 'POST',
    body: { questionSetRef: 'de41-no-such-set', answers: [{ questionId: 'q1', answer: 'a' }] },
  })
  expect(
    { status: answers.status, code: (answers.json as { code?: string } | undefined)?.code },
    '不在等反问的 Mission 收到答案时没有专门回绝 ⇒ 答案会落在没人读的地方',
  ).toEqual({ status: 409, code: 'mission-command-not-awaiting-information' })

  const manifest = await rawCall(`/api/code/missions/${retryId}/requirement-manifest`)
  expect(
    { status: manifest.status, code: (manifest.json as { code?: string } | undefined)?.code },
    '还没物化需求包的 Mission 去读清单，没有专门的 404 ⇒ 分不清「没有」和「坏了」',
  ).toEqual({ status: 404, code: 'requirement-manifest-not-found' })

  // 上面那次 retry 真的在轨迹里留下了一条判定：这条播出来的 Mission 没有绑策略，
  // 于是它在策略这一关被拦下（`policy-content-missing`）。断言它**有内容且说得出理由**，
  // 而不是断言它是空的——空轨迹既可能是「什么都没发生」，也可能是「记录坏了」，
  // 而排干期最需要读的恰恰是「它当时为什么这么判」。
  const trace = await rawCall(`/api/code/missions/${retryId}/decision-trace`)
  const traceItems =
    (trace.json as { items?: Array<{ selected?: { kind?: string; reason?: string } }> } | undefined)
      ?.items ?? []
  expect(
    { status: trace.status, count: traceItems.length > 0 },
    '决策轨迹读不出来（或一条都没记）⇒ 排干期最需要的「它当时为什么这么判」没了',
  ).toEqual({ status: 200, count: true })
  expect(
    traceItems[0]?.selected,
    '轨迹条目没有写清这一步选了什么、为什么 ⇒ 它只是一行时间戳，帮不了正在排障的人',
  ).toEqual({ kind: 'block', reason: 'policy-content-missing' })

  await page.goto(`${daemon.baseUrl}/code/missions/${retryId}`)
  await expect(
    page.getByTestId('evidence-not-collected'),
    '没有流水线证据时证据区是空白而不是一句明确的「尚未采集」⇒ 用户读不出这是「没有」还是「没加载出来」',
  ).toBeVisible()
})

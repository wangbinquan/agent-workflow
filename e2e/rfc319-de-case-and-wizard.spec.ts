// RFC-319 —— 数字员工「任务向导 + 案例页」8 条能力的浏览器兜底。
//
// 覆盖 `architecture/e2e-capability-ledger.json` 里这几条 `tier: nightly` 的 gap：
// DE-19（员工卡片的四类运行成效计数）、DE-20（卡片一键创建任务带 employeeId 预填）、
// DE-23（向导的需求 / 问题 ID 入口）、DE-24（未启用的材料形式提示 + 去配置的链接）、
// DE-25（发起失败时的报错 / 草稿保留 / 已上传文件补偿删除）、DE-28（案例的人工评审
// 移交与回流）、DE-29（事件队列 / 关注范围 / 协作子案例三个面板）、
// DE-30（终态展示与轮询停止）。
//
// 逐条依据见 `design/RFC-319-user-facing-e2e-coverage-hardening/findings.md` 的同名行。
//
// 三条与「怎么造现场」有关的取舍，写在这里免得下一个人重新踩：
//
//  1. **本文件不用 `mode: 'serial'`**。每条用例自带自己的员工 / 案例，互不依赖；
//     `playwright.config.ts` 的 `fullyParallel: false` 已经保证同文件内顺序执行。
//     不加 serial 是为了让一次批量变异注入能同时看清「哪几条红」——serial 下第一条红
//     之后其余全是 `did not run`，归因不出来（`docs/dev-gotchas.md` 同名教训）。
//  2. **DE-29 的事件队列 / 关注范围 / 协作子案例三张表用 `runSqlite` 落库造现场。**
//     平台没有任何用户面入口能往一个案例里塞待处理事件（`employee_case_inbox` 只由
//     事件中心投递写入）、也没有入口能在浏览器里当场委托一个子案例。本条锁的是
//     **界面这一段**：三个面板各自渲染什么、排序按什么、子案例链接落到哪。
//     「谁有资格写这些行」由后端 system-mock 用例负责，不在本条覆盖范围内。
//  3. **DE-28 用一个 `review-doc` stub 模式的独立 daemon。** 内置的方案编写 Agent 把
//     `analysis-plan` 声明成 `path<md>`（`services/digitalEmployeeAgentTemplates.ts:285`），
//     而 `development` stub 对这份合同只会 `fail('direct-JSON prompt has no
//     OUTPUT_SCHEMA_EXAMPLE_JSON block')`（`packages/system-mocks/src/runtime/mode-development.ts:302-303`）——
//     案例永远走不到「等待人工评审」。本用例改用一个自建的 Agent 把该端口声明成
//     `markdown`（同样是 `isReviewableBodyKind`，`packages/shared/src/kindParser.ts:237-241`），
//     配上会给每个声明端口回一份 Markdown 的 `review-doc` stub，于是评审门禁是被
//     **真实执行链**推到 `awaiting_review` 的，不是伪造的。

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { developmentEmployeeTypePackage } from '../packages/backend/src/modules/development-automation/composition/employeeTypePackage'
import { initGitRepo, querySqlite, repoRemoteUrl, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

/** 内置 development 类型包的**当前**引用，从生产 descriptor 派生（同 p1 spec）。 */
const DEVELOPMENT_TYPE_REF = (
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
    readonly typeRef: { readonly typeId: string; readonly revision: number }
  }
).typeRef
const TYPE_REF = `${DEVELOPMENT_TYPE_REF.typeId}@${DEVELOPMENT_TYPE_REF.revision}`
const TYPE_PATH = `${DEVELOPMENT_TYPE_REF.typeId}%40${DEVELOPMENT_TYPE_REF.revision}`

const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/**
 * 材料准备工具用的确定性脚本：内置 Agent 里没有任何一个声明
 * `development.prepare-materials@3`，而这份合同允许 program 执行体。
 *
 * 输出形状必须逐字符合 `development.prepare-materials.result.v2`
 * （`digitalEmployeeToolContractsV2.ts` 的 outputExample）——发布前平台会**真的跑一遍**
 * 这个脚本并校验它的 stdout（validation check `program-fixture-exact-output`）。
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
}

test.setTimeout(240_000)

let daemon: DaemonHandle
let repositoryId = ''
let repositoryUrl = ''
let implAgentRef: ExactRef = { id: '', revision: 0 }
let planAgentRef: ExactRef = { id: '', revision: 0 }
let implToolRef: ExactRef = { id: '', revision: 0 }
let planToolRef: ExactRef = { id: '', revision: 0 }
let materialsToolRef: ExactRef = { id: '', revision: 0 }
/** 只绑「实现变更」：ID 入口不可用、方案评审不可用。 */
let jobMinimalRef: ExactRef = { id: '', revision: 0 }
/** 额外绑了「材料准备」：ID 入口可用。 */
let jobIntakeRef: ExactRef = { id: '', revision: 0 }

let outcomeEmployeeId = ''
let outcomeEmployeeName = ''
let neighbourEmployeeId = ''
let minimalEmployeeId = ''
let minimalEmployeeName = ''
let intakeEmployeeId = ''
let intakeEmployeeName = ''
let panelEmployeeId = ''
let pollingEmployeeId = ''

function dbPath(handle: DaemonHandle): string {
  return join(handle.home, 'db.sqlite')
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  handle: DaemonHandle = daemon,
): Promise<T> {
  const response = await fetch(`${handle.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${handle.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`)
  }
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function primeAuth(page: Page, handle: DaemonHandle = daemon): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: handle.baseUrl, token: handle.token },
  )
}

async function importFixtureRepository(handle: DaemonHandle): Promise<{ id: string; url: string }> {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-de-case-'))
  writeFileSync(join(repoDir, 'README.md'), '# RFC-319 case-and-wizard fixture\n')
  initGitRepo(repoDir)
  const remote = repoRemoteUrl(repoDir)
  let batch = await api<{ batchId: string; state: string; rows: Array<{ status: string }> }>(
    '/api/cached-repos/batch-import',
    { method: 'POST', body: { urls: [remote] } },
    handle,
  )
  const deadline = Date.now() + 60_000
  while (batch.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    batch = await api(`/api/cached-repos/imports/${batch.batchId}`, {}, handle)
  }
  if (batch.state !== 'completed' || batch.rows.some((row) => row.status !== 'done')) {
    throw new Error(`fixture repository import failed: ${JSON.stringify(batch.rows)}`)
  }
  const repositories = await api<{ items: Array<{ id: string; urlRedacted: string | null }> }>(
    '/api/cached-repos',
    {},
    handle,
  )
  const repository = repositories.items.find((candidate) => candidate.urlRedacted === remote)
  if (repository === undefined) throw new Error('fixture repository is missing after import')
  return { id: repository.id, url: repository.urlRedacted ?? repository.id }
}

async function builtinAgentRef(contractId: string, handle: DaemonHandle): Promise<ExactRef> {
  const agents = await api<
    Array<{
      id: string
      updatedAt: number
      frontmatterExtra: { executionContracts?: Array<{ contractId: string; version: number }> }
    }>
  >('/api/agents/builtins/digital-employee-templates', {}, handle)
  const found = agents.find((candidate) =>
    candidate.frontmatterExtra.executionContracts?.some(
      (declared) => declared.contractId === contractId,
    ),
  )
  if (found === undefined) throw new Error(`no built-in Agent declares ${contractId}`)
  return { id: found.id, revision: found.updatedAt }
}

async function seedPublishedTool(
  input: {
    workItemRef: string
    roleRef: string
    displayName: string
    implementation: Record<string, unknown>
  },
  handle: DaemonHandle = daemon,
): Promise<ExactRef> {
  const draft = await api<{
    id: string
    validationReceipt: { status: string; checks: Array<{ code: string; ok: boolean }> }
  }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(input.workItemRef)}/tools`,
    {
      method: 'POST',
      body: {
        displayName: input.displayName,
        description: 'RFC-319 case-and-wizard fixture',
        roleRef: input.roleRef,
        implementation: input.implementation,
      },
    },
    handle,
  )
  if (draft.validationReceipt.status !== 'valid') {
    throw new Error(
      `tool ${input.displayName} is invalid: ${JSON.stringify(draft.validationReceipt.checks)}`,
    )
  }
  const published = await api<{ ref: ExactRef }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(input.workItemRef)}/tools/${encodeURIComponent(draft.id)}/publish`,
    { method: 'POST', body: {} },
    handle,
  )
  return published.ref
}

async function seedPublishedJob(
  name: string,
  bindings: ReadonlyArray<{ workItemRef: string; slotRef: string; registrationRef: ExactRef }>,
  handle: DaemonHandle = daemon,
): Promise<ExactRef> {
  const draft = await api<{ id: string }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
    {
      method: 'POST',
      body: {
        name,
        description: 'RFC-319 case-and-wizard fixture',
        defaultToolBindings: bindings,
        defaultAdapterBindings: [],
        defaultCollaborationBindings: [],
      },
    },
    handle,
  )
  const published = await api<{ ref: ExactRef }>(
    `/api/digital-employee-job-templates/${encodeURIComponent(draft.id)}/publish`,
    { method: 'POST', body: {} },
    handle,
  )
  return published.ref
}

async function seedEmployee(
  name: string,
  jobTemplateRef: ExactRef,
  handle: DaemonHandle = daemon,
  repoId: string = repositoryId,
): Promise<EmployeeRow> {
  return api<EmployeeRow>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`,
    {
      method: 'POST',
      body: {
        name,
        jobTemplateRef,
        workScope: { kind: 'repository', repositoryId: repoId },
        toolOverrides: [],
        adapterOverrides: [],
        collaborationOverrides: [],
      },
    },
    handle,
  )
}

let launchSequence = 0

async function launchCase(
  input: {
    employeeId: string
    name: string
    executionOptions?: Record<string, boolean>
  },
  handle: DaemonHandle = daemon,
  repoId: string = repositoryId,
): Promise<string> {
  launchSequence += 1
  const launched = await api<{ case: { id: string } }>(
    `/api/digital-employees/${encodeURIComponent(input.employeeId)}/cases`,
    {
      method: 'POST',
      body: {
        name: input.name,
        kind: 'body',
        target: { repositoryId: repoId },
        body: 'RFC-319 case-and-wizard fixture case.',
        externalId: null,
        uploads: [],
        executionOptions: input.executionOptions ?? {},
        idempotencyKey: `rfc319-de-case-${RUN_TAG}-${launchSequence}`,
      },
    },
    handle,
  )
  return launched.case.id
}

/**
 * 把一个真实案例静置成稳定的 `blocked` 现场（形态同
 * `e2e/rfc319-digital-employee-p1.spec.ts:239-282`，那里有完整理由）。
 *
 * 这里用它有两个目的：①给 DE-29 一块不会被 OS worker 改写的画布；②给 DE-30 一个
 * 会一直轮询的**非终态**对照组。
 */
async function forceQuietCase(
  caseId: string,
  state: 'blocked' | 'active',
  handle: DaemonHandle = daemon,
): Promise<void> {
  const path = dbPath(handle)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = Date.now()
    runSqlite(
      path,
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
          SET state = '${state}',
              block_reason = ${state === 'blocked' ? `'rfc319-de-fixture: quiesced for a stable browser assertion'` : 'NULL'},
              active_round_id = NULL,
              current_work_item_ref = NULL,
              revision = revision + 1,
              updated_at = ${now}
        WHERE id = '${caseId}';`,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const [row] = querySqlite<{ state: string; active_round_id: string | null; pending: number }>(
      path,
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
    if (row?.state === state && row.active_round_id === null && row.pending === 0) return
  }
  throw new Error(`case ${caseId} never settled into a stable ${state} fixture`)
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'development' })
  const repository = await importFixtureRepository(daemon)
  repositoryId = repository.id
  repositoryUrl = repository.url

  implAgentRef = await builtinAgentRef('development.implement-change', daemon)
  planAgentRef = await builtinAgentRef('development.plan-implementation', daemon)
  implToolRef = await seedPublishedTool({
    workItemRef: 'analyze-implement',
    roleRef: 'primary',
    displayName: `Implementation executor ${RUN_TAG}`,
    implementation: { kind: 'agent', agentRef: implAgentRef },
  })
  planToolRef = await seedPublishedTool({
    workItemRef: 'analyze-implement',
    roleRef: 'planning',
    displayName: `Plan writer ${RUN_TAG}`,
    implementation: { kind: 'agent', agentRef: planAgentRef },
  })
  materialsToolRef = await seedPublishedTool({
    workItemRef: 'prepare-materials',
    roleRef: 'primary',
    displayName: `Material acquisition ${RUN_TAG}`,
    implementation: {
      kind: 'program',
      runtimeKind: 'node',
      source: PROGRAM_FIXTURE,
      parameterValues: {},
      runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
    },
  })

  jobMinimalRef = await seedPublishedJob(`Implement only ${RUN_TAG}`, [
    { workItemRef: 'analyze-implement', slotRef: 'default', registrationRef: implToolRef },
  ])
  jobIntakeRef = await seedPublishedJob(`Implement with intake ${RUN_TAG}`, [
    { workItemRef: 'analyze-implement', slotRef: 'default', registrationRef: implToolRef },
    { workItemRef: 'analyze-implement', slotRef: 'plan', registrationRef: planToolRef },
    { workItemRef: 'prepare-materials', slotRef: 'default', registrationRef: materialsToolRef },
  ])

  outcomeEmployeeName = `Outcome employee ${RUN_TAG}`
  outcomeEmployeeId = (await seedEmployee(outcomeEmployeeName, jobMinimalRef)).id
  neighbourEmployeeId = (await seedEmployee(`Neighbour employee ${RUN_TAG}`, jobMinimalRef)).id
  minimalEmployeeName = `Minimal employee ${RUN_TAG}`
  minimalEmployeeId = (await seedEmployee(minimalEmployeeName, jobMinimalRef)).id
  intakeEmployeeName = `Intake employee ${RUN_TAG}`
  intakeEmployeeId = (await seedEmployee(intakeEmployeeName, jobIntakeRef)).id
  panelEmployeeId = (await seedEmployee(`Panel employee ${RUN_TAG}`, jobMinimalRef)).id
  pollingEmployeeId = (await seedEmployee(`Polling employee ${RUN_TAG}`, jobMinimalRef)).id
})

test.afterEach(async ({ page }) => {
  // `docs/dev-gotchas.md` 锁 B：先摘 handler，再趁 page 还活着把在飞的等完。
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('RFC-319 DE-19: 员工卡片的已合入 / 无需修改 / 其他结束 / 执行失败四类计数各自成桶，且不把别的员工的案例算进来 @nightly', async ({
  page,
}) => {
  // 四个桶给四个**不同**的数量：桶被串了（比如「已合入」读成「无需修改」）时数字
  // 对不上，才会红。四个桶都塞 1 的话，任何一次串桶都仍然是绿的。
  //
  // 「其他结束」用三个不同的终态词、「无需修改」用两个不同的历史终态词：分桶表是
  // 多对一的（`packages/shared/src/employeeTerminalKind.ts:61-78`），只喂一个词
  // 锁不住「表里少了一行」。
  const terminalKinds: ReadonlyArray<readonly [string, string]> = [
    ['merged', 'merged'],
    ['completed-no-change', 'no-change-a'],
    ['no-change-confirmed', 'no-change-b'],
    ['completed', 'other-a'],
    ['closed', 'other-b'],
    ['canceled', 'other-c'],
    ['execution-failed', 'failed-a'],
    ['execution-failed', 'failed-b'],
    ['execution-failed', 'failed-c'],
    ['execution-failed', 'failed-d'],
  ]
  for (const [terminalKind, label] of terminalKinds) {
    const caseId = await launchCase({
      employeeId: outcomeEmployeeId,
      name: `Outcome ${label} ${RUN_TAG}`,
    })
    // The development worker starts as soon as launch returns. On a saturated WebKit shard it can
    // terminalize this tiny fixture before the explicit terminate call, and terminate is correctly
    // idempotent for an already-terminal case. Quiesce first so this outcome-projection test owns
    // the terminal vocabulary it is seeding instead of racing the unrelated execution worker.
    await forceQuietCase(caseId, 'blocked')
    await api(`/api/employee-cases/${encodeURIComponent(caseId)}/terminate`, {
      method: 'POST',
      body: { terminalKind },
    })
  }
  // 邻居员工也有一条已合入的案例：`employeeTerminalOutcomeCounts` 的 employeeId
  // 过滤（`components/digital-employees/outcomes.ts:36`）一旦掉了，下面的 Merged
  // 就会变成 2。
  const neighbourCase = await launchCase({
    employeeId: neighbourEmployeeId,
    name: `Neighbour merged ${RUN_TAG}`,
  })
  await forceQuietCase(neighbourCase, 'blocked')
  await api(`/api/employee-cases/${encodeURIComponent(neighbourCase)}/terminate`, {
    method: 'POST',
    body: { terminalKind: 'merged' },
  })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=employees`)
  // 从**名字**那张卡片里取计数条，而不是直接拿 testid：testid 挂错员工时（同一份
  // map 里 id 取自外层循环变量之类）用 testid 定位是看不出来的。
  const outcomeCard = page
    .locator('.employee-summary-card--employee')
    .filter({ hasText: outcomeEmployeeName })
  await expect(outcomeCard).toHaveCount(1)
  const summary = outcomeCard.getByTestId(`digital-employee-outcomes-${outcomeEmployeeId}`)
  await expect(summary).toBeVisible()
  // 逐格读「标签 → 数字」，而不是 `toContainText('Merged1')`：后者对 'Merged10'
  // 同样成立，也管不住四格的顺序被换掉。
  await expect
    .poll(
      async () =>
        summary
          .locator('span')
          .evaluateAll((spans) =>
            spans.map((span) => [
              span.querySelector('small')?.textContent ?? '',
              span.querySelector('strong')?.textContent ?? '',
            ]),
          ),
      { message: '员工卡片的四类运行成效计数没有收敛到播种值' },
    )
    .toEqual([
      ['Merged', '1'],
      ['No change', '2'],
      ['Other finished', '3'],
      ['Failed', '4'],
    ])

  // 邻居卡片只认自己的那一条，交叉验证过滤是双向的。
  await expect
    .poll(async () =>
      page
        .getByTestId(`digital-employee-outcomes-${neighbourEmployeeId}`)
        .locator('span')
        .evaluateAll((spans) =>
          spans.map((span) => span.querySelector('strong')?.textContent ?? ''),
        ),
    )
    .toEqual(['1', '0', '0', '0'])
})

test('RFC-319 DE-20: 员工卡片的「创建任务」直接带着该员工进向导、跳过选人步骤，回到第一步时选择器已经是这个员工 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=employees`)
  const card = page
    .locator('.employee-summary-card--employee')
    .filter({ hasText: minimalEmployeeName })
  await expect(card).toHaveCount(1)
  await card.getByTestId(`digital-employee-create-task-${minimalEmployeeId}`).click()

  await page.waitForURL(/\/tasks\/new\?/)
  const search = new URL(page.url()).searchParams
  // 两个参数缺一不可：只带 kind 会退回选人步骤，只带 employeeId 会连数字员工向导
  // 都进不去（`routes/tasks.new.tsx:277-281` 要求 `search.kind === source.id`）。
  expect({ kind: search.get('kind'), employeeId: search.get('employeeId') }).toEqual({
    kind: 'digital-employee',
    employeeId: minimalEmployeeId,
  })
  await expect(page.getByTestId('stepper-step-space')).toHaveAttribute('aria-current', 'step')

  // 空间步骤已经按这个员工的作用域冻结了仓库——证明 employeeId 真的被解析成了一个
  // 员工，而不只是留在了 URL 上。
  const fixedRepository = page.getByTestId('repo-source-recent-urls-0')
  await expect(fixedRepository).toBeDisabled()
  await expect(fixedRepository).toContainText(repositoryUrl)

  // 回到第一步：选择器必须已经是这个员工。`initialResourceId` 掉了的话这里是
  // 占位文案，用户每次从卡片进来都得再挑一遍自己刚点过的那个人。
  await page.getByTestId('stepper-step-mode').click()
  await expect(page.getByTestId('stepper-step-mode')).toHaveAttribute('aria-current', 'step')
  const picker = page.getByRole('combobox', { name: 'Digital employee' })
  await expect(picker).toContainText(minimalEmployeeName)
  await expect(picker).not.toContainText('Select…')
})

test('RFC-319 DE-23: 向导用需求 / 问题 ID 发起任务，外部编号随 launch 上行并落到案例的工作上下文里 @nightly', async ({
  page,
}) => {
  const externalId = `ISSUE-${RUN_TAG.toUpperCase()}`
  const taskName = `External id task ${RUN_TAG}`
  await primeAuth(page)
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=digital-employee&employeeId=${intakeEmployeeId}`,
  )
  await expect(page.getByTestId('stepper-step-space')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')

  await page.getByTestId('wizard-task-name').fill(taskName)
  // 这个选项只在员工绑了「准备输入材料」工具时才出现
  // （`TaskCreationSubjectDescriptorContract.tsx:154-172` 的 kindRequirements 过滤）。
  const idOption = page.getByRole('radio', { name: 'Requirement / issue ID', exact: true })
  await expect(idOption).toBeVisible()
  await idOption.click()
  // 切到 ID 形式后正文输入框必须让位给 ID 输入框；两个同时在，用户会以为两样都要填。
  await expect(page.getByLabel('Requirement or problem body')).toHaveCount(0)
  const idInput = page.getByLabel('External requirement or issue ID')
  await expect(idInput).toBeVisible()
  await idInput.fill(externalId)

  const launchRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/digital-employees/${intakeEmployeeId}/cases`,
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  // 确认页要把 ID 原样念回来。念不出来 = 用户在最后一步无法核对自己填的编号。
  await expect(page.getByTestId('employee-case-summary-content')).toContainText(
    'Requirement / issue ID',
  )
  await expect(page.getByTestId('employee-case-summary-content')).toContainText(externalId)

  await page.getByTestId('wizard-launch').click()
  const launched = await launchRequest
  // ID 必须走 `externalId` 而不是被塞进 body：后端按 kind 分派材料准备工具
  // （`employeeTypePackage.ts:1944` 的 kindRequirements），塞错字段等于这条入口失效。
  expect(launched.postDataJSON()).toMatchObject({
    name: taskName,
    kind: 'external-id',
    externalId,
    body: null,
    target: { repositoryId },
  })

  await page.waitForURL(/\/tasks\/employee-cases\/[0-9A-Z]+$/)
  const caseId = page.url().split('/').at(-1)!
  await expect(page.getByRole('heading', { name: taskName, exact: true })).toBeVisible()
  await expect(
    page.getByText(`Development employee · ${intakeEmployeeName}`, { exact: true }),
  ).toBeVisible()
  // 案例的工作上下文里必须真的存着这个编号——它是后续「准备输入材料」唯一的输入。
  // 只断言请求体的话，「服务端收下了但没写进上下文」这一类失败照样绿。
  const frozenInput = page.getByTestId('employee-case-overview-input')
  await expect(frozenInput.getByText('External ID', { exact: true })).toBeVisible()
  await expect(frozenInput.getByText(externalId, { exact: true })).toBeVisible()

  await forceQuietCase(caseId, 'blocked')
})

test('RFC-319 DE-24: 没配材料准备工具的员工看不到 ID 入口，提示里的链接直接落到该职责的配置对话框 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=digital-employee&employeeId=${minimalEmployeeId}`,
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')

  // 三个平台直收的形式还在，只有需要工具的那一个不见了。四个都在 = 门控失效，
  // 用户会选一个员工根本执行不了的入口；四个都没了 = 过滤写反，任务发不出去。
  await expect(page.getByRole('radio', { name: 'Write request', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Upload files', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Request and files', exact: true })).toBeVisible()
  await expect(
    page.getByRole('radio', { name: 'Requirement / issue ID', exact: true }),
  ).toHaveCount(0)

  // 光把选项藏掉不解释，用户只会觉得「这个功能没做」。
  const notice = page
    .locator('.notice-banner')
    .filter({ hasText: 'External ID intake is not enabled' })
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('Prepare work materials')

  await notice.getByRole('link', { name: 'Configure the acquisition tool' }).click()
  // 链接必须落到**这个职责**的配置面，而不是工具箱首页——落错地方等于让用户自己
  // 在 20 个工作项里找。
  await page.waitForURL(/\/digital-employees\//)
  const landed = new URL(page.url())
  expect({
    pathname: decodeURIComponent(landed.pathname),
    view: landed.searchParams.get('view'),
    workItem: landed.searchParams.get('workItem'),
  }).toEqual({
    pathname: `/digital-employees/${TYPE_REF}`,
    view: 'toolbox',
    workItem: 'prepare-materials',
  })
  const dutyDialog = page.getByTestId('employee-toolbox-duty-dialog')
  await expect(dutyDialog).toBeVisible()
  await expect(dutyDialog).toContainText('Prepare input materials')
})

test('RFC-319 DE-25: 发起被拒时报错、已 staged 的上传被逐个删干净、草稿还在且重试能真的成功 @nightly', async ({
  page,
}) => {
  const taskName = `Rejected launch ${RUN_TAG}`
  const body = 'This launch is rejected once on purpose, then retried.'
  const conflictMessage = 'rfc319-de25: the platform refused this launch on purpose'
  const uploadsPath = '/api/digital-employee-input-uploads'
  const launchPath = `/api/digital-employees/${minimalEmployeeId}/cases`

  const before = querySqlite<{ n: number }>(
    dbPath(daemon),
    'SELECT count(*) AS n FROM employee_input_uploads',
  )
  // 前提复核：这张表本来是空的，否则下面「删干净了」的断言零预言力。
  expect(before[0]?.n).toBe(0)

  const deleteCalls: Array<{ uploadRef: string; status: number }> = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (
      response.request().method() === 'DELETE' &&
      url.pathname.startsWith(`${uploadsPath}/`) &&
      url.pathname.length > uploadsPath.length + 1
    ) {
      deleteCalls.push({
        uploadRef: decodeURIComponent(url.pathname.slice(uploadsPath.length + 1)),
        status: response.status(),
      })
    }
  })

  // 只拦这一条 pathname，handler 里只有一次 `fulfill`——`docs/dev-gotchas.md` 锁 A。
  await page.route(
    (url) => url.pathname === launchPath,
    async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'employee-case-launch-rejected',
          message: conflictMessage,
        }),
      })
    },
  )

  await primeAuth(page)
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=digital-employee&employeeId=${minimalEmployeeId}`,
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-task-name').fill(taskName)
  await page.getByRole('radio', { name: 'Request and files', exact: true }).click()
  await page.getByLabel('Requirement or problem body').fill(body)
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: 'acceptance.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Acceptance\nThe committed requirement document.\n'),
    },
    {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('temporary analysis notes\n'),
    },
  ])
  await page
    .getByRole('textbox', { name: 'Repository target path' })
    .first()
    .fill('docs/acceptance.md')
  // 第二个文件走「仅作临时材料」：两个落点都要被补偿删除，不是只删入库的那一个。
  await page.getByRole('radio', { name: 'Temporary material', exact: true }).nth(1).click()

  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-launch').click()

  // ① 失败必须以服务端原话呈现出来。只弹一个泛化的「请求失败」而不带这句话，
  //    用户不知道自己该改什么。
  const failure = page.locator('.feedback-stack .notice-banner--error')
  await expect(failure).toHaveCount(1)
  await expect(failure).toContainText(conflictMessage)

  // ② 每个已 staged 的文件都收到一条 DELETE，而且**服务端真的删成了**：
  //    `inputUploadStore.delete` 找不到行会抛 404，所以 200 本身就是「这一行确实
  //    存在过、并且已经不在了」的证明。
  await expect
    .poll(() => deleteCalls.length, { message: '补偿删除没有对每个已上传文件各发一次' })
    .toBe(2)
  expect(deleteCalls.map((call) => call.status)).toEqual([200, 200])
  expect(new Set(deleteCalls.map((call) => call.uploadRef)).size).toBe(2)

  // ③ 再查一次盘：临时上传表必须回到空。断言只到「发过 DELETE」为止的话，
  //    「请求发了但服务端没删」这类失败照样绿，而那些文件会一直占着盘直到 TTL。
  const leftovers = querySqlite<{ id: string; state: string }>(
    dbPath(daemon),
    'SELECT id, state FROM employee_input_uploads',
  )
  expect(leftovers).toEqual([])

  // ④ 草稿还在：回到内容步骤，任务名 / 正文 / 两个文件的落点原样保留。
  //    这一格坏掉时用户要把整张表单重填一遍。
  await page
    .getByTestId('employee-case-summary-content')
    .getByTestId('wizard-summary-edit-2')
    .click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')
  await expect(page.getByTestId('wizard-task-name')).toHaveValue(taskName)
  await expect(page.getByLabel('Requirement or problem body')).toHaveValue(body)
  await expect(page.getByRole('textbox', { name: 'Repository target path' })).toHaveValue(
    'docs/acceptance.md',
  )
  await expect(page.locator('.employee-case-upload-list .card')).toHaveCount(2)

  // ⑤ 摘掉注入后重试必须真的成功。这一步同时证明了②：补偿删除之后重试是**重新
  //    上传**的——若前端复用了已被删掉的 uploadRef，这次 launch 会被服务端以
  //    `employee-upload-not-found` 打回。
  await page.unrouteAll({ behavior: 'wait' })
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-launch').click()
  await page.waitForURL(/\/tasks\/employee-cases\/[0-9A-Z]+$/)
  const caseId = page.url().split('/').at(-1)!

  const claimed = querySqlite<{ original_name: string; state: string; claimed_by_case_id: string }>(
    dbPath(daemon),
    `SELECT original_name, state, claimed_by_case_id
       FROM employee_input_uploads ORDER BY original_name`,
  )
  expect(claimed).toEqual([
    { original_name: 'acceptance.md', state: 'claimed', claimed_by_case_id: caseId },
    { original_name: 'notes.txt', state: 'claimed', claimed_by_case_id: caseId },
  ])

  await forceQuietCase(caseId, 'blocked')
})

test('RFC-319 DE-29: 案例页的事件队列按待处理 / 优先级 / 时间三级排序，关注范围与协作子案例各自成列 @nightly', async ({
  page,
}) => {
  const caseId = await launchCase({ employeeId: panelEmployeeId, name: `Panels ${RUN_TAG}` })
  const childCaseId = await launchCase({
    employeeId: panelEmployeeId,
    name: `Delegated child ${RUN_TAG}`,
  })
  await forceQuietCase(childCaseId, 'blocked')
  // 委托行要挂在一个真实的轮次上（`employee_invocations.parent_round_id` 是外键），
  // 所以先等第一轮真的被排出来，再把案例静置。
  await expect
    .poll(
      () =>
        querySqlite<{ n: number }>(
          dbPath(daemon),
          'SELECT count(*) AS n FROM employee_reaction_rounds WHERE case_id = ?',
          [caseId],
        )[0]?.n ?? 0,
      { intervals: [250], timeout: 60_000, message: '案例始终没有排出第一轮' },
    )
    .toBeGreaterThan(0)
  await forceQuietCase(caseId, 'blocked')

  const [context] = querySqlite<{ id: string; current_revision: number }>(
    dbPath(daemon),
    'SELECT id, current_revision FROM employee_context_records WHERE case_id = ? ORDER BY id LIMIT 1',
    [caseId],
  )
  expect(context).toBeDefined()
  const [round] = querySqlite<{ id: string }>(
    dbPath(daemon),
    'SELECT id FROM employee_reaction_rounds WHERE case_id = ? ORDER BY id LIMIT 1',
    [caseId],
  )
  expect(round).toBeDefined()

  // 清掉发起时那条真实投递（它已被静置成 obsolete，但仍会渲染），让空态断言有意义。
  // 轮次先解绑，避免外键悬挂。
  runSqlite(
    dbPath(daemon),
    `UPDATE employee_reaction_rounds SET inbox_id = NULL WHERE case_id = '${caseId}';
     DELETE FROM employee_case_inbox WHERE case_id = '${caseId}';`,
  )
  const emptied = querySqlite<{ inbox: number; attention: number; channels: number }>(
    dbPath(daemon),
    `SELECT (SELECT count(*) FROM employee_case_inbox WHERE case_id = ?) AS inbox,
            (SELECT count(*) FROM employee_attention_bindings WHERE case_id = ?) AS attention,
            (SELECT count(*) FROM employee_channels WHERE parent_case_id = ?) AS channels`,
    [caseId, caseId, caseId],
  )
  expect(emptied[0]).toEqual({ inbox: 0, attention: 0, channels: 0 })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/employee-cases/${caseId}?tab=activity`)
  // 三个空态先各说各的话。混用一句「暂无数据」时，用户分不清是「没人委托」还是
  // 「没有事件」。
  await expect(page.getByText('The event queue is empty.', { exact: true })).toBeVisible()
  await expect(page.getByText('No watched subjects.', { exact: true })).toBeVisible()
  await expect(page.getByText('No delegated employee work.', { exact: true })).toBeVisible()

  const base = Date.now()
  const rowId = (suffix: string): string => `RFC319DE29-${RUN_TAG}-${suffix}`
  const invocationId = rowId('invocation')
  const inboxRow = (input: {
    suffix: string
    state: 'pending' | 'settled'
    priority: number
    occurredAt: number
    summary: string
  }): string => {
    const id = rowId(input.suffix)
    return `INSERT INTO employee_case_inbox
       (id, case_id, delivery_id, event_id, event_type_id, event_type_revision, source_id,
        source_revision, subject_type, subject_ref, delivery_class, priority, occurred_at,
        summary, payload_artifact_ref, state, round_id, accepted_at, settled_at)
     VALUES ('${id}', '${caseId}', '${id}-delivery', '${id}-event',
             'development.merge-request-updated', 1, 'rfc319-de29', 1, 'merge-request',
             'rfc319/mr/1', 'authoritative', ${input.priority}, ${input.occurredAt},
             '${input.summary}', NULL, '${input.state}', NULL, ${base},
             ${input.state === 'pending' ? 'NULL' : base});`
  }
  runSqlite(
    dbPath(daemon),
    [
      // 已处理但优先级最高：它必须排在所有待处理之后（第一级 = 状态）。
      inboxRow({
        suffix: 'settled',
        state: 'settled',
        priority: 900,
        occurredAt: base + 4_000,
        summary: 'settled-highest-priority',
      }),
      // 待处理、低优先级（第二级 = 优先级）。
      inboxRow({
        suffix: 'low',
        state: 'pending',
        priority: 10,
        occurredAt: base + 3_000,
        summary: 'pending-low-priority',
      }),
      // 同优先级、较早（第三级 = 时间，前端要的是**新的在前**）。
      inboxRow({
        suffix: 'older',
        state: 'pending',
        priority: 500,
        occurredAt: base + 1_000,
        summary: 'pending-high-older',
      }),
      // 同优先级、较新。
      inboxRow({
        suffix: 'newer',
        state: 'pending',
        priority: 500,
        occurredAt: base + 2_000,
        summary: 'pending-high-newer',
      }),
      `INSERT INTO employee_attention_bindings
         (id, case_id, context_id, context_revision, event_type_id, event_type_revision,
          subject_type, subject_ref, desired_identity_key, event_subscription_id, state,
          created_at, updated_at)
       VALUES ('${rowId('attention')}', '${caseId}', '${context!.id}',
               ${context!.current_revision}, 'development.merge-request-updated', 1, 'merge-request',
               'rfc319/mr/watched', 'rfc319-de29-${RUN_TAG}', NULL, 'active', ${base}, ${base});`,
      `INSERT INTO employee_invocations
         (id, idempotency_key, parent_case_id, parent_round_id, target_employee_id,
          target_employee_revision, target_work_scope_ref_json, input_envelope_ref, input_digest,
          completion_contract_ref_json, deadline_at, child_case_id, state, created_at, updated_at)
       VALUES ('${invocationId}', 'rfc319-de29-${RUN_TAG}', '${caseId}', '${round!.id}',
               '${panelEmployeeId}', 1, '{"kind":"repository","repositoryId":"${repositoryId}"}',
               'rfc319-de29-envelope', 'rfc319-de29-digest',
               '{"contractId":"development.delegate-change","resultSchemaId":"development.delegate-change.result.v1","eventTypeRef":{"id":"development.invocation-settled","revision":1},"sourceRef":{"id":"rfc319-de29","revision":1}}',
               ${base + 600_000}, '${childCaseId}', 'waiting', ${base}, ${base});`,
      `INSERT INTO employee_channels
         (id, invocation_id, parent_case_id, child_case_id, correlation_ref,
          result_contract_ref_json, state, created_at, updated_at)
       VALUES ('${rowId('channel')}', '${invocationId}', '${caseId}',
               '${childCaseId}', '${round!.id}',
               '{"contractId":"development.delegate-change","resultSchemaId":"development.delegate-change.result.v1"}',
               'open', ${base}, ${base});`,
    ].join('\n'),
  )
  // `runSqlite` 走 `db.exec()`，多语句脚本里的约束错误不抛异常（`docs/dev-gotchas.md`）。
  // 种完必须回读自证，否则下面全是「空表也成立」的断言。
  const planted = querySqlite<{ inbox: number; attention: number; channels: number }>(
    dbPath(daemon),
    `SELECT (SELECT count(*) FROM employee_case_inbox WHERE case_id = ?) AS inbox,
            (SELECT count(*) FROM employee_attention_bindings WHERE case_id = ?) AS attention,
            (SELECT count(*) FROM employee_channels WHERE parent_case_id = ?) AS channels`,
    [caseId, caseId, caseId],
  )
  expect(planted[0]).toEqual({ inbox: 4, attention: 1, channels: 1 })

  await page.reload()
  const eventQueue = page
    .locator('.employee-node-panel')
    .filter({ hasText: 'What the next reaction will process' })
  // 排序是三级的，而且和后端的 SQL 排序**不一样**（后端 occurredAt 升序、前端降序，
  // `sqliteRuntimeStore.ts:594-598` vs `employee-cases.$caseId.tsx:409-418`）。
  // 任何一级掉了，下面这个顺序就对不上；而顺序就是「下一轮先处理什么」的全部含义。
  await expect(eventQueue.locator('.node-tool-row span').first()).toBeVisible()
  expect(
    await eventQueue
      .locator('.node-tool-row')
      .evaluateAll((rows) => rows.map((row) => row.querySelector('span')?.textContent ?? '')),
  ).toEqual([
    'pending-high-newer',
    'pending-high-older',
    'pending-low-priority',
    'settled-highest-priority',
  ])
  const firstRow = eventQueue.locator('.node-tool-row').first()
  await expect(firstRow.locator('.status-chip')).toHaveText('Pending')
  await expect(firstRow).toContainText('Priority 500')
  await expect(eventQueue.locator('.node-tool-row').last().locator('.status-chip')).toHaveText(
    'Processed',
  )

  const attention = page
    .locator('.employee-node-panel')
    .filter({ hasText: 'What it is watching for' })
  // 关注对象要报出**具体**在等哪个东西；只显示一个「关注中」的 chip，用户无从判断
  // 这个案例还在等什么。
  await expect(attention.locator('.node-tool-row')).toHaveCount(1)
  await expect(attention.locator('.node-tool-row')).toContainText('rfc319/mr/watched')
  await expect(attention.locator('.node-tool-row .status-chip')).toHaveText('Watching')

  const collaboration = page.locator('.employee-node-panel').filter({ hasText: 'Delegated work' })
  await expect(collaboration.locator('.node-tool-row')).toHaveCount(1)
  await expect(collaboration.locator('.node-tool-row')).toContainText(
    'Waiting for delegated result',
  )
  const childLink = collaboration.getByRole('link', { name: 'View delegated task' })
  // 链接必须指向**被委托的子案例**。指到自己或指到父案例，用户就再也进不去那份工作。
  await expect(childLink).toHaveAttribute('href', `/tasks/employee-cases/${childCaseId}`)
  await childLink.click()
  await page.waitForURL((url) => url.pathname === `/tasks/employee-cases/${childCaseId}`)
  await expect(
    page.getByRole('heading', { name: `Delegated child ${RUN_TAG}`, exact: true }),
  ).toBeVisible()
})

test.describe('人工评审移交', () => {
  // 单独一个 `review-doc` stub 的 daemon：理由见文件头第 3 条。
  let reviewDaemon: DaemonHandle
  let reviewEmployeeId = ''
  let reviewCaseId = ''
  let reviewExecutionRef = ''

  test.beforeAll(async () => {
    reviewDaemon = await startDaemon({ stubMode: 'review-doc' })
    const repository = await importFixtureRepository(reviewDaemon)
    const implRef = await builtinAgentRef('development.implement-change', reviewDaemon)
    // 自建的方案编写 Agent：与内置模板唯一的差别是把 `analysis-plan` 声明成
    // `markdown`（内置的是 `path<md>`）。两者同属 `isReviewableBodyKind`，评审节点
    // 都收；换 kind 只是为了让确定性 stub 能产出一份合法方案，被测的是**平台的**
    // 评审移交链路，不是 stub 的本事。
    const planAgent = await api<{ id: string; updatedAt: number }>(
      '/api/agents',
      {
        method: 'POST',
        body: {
          name: `rfc319-de28-plan-writer-${RUN_TAG}`,
          description: 'RFC-319 DE-28 plan writer fixture',
          bodyMd: 'Write the implementation plan for human review.',
          outputs: ['analysis-plan'],
          outputKinds: { 'analysis-plan': 'markdown' },
          frontmatterExtra: {
            digitalEmployeeTemplate: 'implementation-planning',
            executionContracts: [
              {
                contractId: 'development.plan-implementation',
                version: 2,
                outputPort: 'analysis-plan',
                outputKind: 'markdown',
              },
            ],
          },
        },
      },
      reviewDaemon,
    )
    const implTool = await seedPublishedTool(
      {
        workItemRef: 'analyze-implement',
        roleRef: 'primary',
        displayName: `DE-28 implementation ${RUN_TAG}`,
        implementation: { kind: 'agent', agentRef: implRef },
      },
      reviewDaemon,
    )
    const planTool = await seedPublishedTool(
      {
        workItemRef: 'analyze-implement',
        roleRef: 'planning',
        displayName: `DE-28 plan writer ${RUN_TAG}`,
        implementation: {
          kind: 'agent',
          agentRef: { id: planAgent.id, revision: planAgent.updatedAt },
        },
      },
      reviewDaemon,
    )
    const job = await seedPublishedJob(
      `DE-28 reviewed job ${RUN_TAG}`,
      [
        { workItemRef: 'analyze-implement', slotRef: 'default', registrationRef: implTool },
        { workItemRef: 'analyze-implement', slotRef: 'plan', registrationRef: planTool },
      ],
      reviewDaemon,
    )
    reviewEmployeeId = (
      await seedEmployee(`DE-28 employee ${RUN_TAG}`, job, reviewDaemon, repository.id)
    ).id
    reviewCaseId = await launchCase(
      {
        employeeId: reviewEmployeeId,
        name: `Plan review case ${RUN_TAG}`,
        executionOptions: { 'review-implementation-plan': true },
      },
      reviewDaemon,
      repository.id,
    )
  })

  test.afterAll(async () => {
    await reviewDaemon?.stop()
  })

  test('RFC-319 DE-28: 案例等待人工评审时给出「继续人工评审」直达链接，评审提交后案例页当场回流成已批准 @nightly', async ({
    page,
  }) => {
    // 等真实执行链把方案评审推到 waiting——这一段完全没有落库造现场：员工、工具、
    // 岗位、案例、任务、评审轮次全是产品自己排出来的。
    await expect
      .poll(
        async () => {
          const projection = await api<{
            reviewGates?: Array<{ optionRef: string; state: string; executionRef: string | null }>
          }>(`/api/employee-cases/${encodeURIComponent(reviewCaseId)}`, {}, reviewDaemon)
          const gate = projection.reviewGates?.find(
            (candidate) => candidate.optionRef === 'review-implementation-plan',
          )
          if (gate?.state === 'waiting' && gate.executionRef !== null) {
            reviewExecutionRef = gate.executionRef
          }
          return gate?.state ?? 'missing'
        },
        { intervals: [500], timeout: 180_000, message: '方案评审门禁始终没有走到 waiting' },
      )
      .toBe('waiting')
    expect(reviewExecutionRef).not.toBe('')

    await primeAuth(page, reviewDaemon)
    await page.goto(`${reviewDaemon.baseUrl}/tasks/employee-cases/${reviewCaseId}`)

    // 案例页必须**主动**把球交出去：只把状态显示成「正在工作」的话，用户不会知道
    // 这个案例正等着自己看方案，它会一直挂在那里。
    await expect(page.getByText('Next: complete the human review', { exact: true })).toBeVisible()
    const gateCard = page
      .getByTestId('employee-toolbox-responsibility-map')
      .locator('[data-review-option-ref="review-implementation-plan"]')
    await expect(gateCard).toHaveCount(1)
    await expect(gateCard).toHaveAttribute('aria-label', /Awaiting human review/)
    await expect(gateCard).toHaveClass(/employee-toolbox-card--waiting/)

    const handoff = page.getByRole('link', { name: 'Continue human review', exact: true })
    // 链接必须指向**这一轮的执行 Session**。指错任务，用户点进去看到的是别人的方案。
    await expect(handoff).toHaveAttribute('href', `/tasks/${reviewExecutionRef}`)
    await handoff.click()
    await expect(page).toHaveURL(new RegExp(`/tasks/${reviewExecutionRef}(\\?|$)`))

    // 执行页把评审入口摆出来；从这里进评审页并批准。
    await page.locator('[data-task-detail-section-link="node-runs"]').click()
    const reviewJump = page.locator('.node-runs__review-link').first()
    await expect(reviewJump).toBeVisible()
    await reviewJump.click()
    await page.waitForURL(/\/reviews\/[0-9A-Z]+/)
    // 待评审的正是方案编写 Agent 交上来的那份文档；面板里是别的东西就说明评审节点
    // 接错了上游端口。
    await expect(page.getByText('Order status design')).toBeVisible()
    const approve = page.getByRole('button', { name: 'Approve', exact: true })
    await expect(approve).toBeEnabled()
    const decision = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/decision'),
    )
    await approve.click()
    expect((await decision).status()).toBe(200)

    // 回流：批准之后案例页当场不再要人，门禁卡变成已批准。这一格不动的话，用户
    // 批完方案回到任务上，看到的仍然是「等你评审」——他会以为自己的批准没生效。
    await page.goto(`${reviewDaemon.baseUrl}/tasks/employee-cases/${reviewCaseId}`)
    await expect(gateCard).toHaveAttribute('aria-label', /Approved; implementation continued/, {
      timeout: 60_000,
    })
    await expect(gateCard).toHaveClass(/employee-toolbox-card--completed/)
    await expect(page.getByText('Next: complete the human review', { exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('link', { name: 'Continue human review', exact: true }),
    ).toHaveCount(0)
  })
})

test('RFC-319 DE-30: 案例走到终态后显示已合入 / 已结束并停止轮询，非终态案例仍在轮询 @nightly', async ({
  page,
}) => {
  const mergedCaseId = await launchCase({
    employeeId: pollingEmployeeId,
    name: `Merged case ${RUN_TAG}`,
  })
  const closedCaseId = await launchCase({
    employeeId: pollingEmployeeId,
    name: `Closed case ${RUN_TAG}`,
  })
  await forceQuietCase(closedCaseId, 'blocked')
  await forceQuietCase(mergedCaseId, 'blocked')

  let projectionGets = 0
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).pathname === `/api/employee-cases/${mergedCaseId}`
    ) {
      projectionGets += 1
    }
  })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/employee-cases/${mergedCaseId}`)
  const statusChip = page.locator('.page__meta .status-chip')
  await expect(statusChip).toHaveText('Needs attention')

  // 对照组：同一个页面上，非终态案例确实每 3 秒重取一次
  // （`employee-cases.$caseId.tsx:366`）。没有这一段，下面「计数没涨」就成了恒真
  // ——一个从来不轮询的页面同样满足它。
  const pollingStartedAt = Date.now()
  await expect
    .poll(() => projectionGets, {
      intervals: [200],
      timeout: 30_000,
      message: '非终态案例没有在轮询，本用例的「停止轮询」断言此刻零预言力',
    })
    .toBeGreaterThanOrEqual(3)
  const threePollsMs = Date.now() - pollingStartedAt

  await api(`/api/employee-cases/${encodeURIComponent(mergedCaseId)}/terminate`, {
    method: 'POST',
    body: { terminalKind: 'merged' },
  })
  // 页面自己把终态轮回来（没有 reload）——这一跳同时证明了对照组的轮询是活的。
  await expect(statusChip).toHaveText('Merged', { timeout: 30_000 })
  await expect(statusChip).toHaveClass(/status-chip--success/)
  await expect(page.getByText('MR merged', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Resolved, continue work', exact: true }),
  ).toHaveCount(0)
  const terminalAt = Date.now()
  const countAtTerminal = projectionGets

  // 观察窗用「实测三轮时长」当尺子，而不是拍一个固定秒数：机器慢的时候窗口跟着变长。
  await expect
    .poll(() => Date.now() - terminalAt, {
      intervals: [250],
      timeout: threePollsMs * 3 + 10_000,
    })
    .toBeGreaterThanOrEqual(threePollsMs)
  // 终态之后一次都不许再请求。只断言界面显示 Merged 锁不住轮询——那种退化下页面会
  // 一直对一个再也不会变的案例每 3 秒打一次接口，浏览器开一天就是上万次无效请求。
  expect(projectionGets).toBe(countAtTerminal)

  // 另一半终态：非 merged 的终结走中性色的「已结束」。两种终态显示成同一句话时，
  // 用户分不清 MR 到底进没进主干。
  await api(`/api/employee-cases/${encodeURIComponent(closedCaseId)}/terminate`, {
    method: 'POST',
    body: { terminalKind: 'closed' },
  })
  await page.goto(`${daemon.baseUrl}/tasks/employee-cases/${closedCaseId}`)
  await expect(statusChip).toHaveText('Finished')
  await expect(statusChip).toHaveClass(/status-chip--neutral/)
  await expect(page.getByText('Work finished', { exact: true })).toBeVisible()
})

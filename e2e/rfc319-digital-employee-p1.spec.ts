// RFC-319 —— 数字员工域 5 条 P1 用户面能力的浏览器兜底。
//
// 这 5 条在 `architecture/e2e-capability-ledger.json` 里是 `tier: pr` 的 gap：
// DE-07（停用已发布工具 / 删除工具草稿）、DE-17（创建员工时选仓库 / 仓库组作用域）、
// DE-18（编辑已存在员工时的回填与保存）、DE-27（案例阻塞后的「已处理，继续工作」）、
// DE-X1（发起任务时的「先评审方案 / 直接实现」开关及其不可用门控）。
//
// 逐条依据见 `design/RFC-319-user-facing-e2e-coverage-hardening/findings.md` 的
// 同名小节。**不重复覆盖**已被锁住的行为：员工「配置职责」泳道里的 Adapter 覆盖 /
// 恢复由 `e2e/rfc310-digital-employee-journey.spec.ts` 的
// 「RFC-323 DE-18/39: employee Adapter override and restore live in the lane while
// retired URLs redirect」逐字锁定，本文件只补它没碰的那一半——员工卡片「编辑」
// 对话框的回填往返（`packages/frontend/src/routes/digital-employees.$typeRef.tsx:3927-3945`）。
//
// 夹具一律走产品自己的 HTTP API；唯一的例外是 DE-27 的 blocked 现场——平台没有任何
// 用户面入口能把案例推进 blocked（`packages/backend/src/modules/digital-employee/application/runtimeService.ts:2199`
// / `:2269` / `:2626` 三处都是失败路径的内部转移），`development` stub 也没有产出
// blocked 的分支（`packages/system-mocks/src/runtime/mode-development.ts:172-272` 只有
// 成功分支），所以那一条用 `runSqlite` 落库造现场，并在注释里写清它锁的是哪一段。

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
 * 与被测行为无关的失败。这里跟 `e2e/rfc310-zero-config-onboarding.spec.ts:22-27`
 * 用同一条来源。
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

interface ExactRef {
  id: string
  revision: number
}

interface ToolRow {
  id: string
  content: { displayName: string }
  publishedRevision: number | null
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
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let repositoryId = ''
let repositoryUrl = ''
let repositoryGroupId = ''
let repositoryGroupName = ''
let implAgentRef: ExactRef = { id: '', revision: 0 }
let implToolRef: ExactRef = { id: '', revision: 0 }
let planToolRef: ExactRef = { id: '', revision: 0 }
/** 只绑了「实现变更」的岗位模板：由它派生的员工**没有**方案编写工具。 */
let jobWithoutPlanRef: ExactRef = { id: '', revision: 0 }
let jobWithoutPlanName = ''
/** 额外绑了 `analyze-implement/plan` 的岗位模板：评审开关对它是可用的。 */
let jobWithPlanRef: ExactRef = { id: '', revision: 0 }
let employeeWithoutPlanId = ''
let employeeWithPlanId = ''
let employeeWithPlanName = ''

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${daemon.token}`,
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
 * 作用域选择器是 `searchable` 的（`digital-employees.$typeRef.tsx:4256`），打开后
 * 焦点落在搜索框上；先用搜索框收窄再点行，避免 portaled listbox 滚动时命中过期坐标。
 */
async function pickSelectOption(
  page: Page,
  trigger: Locator,
  query: string,
  optionName: string | RegExp,
): Promise<void> {
  await trigger.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  const search = listbox.getByRole('textbox').first()
  const option = page.getByRole('option', { name: optionName })
  if ((await search.count()) === 0) {
    await expect(option).toBeVisible()
    await option.click()
    await expect(listbox).toHaveCount(0)
    return
  }
  await search.fill(query)
  await expect(option).toBeVisible()
  // searchable 的 Select 把焦点放在搜索框上；WebKit 下 portaled listbox 还在滚动时
  // 直接点行会命中过期坐标。走组件自己的键盘契约，并先确认高亮行就是要选的那一行
  // （同 `e2e/rfc310-zero-config-onboarding.spec.ts:45-58`）。
  const optionId = await option.getAttribute('id')
  expect(optionId).not.toBeNull()
  await expect(listbox).toHaveAttribute('aria-activedescendant', optionId!)
  await page.keyboard.press('Enter')
  await expect(listbox).toHaveCount(0)
}

/**
 * 岗位模板下拉。
 *
 * 不能用 `getByRole('combobox', { name: 'Job template' })`：这个 Select 没有传
 * `ariaLabel`，可访问名来自 `aria-labelledby` 指向的**当前值**
 * （`packages/frontend/src/components/Select.tsx:430` 与 `:443`）。新建时值是占位文案
 * 「Choose a job template」，子串恰好命中；编辑时值已经是岗位名，同一个选择器就
 * 找不到了。改用字段标签定位，两种状态下都稳。
 */
function jobTemplateSelect(scope: Locator): Locator {
  return scope.locator('label.form-field').filter({ hasText: 'Job template' }).getByRole('combobox')
}

async function seedTool(input: {
  workItemRef: string
  roleRef: string
  displayName: string
  agentRef: ExactRef
  publish: boolean
}): Promise<{ id: string; ref: ExactRef | null }> {
  const draft = await api<{ id: string; validationReceipt: { status: string } }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(input.workItemRef)}/tools`,
    {
      method: 'POST',
      body: {
        displayName: input.displayName,
        description: 'RFC-319 P1 browser fixture',
        roleRef: input.roleRef,
        implementation: { kind: 'agent', agentRef: input.agentRef },
      },
    },
  )
  if (!input.publish) return { id: draft.id, ref: null }
  const published = await api<{ ref: ExactRef }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(input.workItemRef)}/tools/${encodeURIComponent(draft.id)}/publish`,
    { method: 'POST', body: {} },
  )
  return { id: draft.id, ref: published.ref }
}

async function seedPublishedJob(
  name: string,
  bindings: ReadonlyArray<{ workItemRef: string; slotRef: string; registrationRef: ExactRef }>,
): Promise<ExactRef> {
  const draft = await api<{ id: string }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
    {
      method: 'POST',
      body: {
        name,
        description: 'RFC-319 P1 browser fixture',
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
  return published.ref
}

async function listTools(workItemRef: string): Promise<ToolRow[]> {
  const listed = await api<{ items: ToolRow[] }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(workItemRef)}/tools`,
  )
  return listed.items
}

async function getEmployee(employeeId: string): Promise<EmployeeRow> {
  return api<EmployeeRow>(`/api/digital-employees/${encodeURIComponent(employeeId)}`)
}

/**
 * 把一个真实案例静置成稳定的 `blocked` 现场。
 *
 * 为什么要落库：用户面没有任何入口能制造阻塞（见文件头注释），而 OS worker 每秒
 * 一跳（`packages/backend/src/services/daemonCadence.ts:57`），单发一条 UPDATE 会被
 * 下一跳改写。这里把 inbox / round / outbox 一起收干净、把续作指针清空，
 * `planOneReaction` 因此不会再碰它（`runtimeService.ts:2258-2260` 只看 active|waiting，
 * `:2299` 无 inbox 无续作即跳过），恢复之后案例也不会立刻二次阻塞。
 *
 * 本条只锁「界面这一段」——blocked 页面长什么样、按钮打到哪个端点、端点回给用户
 * 什么。服务端「谁有资格把案例判成 blocked」不在本条覆盖范围内。
 */
async function forceBlockedCase(caseId: string, blockReason: string): Promise<void> {
  const dbPath = join(daemon.home, 'db.sqlite')
  const escapedReason = blockReason.replaceAll("'", "''")
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const now = Date.now()
    runSqlite(
      dbPath,
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
              block_reason = '${escapedReason}',
              active_round_id = NULL,
              current_work_item_ref = NULL,
              revision = revision + 1,
              updated_at = ${now}
        WHERE id = '${caseId}';`,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const [row] = querySqlite<{ state: string; active_round_id: string | null; pending: number }>(
      dbPath,
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
  throw new Error(`case ${caseId} never settled into a stable blocked fixture`)
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'development' })

  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-de-'))
  writeFileSync(join(repoDir, 'README.md'), '# RFC-319 digital employee P1 fixture\n')
  initGitRepo(repoDir)
  const remote = repoRemoteUrl(repoDir)
  let batch = await api<{ batchId: string; state: string; rows: Array<{ status: string }> }>(
    '/api/cached-repos/batch-import',
    { method: 'POST', body: { urls: [remote] } },
  )
  const importDeadline = Date.now() + 60_000
  while (batch.state !== 'completed' && Date.now() < importDeadline) {
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
  if (repository === undefined) throw new Error('fixture repository is missing after import')
  repositoryId = repository.id
  repositoryUrl = repository.urlRedacted ?? repository.id

  repositoryGroupName = `RFC-319 scope group ${RUN_TAG}`
  const group = await api<{ id: string }>('/api/repo-groups', {
    method: 'POST',
    body: {
      name: repositoryGroupName,
      description: '',
      nodes: [{ path: '', attachment: { kind: 'repo', cachedRepoId: repositoryId } }],
    },
  })
  repositoryGroupId = group.id

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
  const implTool = await seedTool({
    workItemRef: 'analyze-implement',
    roleRef: 'primary',
    displayName: `Implementation executor ${RUN_TAG}`,
    agentRef: implAgentRef,
    publish: true,
  })
  implToolRef = implTool.ref!
  const planTool = await seedTool({
    workItemRef: 'analyze-implement',
    roleRef: 'planning',
    displayName: `Plan writer ${RUN_TAG}`,
    agentRef: findAgent('development.plan-implementation'),
    publish: true,
  })
  planToolRef = planTool.ref!

  jobWithoutPlanName = `Implement only ${RUN_TAG}`
  jobWithoutPlanRef = await seedPublishedJob(jobWithoutPlanName, [
    { workItemRef: 'analyze-implement', slotRef: 'default', registrationRef: implToolRef },
  ])
  jobWithPlanRef = await seedPublishedJob(`Implement with plan review ${RUN_TAG}`, [
    { workItemRef: 'analyze-implement', slotRef: 'default', registrationRef: implToolRef },
    { workItemRef: 'analyze-implement', slotRef: 'plan', registrationRef: planToolRef },
  ])

  const withoutPlan = await api<EmployeeRow>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`,
    {
      method: 'POST',
      body: {
        name: `Plan-less employee ${RUN_TAG}`,
        jobTemplateRef: jobWithoutPlanRef,
        workScope: { kind: 'repository', repositoryId },
        toolOverrides: [],
        adapterOverrides: [],
        collaborationOverrides: [],
      },
    },
  )
  employeeWithoutPlanId = withoutPlan.id
  employeeWithPlanName = `Plan-review employee ${RUN_TAG}`
  const withPlan = await api<EmployeeRow>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`,
    {
      method: 'POST',
      body: {
        name: employeeWithPlanName,
        jobTemplateRef: jobWithPlanRef,
        workScope: { kind: 'repository', repositoryId },
        toolOverrides: [],
        adapterOverrides: [],
        collaborationOverrides: [],
      },
    },
  )
  employeeWithPlanId = withPlan.id
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('DE-07：对已发布工具点「停用」、对草稿点「删除草稿」，二次确认后它们从职责工具列表里消失且刷新后不回来', async ({
  page,
}) => {
  const publishedName = `Retirable published tool ${RUN_TAG}`
  const draftName = `Retirable draft tool ${RUN_TAG}`
  const published = await seedTool({
    workItemRef: 'analyze-implement',
    roleRef: 'primary',
    displayName: publishedName,
    agentRef: implAgentRef,
    publish: false,
  })
  // 先建后发，拿到一条 publishedRevision !== null 的行；UI 对它给的是「停用」。
  await api(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/analyze-implement/tools/${encodeURIComponent(published.id)}/publish`,
    { method: 'POST', body: {} },
  )
  // 指向不存在的 Agent ⇒ 契约校验不过 ⇒ 永远停在草稿态，UI 对它给的是「删除草稿」。
  const draft = await seedTool({
    workItemRef: 'analyze-implement',
    roleRef: 'primary',
    displayName: draftName,
    agentRef: { id: `missing:${RUN_TAG}`, revision: 1 },
    publish: false,
  })

  await primeAuth(page)
  await page.goto(
    `${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=toolbox&workItem=analyze-implement`,
  )
  const toolbox = page.getByTestId('employee-node-toolbox')
  const publishedRow = toolbox.locator('.node-tool-row').filter({ hasText: publishedName })
  const draftRow = toolbox.locator('.node-tool-row').filter({ hasText: draftName })
  await expect(publishedRow).toHaveCount(1)
  await expect(draftRow).toHaveCount(1)

  // 两个按钮文案不同不是措辞洁癖：用户对「停用一个已经在岗位模板里被引用的工具」和
  // 「丢掉一份还没发布的草稿」的风险预期完全不同。若它退化成同一句话，用户会以为
  // 自己只是删了张草稿，实际停掉的是线上正在用的工具。
  await expect(publishedRow.getByRole('button', { name: 'Retire', exact: true })).toBeVisible()
  await expect(draftRow.getByRole('button', { name: 'Delete draft', exact: true })).toBeVisible()

  // 第一次点击只是「上膛」。这一格若失效，用户在职责列表里手滑一次就少一个工具，
  // 而工具是没有回收站的。
  await publishedRow.getByRole('button', { name: 'Retire', exact: true }).click()
  await expect(publishedRow.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible()
  await expect(publishedRow.getByRole('button', { name: 'Retire', exact: true })).toHaveCount(0)

  const retirePublished = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/tools/${published.id}/retire`),
  )
  await publishedRow.getByRole('button', { name: 'Confirm', exact: true }).click()
  expect((await retirePublished).status()).toBe(200)
  // 确认之后行必须当场消失。若列表不失效，用户会以为「停用没生效」而反复点，
  // 或者继续把一个已经停用的工具绑进新的岗位模板。
  await expect(publishedRow).toHaveCount(0)

  await draftRow.getByRole('button', { name: 'Delete draft', exact: true }).click()
  const retireDraft = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/tools/${draft.id}/retire`),
  )
  await draftRow.getByRole('button', { name: 'Confirm', exact: true }).click()
  expect((await retireDraft).status()).toBe(200)
  await expect(draftRow).toHaveCount(0)

  // 刷新后仍然不在：区分「前端把行藏了」和「服务端真的停用了」。前者会让用户在
  // 下一次进页面时看见两条以为已经删掉的工具，并且它们仍然可被选进岗位模板。
  await page.reload()
  await expect(page.getByTestId('employee-node-toolbox')).toBeVisible()
  await expect(page.locator('.node-tool-row').filter({ hasText: publishedName })).toHaveCount(0)
  await expect(page.locator('.node-tool-row').filter({ hasText: draftName })).toHaveCount(0)

  const remaining = await listTools('analyze-implement')
  expect(remaining.map((tool) => tool.content.displayName)).not.toContain(publishedName)
  expect(remaining.map((tool) => tool.content.displayName)).not.toContain(draftName)
  // 停用是逐条的：同一个工作项下其它工具不能被顺手带走，否则整套岗位模板会在
  // 用户不知情的情况下失去默认工具。
  expect(remaining.map((tool) => tool.id)).toContain(implToolRef.id)
})

test('DE-17：作用域选择器里选仓库和选仓库组，分别落成 repository 与 repository-group 两种 workScope', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=employees`)

  const repositoryScopedName = `Repository scoped ${RUN_TAG}`
  await page.getByRole('button', { name: 'Create employee', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Create digital employee' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Employee name').fill(repositoryScopedName)
  await pickSelectOption(page, jobTemplateSelect(dialog), jobWithoutPlanName, jobWithoutPlanName)
  // 三类选项（task / 每个仓库 / 每个仓库组）挤在同一个 Select 里，靠 `group:` 前缀
  // 分流（digital-employees.$typeRef.tsx:4061-4080）。分流错了不会报错，只会把员工
  // 静默绑到错误的代码库集合上——它之后每一次自动接活都在错的仓库里改代码。
  await pickSelectOption(
    page,
    dialog.getByTestId('employee-scope-picker'),
    repositoryUrl,
    repositoryUrl,
  )
  const repositoryCreate = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/digital-employee-types\/[^/]+\/employees$/.test(new URL(response.url()).pathname),
  )
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  const repositoryResponse = await repositoryCreate
  expect(repositoryResponse.status()).toBe(201)
  expect(repositoryResponse.request().postDataJSON()).toMatchObject({
    name: repositoryScopedName,
    workScope: { kind: 'repository', repositoryId },
  })
  await expect(dialog).toHaveCount(0)

  const groupScopedName = `Group scoped ${RUN_TAG}`
  await page.getByRole('button', { name: 'Create employee', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Create digital employee' })
  await dialog.getByLabel('Employee name').fill(groupScopedName)
  await pickSelectOption(page, jobTemplateSelect(dialog), jobWithoutPlanName, jobWithoutPlanName)
  await pickSelectOption(
    page,
    dialog.getByTestId('employee-scope-picker'),
    repositoryGroupName,
    new RegExp(`^${repositoryGroupName}`),
  )
  const groupCreate = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/digital-employee-types\/[^/]+\/employees$/.test(new URL(response.url()).pathname),
  )
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  const groupResponse = await groupCreate
  expect(groupResponse.status()).toBe(201)
  // 仓库组那一端必须解成 repositoryGroupId 而不是被当成 repositoryId：一旦串了，
  // 用户以为员工负责整组仓库，实际它只会去看一个根本不存在的仓库。
  expect(groupResponse.request().postDataJSON()).toMatchObject({
    name: groupScopedName,
    workScope: { kind: 'repository-group', repositoryGroupId },
  })
  await expect(dialog).toHaveCount(0)

  const employees = await api<{ items: EmployeeRow[] }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`,
  )
  const repositoryScoped = employees.items.find((row) => row.name === repositoryScopedName)
  const groupScoped = employees.items.find((row) => row.name === groupScopedName)
  // 落库的形态才是自动接活时真正被读的那份；只断言请求体会漏掉「服务端把它改写了」
  // 这一类失败，用户看到的仍然是自己选的那个仓库，实际跑在别处。
  expect(repositoryScoped?.configuration.workScope).toEqual({ kind: 'repository', repositoryId })
  expect(groupScoped?.configuration.workScope).toEqual({
    kind: 'repository-group',
    repositoryGroupId,
  })

  // 两张卡片必须同时在列表上：作用域不同的员工被合并 / 覆盖，用户就再也找不回
  // 其中一个。
  await expect(
    page.locator('.employee-summary-card--employee').filter({ hasText: repositoryScopedName }),
  ).toHaveCount(1)
  await expect(
    page.locator('.employee-summary-card--employee').filter({ hasText: groupScopedName }),
  ).toHaveCount(1)
})

test('DE-18：员工卡片「编辑」回填当前岗位与作用域，只改名字保存后作用域与岗位逐字段不变、revision 递增', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_PATH}?view=employees`)

  const before = await getEmployee(employeeWithoutPlanId)
  const card = page.locator('.employee-summary-card--employee').filter({ hasText: before.name })
  await expect(card).toHaveCount(1)
  await card.getByRole('button', { name: 'Edit', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Edit digital employee' })
  await expect(dialog).toBeVisible()
  // 回填是一次 workScope → scopeKind + scopeValues 的拆解再组装，只存在于前端
  // （digital-employees.$typeRef.tsx:3927-3945 与 :4061-4066）。拆错时对话框会显示
  // 「任务启动时指定仓库」这个默认值，用户按下保存就把员工的仓库作用域悄悄抹掉了。
  await expect(dialog.getByLabel('Employee name')).toHaveValue(before.name)
  await expect(jobTemplateSelect(dialog)).toContainText(jobWithoutPlanName)
  await expect(dialog.getByTestId('employee-scope-picker')).toContainText(repositoryUrl)
  await expect(dialog.getByTestId('employee-scope-picker')).not.toContainText(
    'Choose repository when starting a task',
  )

  const renamed = `${before.name} renamed`
  await dialog.getByLabel('Employee name').fill(renamed)
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/digital-employees/${employeeWithoutPlanId}`,
  )
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const savedResponse = await saved
  expect(savedResponse.status()).toBe(200)
  // 只改了名字的保存必须原样带回其余字段。少带一个字段就是一次静默的配置丢失：
  // 用户改个名字，员工却从「只管这个仓库」变成「每次任务再挑仓库」。
  expect(savedResponse.request().postDataJSON()).toMatchObject({
    name: renamed,
    jobTemplateRef: before.configuration.jobTemplateRef,
    workScope: before.configuration.workScope,
  })
  await expect(dialog).toHaveCount(0)

  const after = await getEmployee(employeeWithoutPlanId)
  expect(after.configuration.displayName).toBe(renamed)
  expect(after.configuration.workScope).toEqual(before.configuration.workScope)
  expect(after.configuration.jobTemplateRef).toEqual(before.configuration.jobTemplateRef)
  // revision 必须往前走一格：不递增意味着这次编辑没有生成新的冻结版本，
  // 已在运行的案例和新任务会读到互相矛盾的两份配置。
  expect(after.revision).toBe(before.revision + 1)

  // 列表当场跟着改名。不刷新的话用户会以为保存失败并重复提交。
  await expect(
    page.locator('.employee-summary-card--employee').filter({ hasText: renamed }),
  ).toHaveCount(1)
})

test('DE-X1：任务向导把「先评审方案」打开后随 launch 请求上行，且案例真的长出人工评审门禁', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=digital-employee&employeeId=${employeeWithPlanId}`,
  )
  // 从员工卡片的「创建任务」进来时向导直接落在空间步骤
  // （`packages/frontend/src/routes/tasks.new.tsx:274-286`）。它要是退回选人步骤，
  // 用户每次都得再挑一遍刚点过的那个员工。
  await expect(page.getByTestId('stepper-step-space')).toHaveAttribute('aria-current', 'step')
  // 仓库作用域员工的目标仓库是冻结的：可改的话用户会把任务发到员工不负责的仓库。
  await expect(page.getByTestId('repo-source-recent-urls-0')).toBeDisabled()
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')

  const reviewToggle = page.getByTestId('employee-execution-option-review-implementation-plan')
  const implementDirectly = page.getByTestId(
    'employee-execution-option-review-implementation-plan-disabled',
  )
  const reviewFirst = page.getByTestId(
    'employee-execution-option-review-implementation-plan-enabled',
  )
  await expect(reviewToggle).toBeVisible()
  // 默认必须是「直接实现」。默认值悄悄翻面 = 所有任务都停在等人评审上，
  // 用户会以为数字员工罢工了。
  await expect(implementDirectly).toHaveAttribute('aria-checked', 'true')
  await expect(reviewFirst).toBeEnabled()

  await page.getByTestId('wizard-task-name').fill(`Plan review task ${RUN_TAG}`)
  await page
    .getByLabel('Requirement or problem body')
    .fill('Change the README headline and explain the plan first.')
  await reviewFirst.click()
  await expect(reviewFirst).toHaveAttribute('aria-checked', 'true')

  const launchRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /\/api\/digital-employees\/[^/]+\/cases$/.test(new URL(request.url()).pathname),
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-launch').click()
  const launched = await launchRequest
  // 这个开关是产品对外承诺的**发起时**人工控制点。它不随请求上行，用户就会以为
  // 自己开了评审，实际方案直奔实现、代码已经改完才发现没人看过。
  expect(launched.postDataJSON()).toMatchObject({
    executionOptions: { 'review-implementation-plan': true },
  })

  await page.waitForURL(/\/tasks\/employee-cases\/[0-9A-Z]+$/)
  const caseId = page.url().split('/').at(-1)!
  const runtimeMap = page.getByTestId('employee-toolbox-responsibility-map')
  await expect(runtimeMap).toBeVisible()
  // 案例页上必须出现那张评审门禁卡。请求体对了、冻结闭包却没带上它，等于开关
  // 在服务端被吞掉——用户在任务详情里看不到任何「等我评审」的位置。
  await expect(
    runtimeMap.locator('[data-review-option-ref="review-implementation-plan"]'),
  ).toHaveCount(1)
  await expect(runtimeMap).toContainText('Human plan review')

  // 案例已经开始跑；把它收干净，别让重试循环拖住同一份 spec 里后面的用例。
  await forceBlockedCase(caseId, 'rfc319-de-x1-fixture: settled after asserting the review gate')
})

test('DE-X1：员工没有绑定方案编写工具时，「先评审方案」不可选并给出原因', async ({ page }) => {
  await primeAuth(page)
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=digital-employee&employeeId=${employeeWithoutPlanId}`,
  )
  await expect(page.getByTestId('stepper-step-space')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')

  const reviewFirst = page.getByTestId(
    'employee-execution-option-review-implementation-plan-enabled',
  )
  // 缺执行器却还让人点得动，用户会带着「已开评审」的预期发起任务，然后要么
  // 直接失败、要么静默按不评审跑完——两种都比一开始就点不动更糟。
  await expect(reviewFirst).toBeDisabled()
  await expect(reviewFirst).toHaveAttribute(
    'title',
    'This employee lacks the executor required by this option',
  )
  await expect(
    page.getByTestId('employee-execution-option-review-implementation-plan-disabled'),
  ).toHaveAttribute('aria-checked', 'true')
  // 光禁用不解释，用户不知道要去哪儿修；这条 banner 是唯一告诉他「先给对应工作项
  // 绑一个 Agent」的地方。
  await expect(page.getByText('Not supported by this employee')).toBeVisible()
})

test('DE-27：案例阻塞后页头给出「已处理，继续工作」，点击后案例离开阻塞态', async ({ page }) => {
  const launched = await api<{ case: { id: string } }>(
    `/api/digital-employees/${encodeURIComponent(employeeWithoutPlanId)}/cases`,
    {
      method: 'POST',
      body: {
        name: `Blocked recovery case ${RUN_TAG}`,
        kind: 'body',
        target: { repositoryId },
        body: 'Fixture case for the blocked-recovery browser contract.',
        externalId: null,
        uploads: [],
        executionOptions: {},
        idempotencyKey: `rfc319-de27-${RUN_TAG}`,
      },
    },
  )
  const caseId = launched.case.id
  const blockReason = 'rfc319-de27-fixture: the employee stopped and asked for a human'
  await forceBlockedCase(caseId, blockReason)
  const blocked = await api<{ case: { state: string; revision: number } }>(
    `/api/employee-cases/${encodeURIComponent(caseId)}`,
  )
  expect(blocked.case.state).toBe('blocked')

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/employee-cases/${caseId}`)

  // 阻塞必须一眼可辨。状态还显示成「正在工作」的话，用户根本不会来处理，
  // 案例会一直停在那里等一个永远不会发生的自动继续。
  const statusChip = page.locator('.page__meta .status-chip')
  await expect(statusChip).toHaveText('Needs attention')
  // 危险色是「这条要你亲自处理」的唯一视觉信号；退化成中性色就淹没在页面里了。
  await expect(statusChip).toHaveClass(/status-chip--danger/)
  await expect(page.getByText('Next: resolve the blocker', { exact: true })).toBeVisible()
  // 阻塞原因原样呈现：只说「被阻塞了」而不说为什么，用户无从判断自己该做什么。
  await expect(page.getByText(blockReason, { exact: true })).toBeVisible()

  const resumeButton = page.getByRole('button', { name: 'Resolved, continue work', exact: true })
  await expect(resumeButton).toBeVisible()

  const resumed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/employee-cases/${caseId}/resume`,
  )
  await resumeButton.click()
  const resumedResponse = await resumed
  expect(resumedResponse.status()).toBe(200)
  // 端点回的就是用户点完之后该看到的那份投影。它还停在 blocked，说明按钮点了等于
  // 没点——用户会一直点下去，而案例永远不动。
  const projection = (await resumedResponse.json()) as {
    case: { state: string; revision: number; blockReason: string | null }
  }
  expect(projection.case.state).toBe('active')
  expect(projection.case.blockReason).toBeNull()
  expect(projection.case.revision).toBeGreaterThan(blocked.case.revision)

  // 页面必须跟着回到「正在工作」，并且恢复按钮消失。按钮还在 = 用户不知道自己
  // 已经处理过了，会重复点击（第二次会撞上 409）。
  await expect(statusChip).toHaveText('Working')
  await expect(statusChip).toHaveClass(/status-chip--success/)
  await expect(resumeButton).toHaveCount(0)
})

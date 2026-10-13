// RFC-372 complete product journey: real daemon, persistence, browser and TaskEngine.
// Only the model CLI is deterministic. No API response or application state is stubbed.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKFLOW_SCHEMA_VERSION } from '../packages/shared/src/schemas/workflow'
import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(300_000)
const retainedHome = process.env.RFC372_ACCEPTANCE_HOME
let daemon: DaemonHandle
let fixtureRoot: string
let runtimeLog: string
const directions = ['业务范围', '数据一致性', '体验与验收']
const guidance = '先确认预约范围，再深入冲突处理；最终输出可实施的设计文档。'

interface Question {
  id: string
  title: string
  mindmap: { categoryPath: string[]; parentQuestionId?: string; requestId?: string }
}
interface Round {
  intermediaryNodeRunId: string
  iteration: number
  kind: 'self' | 'cross'
  status: string
  questions: Question[]
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  expect(response.ok, `${path}: ${response.status} ${text}`).toBe(true)
  return text ? (JSON.parse(text) as T) : (null as T)
}
async function waitRound(taskId: string, kind: Round['kind']): Promise<Round> {
  let selected: Round | undefined
  await expect
    .poll(
      async () => {
        selected = (await api<Round[]>(`/api/clarify?status=awaiting_human&taskId=${taskId}`)).find(
          (row) => row.kind === kind,
        )
        return !!selected
      },
      { timeout: 90_000 },
    )
    .toBe(true)
  return api(`/api/clarify/${selected!.intermediaryNodeRunId}`)
}
const detail = (page: Page) => page.locator('.mindmap-workspace__detail')
async function select(page: Page, title: string) {
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape')
  await page
    .getByRole('treeitem', { name: new RegExp(title) })
    .or(page.getByRole('option', { name: new RegExp(title) }))
    .first()
    .click()
  await expect(detail(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
  if (await page.getByRole('dialog').isVisible())
    await page.getByRole('button', { name: 'Open in focused answers' }).click()
}
async function answer(page: Page, title: string, options: string[], custom?: string) {
  await select(page, title)
  for (const option of options)
    await detail(page).getByLabel(option, { exact: false }).first().check()
  if (custom) {
    await page.getByTestId('clarify-custom-checkbox').check()
    await page.getByTestId('clarify-custom-textarea').fill(custom)
  }
  await page.getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
}
async function followup(page: Page, hint: string, title: string) {
  const deepen = page.getByRole('button', { name: 'Deepen this question', exact: true })
  if ((await deepen.getAttribute('aria-expanded')) !== 'true') await deepen.click()
  await detail(page).getByRole('textbox').last().fill(hint)
  await page.getByRole('button', { name: 'Ask follow-up', exact: true }).click()
  await expect(
    page
      .getByRole('treeitem', { name: new RegExp(title) })
      .or(page.getByRole('option', { name: new RegExp(title) }))
      .first(),
  ).toBeVisible({
    timeout: 90_000,
  })
}
async function stopRound(page: Page, nodeRunId: string) {
  await expect(page.getByText('This round is reviewed and ready to submit.')).toBeVisible()
  const response = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' && res.url().endsWith(`/api/clarify/${nodeRunId}/answers`),
  )
  await page.getByTestId('clarify-submit-stop').click()
  await page.getByTestId('clarify-stop-confirm').click()
  const submitted = await response
  expect(submitted.ok()).toBe(true)
  const payload = submitted.request().postDataJSON()
  expect(payload.questionSetKey).toMatch(/^v1:/)
  expect(
    payload.answers.every((value: { confirmedBasis?: string }) =>
      value.confirmedBasis?.startsWith('v1:'),
    ),
  ).toBe(true)
}
function runtimeEvents(): { kind: string; request?: { userRequest: string; branch: unknown[] } }[] {
  if (!existsSync(runtimeLog)) return []
  return readFileSync(runtimeLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test.beforeAll(async () => {
  if (retainedHome) {
    expect(
      existsSync(join(retainedHome, 'db.sqlite')),
      'Use a fresh home for a retained acceptance task',
    ).toBe(false)
    mkdirSync(retainedHome, { recursive: true })
  }
  // The real Git gateway serves only the OS temp root. Preserve this fixture
  // as well when retaining the acceptance home and its task worktree.
  fixtureRoot = mkdtempSync(join(tmpdir(), 'aw-rfc372-journey-'))
  const state = join(fixtureRoot, 'runtime')
  mkdirSync(state)
  runtimeLog = join(state, 'mindmap-journey.ndjson')
  daemon = await startDaemon({
    home: retainedHome,
    stubMode: 'clarify',
    extraEnv: { CLARIFY_STUB_STATE: state, CLARIFY_STUB_MINDMAP_SCENARIO: 'complete-design' },
  })
})
test.afterAll(async () => {
  await daemon?.stop()
  if (!retainedHome && fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
})

test('predefined directions → self and cross mindmaps → deep answers → final document → completed task', async ({
  page,
}, testInfo) => {
  const repo = join(fixtureRoot, 'repository')
  mkdirSync(repo)
  writeFileSync(join(repo, 'README.md'), '# 会议室预约系统\n\n本任务产出已确认的实施设计。\n')
  initGitRepo(repo)
  const designer = await api<{ id: string }>('/api/agents', {
    name: 'rfc372-journey-designer',
    description: '会议室预约设计',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const reviewer = await api<{ id: string }>('/api/agents', {
    name: 'rfc372-journey-reviewer',
    description: '按确认结果输出最终设计',
    outputs: ['document'],
    outputKinds: { document: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const edge = (
    id: string,
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ) => ({
    id,
    source: { nodeId: source, portName: sourcePort },
    target: { nodeId: target, portName: targetPort },
  })
  const workflow = await api<{ id: string }>('/api/workflows', {
    name: 'RFC-372 会议室预约设计全流程',
    description: '预置方向、两层深入、双工作区确认与最终文档',
    definition: {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [{ key: 'topic', kind: 'text', label: '设计主题', required: true }],
      nodes: [
        { id: 'topic', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'designer',
          kind: 'agent-single',
          agentId: designer.id,
          promptTemplate: 'RFC372_DESIGN_DRAFT\n主题：{{topic}}',
          position: { x: 280, y: 0 },
        },
        {
          id: 'clarify',
          kind: 'clarify',
          title: '设计方向与分支澄清',
          interactionMode: 'mindmap',
          mindmap: { categories: directions, instructions: guidance },
          position: { x: 280, y: 250 },
        },
        {
          id: 'reviewer',
          kind: 'agent-single',
          agentId: reviewer.id,
          promptTemplate: 'RFC372_DESIGN_REVIEW\n<design-draft>{{design}}</design-draft>',
          position: { x: 600, y: 0 },
        },
        {
          id: 'cross',
          kind: 'clarify-cross-agent',
          title: '验收与文档确认',
          interactionMode: 'mindmap',
          mindmap: { categories: directions, instructions: guidance },
          position: { x: 600, y: 250 },
        },
        { id: 'output', kind: 'output', position: { x: 920, y: 0 } },
      ],
      edges: [
        edge('topic-designer', 'topic', 'topic', 'designer', 'topic'),
        edge('designer-clarify', 'designer', '__clarify__', 'clarify', 'questions'),
        edge('clarify-designer', 'clarify', 'answers', 'designer', '__clarify_response__'),
        edge('designer-reviewer', 'designer', 'design', 'reviewer', 'design'),
        edge('reviewer-cross', 'reviewer', '__clarify__', 'cross', 'questions'),
        edge('cross-reviewer', 'cross', 'to_questioner', 'reviewer', '__clarify_response__'),
        edge('cross-designer', 'cross', 'to_designer', 'designer', '__external_feedback__'),
        edge('reviewer-output', 'reviewer', 'document', 'output', 'document'),
      ],
    },
  })
  const task = await api<{ id: string }>('/api/tasks', {
    name: '会议室预约系统 · 脑图澄清完整验收',
    workflowId: workflow.id,
    repoUrl: repoRemoteUrl(repo),
    ref: 'main',
    inputs: { topic: '共享会议室预约系统' },
  })
  const receiptPath = retainedHome
    ? join(retainedHome, 'rfc372-acceptance.json')
    : testInfo.outputPath('acceptance.json')
  writeFileSync(
    receiptPath,
    JSON.stringify(
      { taskId: task.id, workflowId: workflow.id, home: daemon.home, status: 'running' },
      null,
      2,
    ),
  )
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )

  const self = await waitRound(task.id, 'self')
  expect(self.questions.map((q) => q.mindmap.categoryPath[0])).toEqual(directions)
  await page.goto(`${daemon.baseUrl}/clarify/${self.intermediaryNodeRunId}`)
  const workspace = page.getByRole('region', { name: 'Clarify workspace' })
  await expect(workspace).toBeVisible()
  await expect(page.getByText('This round is reviewed and ready to submit.')).toHaveCount(0)
  await answer(page, '首期服务哪些预约场景？', ['会议室和工位预约'])
  // Changing a reviewed answer invalidates its confirmation in both views.
  await detail(page).getByLabel('仅会议室预约', { exact: false }).check()
  await expect(page.getByRole('button', { name: 'Confirm this answer', exact: true })).toBeEnabled()
  await page
    .getByRole('radiogroup', { name: 'View', exact: true })
    .getByRole('radio', { name: 'Focused answers' })
    .click()
  await expect(detail(page).getByLabel('仅会议室预约', { exact: false })).toBeChecked()
  await page.getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  await page
    .getByRole('radiogroup', { name: 'View', exact: true })
    .getByRole('radio', { name: 'Panorama', exact: true })
    .click()
  await answer(
    page,
    '首期支持哪些操作方式？',
    ['桌面浏览器', '移动浏览器', '键盘操作'],
    '保留筛选条件，刷新后恢复当前输入。',
  )
  await answer(page, '预约数据采用哪种一致性？', ['事务强一致'])

  // Cancel a real running model subprocess, then recover from invalid model output.
  await page.getByRole('button', { name: 'Deepen this question', exact: true }).click()
  await detail(page).getByRole('textbox').last().fill('验证取消恢复')
  await page.getByRole('button', { name: 'Ask follow-up', exact: true }).click()
  await expect
    .poll(() => runtimeEvents().some((event) => event.request?.userRequest === '验证取消恢复'), {
      timeout: 30_000,
    })
    .toBe(true)
  const canceled = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/followup') &&
      response.status() === 409,
  )
  await page.getByRole('button', { name: 'Cancel follow-up', exact: true }).click()
  expect((await (await canceled).json()).code).toBe('clarify-followup-canceled')
  await expect(page.getByRole('button', { name: 'Ask follow-up', exact: true })).toBeEnabled()
  expect((await api<Round>(`/api/clarify/${self.intermediaryNodeRunId}`)).questions).toHaveLength(3)
  await detail(page).getByRole('textbox').last().fill('验证失败重试')
  const failed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/followup') &&
      response.status() === 422,
  )
  await page.getByRole('button', { name: 'Ask follow-up', exact: true }).click()
  expect((await (await failed).json()).code).toBe('clarify-followup-invalid')
  await expect(page.getByRole('alert').last()).toBeVisible()
  await followup(page, '深入并发预约与冲突恢复', '并发预约如何裁决？')
  let expanded = await api<Round>(`/api/clarify/${self.intermediaryNodeRunId}`)
  expect(expanded.iteration).toBe(self.iteration)
  expect(expanded.questions).toHaveLength(5)
  expect(
    expanded.questions.slice(3).every((q) => q.mindmap.parentQuestionId === 'consistency'),
  ).toBe(true)
  // Parent confirmation cannot hide its still-unanswered descendants.
  await page.getByRole('button', { name: 'Collapse children', exact: true }).click()
  await expect(
    detail(page).locator('.mindmap-question__eyebrow .mindmap-status--done'),
  ).toBeVisible()
  await expect(detail(page).getByText('2 child questions pending', { exact: true })).toBeVisible()
  await expect(page.getByText('This round is reviewed and ready to submit.')).toHaveCount(0)
  await page
    .getByRole('textbox', { name: 'Search categories or questions' })
    .fill('并发预约如何裁决')
  await select(page, '并发预约如何裁决？')
  await page.getByRole('textbox', { name: 'Search categories or questions' }).fill('')
  await answer(page, '并发预约如何裁决？', ['先提交者成功'])
  await followup(page, '深入重复提交的幂等性', '重复提交如何识别？')
  await answer(page, '重复提交如何识别？', ['幂等请求键'])
  await answer(page, '冲突失败后如何提示？', ['返回冲突并建议空闲时段'])
  expanded = await api<Round>(`/api/clarify/${self.intermediaryNodeRunId}`)
  const concurrency = expanded.questions.find((q) => q.title === '并发预约如何裁决？')!
  expect(
    expanded.questions.find((q) => q.title === '重复提交如何识别？')!.mindmap.parentQuestionId,
  ).toBe(concurrency.id)
  expect(expanded.questions).toHaveLength(6)
  // Refresh after the real durability indicator acknowledges both the local
  // and collaborative writes, rather than aborting an in-flight debounce.
  await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
    'data-draft-status',
    'saved',
  )
  await page.reload()
  await select(page, '首期服务哪些预约场景？')
  await expect(detail(page).getByLabel('仅会议室预约', { exact: false })).toBeChecked()
  await expect(page.getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
  await expect(page.getByText('This round is reviewed and ready to submit.')).toBeVisible()
  await page.getByRole('button', { name: 'Highlight pending', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Highlight pending', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: /Back to mindmap/ }).click()
  const canvas = page.getByRole('img', { name: 'Clarification mindmap' })
  await canvas.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('0')
  await expect(page.getByLabel('Zoom level')).toHaveText(/^\d+(?:\.\d+)?%$/)
  const zoom = await page.getByLabel('Zoom level').textContent()
  await canvas.dblclick({ position: { x: 30, y: 80 } })
  await expect(page.getByLabel('Zoom level')).toHaveText(zoom!)
  await page.screenshot({ path: testInfo.outputPath('self-reviewed.png'), fullPage: true })
  await stopRound(page, self.intermediaryNodeRunId)

  const cross = await waitRound(task.id, 'cross')
  expect(cross.questions).toHaveLength(2)
  await page.goto(`${daemon.baseUrl}/clarify/${cross.intermediaryNodeRunId}`)
  await answer(page, '验收场景必须覆盖哪些状态？', ['正常、冲突和恢复'])
  await followup(page, '明确页面恢复验收项', '必须验证哪类恢复？')
  await answer(page, '必须验证哪类恢复？', ['刷新与取消恢复'])
  await answer(page, '设计文档采用哪种交付形式？', ['可实施的 Markdown 设计文档'])
  await page.screenshot({ path: testInfo.outputPath('cross-reviewed.png'), fullPage: true })
  await stopRound(page, cross.intermediaryNodeRunId)
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
      timeout: 90_000,
    })
    .toBe('done')

  const results = await api<{
    runs: { id: string; nodeId: string; status: string }[]
    outputs: { nodeRunId: string; port: string; value: string }[]
  }>(`/api/tasks/${task.id}/node-runs`)
  expect(results.runs.filter((run) => run.nodeId === 'designer')).toHaveLength(2)
  expect(results.runs.filter((run) => run.nodeId === 'reviewer')).toHaveLength(2)
  const finalRun = results.runs.findLast(
    (run) => run.nodeId === 'reviewer' && run.status === 'done',
  )!
  const document = results.outputs.find(
    (output) => output.nodeRunId === finalRun.id && output.port === 'document',
  )!.value
  expect(document.startsWith('# 会议室预约系统设计')).toBe(true)
  expect(document).not.toContain('<aw-input')
  for (const text of [
    '# 会议室预约系统设计',
    '仅会议室预约',
    '事务强一致',
    '桌面浏览器',
    '移动浏览器',
    '键盘操作',
    '保留筛选条件',
    '先提交者成功',
    '返回冲突并建议空闲时段',
    '幂等请求键',
    '## 最终验收与交付',
    '刷新与取消恢复',
    '可实施的 Markdown 设计文档',
  ])
    expect(document).toContain(text)
  expect(document).not.toContain('会议室和工位预约')
  expect((await api<Round>(`/api/clarify/${self.intermediaryNodeRunId}`)).status).toBe('answered')
  expect((await api<Round>(`/api/clarify/${cross.intermediaryNodeRunId}`)).status).toBe('answered')
  await page.goto(`${daemon.baseUrl}/tasks/${task.id}`)
  await expect(page.locator('.status-chip', { hasText: /^done$/i }).first()).toBeVisible()
  await page.locator('[data-task-detail-section-link="outputs"]').click()
  await page.getByRole('tab', { name: /document/ }).click()
  await expect(page.locator('.task-outputs-panel__pre')).toContainText('## 最终验收与交付')
  await page.screenshot({ path: testInfo.outputPath('completed-document.png'), fullPage: true })
  const documentPath = retainedHome
    ? join(retainedHome, '会议室预约系统设计.md')
    : testInfo.outputPath('会议室预约系统设计.md')
  writeFileSync(documentPath, document)
  const evidence = {
    taskId: task.id,
    workflowId: workflow.id,
    home: daemon.home,
    fixtureRoot,
    status: 'done',
    documentPath,
    clarifyRuns: [self.intermediaryNodeRunId, cross.intermediaryNodeRunId],
    questionCounts: [6, 3],
    directions,
    model: 'systemmock',
    events: runtimeEvents().map(({ kind, request }) => ({
      kind,
      ...(request ? { depth: request.branch.length, instruction: request.userRequest } : {}),
    })),
  }
  writeFileSync(receiptPath, JSON.stringify(evidence, null, 2) + '\n')
  await testInfo.attach('acceptance', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('final-design', { body: document, contentType: 'text/markdown' })
})

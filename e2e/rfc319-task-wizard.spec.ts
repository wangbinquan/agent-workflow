// RFC-319 —— `/tasks/new` 任务启动向导的用户面 e2e
// （账本 TASK-04 / TASK-05 / TASK-06 / TASK-08 / TASK-11 / TASK-13 / TASK-14 / TASK-15）。
//
// 向导是这个平台**唯一**的「把活派出去」的入口：一次点击之后，参数就被冻结进任务行、
// 冻结进工作树、冻结进 agent 的 prompt。它坏掉的方式几乎都不报错：
//
//   * TASK-04 files / enum / git 三个选择器各有自己的**打包格式**（换行连接 / 裸串或
//     JSON 数组 / JSON 对象）。打包错了后端直接 422，用户看到的是「输入不合法」而不是
//     「你选的那三个文件没传上去」；打包对但值取错（比如多选只取了最后一个）则**静默**
//     少派工作，没有任何一层会报。
//   * TASK-05 上传输入是唯一一条「浏览器里的字节要变成工作树里的文件」的链路。接口回
//     200 不代表文件落了盘，落了盘也不代表 prompt 引用得到它——中间任何一环断掉，agent
//     拿到的都是一个不存在的路径，而任务照样「成功」。
//   * TASK-06 基线 ref 决定 agent 在**哪一版代码**上干活。选了 tag 却检出默认分支，产出
//     的 diff 会打在错误的基线上；非法 ref 若不当场报，用户要等到任务失败才知道自己敲错
//     了一个字母。
//   * TASK-08 重放是「再跑一次刚才那个」。参数漏带一项就是另一次实验；多仓布局若读的是
//     **当前**仓库组而不是源任务冻结的快照，组被改过之后重启出来的就是另一个工作区。
//   * TASK-11 非幂等提交丢响应是分布式系统的常态。向导不冻结、不对账，用户的本能反应是
//     再点一次启动——于是同一份工作被派了两遍。
//   * TASK-13 工作流在提交瞬间被别人改掉时，若不拦，就会拿 vN 校验过的输入去跑 vN+1 的
//     图；那正是 RFC-199 立 OCC 栅栏要防的事故。
//   * TASK-14 高级折叠区的六项各自是一条独立的 wire 字段。whitelist 型 builder 漏拷一行
//     就静默丢一项（本仓有过前科，见 lib/launch-repo-source.ts 里那段注释）。
//   * TASK-15 分步必填校验是用户唯一的「我还没填完」提示。门失效 = 一个必然 422 的请求；
//     门反了 = 填完了也走不下去。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/tasks.new.tsx:1041-1064   missingRequired：upload 走计数、多选空数组算缺
//   packages/frontend/src/routes/tasks.new.tsx:1102-1155   四道门 stepModeReady / sourceReady / nameReady / contentReady
//   packages/frontend/src/routes/tasks.new.tsx:1463-1464   nextEnabled 按步分派
//   packages/frontend/src/routes/tasks.new.tsx:1492-1502   collectAdvanced：六项高级字段的 wire 白名单
//   packages/frontend/src/routes/tasks.new.tsx:1544-1556   immediateGuards：expectedWorkflowVersion 等 OCC 栅栏
//   packages/frontend/src/routes/tasks.new.tsx:1558-1614   start.mutationFn：upload ⇒ multipart，否则 JSON
//   packages/frontend/src/routes/tasks.new.tsx:1619-1636   onError：definitive 之外一律进对账态
//   packages/frontend/src/routes/tasks.new.tsx:1648-1686   adoptLatestWorkflow / recoverWorkflowVersion
//   packages/frontend/src/routes/tasks.new.tsx:1858-1867   canSubmit / canStartNow
//   packages/frontend/src/routes/tasks.new.tsx:2040-2079   对账横幅 + 两条收口路径
//   packages/frontend/src/routes/tasks.new.tsx:2102-2151   版本失配的两条横幅（进入时 / 提交时）
//   packages/frontend/src/routes/tasks.new.tsx:2339-2358   replay 空间卡片（冻结布局）
//   packages/frontend/src/routes/tasks.new.tsx:2560-2644   高级折叠区五个控件
//   packages/frontend/src/routes/tasks.new.tsx:2716-2762   确认页的 git 身份行与高级摘要行
//   packages/frontend/src/components/launch/EnumPicker.tsx:44-49   单选 = 裸串、多选 = JSON 数组
//   packages/frontend/src/components/launch/FilesPicker.tsx:73-82  files = 换行连接
//   packages/frontend/src/components/launch/GitPicker.tsx:76-78    git = JSON 对象
//   packages/frontend/src/components/launch/RepoSourceRow.tsx:249-260  ref 输入框
//   packages/frontend/src/lib/task-wizard.ts:167-200        buildWorkflowStartFormData：multipart 装配
//   packages/frontend/src/lib/task-wizard.ts:495-556        taskToLaunchPayload：多仓 ⇒ sourceTaskId 重放
//   packages/frontend/src/lib/write-outcome.ts:45-52        4xx = definitive，其余一律 unknown
//   packages/backend/src/services/upload.ts:1-8             上传落点 = 工作树内 targetDir，回填成 {{port}} 值
//   packages/backend/src/services/workflowLaunchInputs.ts:74-110  服务端复核 enum 成员与 git 形状
//   packages/backend/src/services/task.ts:2192-2205         ref 解析不出来 ⇒ 422 repo-ref-not-found + availableRefs
//   packages/backend/src/services/task.ts:2533-2542         expectedWorkflowVersion 栅栏（物化之前，不铸任务行）
//   packages/backend/src/services/multipartTaskStart.ts:107-129   multipart 侧的同一道版本栅栏
//   packages/backend/src/routes/tasks.ts:330-334            **只有** JSON-body 的 POST /api/tasks 延后仓库准备
//
// 与既有覆盖的关系（不重复造轮子）：
//   · `e2e/task-wizard.spec.ts` 走的是 happy path：agent/workgroup/scheduled 三条链能不能
//     跑通。它一处都没碰选择器取值、上传落盘、ref、版本失配、对账与必填门。
//   · `e2e/rfc250-task-wizard-recovery.spec.ts` 锁的是**草稿**恢复（同标签页 reload、凭据
//     脱敏、pending 期间锁 UI）。本文件的 TASK-11 锁的是它的另一半：请求已经出去、结果
//     未知时的**对账**闭环，判据落在「库里到底有几条任务」。
//   · `e2e/repo-group-launch.spec.ts` 锁的是「在下拉里选中一个组 ⇒ 按组布局物化」。本文件
//     TASK-08 的重放锁的是相反的方向：**不读当前组定义**，只读源任务冻结的快照。
//   · `e2e/rfc319-de-case-and-wizard.spec.ts` 覆盖的是数字员工那一支合同（subject-descriptor），
//     与本文件的编排合同（shared-schema）是两套 Step 3。
//
// 执行模型：单 daemon，**不用 `mode: 'serial'`**——每条用例自带自己的工作流 / 代理 / 任务，
// 互不依赖；`playwright.config.ts` 的 `fullyParallel: false` 已保证同文件内顺序执行。不加
// serial 是为了让一次批量变异注入能同时看清「哪几条红」（`docs/dev-gotchas.md` 同名教训）。
//
// 本文件只有 TASK-11 与 TASK-13（提交冲突）用 `page.route`，两处都**只 fulfill**、绝不
// `route.fetch()`；要回源的真实响应一律在 Node 侧用测试自己的 API helper 预取
// （`docs/dev-gotchas.md` 锁 A），`afterEach` 统一 `unrouteAll({ behavior: 'wait' })`（锁 B）。

import { expect, test, type Page, type Request } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, querySqlite, repoRemoteUrl, runGit } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(240_000)

const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** 管理员的账户档案 —— 与 `e2e/harness.ts` 的 E2E_ADMIN 逐字一致（git 身份由它派生）。 */
const ADMIN_DISPLAY_NAME = 'E2E Administrator'
const ADMIN_EMAIL = 'e2e-admin@example.com'

let daemon: DaemonHandle
/** 主夹具仓：main 上有四个文件，release/v9 上多一个 RELEASE.md，并打了 tag v9.0.0。 */
let fixtureRepoDir = ''
let fixtureRepoUrl = ''
/** 仓库组的第二个成员仓（挂在 vendor/sdk）。 */
let vendorRepoDir = ''
let vendorRepoUrl = ''
let peerUserId = ''
let peerDisplayName = ''
let peerUsername = ''

interface TaskRow {
  id: string
  name: string
  status: string
  worktreePath: string
  baseBranch: string
  workingBranch: string | null
  autoCommitPush: boolean
  inputs: Record<string, string>
  maxDurationMs: number | null
  maxTotalTokens: number | null
  gitUserName: string | null
  gitUserEmail: string | null
  workflowVersion: number | null
  errorSummary: string | null
  errorMessage: string | null
  repoCount: number
  repos: Array<{ repoIndex: number; mountPath: string; cachedRepoId: string | null }>
}

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  promptText: string | null
}

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  token: string = daemon.token,
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
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

/**
 * 用**测试自己**的 HTTP 面把浏览器那一份请求体原样重放一次。
 *
 * TASK-11 需要「服务端确实落了库、而浏览器没收到答案」这个现场。`docs/dev-gotchas.md`
 * 锁 A 禁止在 route handler 里 `route.fetch()`（页面关掉时它是唯一会抛的动词），所以
 * 回源这一步放在 Node 侧：同一个 daemon、同一个 token、同一条路径、同一份 body，
 * 服务端看到的与浏览器本来会发出的那一次完全同形。
 */
async function replayRawJson(path: string, rawBody: string): Promise<{ id: string }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: rawBody,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`replay POST ${path} returned ${response.status}: ${text}`)
  }
  return JSON.parse(text) as { id: string }
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

async function importCachedRepo(url: string): Promise<string> {
  let batch = await api<{ batchId: string; state: string; rows: Array<{ status: string }> }>(
    '/api/cached-repos/batch-import',
    { method: 'POST', body: { urls: [url] } },
  )
  const deadline = Date.now() + 60_000
  while (batch.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    batch = await api(`/api/cached-repos/imports/${batch.batchId}`)
  }
  if (batch.state !== 'completed' || batch.rows.some((row) => row.status !== 'done')) {
    throw new Error(`cached-repo import failed: ${JSON.stringify(batch.rows)}`)
  }
  const repositories = await api<{ items: Array<{ id: string; urlRedacted: string }> }>(
    '/api/cached-repos',
  )
  const hit = repositories.items.find((candidate) => candidate.urlRedacted === url)
  if (hit === undefined) throw new Error(`cached repo missing after import: ${url}`)
  return hit.id
}

let agentSeq = 0
async function createAgent(label: string): Promise<{ id: string; name: string }> {
  agentSeq += 1
  const name = `rfc319-wizard-${label}-${RUN_TAG}-${agentSeq}`
  const created = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name,
      description: 'RFC-319 task wizard fixture agent',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    },
  })
  return { id: created.id, name }
}

interface WorkflowInputDef extends Record<string, unknown> {
  kind: 'text' | 'files' | 'enum' | 'git' | 'upload'
  key: string
  label: string
}

/**
 * 线性工作流：每个声明输入配一个 input 节点，全部接进同一个 agent 节点，
 * promptTemplate 逐个引用（TASK-05 的 prompt 断言就落在这上面）。
 */
function linearDefinition(
  agentId: string,
  agentName: string,
  inputs: readonly WorkflowInputDef[],
): Record<string, unknown> {
  return {
    $schema_version: 2,
    inputs,
    nodes: [
      ...inputs.map((def, index) => ({
        id: `in_${index}`,
        kind: 'input',
        inputKey: def.key,
        position: { x: 0, y: index * 120 },
      })),
      {
        id: 'agent_1',
        kind: 'agent-single',
        agentId,
        agentName,
        promptTemplate:
          inputs.length === 0
            ? 'Do the work.'
            : inputs.map((def) => `${def.key}=<<{{${def.key}}}>>`).join('\n'),
        position: { x: 360, y: 0 },
      },
      {
        id: 'out_1',
        kind: 'output',
        ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
        position: { x: 720, y: 0 },
      },
    ],
    edges: [
      ...inputs.map((def, index) => ({
        id: `e_in_${index}`,
        source: { nodeId: `in_${index}`, portName: def.key },
        target: { nodeId: 'agent_1', portName: def.key },
      })),
      {
        id: 'e_out',
        source: { nodeId: 'agent_1', portName: 'answer' },
        target: { nodeId: 'out_1', portName: 'answer' },
      },
    ],
  }
}

let workflowSeq = 0
async function createWorkflow(
  label: string,
  inputs: readonly WorkflowInputDef[],
): Promise<{ id: string; name: string; version: number; agentName: string }> {
  workflowSeq += 1
  const agent = await createAgent(label)
  const name = `rfc319-wf-${label}-${RUN_TAG}-${workflowSeq}`
  const created = await api<{ id: string; version: number }>('/api/workflows', {
    method: 'POST',
    body: {
      name,
      description: 'RFC-319 task wizard fixture workflow',
      definition: linearDefinition(agent.id, agent.name, inputs),
    },
  })
  return { id: created.id, name, version: created.version, agentName: agent.name }
}

/** `clientMutationId` 要求 26 位 Crockford ULID 字母表（无 I/L/O/U）。 */
let mutationSeq = 0
function mutationId(): string {
  mutationSeq += 1
  const body = `${Date.now().toString(32)}${mutationSeq}`.toUpperCase().replace(/[ILOU]/g, 'X')
  return `0${body}`.padEnd(26, '0').slice(0, 26)
}

/** 改一次工作流定义并返回新版本号（PUT 才会让 `workflows.version` 前进）。 */
async function bumpWorkflow(
  workflowId: string,
  expectedVersion: number,
  mutate: (definition: Record<string, unknown>) => Record<string, unknown>,
): Promise<number> {
  const current = await api<{
    name: string
    description: string
    definition: Record<string, unknown>
  }>(`/api/workflows/${workflowId}`)
  const receipt = await api<{ revision: { version: number }; outcome: string }>(
    `/api/workflows/${workflowId}`,
    {
      method: 'PUT',
      body: {
        expectedVersion,
        clientMutationId: mutationId(),
        snapshot: {
          name: current.name,
          description: current.description,
          definition: mutate(structuredClone(current.definition)),
        },
      },
    },
  )
  if (receipt.outcome !== 'committed') {
    throw new Error(`workflow PUT did not commit a new revision: ${receipt.outcome}`)
  }
  return receipt.revision.version
}

async function fetchTask(taskId: string): Promise<TaskRow> {
  return api<TaskRow>(`/api/tasks/${taskId}`)
}

/** 等到仓库准备完成（RFC-287 G7 之后 JSON 启动的工作树是后台回填的）。 */
async function waitWorktree(taskId: string): Promise<TaskRow> {
  let last: TaskRow | null = null
  await expect
    .poll(
      async () => {
        last = await fetchTask(taskId)
        return last.worktreePath !== '' ? 'ready' : last.status
      },
      { intervals: [200], timeout: 120_000, message: `任务 ${taskId} 的工作树始终没有物化` },
    )
    .toBe('ready')
  return last as unknown as TaskRow
}

const TERMINAL = new Set(['done', 'failed', 'canceled', 'interrupted'])

async function waitTerminal(taskId: string): Promise<TaskRow> {
  let last: TaskRow | null = null
  await expect
    .poll(
      async () => {
        last = await fetchTask(taskId)
        return TERMINAL.has(last.status)
      },
      { intervals: [250], timeout: 120_000, message: `任务 ${taskId} 始终没有走到终态` },
    )
    .toBe(true)
  return last as unknown as TaskRow
}

function countTasksNamed(name: string): number {
  return (
    querySqlite<{ n: number }>(dbPath(), 'SELECT count(*) AS n FROM tasks WHERE name = ?', [
      name,
    ])[0]?.n ?? 0
  )
}

test.beforeAll(async () => {
  daemon = await startDaemon()

  fixtureRepoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-wizard-repo-'))
  writeFileSync(join(fixtureRepoDir, 'README.md'), '# rfc-319 wizard fixture\n', 'utf-8')
  mkdirSync(join(fixtureRepoDir, 'src'))
  writeFileSync(join(fixtureRepoDir, 'src', 'alpha.ts'), 'export const alpha = 1\n', 'utf-8')
  writeFileSync(join(fixtureRepoDir, 'src', 'beta.ts'), 'export const beta = 2\n', 'utf-8')
  mkdirSync(join(fixtureRepoDir, 'docs'))
  writeFileSync(join(fixtureRepoDir, 'docs', 'guide.md'), '# guide\n', 'utf-8')
  initGitRepo(fixtureRepoDir, { message: 'rfc-319 wizard fixture' })
  // 只在 release/v9 上存在的文件 + 指向它的 tag。TASK-06 用「工作树里有没有这个文件」
  // 来判定 ref 到底被没被采纳——比读一个字符串字段硬得多。
  runGit(['checkout', '-q', '-b', 'release/v9'], fixtureRepoDir)
  writeFileSync(join(fixtureRepoDir, 'RELEASE.md'), '# only on release/v9\n', 'utf-8')
  runGit(['add', '.'], fixtureRepoDir)
  runGit(
    ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', 'release marker'],
    fixtureRepoDir,
  )
  runGit(['tag', 'v9.0.0'], fixtureRepoDir)
  runGit(['checkout', '-q', 'main'], fixtureRepoDir)
  fixtureRepoUrl = repoRemoteUrl(fixtureRepoDir)
  await importCachedRepo(fixtureRepoUrl)

  vendorRepoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-wizard-vendor-'))
  writeFileSync(join(vendorRepoDir, 'README.md'), '# vendor sdk\n', 'utf-8')
  initGitRepo(vendorRepoDir, { message: 'rfc-319 wizard vendor fixture' })
  vendorRepoUrl = repoRemoteUrl(vendorRepoDir)

  peerUsername = `rfc319-wizard-peer-${RUN_TAG}`
  peerDisplayName = `Wizard Peer ${RUN_TAG}`
  const peer = await api<{ id: string }>('/api/users', {
    method: 'POST',
    body: {
      username: peerUsername,
      email: `${peerUsername}@example.com`,
      displayName: peerDisplayName,
      role: 'user',
      password: 'Rfc319WizardPeer!',
    },
  })
  peerUserId = peer.id
})

test.afterEach(async ({ page }) => {
  // `docs/dev-gotchas.md` 锁 B：先摘 handler，再趁 page 还活着把在飞的等完。
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async () => {
  await daemon?.stop()
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-15：任务名或必填输入缺一样，向导的下一步就按不下去；从确认页折回清空后启动键同样失效，一个请求都不发 @nightly', async ({
  page,
}) => {
  const workflow = await createWorkflow('required-gate', [
    { kind: 'text', key: 'topic', label: 'Topic', required: true },
  ])
  const taskName = `Required gate ${RUN_TAG}`

  const launchPosts: string[] = []
  page.on('request', (request: Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') {
      launchPosts.push(request.url())
    }
  })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=workflow&workflow=${workflow.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await page.getByTestId('wizard-space-scratch').click()
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')

  const next = page.getByTestId('stepper-next')
  const topic = page.locator('label.form-field', { hasText: 'Topic' }).locator('input.form-input')

  // ① 两样都缺。
  await expect(page.getByTestId('wizard-task-name')).toHaveValue('')
  await expect(next, '任务名与必填输入都空着，下一步必须按不下去').toBeDisabled()

  // ② 只有任务名 —— 必填输入仍缺。这一格坏掉时用户会带着空输入走到最后一步，
  //    然后吃一个服务端 422（`workflowLaunchInputs.ts` 的 required-input-missing）。
  await page.getByTestId('wizard-task-name').fill(taskName)
  await expect(next, '必填输入还空着时，光有任务名不该放行').toBeDisabled()

  // ③ 只有必填输入 —— 任务名缺。`nameReady` 与 `contentReady` 是两道独立的门，
  //    任何一道被并进另一道都会在这里露出来。
  await topic.fill('wizard gating')
  await page.getByTestId('wizard-task-name').fill('')
  await expect(next, '清空任务名之后必须重新挡住').toBeDisabled()

  // ④ 正向对照：两样齐了就必须放行。没有这一步，上面三条「按不下去」对一个
  //    永远置灰的按钮同样成立（那就是一条恒真断言）。
  await page.getByTestId('wizard-task-name').fill(taskName)
  await expect(next, '两样都填齐之后必须放行').toBeEnabled()
  await next.click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  await expect(page.getByTestId('wizard-launch')).toBeEnabled()

  // ⑤ 真正危险的那条路径：走到过确认页之后，步骤头就一直可点回来。回内容步骤清空
  //    必填输入，再从步骤头跳回确认页——启动键必须仍然是死的。若产品把启动门写成
  //    「走到过第四步就能提交」，这里就是它唯一会露馅的地方。
  await page.getByTestId('stepper-step-content').click()
  await topic.fill('')
  await page.getByTestId('stepper-step-confirm').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  const launch = page.getByTestId('wizard-launch')
  await expect(launch, '必填输入被清空后，确认页的启动键必须置灰').toBeDisabled()
  // 置灰这件事本身与「灰着也真的点不动」是两条断言（`docs/dev-gotchas.md` 同名教训）。
  await launch.click({ force: true })
  await expect(page).toHaveURL(/\/tasks\/new\?/)
  expect(launchPosts, '被门挡住的启动不许有任何请求出门').toEqual([])
  expect(countTasksNamed(taskName), '被门挡住的启动不许在库里留下任务行').toBe(0)
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-04：files / enum 单选 / enum 多选 / git 分支四个选择器在浏览器里取到值，并按各自的打包格式原样进入任务 inputs @nightly', async ({
  page,
}) => {
  const workflow = await createWorkflow('pickers', [
    { kind: 'files', key: 'targets', label: 'Target files', required: true, maxCount: 3 },
    {
      kind: 'enum',
      key: 'severity',
      label: 'Severity',
      required: true,
      choices: ['low', 'medium', 'high'],
    },
    {
      kind: 'enum',
      key: 'areas',
      label: 'Areas',
      required: true,
      multiSelect: true,
      choices: ['backend', 'frontend', 'docs'],
    },
    { kind: 'git', key: 'baseline', label: 'Baseline', required: true, gitKind: 'branch' },
  ])
  const taskName = `Picker values ${RUN_TAG}`

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=workflow&workflow=${workflow.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()

  // 空间步骤：选中已缓存的夹具仓——files / git 两个选择器都要靠它的本地镜像枚举。
  await page.getByTestId('wizard-space-remote').click()
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: fixtureRepoUrl, exact: true }).click()
  await expect(page.getByTestId('repo-source-ref-0')).toBeVisible()
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-task-name').fill(taskName)

  // ① files：清单必须来自**这个仓**（`git ls-files`），不是任何本地兜底。
  const filesField = page.locator('label.form-field', { hasText: 'Target files' })
  await expect(
    filesField.getByRole('checkbox', { name: 'docs/guide.md', exact: true }),
  ).toBeVisible({ timeout: 30_000 })
  // 过滤框把清单收窄——它是用户在中等规模仓里唯一的导航手段。
  await filesField.getByPlaceholder('Filter paths…').fill('src/')
  await expect(filesField.getByRole('checkbox')).toHaveCount(2)
  await expect(
    filesField.getByRole('checkbox', { name: 'docs/guide.md', exact: true }),
  ).toHaveCount(0)
  await filesField.getByRole('checkbox', { name: 'src/alpha.ts', exact: true }).check()
  await filesField.getByRole('checkbox', { name: 'src/beta.ts', exact: true }).check()

  // ② enum 单选：值是**裸串**。
  const severityField = page.locator('label.form-field', { hasText: 'Severity' })
  await severityField.getByRole('radio', { name: 'high', exact: true }).click()

  // ③ enum 多选：值是 JSON 数组，勾两个就该有两项——只留最后一个是最典型的退化。
  const areasField = page.locator('label.form-field', { hasText: 'Areas' })
  await areasField.getByRole('checkbox', { name: 'frontend', exact: true }).check()
  await areasField.getByRole('checkbox', { name: 'docs', exact: true }).check()

  // ④ git 分支：下拉里必须真的列出镜像里的远端分支。`origin/release/v9` 只可能来自
  //    对缓存镜像跑 `for-each-ref`——它在场就说明这个选择器不是一张写死的表。
  const branchPicker = page.getByRole('combobox', { name: 'Branch', exact: true })
  await branchPicker.click()
  await expect(page.getByRole('option', { name: 'origin/release/v9', exact: true })).toBeVisible()
  await page.getByRole('option', { name: 'main', exact: true }).click()

  // 确认页把四个值原样念回来——用户在最后一步就是靠它核对自己选了什么。
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  const summary = page.getByTestId('wizard-summary-content')
  await expect(summary).toContainText('targets: src/alpha.ts')
  await expect(summary).toContainText('severity: high')
  await expect(summary).toContainText('areas: ["frontend","docs"]')
  await expect(summary).toContainText('baseline: {"kind":"branch","ref":"main"}')

  const launchRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks',
  )
  await page.getByTestId('wizard-launch').click()
  const launched = await launchRequest
  // 打包格式是四个选择器各自的契约，服务端还会复核 enum 成员与 git 形状
  // （`workflowLaunchInputs.ts`）。逐字断言这四个值，任何一个打包器退化都会红。
  expect((launched.postDataJSON() as { inputs: Record<string, string> }).inputs).toEqual({
    targets: 'src/alpha.ts\nsrc/beta.ts',
    severity: 'high',
    areas: '["frontend","docs"]',
    baseline: '{"kind":"branch","ref":"main"}',
  })

  await page.waitForURL(/\/tasks\/[0-9A-Z]{26}$/i)
  const taskId = page.url().split('/').at(-1)!
  // 再从**库里**读一遍：只断言请求体的话，「服务端收下了但没落进任务」这一类失败照样绿。
  const task = await fetchTask(taskId)
  expect(task.inputs).toEqual({
    targets: 'src/alpha.ts\nsrc/beta.ts',
    severity: 'high',
    areas: '["frontend","docs"]',
    baseline: '{"kind":"branch","ref":"main"}',
  })
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-05：向导里选本地文件 → multipart 启动 → 文件真的落进工作树的目标目录，并被节点 prompt 逐字引用 @nightly', async ({
  page,
}) => {
  const workflow = await createWorkflow('upload', [
    { kind: 'text', key: 'topic', label: 'Topic', required: true },
    {
      kind: 'upload',
      key: 'refs',
      label: 'Reference materials',
      required: true,
      targetDir: 'inputs/refs',
      minCount: 1,
      maxCount: 3,
    },
  ])
  const taskName = `Upload landing ${RUN_TAG}`
  const uploadBody = `# acceptance ${RUN_TAG}\nThe file the agent must be able to open.\n`

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=workflow&workflow=${workflow.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await page.getByTestId('wizard-space-remote').click()
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: fixtureRepoUrl, exact: true }).click()
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')

  await page.getByTestId('wizard-task-name').fill(taskName)
  await page
    .locator('label.form-field', { hasText: 'Topic' })
    .locator('input.form-input')
    .fill('read the uploaded acceptance note')
  // 必选上传的门走的是**计数**分支（`tasks.new.tsx` 的 missingRequired 里 upload 专有的
  // 那一支），与文本输入的「trim 后非空」不是同一段代码。
  await expect(page.getByTestId('stepper-next'), '必选上传还没选文件时不该放行').toBeDisabled()
  await page.getByTestId('upload-picker-refs').setInputFiles({
    name: 'acceptance.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(uploadBody),
  })
  await expect(page.getByTestId('stepper-next')).toBeEnabled()

  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('wizard-summary-content')).toContainText('refs: acceptance.md')

  const launchRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks',
  )
  await page.getByTestId('wizard-launch').click()
  const launched = await launchRequest
  // 有 upload 声明就必须走 multipart：JSON 那条路后端会拒（路径值是服务端写的）。
  expect(
    (launched.headers()['content-type'] ?? '').toLowerCase(),
    '带上传输入的启动必须以 multipart 提交',
  ).toContain('multipart/form-data')

  await page.waitForURL(/\/tasks\/[0-9A-Z]{26}$/i)
  const taskId = page.url().split('/').at(-1)!
  const task = await waitWorktree(taskId)

  // ① 输入值被服务端改写成了工作树内的相对路径（用户填的是一个 File，落地的是路径）。
  expect(task.inputs.refs, '上传输入的值必须是服务端写回的工作树相对路径').toBe(
    'inputs/refs/acceptance.md',
  )

  // ② 盘上真的有这个文件、内容逐字节相同。只断言接口回了 201 的话，
  //    「路径回填了但字节没落盘」这类失败照样绿，而 agent 会读到一个不存在的文件。
  const landed = join(task.worktreePath, 'inputs', 'refs', 'acceptance.md')
  expect(readFileSync(landed, 'utf-8')).toBe(uploadBody)

  // ③ prompt 真的引用了它。这是整条链的最后一环：文件在盘上但 prompt 里没有它，
  //    agent 依然不知道该去打开什么。
  let prompt = ''
  await expect
    .poll(
      async () => {
        const runs = await api<{ runs: NodeRunRow[] }>(`/api/tasks/${taskId}/node-runs`)
        const agentRun = runs.runs.find((run) => run.nodeId === 'agent_1')
        prompt = agentRun?.promptText ?? ''
        return prompt !== ''
      },
      { intervals: [300], timeout: 120_000, message: 'agent 节点始终没有生成 prompt' },
    )
    .toBe(true)
  // 注入位置也要对：路径必须落在 **refs 端口自己的** `<aw-input name="refs">` 数据块里
  // （不可信输入边界，`services/promptAssembly` 的既有形态）。落错端口 = agent 读不到。
  expect(prompt, 'prompt 的 refs 端口槽位里必须逐字带上上传物的工作树路径').toMatch(
    /refs=<<<aw-input name="refs" id="[0-9a-f]+">\r?\ninputs\/refs\/acceptance\.md\r?\n<\/aw-input>>>/,
  )
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-06：基线 ref 填什么就检出什么；非法 ref 的启动当场报服务端原话与可用引用，而且一行任务都不落库 @nightly', async ({
  page,
}) => {
  const agent = await createAgent('ref')
  const okName = `Ref honored ${RUN_TAG}`
  const badName = `Ref rejected ${RUN_TAG}`
  const badRef = `no-such-ref-${RUN_TAG}`

  await primeAuth(page)

  // ---- ① 合法 ref（tag v9.0.0）必须真的被检出 -----------------------------
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=agent&agentId=${agent.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await page.getByTestId('wizard-space-remote').click()
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: fixtureRepoUrl, exact: true }).click()
  await page.getByTestId('repo-source-ref-0').fill('v9.0.0')
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill(okName)
  await page.getByTestId('wizard-description').fill('work on the tagged revision')
  await page.getByTestId('stepper-next').click()
  // 确认页把 ref 念回来——用户核对的就是这一行。
  await expect(page.getByTestId('wizard-summary-space')).toContainText(`${fixtureRepoUrl} @ v9.0.0`)
  await page.getByTestId('wizard-launch').click()
  await page.waitForURL(/\/tasks\/[0-9A-Z]{26}$/i)
  const okTaskId = page.url().split('/').at(-1)!
  const okTask = await waitWorktree(okTaskId)
  expect(okTask.baseBranch, '任务必须记住用户选的基线 ref').toBe('v9.0.0')
  // 判据落在盘上：`RELEASE.md` 只存在于 v9.0.0 指向的那个提交。ref 被忽略、退回默认
  // 分支时这个文件不会出现——而那正是「静默在错误基线上干活」的样子。
  expect(
    readFileSync(join(okTask.worktreePath, 'RELEASE.md'), 'utf-8'),
    '工作树必须检出在选定的 ref 上',
  ).toContain('only on release/v9')

  // ---- ② 非法 ref：同步 422，横幅带服务端原话 + 可用引用，且不铸任务行 -------
  const badLaunchPosts: string[] = []
  page.on('request', (request: Request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/agents/${agent.id}/tasks`
    ) {
      badLaunchPosts.push(request.url())
    }
  })
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=agent&agentId=${agent.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await page.getByTestId('wizard-space-remote').click()
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: fixtureRepoUrl, exact: true }).click()
  await page.getByTestId('repo-source-ref-0').fill(badRef)
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill(badName)
  await page.getByTestId('wizard-description').fill('this launch must be refused')
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-launch').click()

  const failure = page.getByTestId('wizard-submit-error')
  await expect(failure).toBeVisible()
  // 三层都要有：本地化标题（用户看得懂）、服务端原话（点名是哪个 ref）、可用引用
  // （告诉用户该改成什么）。只剩标题的话，用户只知道「有个 ref 不对」。
  await expect(failure).toContainText('The requested ref was not found in the repository.')
  await expect(failure).toContainText(badRef)
  await expect(failure).toContainText('Available branches/refs:')
  await expect(failure).toContainText('main')
  await expect(page, '被拒的启动必须留在向导上，不许跳去一个不存在的任务').toHaveURL(/\/tasks\/new/)
  expect(badLaunchPosts.length, '这条被拒的启动确实发出去过（否则下面的断言零预言力）').toBe(1)
  expect(countTasksNamed(badName), 'ref 解析失败发生在物化之前，不许留下任务行').toBe(0)
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-13：深链带着已经过期的工作流版本进向导时拦住启动，并把人送回编辑器校验最新版 @nightly', async ({
  page,
}) => {
  const workflow = await createWorkflow('stale-deeplink', [
    { kind: 'text', key: 'topic', label: 'Topic', required: true },
  ])
  const bumped = await bumpWorkflow(workflow.id, workflow.version, (definition) => {
    const nodes = definition.nodes as Array<Record<string, unknown>>
    const agentNode = nodes.find((node) => node.id === 'agent_1')!
    agentNode.promptTemplate = `${String(agentNode.promptTemplate)}\n(revised)`
    return definition
  })
  expect(bumped).toBe(workflow.version + 1)

  await primeAuth(page)
  const material = page.locator('fieldset.task-wizard__material')

  // 正向对照：**不带**版本参数进同一个工作流时，表单是可编辑的。没有这一段，
  // 下面的「整张表单冻结」对一个永远冻着的向导同样成立（那就是一条恒真断言）。
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=workflow&workflow=${workflow.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await expect(page.getByTestId('wizard-space-scratch')).toBeEnabled()
  await expect(page.getByTestId('wizard-workflow-version-mismatch')).toHaveCount(0)

  // 深链带着 v1（编辑器交接时校验过的那一版），而工作流现在已经是 v2。
  await page.goto(
    `${daemon.baseUrl}/tasks/new?kind=workflow&workflow=${workflow.id}&workflowVersion=${workflow.version}`,
  )
  await expect(page.getByTestId('task-wizard')).toBeVisible()

  // 横幅要把两个版本号都说出来——只说「版本变了」的话，用户不知道自己手上这份是哪一版。
  const mismatch = page.getByTestId('wizard-workflow-version-mismatch')
  await expect(mismatch).toBeVisible()
  await expect(mismatch).toContainText(
    `This launch was prepared for v${workflow.version}, but the workflow is now v${bumped}.`,
  )

  // 拦法比「只置灰启动键」更彻底：向导**从不采纳**这一版快照，于是草稿基线立不起来，
  // 整块 material fieldset 保持冻结——用户连空间都改不了，更不可能拿 v1 的表单发车。
  await expect(material, '快照过期时整张表单必须冻结').toHaveAttribute('disabled', '')
  const scratchCard = page.getByTestId('wizard-space-scratch')
  await expect(scratchCard).toBeDisabled()
  // 置灰这件事本身与「灰着也真的点不动」是两条断言（`docs/dev-gotchas.md` 同名教训）。
  await scratchCard.click({ force: true })
  await expect(page.getByTestId('stepper-step-space'), '冻结期间步骤不许被推进').toHaveAttribute(
    'aria-current',
    'step',
  )
  await expect(page.getByTestId('stepper-next')).toBeDisabled()

  // 恢复路径：编辑器交接来的深链带着确切版本，所以这里给的是「回编辑器校验」，
  // 不是「就用最新版」——后者会让用户在没看过改动的情况下直接发车。
  // 按钮住在 fieldset 之外的反馈区，所以冻结期间它仍然可点。
  const recover = page.getByTestId('wizard-workflow-version-recover')
  await expect(recover).toHaveText('Return to editor and validate')
  await recover.click()
  await expect(page).toHaveURL(new RegExp(`/workflows/${workflow.id}(\\?|$)`))
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-13：提交瞬间工作流被改掉时后端 409，向导报「没有创建任务」并支持载入最新版重来 @nightly', async ({
  page,
}) => {
  const workflow = await createWorkflow('submit-conflict', [
    { kind: 'text', key: 'topic', label: 'Topic', required: true },
  ])
  const detailPath = `/api/workflows/${workflow.id}`
  const conflictName = `Submit conflict ${RUN_TAG}`
  const retryName = `Submit conflict retry ${RUN_TAG}`

  // 在 Node 侧预取 v1 的**真实**响应（锁 A：handler 里只 fulfill，绝不 route.fetch）。
  const v1Body = JSON.stringify(await api<unknown>(detailPath))

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=workflow&workflow=${workflow.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await page.getByTestId('wizard-space-scratch').click()
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill(conflictName)
  await page
    .locator('label.form-field', { hasText: 'Topic' })
    .locator('input.form-input')
    .fill('validated against v1')
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')

  // 把这一条 pathname 钉在 v1 上：向导每 15s 会重取工作流详情，不钉住就会在版本被改
  // 之后自己发现失配、把启动键置灰——那考的是**进入时**那条横幅，不是提交时的 409。
  // 页面看到的仍是服务端真给过的那一份响应，POST 一个字节都没被拦。
  await page.route(
    (url) => url.pathname === detailPath,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: v1Body })
    },
  )

  // 真·并发写：另一个人在这一刻改了工作流。
  const bumped = await bumpWorkflow(workflow.id, workflow.version, (definition) => {
    const inputs = definition.inputs as WorkflowInputDef[]
    inputs.push({ kind: 'text', key: 'rationale', label: 'Rationale', required: true })
    const nodes = definition.nodes as Array<Record<string, unknown>>
    nodes.push({
      id: 'in_rationale',
      kind: 'input',
      inputKey: 'rationale',
      position: { x: 0, y: 300 },
    })
    const edges = definition.edges as Array<Record<string, unknown>>
    edges.push({
      id: 'e_in_rationale',
      source: { nodeId: 'in_rationale', portName: 'rationale' },
      target: { nodeId: 'agent_1', portName: 'rationale' },
    })
    const agentNode = nodes.find((node) => node.id === 'agent_1')!
    agentNode.promptTemplate = `${String(agentNode.promptTemplate)}\nrationale=<<{{rationale}}>>`
    return definition
  })
  expect(bumped).toBe(workflow.version + 1)

  await page.getByTestId('wizard-launch').click()

  const submitError = page.getByTestId('wizard-workflow-submit-version-error')
  await expect(submitError).toBeVisible()
  // 「没有创建任务」这句话是这条横幅存在的全部意义：用户下一步该做什么，取决于
  // 到底建没建。说错了，用户要么重复发车，要么以为任务丢了。
  await expect(submitError).toContainText(
    'The workflow changed while the task was starting, so no task was created.',
  )
  expect(countTasksNamed(conflictName), '409 发生在物化之前，不许留下任务行').toBe(0)

  // 摘掉钉子，走恢复路径：载入最新版。
  await page.unrouteAll({ behavior: 'wait' })
  const recover = page.getByTestId('wizard-workflow-submit-version-recover')
  await expect(recover).toHaveText('Load and review latest version')
  await recover.click()

  // 采纳最新版必须把人**送回内容步骤**并重画表单：v2 多了一个必填输入，
  // 直接放行提交等于拿一份缺字段的表单再发一次车。
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')
  await expect(page.getByTestId('wizard-workflow-submit-version-error')).toHaveCount(0)
  const rationale = page
    .locator('label.form-field', { hasText: 'Rationale' })
    .locator('input.form-input')
  await expect(rationale, '采纳最新版之后 v2 新增的输入必须出现在表单里').toBeVisible()
  await expect(page.getByTestId('stepper-next'), 'v2 的新必填输入还空着时不许放行').toBeDisabled()

  await rationale.fill('reviewed the new revision')
  await page.getByTestId('wizard-task-name').fill(retryName)
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-launch').click()
  await page.waitForURL(/\/tasks\/[0-9A-Z]{26}$/i)
  const retryTaskId = page.url().split('/').at(-1)!
  const retryTask = await fetchTask(retryTaskId)
  // 重来那一次必须落在 v2 上——落回 v1 就说明「采纳」只改了界面没改栅栏。
  expect(retryTask.workflowVersion).toBe(bumped)
  expect(retryTask.inputs.rationale).toBe('reviewed the new revision')
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-14：代码仓步骤的工作分支与高级折叠区的协作者 / 自动提交推送 / 最长时长 / token 上限逐项进入启动载荷并落库，git 身份由服务端从账户冻结 @nightly', async ({
  page,
}) => {
  const agent = await createAgent('advanced')
  const taskName = `Advanced fold ${RUN_TAG}`
  const workingBranch = `feature/wizard-advanced-${RUN_TAG}`

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=agent&agentId=${agent.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  // 工作分支与自动提交推送只在「远程仓库」空间下才有意义，也只在那里渲染。
  await page.getByTestId('wizard-space-remote').click()
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: fixtureRepoUrl, exact: true }).click()
  const workingBranchInput = page.getByTestId('wizard-working-branch')
  await expect(workingBranchInput).toBeVisible()
  await expect(workingBranchInput.locator('xpath=ancestor::details')).toHaveCount(0)
  await workingBranchInput.fill(workingBranch)
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')

  await page.getByTestId('wizard-task-name').fill(taskName)
  await page.getByTestId('wizard-description').fill('exercise every advanced field')

  const advanced = page.getByTestId('wizard-advanced')
  await advanced.locator('summary').click()

  // ① 协作者。
  await page.getByTestId('wizard-collaborators-input').fill(peerUsername)
  await page.getByTestId(`wizard-collaborators-option-${peerUsername}`).click()
  await expect(page.getByTestId(`wizard-collaborators-remove-${peerUsername}`)).toBeVisible()

  // ② 自动提交推送 ③ 最长时长 ④ token 上限。
  await advanced
    .locator('label.form-switch', { hasText: 'Auto commit & push on completion' })
    .locator('input[type="checkbox"]')
    .check()
  await page.getByTestId('wizard-max-duration').fill('7')
  await page.getByTestId('wizard-max-tokens').fill('12345')

  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')

  // 工作分支跟随代码仓摘要；其余四项仍在高级摘要里复核。
  await expect(page.getByTestId('wizard-summary-working-branch')).toContainText(workingBranch)
  const advancedSummary = page.getByTestId('wizard-summary-advanced')
  await expect(advancedSummary).toContainText('1 collaborator')
  await expect(advancedSummary).not.toContainText(workingBranch)
  await expect(advancedSummary).toContainText('Auto commit & push on completion')
  await expect(advancedSummary).toContainText('Max duration (minutes): 7')
  await expect(advancedSummary).toContainText('Max total tokens: 12345')
  // git 身份不是折叠区里的输入项，而是服务端从账户档案取的只读事实（RFC-320）。
  await expect(page.getByTestId('wizard-summary-git-identity')).toHaveText(
    `${ADMIN_DISPLAY_NAME} <${ADMIN_EMAIL}>`,
  )

  const launchRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/agents/${agent.id}/tasks`,
  )
  await page.getByTestId('wizard-launch').click()
  const launched = await launchRequest
  // `collectAdvanced()` 是一张白名单，漏拷一行就静默丢一项（本仓有过前科）。
  // 逐项断言 wire 上的确切键值，而不是「控件能填」。
  expect(launched.postDataJSON()).toMatchObject({
    name: taskName,
    workingBranch,
    autoCommitPush: true,
    maxDurationMs: 7 * 60_000,
    maxTotalTokens: 12345,
    collaboratorUserIds: [peerUserId],
  })

  await page.waitForURL(/\/tasks\/[0-9A-Z]{26}$/i)
  const taskId = page.url().split('/').at(-1)!
  const task = await fetchTask(taskId)
  // 再从库里对一遍：wire 对而持久化丢字段，用户看到的是「我明明设过时长上限」。
  expect({
    workingBranch: task.workingBranch,
    autoCommitPush: task.autoCommitPush,
    maxDurationMs: task.maxDurationMs,
    maxTotalTokens: task.maxTotalTokens,
    gitUserName: task.gitUserName,
    gitUserEmail: task.gitUserEmail,
  }).toEqual({
    workingBranch,
    autoCommitPush: true,
    maxDurationMs: 7 * 60_000,
    maxTotalTokens: 12345,
    gitUserName: ADMIN_DISPLAY_NAME,
    gitUserEmail: ADMIN_EMAIL,
  })
  const members = await api<{
    owner: { id: string }
    members: Array<{ user: { id: string }; role: string }>
  }>(`/api/tasks/${taskId}/members`)
  // 协作者不是一个展示字段——它决定谁能回评审 / 反问。没真授权就是一次空点。
  expect(
    members.members.filter((member) => member.role === 'collaborator').map((m) => m.user.id),
  ).toEqual([peerUserId])
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-11：提交结果未知时向导冻结并弹对账横幅，「去清单核对」与「我已确认」各自收口，库里只落了一条任务 @nightly', async ({
  page,
  browserName,
}) => {
  const agent = await createAgent('reconcile')
  const launchPath = `/api/agents/${agent.id}/tasks`
  const taskName = `Outcome unknown ${RUN_TAG}`

  expect(countTasksNamed(taskName), '前提复核：这个任务名此前不存在').toBe(0)

  let browserPosts = 0
  let committedTaskId = ''
  // 只拦这一条 pathname；handler 里只有一次 `fulfill`，回源在 Node 侧完成（锁 A）。
  await page.route(
    (url) => url.pathname === launchPath,
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      browserPosts += 1
      // 服务端**确实**把任务落了库；浏览器只拿到一个 502。这正是「答案丢了但写入
      // 生效了」的现场——用户此刻无从判断该不该重发。
      committedTaskId = (await replayRawJson(launchPath, route.request().postData() ?? '')).id
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'bad-gateway',
          message: 'rfc319-task11: the response never came back',
        }),
      })
    },
  )

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/new?kind=agent&agentId=${agent.id}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await page.getByTestId('wizard-space-scratch').click()
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill(taskName)
  await page.getByTestId('wizard-description').fill('the response to this launch gets lost')
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-launch').click()

  // ① 对账横幅：必须点名是哪一次提交（任务名），否则用户对着一堆任务无从核对。
  //
  // 不按 `wizard-outcome-unknown` 定位，改按文案 + `.notice-banner`：本用例落地时
  // `tasks.new.tsx:2072` 把该锚点写成 `data-testid=` 传给只认 `testid=` 的
  // `<NoticeBanner>`（带连字符的 JSX 属性名 TS 不做 props 校验），锚点从未进 DOM。
  // 该缺陷已在随后一提交里修好（连同另外三处），并由
  // `packages/frontend/tests/jsx-dropped-data-attr-guard.test.ts` 上锁；这里保留按
  // 文案定位不改——它锁的是「横幅必须点名是哪一次提交」这件事，比锚点本身更接近用户。
  const banner = page
    .locator('.notice-banner')
    .filter({ hasText: 'Task request result is unknown' })
  await expect(banner).toHaveCount(1)
  await expect(banner).toContainText(taskName)

  // ② 冻结：启动键必须死掉、整块表单必须锁住。用户的本能是再点一次——那就是重复派工。
  const launch = page.getByTestId('wizard-launch')
  await expect(launch, '结果未知期间启动键必须置灰').toBeDisabled()
  await expect(page.locator('fieldset.task-wizard__material')).toHaveAttribute('disabled', '')
  await launch.click({ force: true })
  // 确认页上「回去改」的入口同样必须锁住——改完再提交就是第二次派工。
  await expect(page.getByTestId('wizard-summary-edit-2')).toBeDisabled()
  expect(browserPosts, '冻结期间不许再发第二次启动请求').toBe(1)

  // ③ 收口路径 A：「去清单核对」在新标签页打开任务清单，用户在那里看到它已经建成了。
  const inventory = page.getByTestId('wizard-reconcile-inventory')
  await expect(inventory).toHaveAttribute('href', '/tasks')
  await expect(inventory).toHaveAttribute('target', '_blank')
  // Chromium's full tier owns the native target=_blank activation. Playwright
  // WebKit on macOS closes its automation context as soon as it activates a
  // noreferrer native window (before either `page` or `popup` can be observed),
  // so that engine verifies the authored href/target above and opens the same
  // same-origin destination through the context API instead.
  const popup =
    browserName === 'webkit'
      ? await page.context().newPage()
      : (await Promise.all([page.waitForEvent('popup'), inventory.click()]))[0]
  if (browserName === 'webkit') await popup.goto(`${daemon.baseUrl}/tasks`)
  await popup.waitForLoadState('domcontentloaded')
  expect(committedTaskId, '前提复核：服务端确实已经把这次提交落了库').not.toBe('')
  await expect(
    popup.getByTestId(`task-row-${committedTaskId}`),
    '对账清单里必须能看到这条已经提交成功的任务',
  ).toBeVisible()
  await expect(
    popup.locator('[data-testid^="task-row-"]').filter({ hasText: taskName }),
    '同名任务只允许出现一行——出现两行就是重复派工',
  ).toHaveCount(1)
  await popup.close()

  // ④ 库里核对：服务端只落了一条。这一格才是整条用例的判据——横幅再漂亮，
  //    真发生重复派工也照样白搭。
  expect(countTasksNamed(taskName), '同一次提交只允许在库里落一条任务').toBe(1)

  // ⑤ 收口路径 B：「我已确认」把对账标记清掉，向导恢复可用。不恢复的话，
  //    用户只能刷新页面——而刷新会把草稿再拿出来问一遍。
  await page.getByTestId('wizard-reconcile-finish').click()
  await expect(banner, '收口之后对账横幅必须消失').toHaveCount(0)
  await expect(page.getByTestId('wizard-reconcile-finish')).toHaveCount(0)
  await expect(page.getByTestId('wizard-launch')).toBeEnabled()
  const reconciliationLeft = await page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) =>
      candidate.startsWith('aw:task-wizard-draft:v1:'),
    )
    if (key === undefined) return 'no-draft'
    const raw = window.sessionStorage.getItem(key)
    if (raw === null) return 'no-draft'
    return (JSON.parse(raw) as { reconciliation?: unknown }).reconciliation === undefined
      ? 'cleared'
      : 'still-there'
  })
  expect(reconciliationLeft, '收口之后草稿里不许再留着对账标记').not.toBe('still-there')
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-08：终态任务一键重放，向导按源任务预填执行对象 / 内容 / 限额 / 协作者，再启动得到一条等价的新任务 @nightly', async ({
  page,
}) => {
  const agent = await createAgent('relaunch')
  const sourceName = `Relaunch source ${RUN_TAG}`
  const description = `replayed prompt ${RUN_TAG}`
  const source = await api<{ id: string }>(`/api/agents/${agent.id}/tasks`, {
    method: 'POST',
    body: {
      name: sourceName,
      description,
      scratch: true,
      allowClarify: false,
      collaboratorUserIds: [peerUserId],
      maxDurationMs: 11 * 60_000,
      maxTotalTokens: 54321,
    },
  })
  const sourceTask = await waitTerminal(source.id)
  expect(TERMINAL.has(sourceTask.status)).toBe(true)

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/${source.id}`)
  const relaunch = page.getByTestId('task-detail-relaunch')
  await expect(relaunch, '终态任务的详情页必须给出一键重放入口').toBeVisible()
  await relaunch.click()
  await page.waitForURL(/\/tasks\/new\?/)
  expect(new URL(page.url()).searchParams.get('relaunchFrom')).toBe(source.id)

  // 重放落在第一步，且执行对象已经是源任务用的那个代理——预填掉了的话，
  // 「一键重放」实际上是「重新填一遍」。
  await expect(page.getByTestId('stepper-step-mode')).toHaveAttribute('aria-current', 'step')
  await expect(page.getByTestId('wizard-object-agent')).toContainText(agent.name)

  await page.getByTestId('stepper-step-space').click()
  await expect(
    page.getByTestId('wizard-scratch-hint'),
    '源任务是临时空间，重放也应是',
  ).toBeVisible()

  await page.getByTestId('stepper-step-content').click()
  await expect(page.getByTestId('wizard-task-name')).toHaveValue(sourceName)
  await expect(page.getByTestId('wizard-description')).toHaveValue(description)
  await page.getByTestId('wizard-advanced').locator('summary').click()
  await expect(page.getByTestId('wizard-max-duration')).toHaveValue('11')
  await expect(page.getByTestId('wizard-max-tokens')).toHaveValue('54321')
  // 协作者来自源任务的**当前**成员表（不是启动时的快照）——这条链断了，重放出来的
  // 任务只有发起人能回评审。
  await expect(page.getByTestId(`wizard-collaborators-remove-${peerUsername}`)).toBeVisible()

  const relaunchName = `Relaunch target ${RUN_TAG}`
  await page.getByTestId('wizard-task-name').fill(relaunchName)
  await page.getByTestId('stepper-step-confirm').click()
  await page.getByTestId('wizard-launch').click()
  await page.waitForURL(/\/tasks\/[0-9A-Z]{26}$/i)
  const replayId = page.url().split('/').at(-1)!
  expect(replayId).not.toBe(source.id)

  const replay = await fetchTask(replayId)
  expect({
    description: replay.inputs.description,
    maxDurationMs: replay.maxDurationMs,
    maxTotalTokens: replay.maxTotalTokens,
  }).toEqual({
    description,
    maxDurationMs: 11 * 60_000,
    maxTotalTokens: 54321,
  })
  const members = await api<{ members: Array<{ user: { id: string }; role: string }> }>(
    `/api/tasks/${replayId}/members`,
  )
  expect(
    members.members.filter((member) => member.role === 'collaborator').map((m) => m.user.id),
  ).toEqual([peerUserId])
})

// ---------------------------------------------------------------------------

test('RFC-319 TASK-08：重放多仓任务用的是源任务冻结的布局——仓库组事后被改成单仓，重启出来的仍是原来那两仓 @nightly', async ({
  page,
}) => {
  const workflow = await createWorkflow('replay-space', [
    { kind: 'text', key: 'topic', label: 'Topic' },
  ])
  const groupName = `rfc319-wizard-group-${RUN_TAG}`
  const group = await api<{ id: string; version: number }>('/api/repo-groups', {
    method: 'POST',
    body: {
      name: groupName,
      description: '',
      nodes: [
        { path: '', attachment: { kind: 'repo', repoUrl: fixtureRepoUrl } },
        { path: 'vendor', attachment: null },
        { path: 'vendor/sdk', attachment: { kind: 'repo', repoUrl: vendorRepoUrl } },
      ],
    },
  })

  const sourceName = `Replay source ${RUN_TAG}`
  const source = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: { workflowId: workflow.id, name: sourceName, inputs: {}, repoGroupId: group.id },
  })
  const sourceTask = await waitWorktree(source.id)
  expect(sourceTask.repoCount, '源任务必须真的是两仓，否则下面的冻结断言零预言力').toBe(2)
  expect(sourceTask.repos.map((repo) => repo.mountPath).sort()).toEqual(['', 'vendor/sdk'])
  await waitTerminal(source.id)

  // 把仓库组**改小**成单仓。重启若读的是当前组定义，新任务就会变成一仓；
  // 读源任务冻结的 `task_repos` 才会仍是两仓。这一步是整条用例的判据来源。
  await api(`/api/repo-groups/${group.id}`, {
    method: 'PUT',
    body: {
      name: groupName,
      description: '',
      expectedVersion: group.version,
      nodes: [{ path: '', attachment: { kind: 'repo', repoUrl: fixtureRepoUrl } }],
    },
  })
  const shrunk = await api<{ flatRepoCount: number }>(`/api/repo-groups/${group.id}`)
  expect(shrunk.flatRepoCount, '前提复核：仓库组确实已经被改成单仓').toBe(1)

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/${source.id}`)
  await page.getByTestId('task-detail-relaunch').click()
  await page.waitForURL(/\/tasks\/new\?/)

  await page.getByTestId('stepper-step-space').click()
  // 重放空间是一张**只读**卡片：它指向源任务，而不是任何一个仓库组——组会被改、
  // 会被删，而「再跑一次刚才那个」要的是当时那份布局。
  const replayCard = page.getByTestId('wizard-space-replay')
  await expect(replayCard).toBeVisible()
  await expect(replayCard).toContainText(source.id)
  await expect(replayCard).toContainText('Reuse task layout')
  await expect(page.getByTestId('repo-source-row-0'), '重放空间下不该再渲染仓库选择行').toHaveCount(
    0,
  )

  const replayName = `Replay target ${RUN_TAG}`
  await page.getByTestId('stepper-step-content').click()
  await page.getByTestId('wizard-task-name').fill(replayName)
  await page.getByTestId('stepper-step-confirm').click()
  await expect(page.getByTestId('wizard-summary-space')).toContainText(
    `Reuse the repo layout of task ${source.id}`,
  )

  const launchRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks',
  )
  await page.getByTestId('wizard-launch').click()
  const launched = await launchRequest
  const body = launched.postDataJSON() as Record<string, unknown>
  // wire 上只能是 `sourceTaskId`：发 `repoGroupId` 会读到已经被改小的当前定义，
  // 发 `repos[]` 则会被 422 硬拒（RFC-248 已退役）。
  expect(body.sourceTaskId).toBe(source.id)
  expect(body.repoGroupId).toBeUndefined()

  await page.waitForURL(/\/tasks\/[0-9A-Z]{26}$/i)
  const replayId = page.url().split('/').at(-1)!
  const replayTask = await waitWorktree(replayId)
  expect(replayTask.repoCount, '重启必须复现源任务冻结的两仓布局，而不是当前组定义').toBe(2)
  expect(replayTask.repos.map((repo) => repo.mountPath).sort()).toEqual(['', 'vendor/sdk'])
})

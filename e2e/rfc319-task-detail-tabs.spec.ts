// RFC-319 —— 任务详情页的各个页签与运维动作。
//
// 这一域的共同点是「任务已经跑完（或卡住）之后，人在详情页上还能做什么」：
// 把产出物读出来（Outputs / Markdown 预览）、把自动提交的回执读明白（commit&push 行）、
// 把变更读懂（变更叙述）、以及四条运维出口（单节点重试 / 重试仓库准备 /
// 解除自动恢复隔离 / 同步最新工作流定义）。它们的失效形态都是**静默的**——
// 按钮点下去什么也没发生、横幅挂在那里但动作是空头支票、开关拨到另一边结果却一样——
// 而这些正是浏览器 e2e 之外任何一层都照不到的地方。
//
// 判据取自源码单一事实源（读的时候按 file:line 复核，勿凭记忆）：
//   packages/frontend/src/components/TaskOutputPanel.tsx:215        showDownload = 文件 kind ∧ 单行值
//   packages/frontend/src/components/TaskOutputPanel.tsx:223-232    预览源三分支（artifact / file / port）
//   packages/frontend/src/lib/output-port.ts:11-27                  isFileOutputKind / isSingleLinePath
//   packages/frontend/src/lib/markdown-preview.ts:40-57             isMarkdownPreviewable
//   packages/frontend/src/lib/markdown-preview.ts:102-124           resolvePreviewSource：三参数 = artifact
//   packages/frontend/src/routes/tasks.preview.tsx:97-155           artifact 源；404 回退 file 源
//   packages/frontend/src/routes/tasks.detail.tsx:1924-1990         commit&push 行：结果 chip / 排除项 / 会话入口
//   packages/frontend/src/routes/tasks.detail.tsx:1066-1081         只读成员被改动的警告横幅
//   packages/frontend/src/routes/tasks.detail.tsx:715-744           卡在仓库准备的横幅 + 「重试准备」按钮
//   packages/frontend/src/routes/tasks.detail.tsx:2107-2119         findRepoPrepRetryTarget：只认**最新**那条准备行
//   packages/frontend/src/components/NodeDetailDrawer.tsx:117-124   retry?cascade=<开关>
//   packages/frontend/src/components/tasks/RecoverySection.tsx:80-95 隔离态 + 一键解除
//   packages/frontend/src/components/tasks/WorkflowSyncBanner.tsx:70-124 「工作流已更新」横幅 + 同步
//   packages/frontend/src/components/changes/ChangeNarrativeCard.tsx:78-160 变更叙述四态
//   packages/backend/src/services/recoveryBreaker.ts:23-96          隔离标志的读 / 置 / 清
//   packages/backend/src/services/autoResume.ts:175,207            隔离中的任务被 boot auto-resume 跳过
//   packages/backend/src/services/task.ts:5455-5490                cascade=true 才把下游算进重铸集合
//   packages/backend/src/services/task.ts:5384-5445                `__repo_prep__` 走自己的重试路径
//   packages/backend/src/services/changeNarrative.ts:311-330       ready 从磁盘缓存读；404 = 按钮态
//   packages/backend/src/services/scheduler.ts:2123-2135           只读成员的脏检查落 readonly_dirty_count
//
// 与已落地的姊妹文件的边界（不重复造轮子）：
//   · `e2e/rfc319-worktree-and-commit.spec.ts` 覆盖 REPO-X1（工作目录页签的懒加载 /
//     预览 / 超限下载）与 REPO-X2（变更页签的真实 git diff），以及 REPO-17/19/X3
//     在**远端与回执**层面的自动提交语义。本文件一条都不重复：TASK-33/36 走的是
//     **输出端口与 Markdown 预览**那一面，TASK-X1 走的是**详情页那一行怎么呈现**。
//   · `e2e/rfc319-repo-mirrors-and-launch.spec.ts` 的 REPO-15 只断言「卡在准备时
//     『重试准备』按钮**可见**」。本文件的 TASK-27 接着往下走：点下去、准备真的重跑、
//     任务真的从 failed 里走出来——按钮可见与按钮有用是两件事。
//   · `e2e/crash-recovery.spec.ts` 覆盖 SIGKILL → interrupted → 手动 Resume。
//     本文件的 TASK-30 覆盖的是**自动**恢复被熔断隔离之后的一键放行。
//
// 三处与账本措辞不符、按源码实际写的地方（详见交付报告 ⑤）：
//   * TASK-X1 的「子仓逐项结果」需要一棵真带 submodule 且 submodule 工作树被改脏的
//     任务工作树才可达（commitPushRunner.ts:272 起）。本文件覆盖结果 chip / 排除项 /
//     会话入口三项，子仓那一项如实留空并在报告里点名。
//   * TASK-X2 的「按需生成」在 e2e 里**必然以失败收场**：变更叙述走 runSystemAgent，
//     它的提示词不带 RFC-200 信封 nonce，而所有 stub 都在 `requireOutputOpen` 上
//     exit 3（skeleton.ts:137-143）。所以「按需生成」这一支锁的是**接线**——按钮真的
//     发了 POST、守护进程真的跑了一次生成、界面真的把结果轮询回来并改写了自己。
//     「查看」那一支按产品的真实读路径（磁盘缓存 → GET → ready）写。
//   * 执行模型：**刻意不加** `describe.configure({ mode: 'serial' })`——`fullyParallel`
//     本就是 false，声明顺序即执行顺序；而 serial 会让第一条红之后其余全部
//     `did not run`，变异验证时无法按「红了几条」归因。每条用例**自带夹具**、
//     不依赖前一条留下的任务（Playwright 在任一用例失败后会换 worker 重跑
//     `beforeAll`，daemon 也就换了一个，跨用例状态依赖会在那一刻凭空消失）。

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import {
  initBareGitRepo,
  initGitRepo,
  querySqlite,
  repoRemoteUrl,
  runGit,
  runSqlite,
} from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(300_000)

// ---------------------------------------------------------------------------
// 三个常驻守护进程 —— stub 行为是 daemon 级 env，互斥，所以只能各起一个：
//   matrixDaemon —— `workflow-matrix`：唯一能按声明的 kind 吐出七类端口、
//                    并在工作树里真写出 .md 文件的 stub（mode-workflow-matrix.ts:162）；
//   commitDaemon —— `commit`：agent 真往工作树写文件，自动提交才有内容可提；
//   slowDaemon   —— `slow` + hold 文件：把「这一回合还在飞」做成确定性的。
// TASK-30 需要在同一个 home 上连起三次 daemon，自带自己的守护进程，不在这里。
// ---------------------------------------------------------------------------

let matrixDaemon: DaemonHandle
let commitDaemon: DaemonHandle
let slowDaemon: DaemonHandle

/** `slow` stub 的 hold 文件（存在即挂住这一回合）。 */
let holdDir = ''
let holdFile = ''

const cleanupPaths: string[] = []

const SEED_README = '# rfc-319 task-detail fixture\n'

/** MATRIX_OUTPUT_KINDS 一次吐出的七个端口，**顺序即声明顺序**。 */
const KIND_PORTS = ['text', 'markdown', 'file', 'names', 'documents', 'files', 'done_signal']

interface Fixture {
  agentId: string
  workflowId: string
}

let kindsFixture: Fixture
let chainFixture: Fixture
let retryFixture: Fixture
let commitFixture: Fixture
let slowFixture: Fixture

/** `MATRIX_RUNTIME mode=retry` 的首次失败标记落在这里（必须在工作树之外——重试会
 *  把工作树回滚到 run 之前的快照）。 */
let matrixStateDir = ''

test.beforeAll(async () => {
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-tdt-hold-'))
  holdFile = join(holdDir, 'turn-hold')
  matrixStateDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-tdt-matrix-state-'))
  cleanupPaths.push(holdDir, matrixStateDir)

  matrixDaemon = await startDaemon({
    stubMode: 'workflow-matrix',
    extraEnv: { MATRIX_STATE_DIR: matrixStateDir },
    // 与 `e2e/workflow-matrix.spec.ts` 同源的两个预算：`defaultNodeRetries: 1`
    // 让「首次失败 → 框架自动重试一次 → 成功」成为一条**真实可达**的历史，
    // TASK-26 的级联判据就建在它留下的那条失败尝试上；`sessionRestartBudget: 0`
    // 防止 RFC-313 的乘积把 attempt 次数翻倍。
    configOverrides: { defaultNodeRetries: 1, sessionRestartBudget: 0 },
  })
  commitDaemon = await startDaemon({ stubMode: 'commit' })
  slowDaemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '0', STUB_OPENCODE_HOLD_FILE: holdFile },
  })

  kindsFixture = await seedOutputKindsWorkflow(matrixDaemon)
  chainFixture = await seedChainWorkflow(matrixDaemon)
  retryFixture = await seedRetryChainWorkflow(matrixDaemon)
  commitFixture = await seedPlainWorkflow(commitDaemon, 'rfc319tdt-commit')
  slowFixture = await seedPlainWorkflow(slowDaemon, 'rfc319tdt-slow')
})

test.afterAll(async () => {
  for (const daemon of [matrixDaemon, commitDaemon, slowDaemon]) {
    if (daemon !== undefined) await daemon.stop()
  }
  for (const path of cleanupPaths) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// 本文件不用 `page.route` 注入任何响应（判据一律取真实链路）。这条收尾仍然留着：
// 一旦以后有人加了注入，`docs/dev-gotchas.md` 的「两把锁」里的锁 B 已经就位。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function authHeaders(daemon: DaemonHandle): Record<string, string> {
  return { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' }
}

async function req(daemon: DaemonHandle, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: { ...authHeaders(daemon), ...(init?.headers ?? {}) },
  })
}

async function api<T>(daemon: DaemonHandle, path: string, init?: RequestInit): Promise<T> {
  const res = await req(daemon, path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

interface TaskDto {
  id: string
  status: string
  worktreePath: string
  branch: string
  workflowSnapshot: { nodes?: Array<{ id?: string }> } | null
  repos: Array<{ mountPath: string; readonly: boolean; readonlyDirtyCount: number | null }>
}

interface NodeRunLite {
  id: string
  nodeId: string
  status: string
  retryIndex: number
  rerunCause: string | null
  errorMessage: string | null
  parentNodeRunId: string | null
  commitPush: {
    pushOutcome: string
    commitSha: string | null
    exclusions?: { count: number; paths: string[] }
  } | null
}

interface NodeRunsDto {
  runs: NodeRunLite[]
  outputs: Array<{ nodeRunId: string; port: string; value: string; kind: string | null }>
}

async function seedAgent(
  daemon: DaemonHandle,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  return api<{ id: string }>(daemon, '/api/agents', { method: 'POST', body: JSON.stringify(body) })
}

async function seedWorkflow(
  daemon: DaemonHandle,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  return api<{ id: string }>(daemon, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** MATRIX_OUTPUT_KINDS：一个 agent 节点 + 一个把七个端口全都绑出来的 output 节点。 */
async function seedOutputKindsWorkflow(daemon: DaemonHandle): Promise<Fixture> {
  const name = 'rfc319tdt-kinds'
  const agent = await seedAgent(daemon, {
    name,
    description: 'RFC-319 task-detail output-kinds fixture',
    outputs: KIND_PORTS,
    outputKinds: {
      text: 'string',
      markdown: 'markdown',
      file: 'path<md>',
      names: 'list<string>',
      documents: 'list<markdown>',
      files: 'list<path<md>>',
      done_signal: 'signal',
    },
    readonly: false,
    bodyMd: '',
  })
  const workflow = await seedWorkflow(daemon, {
    name: `${name}-wf`,
    description: 'RFC-319 task-detail output-kinds fixture',
    definition: {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'kind_producer',
          kind: 'agent-single',
          agentId: agent.id,
          agentName: name,
          promptTemplate: 'MATRIX_OUTPUT_KINDS',
          position: { x: 0, y: 0 },
        },
        {
          id: 'final_output',
          kind: 'output',
          ports: KIND_PORTS.map((port) => ({
            name: port,
            bind: { nodeId: 'kind_producer', portName: port },
          })),
          position: { x: 400, y: 0 },
        },
      ],
      edges: KIND_PORTS.map((port) => ({
        id: `${port}_to_output`,
        source: { nodeId: 'kind_producer', portName: port },
        target: { nodeId: 'final_output', portName: port },
      })),
    },
  })
  return { agentId: agent.id, workflowId: workflow.id }
}

/** 两个节点串成一条链：upstream(part) → downstream(answer)。级联开关的判据面。 */
async function seedChainWorkflow(daemon: DaemonHandle): Promise<Fixture> {
  const upstreamName = 'rfc319tdt-chain-up'
  const downstreamName = 'rfc319tdt-chain-down'
  const upstream = await seedAgent(daemon, {
    name: upstreamName,
    description: 'RFC-319 cascade fixture (upstream)',
    outputs: ['part'],
    outputKinds: { part: 'string' },
    readonly: true,
    bodyMd: '',
  })
  const downstream = await seedAgent(daemon, {
    name: downstreamName,
    description: 'RFC-319 cascade fixture (downstream)',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const workflow = await seedWorkflow(daemon, {
    name: 'rfc319tdt-chain-wf',
    description: 'RFC-319 cascade fixture',
    definition: {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'source_a',
          kind: 'agent-single',
          agentId: upstream.id,
          agentName: upstreamName,
          promptTemplate: 'MATRIX_SOURCE_A',
          position: { x: 0, y: 0 },
        },
        {
          id: 'merge',
          kind: 'agent-single',
          agentId: downstream.id,
          agentName: downstreamName,
          promptTemplate: 'MATRIX_MERGE\nparts={{parts}}',
          position: { x: 400, y: 0 },
        },
        {
          id: 'final_output',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'merge', portName: 'answer' } }],
          position: { x: 800, y: 0 },
        },
      ],
      edges: [
        {
          id: 'a_to_merge',
          source: { nodeId: 'source_a', portName: 'part' },
          target: { nodeId: 'merge', portName: 'parts' },
        },
        {
          id: 'merge_to_output',
          source: { nodeId: 'merge', portName: 'answer' },
          target: { nodeId: 'final_output', portName: 'answer' },
        },
      ],
    },
  })
  return { agentId: upstream.id, workflowId: workflow.id }
}

/**
 * 级联开关的判据面：`runtime_worker`（首次失败、框架自动重试后成功）→ `merge`。
 *
 * 为什么必须是「首次失败」这条形状：抽屉里的重试按钮只在**被选中那次 run 处于
 * failed / interrupted / exhausted / canceled** 时才渲染（NodeDetailDrawer.tsx:675-686
 * 的 canRetryNodeRun），而级联开关要能被观察到差别，又要求**下游已经跑完过**。
 * 两者同时成立的唯一真实形态就是「上游有一次失败的历史尝试、后续尝试成功、
 * 下游随之跑完」——用户从 Stats 页签的运行历史里点回那次失败尝试再重试。
 */
async function seedRetryChainWorkflow(daemon: DaemonHandle): Promise<Fixture> {
  const workerName = 'rfc319tdt-retry-worker'
  const mergeName = 'rfc319tdt-retry-merge'
  const worker = await seedAgent(daemon, {
    name: workerName,
    description: 'RFC-319 cascade fixture (first attempt fails)',
    outputs: ['result'],
    outputKinds: { result: 'string' },
    readonly: true,
    bodyMd: '',
  })
  const merge = await seedAgent(daemon, {
    name: mergeName,
    description: 'RFC-319 cascade fixture (downstream)',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const workflow = await seedWorkflow(daemon, {
    name: 'rfc319tdt-retry-wf',
    description: 'RFC-319 cascade fixture',
    definition: {
      $schema_version: 4,
      inputs: [
        {
          kind: 'enum',
          key: 'mode',
          label: 'Runtime mode',
          required: true,
          choices: ['retry'],
          multiSelect: false,
          allowOther: false,
        },
      ],
      nodes: [
        { id: 'mode_input', kind: 'input', inputKey: 'mode', position: { x: 0, y: 0 } },
        {
          id: 'runtime_worker',
          kind: 'agent-single',
          agentId: worker.id,
          agentName: workerName,
          promptTemplate: 'MATRIX_RUNTIME\nmode={{mode}}\ntask={{__task_id__}}',
          position: { x: 300, y: 0 },
        },
        {
          id: 'merge',
          kind: 'agent-single',
          agentId: merge.id,
          agentName: mergeName,
          promptTemplate: 'MATRIX_MERGE\nparts={{parts}}',
          position: { x: 600, y: 0 },
        },
        {
          id: 'final_output',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'merge', portName: 'answer' } }],
          position: { x: 900, y: 0 },
        },
      ],
      edges: [
        {
          id: 'mode_to_worker',
          source: { nodeId: 'mode_input', portName: 'mode' },
          target: { nodeId: 'runtime_worker', portName: 'mode' },
        },
        {
          id: 'worker_to_merge',
          source: { nodeId: 'runtime_worker', portName: 'result' },
          target: { nodeId: 'merge', portName: 'parts' },
        },
        {
          id: 'merge_to_output',
          source: { nodeId: 'merge', portName: 'answer' },
          target: { nodeId: 'final_output', portName: 'answer' },
        },
      ],
    },
  })
  return { agentId: worker.id, workflowId: workflow.id }
}

/** 单节点、单端口的最小工作流（stub 与 MATRIX 无关时用）。 */
async function seedPlainWorkflow(daemon: DaemonHandle, prefix: string): Promise<Fixture> {
  const agent = await seedAgent(daemon, {
    name: `${prefix}-writer`,
    description: 'RFC-319 task-detail fixture',
    outputs: ['answer'],
    readonly: false,
    bodyMd: '',
  })
  const workflow = await seedWorkflow(daemon, {
    name: `${prefix}-wf`,
    description: 'RFC-319 task-detail fixture',
    definition: {
      $schema_version: 3,
      inputs: [],
      nodes: [
        {
          id: 'w',
          kind: 'agent-single',
          agentId: agent.id,
          agentName: `${prefix}-writer`,
          promptTemplate: 'Do the work.',
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
  })
  return { agentId: agent.id, workflowId: workflow.id }
}

/** 一个带 main 的普通夹具仓（只需要被克隆）。 */
function seedPlainRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `aw-rfc319-tdt-${label}-`))
  cleanupPaths.push(repo)
  writeFileSync(join(repo, 'README.md'), SEED_README, 'utf-8')
  initGitRepo(repo, { email: 'e2e@test.local', message: 'rfc-319 seed' })
  return repo
}

/** 一个裸远端 + 一份用来播种的工作副本；推送真的会落在这个裸仓上。 */
function seedBareRemote(label: string, bareDir?: string): string {
  const remote = bareDir ?? mkdtempSync(join(tmpdir(), `aw-rfc319-tdt-${label}-remote-`))
  const work = mkdtempSync(join(tmpdir(), `aw-rfc319-tdt-${label}-work-`))
  cleanupPaths.push(remote, work)
  mkdirSync(remote, { recursive: true })
  initBareGitRepo(remote)
  writeFileSync(join(work, 'README.md'), SEED_README, 'utf-8')
  initGitRepo(work, { email: 'e2e@test.local', message: 'rfc-319 seed' })
  runGit(['remote', 'add', 'origin', remote], work)
  runGit(['push', '-q', '-u', 'origin', 'main'], work)
  return remote
}

async function launchTask(
  daemon: DaemonHandle,
  fixture: Fixture,
  body: Record<string, unknown>,
): Promise<string> {
  // 组启动不接受顶层 `ref`（成员的 ref 在组定义里，多带一个会 422
  // `start-task-ref-not-applicable`）——单仓才默认带上。
  const res = await req(daemon, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: fixture.workflowId,
      ...(body.repoGroupId === undefined ? { ref: 'main' } : {}),
      inputs: {},
      ...body,
    }),
  })
  const text = await res.text()
  expect(res.status, `POST /api/tasks: ${res.status} ${text}`).toBe(201)
  return (JSON.parse(text) as { id: string }).id
}

async function getTask(daemon: DaemonHandle, taskId: string): Promise<TaskDto> {
  return api<TaskDto>(daemon, `/api/tasks/${taskId}`)
}

async function waitForStatus(
  daemon: DaemonHandle,
  taskId: string,
  expected: string,
  message: string,
): Promise<void> {
  await expect
    .poll(async () => (await getTask(daemon, taskId)).status, { timeout: 180_000, message })
    .toBe(expected)
}

async function nodeRunsOf(daemon: DaemonHandle, taskId: string): Promise<NodeRunsDto> {
  return api<NodeRunsDto>(daemon, `/api/tasks/${taskId}/node-runs`)
}

/** 工作流 PUT 要求一个 26 位 Crockford base32 的幂等键（ULID 形状）。 */
function mutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)]! + encoded
    value >>= 5n
  }
  return encoded
}

/** 浏览器会话：与 daemon 同源，token 走 localStorage（前端 api 客户端读它）。 */
async function primePage(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

/** 跑一趟 MATRIX_OUTPUT_KINDS，回来时任务已 done。 */
async function runKindsTask(name: string): Promise<{ taskId: string; producerRunId: string }> {
  const repo = seedPlainRepo(name)
  const taskId = await launchTask(matrixDaemon, kindsFixture, {
    name,
    repoUrl: repoRemoteUrl(repo),
  })
  await waitForStatus(matrixDaemon, taskId, 'done', `${name} 没有跑完 ⇒ 后面的判据无从谈起`)
  const data = await nodeRunsOf(matrixDaemon, taskId)
  const producer = data.runs.find((run) => run.nodeId === 'kind_producer')
  expect(producer, '找不到 kind_producer 的 node_run ⇒ 夹具没有真的跑起来').toBeTruthy()
  return { taskId, producerRunId: producer!.id }
}

// ===========================================================================
// TASK-33 [P2] —— Outputs 页签：端口两栏浏览器 + 复制 + 文件类端口下载 + 预览跳转
// ===========================================================================

test('RFC-319 TASK-33: Outputs 页签按声明顺序列出全部端口，只有「单行文件路径」端口才给下载与预览，复制/下载拿到的是真内容 @nightly', async ({
  page,
  context,
}) => {
  const { taskId } = await runKindsTask('rfc319-task33')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await primePage(page, matrixDaemon)
  await page.goto(`${matrixDaemon.baseUrl}/tasks/${taskId}?tab=outputs`)

  const panel = page.getByTestId('task-outputs-panel')
  await expect(panel, 'Outputs 页签没有渲染端口两栏浏览器').toBeVisible({ timeout: 30_000 })

  // ① 左栏 = 工作流 output 节点声明的端口，**逐个且按声明顺序**。少一个就意味着
  //    某个端口的产出在界面上根本拿不到；顺序错了意味着 collectPorts 的遍历被改写。
  await expect(
    panel.locator('.task-outputs-panel__option-name'),
    '端口列表与工作流声明的七个端口对不上 ⇒ 有端口的产出在界面上取不到',
  ).toHaveText(KIND_PORTS)

  const option = (port: string) =>
    panel.getByTestId(`task-output-option-${KIND_PORTS.indexOf(port)}`)
  const detail = panel.locator('.task-outputs-panel__pre')
  const download = page.getByTestId('task-output-download')
  const preview = page.getByTestId('task-output-preview')

  // ② 默认选中第一个端口（string）：值是真实产出，且**没有**下载 / 预览。
  //    这半场是下面那半场的对照——没有它，「文件端口有下载按钮」在一个所有端口
  //    都给下载按钮的产品上同样成立。
  await expect(detail, '第一个端口的值不是 stub 真实吐出的那个').toHaveText('plain-value')
  await expect(
    download,
    'string 端口也给了下载按钮 ⇒ isFileOutputKind 这道门形同虚设，点下去必然 404',
  ).toHaveCount(0)
  await expect(preview, 'string 端口也给了 Markdown 预览入口 ⇒ 预览判据没有看 kind').toHaveCount(0)

  // ③ 文件端口（path<md> + 单行值）：值是路径本身，下载与预览两个入口都在。
  await option('file').click()
  await expect(detail, '文件端口渲染的不是工作树相对路径').toHaveText(
    'matrix-generated/kinds/one.md',
  )
  await expect(download, '文件端口没有下载按钮 ⇒ 产出物只能看路径、拿不到内容').toBeVisible()
  await expect(preview, '`.md` 文件端口没有预览入口').toBeVisible()

  // ④ `list<path<md>>` 端口的值是**两行**：单行判据一塌，下载按钮就会挂到一个
  //    根本不是路径的值上。这条锁 isSingleLinePath。
  await option('files').click()
  await expect(detail, 'list<path<md>> 端口的值不是两行路径').toHaveText(
    'matrix-generated/kinds/one.md\nmatrix-generated/kinds/two.md',
  )
  await expect(
    page.getByTestId('task-output-download'),
    '多行值也给了下载按钮 ⇒ 点下去会拿两行文本当一个文件名去请求',
  ).toHaveCount(0)

  // ⑤ 复制：内联 markdown 端口的正文要**原样**进剪贴板。只断言按钮文案翻成
  //    「Copied」是不够的——那只证明 copyText 返回了 true。
  await option('markdown').click()
  const copy = page.getByTestId('task-output-copy')
  await copy.click()
  await expect(copy, '复制按钮没有给出成功反馈 ⇒ copyText 返回了 false').toHaveText('Copied!')
  expect(
    await page.evaluate(() => navigator.clipboard.readText()),
    '剪贴板里的内容不是这个端口的值 ⇒ 复制按钮复制的是别的东西',
  ).toBe('# Inline document')

  // ⑥ 下载：文件端口下载下来的必须是**工作树里那个文件的真实字节**，
  //    文件名取路径的 basename。
  await option('file').click()
  const [downloaded] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('task-output-download').click(),
  ])
  expect(downloaded.suggestedFilename(), '下载文件名不是端口值的 basename').toBe('one.md')
  const stream = await downloaded.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(
    Buffer.concat(chunks).toString('utf-8'),
    '下载下来的不是工作树里那个文件的内容 ⇒ 下载按钮取错了源',
  ).toBe('# One file\n')

  // ⑦ 预览跳转：链接必须带齐 artifact 三参数（path + runId + port），
  //    并真的渲染出那份 Markdown。只带 path 会在 wrapper 内节点 / 工作树被回收后失效。
  await page.getByTestId('task-output-preview').click()
  await page.waitForURL(/\/tasks\/[A-Z0-9]{26}\/preview\?/i, { timeout: 30_000 })
  const target = new URL(page.url())
  expect(target.pathname, '预览入口跳错了路由').toBe(`/tasks/${taskId}/preview`)
  expect(
    target.searchParams.get('path'),
    '预览链接没带上文件路径 ⇒ artifact 404 时回退不到工作树',
  ).toBe('matrix-generated/kinds/one.md')
  expect(
    target.searchParams.get('runId'),
    '预览链接没带上来源 run ⇒ 退化成纯文件源，端口归档就白存了',
  ).toBeTruthy()
  expect(target.searchParams.get('port'), '预览链接没带上端口名').toBe('file')
  await expect(
    page.getByRole('heading', { name: 'One file' }),
    '预览页没有把那份 Markdown 渲染出来',
  ).toBeVisible({ timeout: 30_000 })
})

// ===========================================================================
// TASK-36 [P3] —— 独立 Markdown 预览页 /tasks/$id/preview 的四种来源
// ===========================================================================

test('RFC-319 TASK-36: 预览页四种来源各走各的路——文件源读工作树、端口源读产出值、归档源在工作树文件被删后仍渲染、参数不全直接判非法 @nightly', async ({
  page,
}) => {
  const { taskId, producerRunId } = await runKindsTask('rfc319-task36')
  const task = await getTask(matrixDaemon, taskId)
  const oneMd = join(task.worktreePath, 'matrix-generated', 'kinds', 'one.md')
  const twoMd = join(task.worktreePath, 'matrix-generated', 'kinds', 'two.md')
  expect(existsSync(oneMd) && existsSync(twoMd), '夹具没有在工作树里写出两份 .md').toBe(true)

  await primePage(page, matrixDaemon)
  const previewUrl = (search: string): string =>
    `${matrixDaemon.baseUrl}/tasks/${taskId}/preview${search}`

  // ① 文件源（只带 path）：正文从工作树取。
  await page.goto(previewUrl('?path=matrix-generated/kinds/two.md'))
  await expect(
    page.getByRole('heading', { name: 'Two file' }),
    '文件源没有把工作树里那份 .md 渲染出来',
  ).toBeVisible({ timeout: 30_000 })

  // ② 端口源（runId + port）：正文是**端口值本身**，与工作树无关。
  await page.goto(previewUrl(`?runId=${producerRunId}&port=markdown&title=inline-port`))
  await expect(
    page.getByRole('heading', { name: 'Inline document' }),
    '端口源没有把内联 markdown 端口的值渲染出来',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator('.md-preview__title'),
    'title 参数没有被用作页头 ⇒ 分享出去的链接标题是空的',
  ).toHaveText('inline-port')

  // ③ 归档源（path + runId + port）：正文从**发射时的归档**取。
  //    判据必须能把它和文件源区分开——否则「归档源可用」在一个悄悄退回读工作树
  //    的实现上同样成立。做法：把工作树里那个文件删掉，再分别打开两条链接。
  rmSync(oneMd, { force: true })
  expect(existsSync(oneMd), '工作树文件没删掉 ⇒ 下面的区分判据是空洞的').toBe(false)

  await page.goto(previewUrl('?path=matrix-generated/kinds/one.md'))
  await expect(
    page.getByRole('alert'),
    '工作树里的文件已经不在了，纯文件源却仍渲染出正文 ⇒ 这条对照不成立',
  ).toBeVisible({ timeout: 30_000 })

  await page.goto(
    previewUrl(`?path=matrix-generated/kinds/one.md&runId=${producerRunId}&port=file`),
  )
  await expect(
    page.getByRole('heading', { name: 'One file' }),
    '工作树文件被删之后归档源也读不出来 ⇒ 端口归档并没有真的独立于工作树',
  ).toBeVisible({ timeout: 30_000 })

  // ④ 非法链接：参数不全时给的是明确的提示，而不是空白页或永远转圈。
  await page.goto(previewUrl(''))
  await expect(
    page.getByTestId('md-preview-invalid'),
    '参数不全的预览链接没有落到非法提示分支',
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'One file' })).toHaveCount(0)
})

// ===========================================================================
// TASK-X1 [P2] —— 详情页 commit&push 行：结果 chip / 排除项 / 会话入口
// ===========================================================================

test('RFC-319 TASK-X1: 详情页的 commit&push 行如实呈现两种结局——推送成功那行能打开生成 commit message 的会话，被排除那行点名了每一个没进提交的文件 @nightly', async ({
  page,
}) => {
  await primePage(page, commitDaemon)

  // ── 甲：没有排除规则 ⇒ 真提交真推送，行上带「查看会话」入口。
  const remoteA = seedBareRemote('x1-pushed')
  const pushedTask = await launchTask(commitDaemon, commitFixture, {
    name: 'rfc319-x1-pushed',
    repoUrl: repoRemoteUrl(remoteA),
    workingBranch: 'rfc319-x1-pushed',
    autoCommitPush: true,
  })
  await waitForStatus(commitDaemon, pushedTask, 'done', '推送组任务没有跑完')

  await page.goto(`${commitDaemon.baseUrl}/tasks/${pushedTask}?tab=node-runs`)
  const pushedRow = page.getByTestId('commit-push-row')
  await expect(pushedRow, '节点表里没有 commit&push 行 ⇒ 自动提交对用户完全不可见').toBeVisible({
    timeout: 30_000,
  })
  await expect(
    pushedRow.getByTestId('commit-push-outcome'),
    '推送成功却没有渲染成「已推送」⇒ 结果 chip 与真实结局脱钩',
  ).toHaveText('Pushed')
  await expect(
    pushedRow.getByTestId('commit-push-exclusions'),
    '没有配置任何排除规则却渲染了排除项区块',
  ).toHaveCount(0)

  // 「打开生成 commit message 的会话」——这个入口只在框架真的挂了子 node_run
  // 会话时才渲染；点开之后弹窗里要有那次会话，而不是一个空壳。
  const sessionBtn = pushedRow.getByTestId('commit-push-session-btn')
  await expect(
    sessionBtn,
    '推送成功的行上没有会话入口 ⇒ 用户无从知道这条 commit message 是怎么来的',
  ).toBeVisible()
  await sessionBtn.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog, '会话入口点了没有弹出对话框').toBeVisible()
  await expect(
    dialog,
    '会话弹窗里没有那次生成 commit message 的会话内容 ⇒ 入口是空头支票',
  ).toContainText('commit_message', { timeout: 30_000 })

  // ── 乙：把规则改成命中 agent 写的那个文件 ⇒ 同一条链路，结局相反。
  const setExcludes = async (patterns: string[]): Promise<void> => {
    const res = await req(commitDaemon, '/api/config', {
      method: 'PUT',
      body: JSON.stringify({ taskCommitExcludePatterns: patterns }),
    })
    expect(res.ok, `写配置失败：${res.status} ${await res.text()}`).toBe(true)
  }
  await setExcludes(['*.txt'])
  try {
    const remoteB = seedBareRemote('x1-excluded')
    const excludedTask = await launchTask(commitDaemon, commitFixture, {
      name: 'rfc319-x1-excluded',
      repoUrl: repoRemoteUrl(remoteB),
      workingBranch: 'rfc319-x1-excluded',
      autoCommitPush: true,
    })
    await waitForStatus(commitDaemon, excludedTask, 'done', '排除组任务没有跑完')

    await page.goto(`${commitDaemon.baseUrl}/tasks/${excludedTask}?tab=node-runs`)
    const excludedRow = page.getByTestId('commit-push-row')
    await expect(excludedRow, '排除组没有 commit&push 行').toBeVisible({ timeout: 30_000 })
    await expect(
      excludedRow.getByTestId('commit-push-outcome'),
      '所有改动都被排除了，结果 chip 却仍说推送成功 ⇒ 用户会以为产出已经上了远端',
    ).toHaveText('Only excluded changes')
    const exclusions = excludedRow.getByTestId('commit-push-exclusions')
    await expect(exclusions, '被排除了却没有渲染排除项区块').toBeVisible()
    await expect(
      exclusions,
      '排除项区块里没有点名具体路径 ⇒ 用户只知道「被排除了」，不知道少了什么',
    ).toContainText('e2e-change.txt')
  } finally {
    // 收尾：把配置还原，免得同一个 daemon 上后面的用例继承一条排除规则。
    await setExcludes([])
  }
})

// ===========================================================================
// TASK-X2 [P3] —— 变更叙述：尚未生成时的空态 / 按需生成
// ===========================================================================

test('RFC-319 TASK-X2: 尚未生成变更叙述时给的是「生成」按钮而不是空白，点下去真的驱动了一次服务端生成并把结果回写到界面上 @nightly', async ({
  page,
}) => {
  const { taskId } = await runKindsTask('rfc319-taskx2-idle')
  await primePage(page, matrixDaemon)

  // 夹具自证：磁盘上没有叙述、接口给 404 ⇒ 界面现在必须是「按钮态」。
  const before = await req(matrixDaemon, `/api/tasks/${taskId}/change-narrative`)
  expect(before.status, '任务刚跑完就已经有变更叙述了 ⇒ 空态判据无从谈起').toBe(404)

  await page.goto(`${matrixDaemon.baseUrl}/tasks/${taskId}?tab=changes`)
  await expect(page.getByTestId('change-review'), '变更页签没有渲染出来').toBeVisible({
    timeout: 60_000,
  })
  // 判据钉在叙述卡片自己的容器里：`changesNarrativeRetry` 的英文就是裸的
  // "Retry"，页面上另有 ErrorBanner 的同名按钮，不限定作用域会认错人。
  const idle = page.locator('.changes__narrative--idle')
  const generate = idle.getByRole('button', { name: 'Generate AI walkthrough' })
  await expect(
    generate,
    '还没生成过变更叙述时既没有卡片也没有生成按钮 ⇒ 这条能力在界面上根本没有入口',
  ).toBeVisible({ timeout: 60_000 })
  await expect(
    page.getByTestId('change-narrative'),
    '什么都还没生成，却已经渲染出了叙述卡片',
  ).toHaveCount(0)

  // 按需生成：按钮必须真的打到服务端，而不是只在本地翻个 state。
  const [triggered] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === `/api/tasks/${taskId}/change-narrative`,
    ),
    generate.click(),
  ])
  expect(
    triggered.ok(),
    `生成请求被服务端拒了：${triggered.status()} ⇒ 按钮点得动但生成起不来`,
  ).toBe(true)

  // 生成真的在守护进程里跑了一趟：e2e 的 runtime 是 stub，系统代理提示词不带
  // RFC-200 信封 nonce，stub 必然 exit 3（skeleton.ts:137-143），于是这次生成
  // 以 failed 收场。锁的是**接线**：界面轮询回结果并据此改写了自己——按钮文案
  // 从「生成」变成「重试」，并且给出了失败原因。生成永远停在「按钮态」
  // （请求没发出去 / 结果没轮询回来）时这条会红。
  await expect(
    idle.locator('.changes__narrative-error').first(),
    '一次生成跑完了，卡片上却没有任何结果 ⇒ 结果没有被轮询回来，用户点了等于没点',
  ).toHaveText('AI walkthrough generation failed.', { timeout: 60_000 })
  await expect(
    idle.getByRole('button', { name: 'Retry', exact: true }),
    '失败之后按钮文案没有从「生成」改成「重试」⇒ 界面没有按结果改写自己',
  ).toBeVisible()
  await expect(
    idle.getByRole('button', { name: 'Generate AI walkthrough' }),
    '生成已经跑完并失败了，卡片却还停在最初的「生成」按钮上',
  ).toHaveCount(0)
})

test('RFC-319 TASK-X2: 已生成的变更叙述从磁盘缓存读回并完整渲染——总述、阅读顺序与每一步的理由都在，折叠开关真的把正文收走 @nightly', async ({
  page,
}) => {
  const { taskId } = await runKindsTask('rfc319-taskx2-ready')

  // 产品的真实读路径是「磁盘缓存 → GET → ready」（changeNarrative.ts:311-320），
  // 生成侧在 e2e 里不可达（见上一条注释），所以按真实形态把缓存种进去。
  const structural = await api<{ contentDigest?: string }>(
    matrixDaemon,
    `/api/tasks/${taskId}/structural-diff?scope=task`,
  )
  const digest = structural.contentDigest ?? 'unknown'
  const dir = join(matrixDaemon.home, 'structural-diffs', taskId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'narrative-task.json'),
    JSON.stringify({
      version: 1,
      overview: 'rfc319-overview-sentence',
      groups: [],
      readingOrder: [
        { ref: 'matrix-generated/kinds/one.md', why: 'rfc319-why-first' },
        { ref: 'matrix-generated/kinds/two.md', why: 'rfc319-why-second' },
      ],
      generatedAt: Date.now(),
      inputDigest: digest,
    }),
    'utf-8',
  )

  // 夹具自证：接口现在必须报 ready，否则下面断言的是别的东西。
  const status = await api<{ status: string }>(
    matrixDaemon,
    `/api/tasks/${taskId}/change-narrative`,
  )
  expect(status.status, '种下缓存之后接口仍不认为叙述已就绪').toBe('ready')

  await primePage(page, matrixDaemon)
  await page.goto(`${matrixDaemon.baseUrl}/tasks/${taskId}?tab=changes`)
  const card = page.getByTestId('change-narrative')
  await expect(card, '已经有叙述了，变更页签却没有渲染叙述卡片').toBeVisible({ timeout: 60_000 })
  await expect(card, '叙述卡片里没有总述 ⇒ 卡片渲染的是别人的数据').toContainText(
    'rfc319-overview-sentence',
  )
  await expect(
    card.locator('.changes__narrative-order li'),
    '阅读顺序的步数与缓存里的对不上',
  ).toHaveCount(2)
  await expect(
    card.locator('.changes__narrative-order'),
    '阅读顺序里只有 ref 没有 why ⇒ 用户看得到「看哪儿」看不到「为什么」',
  ).toContainText('rfc319-why-second')

  // 折叠是有状态的：收起之后正文必须真的从 DOM 上消失，而不是留着占位。
  await card.locator('.changes__narrative-fold').click()
  await expect(
    card.locator('.changes__narrative-overview'),
    '收起之后总述还在 ⇒ 折叠开关没有作用到内容上',
  ).toHaveCount(0)
})

// ===========================================================================
// TASK-26 [P2] —— 单节点重试 + 级联下游开关
// ===========================================================================

test('RFC-319 TASK-26: 节点抽屉里的重试受「同时重跑下游」开关支配——关掉时下游一行不动，打开时下游被作废并重铸，两侧发出的请求也各带各的 cascade @nightly', async ({
  page,
}) => {
  const repo = seedPlainRepo('task26')
  const taskId = await launchTask(matrixDaemon, retryFixture, {
    name: 'rfc319-task26',
    repoUrl: repoRemoteUrl(repo),
    inputs: { mode: 'retry' },
  })
  await waitForStatus(matrixDaemon, taskId, 'done', '级联夹具任务没有跑完')

  /** 某个节点的每一行 node_run 是**因为什么**被铸出来的（rerunCause 是这条链路的
   *  单一事实源：`retry-node-cascade` 只有级联作废才会写）。 */
  const causesOf = async (nodeId: string): Promise<string[]> =>
    (await nodeRunsOf(matrixDaemon, taskId)).runs
      .filter((run) => run.nodeId === nodeId)
      .map((run) => run.rerunCause ?? '-')

  // 夹具自证：上游留下了「失败一次 + 成功一次」两条历史，下游恰好跑过一次。
  // 少了这两条，下面的「多了几行 / 没多」都失去参照。
  const seededRuns = (await nodeRunsOf(matrixDaemon, taskId)).runs.filter(
    (run) => run.nodeId === 'runtime_worker',
  )
  expect(
    seededRuns.map((run) => run.status).sort(),
    '上游节点没有留下「先失败后成功」的历史 ⇒ 抽屉里根本点不出可重试的那次尝试',
  ).toEqual(['done', 'failed'])
  expect(await causesOf('merge'), '下游节点不是恰好跑过一次').toEqual(['initial'])

  await primePage(page, matrixDaemon)
  await page.goto(`${matrixDaemon.baseUrl}/tasks/${taskId}?tab=workflow-status`)
  await page.waitForSelector('.react-flow__node', { state: 'visible', timeout: 60_000 })

  const cascadeToggle = page.getByRole('checkbox', { name: 'Also re-run downstream nodes' })
  const retryButton = page.getByRole('button', { name: 'Retry node', exact: true })

  // 画布点节点 ⇒ 抽屉停在**最新**那次（成功的）尝试上，此时不该有重试入口；
  // 要重试得先从 Stats 页签的运行历史里点回那次失败的尝试。这两步本身也是判据：
  // 「已成功的尝试也能重试」会让用户对一个好好的节点重做一遍。
  const openFailedAttempt = async (): Promise<void> => {
    await page.locator('.react-flow__node[data-id="runtime_worker"] .canvas-node').click()
    const statsTab = page.getByRole('tab', { name: 'Stats' })
    await expect(statsTab, '点了画布上的节点却没有打开节点抽屉').toBeVisible({ timeout: 30_000 })
    await statsTab.click()
    const history = page.getByTestId('stats-history-list')
    await expect(history, '抽屉的 Stats 页签里没有运行历史 ⇒ 点不回那次失败的尝试').toBeVisible({
      timeout: 30_000,
    })
    await expect(
      retryButton,
      '抽屉停在一次**已成功**的尝试上却给了重试入口 ⇒ 用户会对一个好好的节点重做一遍',
    ).toHaveCount(0)
    await history.locator('button', { hasText: 'Failed' }).first().click()
    await expect(retryButton, '点回失败的那次尝试之后仍然没有重试入口').toBeVisible({
      timeout: 30_000,
    })
  }

  /** 点重试并把它真正发出去的那条请求的 `cascade` 查询参数取回来。 */
  const clickRetry = async (): Promise<string | null> => {
    const [request] = await Promise.all([
      page.waitForRequest(
        (candidate) =>
          candidate.method() === 'POST' &&
          new URL(candidate.url()).pathname.startsWith(`/api/tasks/${taskId}/nodes/`),
      ),
      retryButton.click(),
    ])
    return new URL(request.url()).searchParams.get('cascade')
  }

  // ── 甲：开关**关掉** ⇒ 只有被点的那个节点被作废重铸，下游一行都不新增作废行。
  await openFailedAttempt()
  await expect(
    cascadeToggle,
    '级联开关默认不是勾选态 ⇒ 下面「取消勾选」这一步可能什么都没改',
  ).toBeChecked()
  await cascadeToggle.uncheck()
  expect(
    await clickRetry(),
    '开关拨到「不重跑下游」，发出去的请求却没带上 cascade=false ⇒ 这个复选框没有接到请求上',
  ).toBe('false')
  await waitForStatus(matrixDaemon, taskId, 'done', '关掉级联的重试没有把任务重新收敛到 done')

  // 被点的节点：先落一条 `retry-node` 的作废行，再由引擎复活跑一次。
  expect(
    await causesOf('runtime_worker'),
    '关掉级联之后被点的节点也没有被作废重铸 ⇒ 重试按钮根本没生效，下面的对比无意义',
  ).toEqual(['initial', 'process-retry', 'retry-node', 'revival'])
  // 下游：**没有**任何 `retry-node-cascade` 作废行。它之所以还是跑了一次，是因为
  // 上游产出比它新、引擎按「陈旧重派」自行重跑（scheduler.ts:2565 的 isNodeRunFresh），
  // 与级联开关无关——这正是开关两侧唯一真实的分野。
  expect(
    await causesOf('merge'),
    '关掉了「同时重跑下游」，下游却还是被级联作废了 ⇒ 这个开关是装饰',
  ).toEqual(['initial', 'stale-redispatch'])

  // ── 乙：开关**打开** ⇒ 同一个动作，下游必须被级联作废并重铸。
  await page.reload()
  await page.waitForSelector('.react-flow__node', { state: 'visible', timeout: 60_000 })
  await openFailedAttempt()
  await expect(cascadeToggle, '重开抽屉后级联开关没有回到默认的勾选态').toBeChecked()
  expect(await clickRetry(), '开关停在「同时重跑下游」，发出去的请求却没带上 cascade=true').toBe(
    'true',
  )
  await waitForStatus(matrixDaemon, taskId, 'done', '开着级联的重试没有把任务重新收敛到 done')
  expect(
    await causesOf('merge'),
    '开着「同时重跑下游」，下游却没有被级联作废重铸 ⇒ 开关两侧结果一样，勾不勾都白勾',
  ).toEqual(['initial', 'stale-redispatch', 'retry-node-cascade', 'revival'])
})

// ===========================================================================
// TASK-27 [P2] —— 卡在仓库准备时的横幅与「重试准备」按钮（RFC-287 G7）
// ===========================================================================

// ⚠️ 本条**刻意不断言**「重试之后准备成功」。实测（见交付报告 ⑤）：
// `/api/tasks/:id/nodes/:runId/retry` 的路由没有把 `deps.secretBox` 传进
// `StartTaskDeps`（routes/tasks.ts:998-1006 对比启动路径的
// routes/tasks.ts:321 `buildStartTaskDeps(…, deps.secretBox)`），于是
// `retryRepoPreparation → startTask` 走到 task.ts:1050 的 `unsealRepoUrl` 时拿到
// `secretBox === undefined`，对一条**正常密封**的 `cached_repos.url_enc` 一律返回
// null ⇒ 409 `cached-repo-credential-unavailable`。也就是说在任何启用了
// secret.key 的部署里，RFC-287 AC-11 承诺的这条出口**必然失败**，而且错误文案
// 把原因误导成「密钥不对」。
//
// 所以这里锁的是**与那个缺陷无关、修好之后依然成立**的三件事：按钮打的是合成
// 准备行自己的重试端点且从不级联、服务端真的重新发起了一次准备尝试（铸出新行）、
// 以及旧尝试自此被判为过期。把「必然失败」写进断言会得到一条**阻止修复**的用例。
test('RFC-319 TASK-27: 卡在仓库准备的任务点「重试准备」，打的是合成准备行自己的重试端点（永不级联），服务端真的重新发起一次准备尝试并把上一次判为过期 @nightly', async ({
  page,
}) => {
  // 远端在启动时**还不存在**：克隆必然失败 ⇒ 任务卡在准备。
  // 之后再把它建出来（外部条件修好），重试才不是把上一次的失败原样复读一遍。
  const remoteParent = mkdtempSync(join(tmpdir(), 'aw-rfc319-tdt-prep-'))
  cleanupPaths.push(remoteParent)
  const remoteDir = join(remoteParent, 'late.git')
  const remoteUrl = `${repoRemoteUrl(remoteParent)}/late.git`
  expect(existsSync(remoteDir), '远端在启动前就已经存在 ⇒ 准备根本不会失败').toBe(false)

  const taskId = await launchTask(matrixDaemon, chainFixture, {
    name: 'rfc319-task27',
    repoUrl: remoteUrl,
  })
  await waitForStatus(
    matrixDaemon,
    taskId,
    'failed',
    '拉不动的远端没有把任务收敛成 failed ⇒ 准备失败这一态没出现',
  )
  const stuck = await getTask(matrixDaemon, taskId)
  expect(stuck.worktreePath, '准备失败却已经有了工作树路径 ⇒ 夹具没有落在准备失败这一态').toBe('')
  const prepRuns = (await nodeRunsOf(matrixDaemon, taskId)).runs.filter(
    (run) => run.nodeId === '__repo_prep__',
  )
  expect(prepRuns.length, '没有合成出仓库准备行 ⇒ 重试按钮寻址不到任何 runId').toBe(1)
  expect(prepRuns[0]?.status, '准备行不是失败态').toBe('failed')

  await primePage(page, matrixDaemon)
  await page.goto(`${matrixDaemon.baseUrl}/tasks/${taskId}`)
  const retryPrep = page.getByRole('button', { name: 'Retry repository preparation', exact: true })
  await expect(
    retryPrep,
    '卡在仓库准备却没有「重试准备」的出口 ⇒ 准备行不在工作流图里，画布上永远点不到它',
  ).toBeVisible({ timeout: 30_000 })

  // 把远端真的建出来（外部条件修好），再点重试。
  seedBareRemote('task27-late', remoteDir)
  const stalePrepRunId = prepRuns[0]!.id
  const [retryRequest] = await Promise.all([
    page.waitForRequest(
      (candidate) =>
        candidate.method() === 'POST' &&
        new URL(candidate.url()).pathname.startsWith(`/api/tasks/${taskId}/nodes/`),
    ),
    retryPrep.click(),
  ])
  const retryTarget = new URL(retryRequest.url())
  expect(
    retryTarget.pathname,
    '横幅上的按钮没有寻址到那条合成的准备行 ⇒ 它重试的是别的东西（准备行不在工作流图里，画布上点不到它，这是唯一入口）',
  ).toBe(`/api/tasks/${taskId}/nodes/${stalePrepRunId}/retry`)
  expect(
    retryTarget.searchParams.get('cascade'),
    '重试准备带上了级联 ⇒ 准备是第 0 步，级联作废下游只会白铸一堆行',
  ).toBe('false')

  // 服务端真的**重新发起**了一次准备（铸出一条新的准备行），而不是把旧行原地
  // 改一改、或者只把任务状态翻一下。
  await expect
    .poll(
      async () =>
        (await nodeRunsOf(matrixDaemon, taskId)).runs.filter(
          (run) => run.nodeId === '__repo_prep__',
        ).length,
      { timeout: 60_000, message: '重试没有铸出新的准备行 ⇒ 「重试准备」只是把任务翻了个状态' },
    )
    .toBe(2)
  const afterRuns = (await nodeRunsOf(matrixDaemon, taskId)).runs
    .filter((run) => run.nodeId === '__repo_prep__')
    .sort((a, b) => a.retryIndex - b.retryIndex)
  expect(
    afterRuns.map((run) => run.retryIndex),
    '新的准备尝试没有递增 retryIndex ⇒ 因果尝试序断了，过期判据（repo-prep-superseded）会误判',
  ).toEqual([0, 1])
  expect(
    afterRuns[1]?.errorMessage ?? '',
    '新一次准备原样复读了上一次的 git 报错 ⇒ 外部条件已经修好了它却没有真的重新去拉',
  ).not.toContain('not found')

  // 旧尝试自此过期：对它再点重试必须被拒。少了这道门，一条自然序列
  // （失败 → 重试成功 → 后面某个节点才失败）下点旧行 = 对一个已经准备好的任务
  // 重做准备（task.ts:5424-5437 的实测缺陷）。
  //
  // 先等任务离开 pending/running 再点：`retryNode` 开头有一道**通用**的
  // `task-still-running` 闸（services/task.ts:5346-5357），它排在 `__repo_prep__`
  // 分支的过期判据（:5429）之前。重试真的把准备跑起来之后，紧接着点旧行拿到的是
  // `task-still-running` 而不是 `repo-prep-superseded`——那是闸序使然，不是过期判据
  // 失效。2026-08-26 `3cc81b245` 给重试补上 secretBox（此前凡配了 secret.key 的部署
  // 重试必然 409）之后，这条腿才第一次真的走到「重试成功」，这个先后关系也才浮出来。
  await expect
    .poll(async () => (await getTask(matrixDaemon, taskId)).status, {
      timeout: 180_000,
      message: '任务一直没离开 pending/running ⇒ 过期判据这一段永远够不着',
    })
    .not.toMatch(/^(pending|running)$/)
  const supersededRes = await req(
    matrixDaemon,
    `/api/tasks/${taskId}/nodes/${stalePrepRunId}/retry?cascade=false`,
    { method: 'POST' },
  )
  expect(
    supersededRes.status,
    `已经被新尝试取代的准备行仍可重试（HTTP ${supersededRes.status}）⇒ 用户点历史里的旧行会把准备重做一遍`,
  ).toBe(409)
  expect(((await supersededRes.json()) as { code?: string }).code, '拒了但没给出可分辨的原因').toBe(
    'repo-prep-superseded',
  )
})

// ===========================================================================
// TASK-30 [P2] —— 系统恢复事件区与解除自动恢复隔离
// ===========================================================================

test('RFC-319 TASK-30: 被熔断隔离的任务在恢复事件区里如实标注并给出一键放行——解除之前 boot 自动恢复跳过它，解除之后同一条 boot 路径真的把它跑完 @nightly', async ({
  page,
}) => {
  const repo = seedPlainRepo('task30')
  const startedMarker = `${holdFile}.started`

  // 三次 boot 共用同一个 home：A 起任务并被 SIGKILL；B 观察「隔离中 ⇒ 不自动恢复」
  // 并在界面上解除隔离；C 观察「解除之后 ⇒ 同一条 boot 路径真的把它跑完」。
  const daemonA = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '0', STUB_OPENCODE_HOLD_FILE: holdFile },
    configOverrides: { autoResumeOnBoot: true },
  })
  const home = daemonA.home
  let daemonB: DaemonHandle | undefined
  let daemonC: DaemonHandle | undefined
  try {
    const fixture = await seedPlainWorkflow(daemonA, 'rfc319tdt-recovery')
    rmSync(startedMarker, { force: true })
    writeFileSync(holdFile, '')
    const taskId = await launchTask(daemonA, fixture, {
      name: 'rfc319-task30',
      repoUrl: repoRemoteUrl(repo),
    })
    await expect
      .poll(() => existsSync(startedMarker), {
        timeout: 120_000,
        message: 'stub 一直没起来 ⇒ 任务没有真的在跑，杀掉的不是一个活任务',
      })
      .toBe(true)
    await daemonA.killChild('SIGKILL')

    // 熔断器把这个任务判成 crash-loop 之后的**真实持久形态**
    // （recoveryBreaker.ts:66-82：置 auto_recovery_suspended + 落一行 quarantine 审计）。
    const dbFile = join(home, 'db.sqlite')
    runSqlite(
      dbFile,
      `UPDATE tasks SET auto_recovery_suspended = 1, auto_recovery_attempts = 9 WHERE id = '${taskId}';
       INSERT INTO recovery_events (id, task_id, node_run_id, actor, kind, reason, before_json, after_json, created_at)
       VALUES ('01RFC319TASK30QUARANTINE01', '${taskId}', NULL, 'system', 'quarantine',
               'auto-recovery attempts 9 exceeded 3 per 3600000ms window', NULL, NULL, ${Date.now()});`,
    )
    // `db.exec()` 对多语句脚本里的约束错误不抛异常（事务回滚、零行落库、调用方
    // 看到「成功」）——回读自证，别信它的返回值。
    const seeded = querySqlite<{ suspended: number }>(
      dbFile,
      'SELECT auto_recovery_suspended AS suspended FROM tasks WHERE id = ?',
      [taskId],
    )
    expect(seeded[0]?.suspended, '隔离标志没有落库 ⇒ 下面所有判据都在测另一个东西').toBe(1)
    expect(
      querySqlite<{ n: number }>(
        dbFile,
        "SELECT COUNT(*) AS n FROM recovery_events WHERE task_id = ? AND kind = 'quarantine'",
        [taskId],
      )[0]?.n,
      '隔离审计行没有落库 ⇒ 恢复事件区里没有「被隔离」这条历史',
    ).toBe(1)

    // ── boot B：隔离仍在 ⇒ 自动恢复必须跳过它，任务停在 interrupted。
    daemonB = await startDaemon({
      stubMode: 'slow',
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
      configOverrides: { autoResumeOnBoot: true },
      home,
    })
    rmSync(holdFile, { force: true })
    await waitForStatus(
      daemonB,
      taskId,
      'interrupted',
      'boot 重启没有把被 SIGKILL 的任务收成 interrupted ⇒ 夹具没落到「等待恢复」这一态',
    )
    const recoveryOf = async (
      daemon: DaemonHandle,
    ): Promise<{ events: Array<{ kind: string }>; suspended: boolean }> =>
      api(daemon, `/api/tasks/${taskId}/recovery-events`)
    const recovery = await recoveryOf(daemonB)
    expect(recovery.suspended, '任务明明还隔离着，接口却说没有').toBe(true)
    expect(
      recovery.events.map((event) => event.kind),
      '恢复事件区里没有 boot 重启那次真实的回收记录 ⇒ 事件区只有我种下去的那一行',
    ).toContain('boot-reap')

    // ── 界面：隔离态要显眼（alert）、事件历史要能展开、放行入口要在。
    await primePage(page, daemonB)
    await page.goto(`${daemonB.baseUrl}/tasks/${taskId}`)
    const banner = page.getByTestId('task-recovery')
    await expect(banner, '被隔离的任务在详情页上没有恢复事件区').toBeVisible({ timeout: 30_000 })
    await expect(
      banner,
      '隔离态没有以 alert 呈现 ⇒ 与「只是有点历史」的常态长得一样，用户不会注意到',
    ).toHaveAttribute('role', 'alert')
    await page.getByTestId('task-recovery-toggle').click()
    await expect(
      page.getByTestId('task-recovery-list').locator('li'),
      '展开之后没有列出恢复事件 ⇒ 事件区只有一个标题',
    ).not.toHaveCount(0)

    const clear = page.getByTestId('task-recovery-clear')
    await expect(clear, '被隔离的任务没有一键放行的入口').toBeVisible()

    // 放行之前的对照半场：boot B 的自动恢复扫描早就跑完了（它排在 boot reap 之后，
    // 而上面已经等到 reap 的结果、又走完了整段界面交互），它**跳过**了这个任务——
    // 判据是 autoResume.ts:216-225 那条只有真的 resume 才会写的审计行。
    // 只断言「状态还是 interrupted」不够：那对一个压根没开自动恢复的部署同样成立。
    const beforeClear = await recoveryOf(daemonB)
    expect(
      beforeClear.events.map((event) => event.kind),
      '任务还隔离着，boot 自动恢复却照样把它重新驱动了 ⇒ 熔断隔离没有拦住自动恢复循环',
    ).not.toContain('auto-resume')
    expect(
      (await getTask(daemonB, taskId)).status,
      '任务还隔离着却已经离开 interrupted ⇒ 隔离期间它被什么东西推动了',
    ).toBe('interrupted')

    await clear.click()
    await expect
      .poll(
        async () =>
          (await api<{ suspended: boolean }>(daemonB!, `/api/tasks/${taskId}/recovery-events`))
            .suspended,
        { timeout: 30_000, message: '点了放行之后隔离标志仍然挂着' },
      )
      .toBe(false)
    await expect(
      page.getByTestId('task-recovery-clear'),
      '放行之后放行按钮还在 ⇒ 界面没有跟着服务端状态走',
    ).toHaveCount(0)

    // ── boot C：同一条 boot 自动恢复路径，这次必须真的把它跑完。
    //    只断言「横幅消失」是不够的——那只证明一个布尔位被清了。
    await daemonB.stop()
    daemonB = undefined
    daemonC = await startDaemon({
      stubMode: 'slow',
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
      configOverrides: { autoResumeOnBoot: true },
      home,
    })
    await waitForStatus(
      daemonC,
      taskId,
      'done',
      '解除隔离之后，同一条 boot 自动恢复路径仍然没把这个任务跑起来 ⇒ 「放行」只清了一个布尔位',
    )
    expect(
      (await recoveryOf(daemonC)).events.map((event) => event.kind),
      '任务是跑完了，但恢复事件区里没有 auto-resume 那条审计 ⇒ 推动它的不是被放行的自动恢复循环',
    ).toContain('auto-resume')
  } finally {
    rmSync(holdFile, { force: true })
    for (const daemon of [daemonA, daemonB, daemonC]) {
      if (daemon !== undefined) await daemon.stop()
    }
    rmSync(home, { recursive: true, force: true })
  }
})

// ===========================================================================
// TASK-31 [P2] —— 「工作流已更新」横幅与同步对话框
// ===========================================================================

test('RFC-319 TASK-31: 工作流在任务跑完之后又改了，详情页给出版本差横幅，同步对话框逐项列出新增节点，确认之后任务快照真的换成了最新定义 @nightly', async ({
  page,
}) => {
  const repo = seedPlainRepo('task31')
  const upstreamName = 'rfc319tdt-sync-up'
  const upstream = await seedAgent(matrixDaemon, {
    name: upstreamName,
    description: 'RFC-319 workflow-sync fixture',
    outputs: ['part'],
    outputKinds: { part: 'string' },
    readonly: true,
    bodyMd: '',
  })
  const v1Nodes = [
    {
      id: 'source_a',
      kind: 'agent-single',
      agentId: upstream.id,
      agentName: upstreamName,
      promptTemplate: 'MATRIX_SOURCE_A',
      position: { x: 0, y: 0 },
    },
  ]
  const workflow = await seedWorkflow(matrixDaemon, {
    name: 'rfc319tdt-sync-wf',
    description: 'RFC-319 workflow-sync fixture',
    definition: { $schema_version: 4, inputs: [], nodes: v1Nodes, edges: [] },
  })

  const taskId = await launchTask(
    matrixDaemon,
    { agentId: upstream.id, workflowId: workflow.id },
    { name: 'rfc319-task31', repoUrl: repoRemoteUrl(repo) },
  )
  await waitForStatus(matrixDaemon, taskId, 'done', '同步夹具任务没有跑完')

  // 夹具自证：任务快照此刻只有一个节点，横幅要断言的差异还不存在。
  const beforeSnapshot = (await getTask(matrixDaemon, taskId)).workflowSnapshot
  expect(
    (beforeSnapshot?.nodes ?? []).map((node) => node.id),
    '任务快照不是 v1 的形状 ⇒ 后面的「快照换了」判据是空洞的',
  ).toEqual(['source_a'])

  await primePage(page, matrixDaemon)
  await page.goto(`${matrixDaemon.baseUrl}/tasks/${taskId}`)
  await expect(
    page.getByTestId('workflow-sync-banner'),
    '工作流还没改动，详情页就已经在说「工作流已更新」⇒ 横幅恒显，等于没有',
  ).toHaveCount(0)

  // 工作流往前走一版：新增一个节点。
  const current = await api<{ version: number }>(matrixDaemon, `/api/workflows/${workflow.id}`)
  const putRes = await req(matrixDaemon, `/api/workflows/${workflow.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      expectedVersion: current.version,
      clientMutationId: mutationId(),
      snapshot: {
        name: 'rfc319tdt-sync-wf',
        description: 'RFC-319 workflow-sync fixture',
        definition: {
          $schema_version: 4,
          inputs: [],
          nodes: [
            ...v1Nodes,
            {
              id: 'source_b',
              kind: 'agent-single',
              agentId: upstream.id,
              agentName: upstreamName,
              promptTemplate: 'MATRIX_SOURCE_B',
              position: { x: 400, y: 0 },
            },
          ],
          edges: [],
        },
      },
    }),
  })
  expect(putRes.ok, `工作流没能改成 v2：${putRes.status} ${await putRes.text()}`).toBe(true)

  await page.reload()
  const banner = page.getByTestId('workflow-sync-banner')
  await expect(
    banner,
    '工作流已经前进了一版，详情页却没有任何提示 ⇒ 用户不知道自己看的是旧定义',
  ).toBeVisible({ timeout: 60_000 })
  await expect(banner, '横幅里没有版本差 ⇒ 用户不知道差了多少').toContainText('v1 → v2')

  await page.getByTestId('workflow-sync-open').click()
  const dialog = page.getByTestId('workflow-sync-dialog')
  await expect(dialog, '同步入口点了没有打开对话框').toBeVisible()
  await expect(
    dialog,
    '对话框没有点名新增的那个节点 ⇒ 用户要盲签一次会改写任务快照的操作',
  ).toContainText('source_b')

  await page.getByTestId('workflow-sync-confirm').click()
  await expect
    .poll(
      async () =>
        ((await getTask(matrixDaemon, taskId)).workflowSnapshot?.nodes ?? []).map(
          (node) => node.id,
        ),
      { timeout: 60_000, message: '确认同步之后任务快照没有换成最新定义' },
    )
    .toEqual(['source_a', 'source_b'])
  await expect(
    page.getByTestId('workflow-sync-banner'),
    '快照已经对齐最新定义，横幅却还挂着 ⇒ 同步之后没有重算差异',
  ).toHaveCount(0, { timeout: 60_000 })
})

// ===========================================================================
// TASK-X7 [P2] —— 只读仓库成员被改动时的警告横幅
// ===========================================================================

test('RFC-319 TASK-X7: 只读成员被改动过的任务，详情页以告警横幅点名那个挂载点——干净的只读成员不触发，改脏之后才触发 @nightly', async ({
  page,
}) => {
  const rootRepo = seedPlainRepo('x7-root')
  const vendorRepo = seedPlainRepo('x7-vendor')
  const group = await api<{ id: string }>(slowDaemon, '/api/repo-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-x7-${Date.now()}`,
      description: '',
      nodes: [
        { path: '', attachment: { kind: 'repo', repoUrl: repoRemoteUrl(rootRepo) } },
        { path: 'vendor', attachment: null },
        {
          path: 'vendor/sdk',
          attachment: { kind: 'repo', repoUrl: repoRemoteUrl(vendorRepo), readonly: true },
        },
      ],
    }),
  })

  const startedMarker = `${holdFile}.started`
  rmSync(startedMarker, { force: true })
  writeFileSync(holdFile, '')
  let taskId = ''
  try {
    taskId = await launchTask(slowDaemon, slowFixture, {
      name: 'rfc319-taskx7',
      repoGroupId: group.id,
    })
    await expect
      .poll(() => existsSync(startedMarker), {
        timeout: 120_000,
        message: 'stub 一直没起来 ⇒ 工作树还没物化，没有只读成员可改',
      })
      .toBe(true)
    const running = await getTask(slowDaemon, taskId)
    const readonlyMember = running.repos.find((repo) => repo.readonly)
    expect(readonlyMember?.mountPath, '组里那个只读成员没有落到任务上').toBe('vendor/sdk')

    // 框架**不在文件系统层面**阻止写入只读成员（scheduler.ts:2107-2113 的注释就是
    // 这条能力存在的理由）——照着 agent 的真实行为往里写一笔。
    const memberWorktree = join(running.worktreePath, 'vendor', 'sdk')
    expect(existsSync(memberWorktree), '只读成员的工作树没有落在挂载点上').toBe(true)
    writeFileSync(join(memberWorktree, 'rfc319-x7-lost.txt'), 'this write is dropped\n', 'utf-8')
  } finally {
    rmSync(holdFile, { force: true })
  }
  await waitForStatus(slowDaemon, taskId, 'done', '多仓任务没有跑完')

  // 服务端把「丢了几处」持久化下来（这一位是横幅的唯一判据）。
  const finished = await getTask(slowDaemon, taskId)
  const member = finished.repos.find((repo) => repo.readonly)
  expect(
    member?.readonlyDirtyCount,
    '只读成员被改动了，脏计数却没落库 ⇒ 横幅永远不会出现，改动静默消失',
  ).toBe(1)
  const writable = finished.repos.find((repo) => !repo.readonly)
  expect(
    writable?.readonlyDirtyCount,
    '可写成员也被算进了只读脏计数 ⇒ 检查没有按 readonly 分流',
  ).toBeNull()

  await primePage(page, slowDaemon)
  await page.goto(`${slowDaemon.baseUrl}/tasks/${taskId}?tab=details`)
  const dirtyBanner = page.getByTestId('task-detail-readonly-dirty-banner')
  await expect(
    dirtyBanner,
    '只读成员被改动了，详情页却没有任何提示 ⇒ 用户会把「改动没上远端」当成平台的 bug',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    dirtyBanner,
    '横幅没有点名是哪个挂载点 ⇒ 多仓任务里用户不知道该去哪儿找回那笔改动',
  ).toContainText('vendor/sdk')
  await expect(
    dirtyBanner,
    '这条提示不是 alert ⇒ 与普通信息条无异，正是它要避免的「静默」',
  ).toHaveAttribute('role', 'alert')

  // 对照：同一个界面上，另起一个**不去碰**只读成员的任务不许出现这条横幅。
  const cleanTask = await launchTask(slowDaemon, slowFixture, {
    name: 'rfc319-taskx7-clean',
    repoGroupId: group.id,
  })
  await waitForStatus(slowDaemon, cleanTask, 'done', '对照任务没有跑完')
  const cleanMember = (await getTask(slowDaemon, cleanTask)).repos.find((repo) => repo.readonly)
  expect(cleanMember?.readonlyDirtyCount, '没人改只读成员，脏计数却不是 0').toBe(0)
  await page.goto(`${slowDaemon.baseUrl}/tasks/${cleanTask}?tab=details`)
  await expect(page.getByTestId('task-detail-repo-group')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByTestId('task-detail-readonly-dirty-banner'),
    '没人改只读成员也弹这条横幅 ⇒ 横幅恒显，等于没有',
  ).toHaveCount(0)
})

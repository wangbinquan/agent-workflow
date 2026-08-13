// RFC-253 T41 —— 脚本节点全链 e2e：拖入 → 写代码 → 连线 → 启动 → 见 stdout → output 拿到值。
//
// 为什么这条测试存在：RFC-253 的 plan.md 把 T41 的验收写成「双浏览器绿」，但 2026-08-09
// 复核索引状态时实测发现它从未落地——`e2e/` 里唯一碰脚本节点的是
// `visual-regression.spec.ts` 里断言 palette 有 Scripts 分类且 badge 为 1 的三行，**执行链
// 零覆盖**。脚本节点的后端不变量由 `rfc253-script-*.test.ts`（backend 63 / shared 38）锁着，
// 缺的恰恰是「用户在浏览器里真的能把它用起来」这一层：palette 拖拽、CodeMirror 正文、
// 连线建出的输入端口名、以及跑完之后 stdout 与 output 两个读面。
//
// 链路上被这条测试真正钉住、且只有浏览器能证明的三件事：
//   1. **拖入**走的是 HTML5 原生 drag（`PALETTE_MIME` + `text/plain`），不是 click 插入——
//      RFC-270 之后 drag 是独立于 click 的第二条创建路径，它自己判权限。
//   2. **连线**拖到目标卡片上时，新输入端口名由
//      `dropTarget.ts:144` 的 `nextFreeInputPort(existingInputPorts(…), sourceHandle)` 从上游
//      出口名推出（不是 `translateInboundConnection`——那条只管落在 catch-all 左把手上的
//      情形；本用例走的是「拖到卡片」的 new-input 路径，两者是不同分支，写测试时曾把机制
//      认错，靠变异实证才纠正过来）。所以 producer 的 `stdout` 出去，consumer 就必须在
//      `AW_PORT_STDOUT` 里读到它——env 后缀由 `scriptEnvSuffix('stdout')` 推出。这条
//      前端命名 → 后端注入的接缝，两侧的单测各自都是绿的，只有连起来才证明得了。
//   3. **单端口模式**（不声明 outputs）下 stdout 的字节原样成为端口值（AC-27）。
//
// 语言选 bash 的理由：POSIX 上 `/bin/bash` 恒在；Windows 上 `scriptRun.ts` 从 `git` 推导
// git-bash（`<root>\cmd\git.exe` → `<root>\bin\bash.exe`）而不是裸 `which('bash')`——后者会
// 命中 `System32\bash.exe`（WSL 启动器）。GitHub 三个 runner 都预装 Git，故三平台可跑。
//
// RFC-276 后脚本使用自然子进程路径；本用例不再声明或测试已退役的
// network-deny / 平台隔离准入，只验证用户业务链本身。

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let repoDir: string
let workflowId: string

const WORKFLOW_NAME = 'rfc253-script-chain'
/** producer 打到 stdout 的标记；单端口模式下它原样成为端口值。 */
const PRODUCED = 'rfc253-produced-value'
/** consumer 把上游值原样回显时的前缀；断言它证明边真的把数据送到了。 */
const CONSUMED_PREFIX = 'consumed:'

// 全链跑一个真任务（clone → worktree → 两次 spawn → merge-back），比纯编辑器 spec 慢得多。
test.setTimeout(120_000)

interface WorkflowDefinition {
  nodes: { id: string; kind: string }[]
  edges: {
    source: { nodeId: string; portName: string }
    target: { nodeId: string; portName: string }
  }[]
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

test.beforeAll(async () => {
  daemon = await startDaemon()

  // 启动器要一个真 git repo：daemon 在启动时把它 clone 成 worktree，脚本进程的 cwd 就是它。
  repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-rfc253-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc253 e2e fixture repo\n', 'utf-8')
  initGitRepo(repoDir)

  // 空工作流：两个节点都要在浏览器里现建，否则「拖入」就没被覆盖。
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: WORKFLOW_NAME,
      description: 'RFC-253 T41 e2e fixture',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    }),
  })
  workflowId = created.id
})

test.afterAll(async () => {
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  if (daemon !== undefined) await daemon.stop()
})

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        // 选择器全部对着 en-US 串，锁掉语言避免 i18n race。
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

/**
 * 从 palette 把一个 kind 拖到画布的相对位置上。
 *
 * Playwright 的 `dragTo` 走的是鼠标管线，不会触发 HTML5 的 dragstart/drop
 * （见 `workflow-editor.spec.ts` 头注），所以这里用 page.evaluate 合成带真 DataTransfer
 * 的事件——和那条既有 spec 同一手法，区别是精确指定拖拽源的 kind 与落点。
 */
async function dragPaletteNode(
  page: Page,
  kind: string,
  relX: number,
  relY: number,
): Promise<void> {
  await expect(page.locator(`[data-testid="workflow-node-picker-item-kind-${kind}"]`)).toHaveCount(
    1,
  )
  await page.evaluate(
    ({ kind, relX, relY }) => {
      const src = document.querySelector(
        `[data-testid="workflow-node-picker-item-kind-${kind}"] .workflow-node-picker__drag-grip`,
      )
      const canvas = document.querySelector('.react-flow__pane')
      if (src === null || canvas === null)
        throw new Error(`palette grip or canvas missing: ${kind}`)
      const box = canvas.getBoundingClientRect()
      const x = box.left + box.width * relX
      const y = box.top + box.height * relY
      const dataTransfer = new DataTransfer()
      src.dispatchEvent(
        new DragEvent('dragstart', { dataTransfer, bubbles: true, cancelable: true }),
      )
      // drop 只有在 dragover 被 preventDefault 之后才会派发，两个都要给。
      for (const type of ['dragover', 'drop'] as const) {
        canvas.dispatchEvent(
          new DragEvent(type, {
            dataTransfer,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        )
      }
      src.dispatchEvent(new DragEvent('dragend', { dataTransfer, bubbles: true }))
    },
    { kind, relX, relY },
  )
}

/**
 * 选中一个节点并把 Inspector 里的脚本正文整体替换成 `body`（先切 bash，再全选覆写）。
 *
 * 必须显式点一下卡片：合成的 HTML5 drop 只把节点插进定义，不像 picker 的 click 路径那样
 * 顺带把它设为选中项，所以落下之后 Inspector 是空的。
 */
async function selectAndWriteBashBody(page: Page, nodeIndex: number, body: string): Promise<void> {
  await page.locator('.react-flow__node').nth(nodeIndex).locator('.canvas-node').click()
  await expect(page.getByTestId('script-body-editor')).toBeVisible()
  // 语言默认 python；切到 bash 时未改动的 starter 正文会跟着换模板，所以先切语言再写正文。
  await page.getByTestId('script-language-bash').click()
  const editor = page.getByTestId('script-body-editor')
  await expect(editor).toHaveAttribute('data-language', 'bash')
  const content = editor.locator('.cm-content')
  await content.click()
  await page.keyboard.press('ControlOrMeta+a')
  // 单行正文是刻意的：CodeMirror 的 `indentUnit` 会在换行处自动缩进，多行输入要么
  // 被改形要么得逐行清缩进，而这条测试要证明的是链路不是编辑器缩进行为。
  await page.keyboard.type(body)
  await expect(content).toContainText(body)
}

async function pollUntilTerminal(taskId: string, timeoutMs: number): Promise<string> {
  const terminal = new Set(['done', 'failed', 'canceled', 'interrupted', 'exhausted'])
  const deadline = Date.now() + timeoutMs
  let last = 'pending'
  while (Date.now() < deadline) {
    const task = await api<{ status: string }>(`/api/tasks/${taskId}`)
    last = task.status
    if (terminal.has(last)) return last
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`task ${taskId} 未在 ${timeoutMs}ms 内到终态；最后状态=${last}`)
}

test('RFC-253 T41: 拖入两个脚本节点 → 写代码 → 连线 → 启动 → stdout 可见 → 下游 output 拿到上游的值', async ({
  page,
}) => {
  await primeAuth(page)
  // 240px 的 palette rail 只在 ≥1536 宽挂载；canonical 的 1280×800 下画布只有空状态按钮，
  // 拖拽把手根本不在 DOM 里（实测：1280 下 `.workflow-node-picker__drag-grip` 为 0 个）。
  // 与 `workflow-editor.spec.ts` 的 drag-from-sidebar 用例取同一视口。
  await page.setViewportSize({ width: 1536, height: 900 })
  await page.goto(`${daemon.baseUrl}/workflows/${workflowId}`)
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)

  // ── 1. 拖入 producer，写正文 ────────────────────────────────────────────────
  await dragPaletteNode(page, 'script', 0.28, 0.4)
  await expect(page.locator('.canvas-node--script')).toHaveCount(1)
  await selectAndWriteBashBody(page, 0, `echo "${PRODUCED}"`)

  // ── 2. 拖入 consumer，读上游端口 ───────────────────────────────────────────
  await dragPaletteNode(page, 'script', 0.72, 0.4)
  await expect(page.locator('.canvas-node--script')).toHaveCount(2)
  // 连线把目标端口命名为上游的 `stdout`，故注入的环境变量是 AW_PORT_ + scriptEnvSuffix('stdout')。
  await selectAndWriteBashBody(page, 1, `echo "${CONSUMED_PREFIX}$AW_PORT_STDOUT"`)

  // ── 3. 连线：producer 右把手 → consumer 卡片（走 new-input 解析，不是 catch-all 把手）──
  const cards = page.locator('.react-flow__node')
  const producerId = await cards.nth(0).getAttribute('data-id')
  const consumerId = await cards.nth(1).getAttribute('data-id')
  if (producerId === null || consumerId === null) throw new Error('节点 data-id 缺失')

  const sourceHandle = page.locator(
    `.react-flow__node[data-id="${producerId}"] .react-flow__handle-right`,
  )
  const targetCard = page.locator(`.react-flow__node[data-id="${consumerId}"] .canvas-node`)
  const sourceBox = await sourceHandle.boundingBox()
  const targetBox = await targetCard.boundingBox()
  if (sourceBox === null || targetBox === null) throw new Error('连线几何缺失')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  // 分步移动 + 释放前先停一拍：xyflow 要看到中间的 pointermove 才会进入连线态。
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 20,
  })
  await expect(targetCard).toHaveAttribute('data-connect-preview', 'new')
  await page.mouse.up()
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  // ── 4. 自动保存落库，并从 wire 上确认端口命名规则真的生效 ─────────────────
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved', { timeout: 20_000 })
  const saved = await api<{ definition: WorkflowDefinition }>(`/api/workflows/${workflowId}`)
  const scriptNodes = saved.definition.nodes.filter((n) => n.kind === 'script')
  expect(scriptNodes).toHaveLength(2)
  expect(saved.definition.edges).toHaveLength(1)
  // 上游出口是单端口模式的隐式 `stdout`；下游入口由 `nextFreeInputPort(…, sourceHandle)`
  // 继承同名 —— 这正是 AW_PORT_STDOUT 的来源。两端都要断言：只断言 source 的话，端口
  // 命名规则被改坏时这条测试会静默放过（变异实证抓到过这个洞）。
  expect(saved.definition.edges[0]?.source.portName).toBe('stdout')
  expect(saved.definition.edges[0]?.target.portName).toBe('stdout')

  // ── 5. 启动任务 ────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /launch task/i }).click()
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await page.getByTestId('wizard-space-remote').click()
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: 'Enter a new Git URL…', exact: true }).click()
  await page.fill('[data-testid="repo-source-url-0"]', repoRemoteUrl(repoDir))
  await page.fill('[data-testid="repo-source-ref-0"]', 'main')
  await page.getByTestId('stepper-next').click()
  // 本工作流没有声明输入，第 3 步只剩任务名。
  await page.fill('[data-testid="wizard-task-name"]', 'rfc253-script-chain-task')
  await page.getByTestId('stepper-next').click()
  await page.getByRole('button', { name: 'Start task', exact: true }).click()

  await page.waitForURL(/\/tasks\/[A-Z0-9]{26}/i, { timeout: 20_000 })
  const taskId = /\/tasks\/([A-Z0-9]+)/i.exec(page.url())![1]!

  // ── 6. 先在 API 上判定，再看 UI：瞬时状态不会被误当成终态 ─────────────────
  const finalStatus = await pollUntilTerminal(taskId, 90_000)

  const nodeRuns = await api<{
    runs: {
      id: string
      nodeId: string
      status: string
      failureCode: string | null
      errorMessage: string | null
    }[]
    outputs: { nodeRunId: string; port: string; value: string }[]
  }>(`/api/tasks/${taskId}/node-runs`)

  // 裸 `toBe('done')` 只会告诉你「Expected done / Received failed」，而脚本节点失败的
  // 真原因（解释器解析不到 / 非零退出码 / 信封解析失败…）全在 node_run 行里。首次上
  // hosted runner 就撞上这一点：Windows 腿红了，CI 日志里只有 expected/received 两行，
  // daemon 侧一个字都没有，只能再推一轮才拿得到原因。所以这里把原因随断言一起抛出。
  if (finalStatus !== 'done') {
    // 连 stderr 一起捞：脚本节点的失败原因常常只在 node_run_events 里（解释器解析不到、
    // 非零退出码的最后几行、信封解析失败），`errorMessage` 只是 stderrTail 的后缀。
    const parts: string[] = []
    for (const r of nodeRuns.runs) {
      let tail = ''
      try {
        const ev = await api<{ events: { kind: string; payload: string }[] }>(
          `/api/tasks/${taskId}/node-runs/${r.id}/events`,
        )
        tail = ev.events
          .filter((e) => e.kind === 'stderr' || e.kind === 'text')
          .slice(-6)
          .map((e) => `${e.kind}:${e.payload}`)
          .join(' | ')
      } catch (err) {
        tail = `（事件拉取失败：${String(err)}）`
      }
      parts.push(
        `${r.nodeId}=${r.status}${r.failureCode === null ? '' : `/${r.failureCode}`}` +
          `${r.errorMessage === null ? '' : ` msg=${JSON.stringify(r.errorMessage)}`}` +
          `${tail === '' ? '' : ` events=[${tail}]`}`,
      )
    }
    throw new Error(
      `任务终态 ${finalStatus}（期望 done）；各 node_run：${parts.join(' · ') || '（无）'}`,
    )
  }

  const producerRun = nodeRuns.runs.find((r) => r.nodeId === producerId)
  const consumerRun = nodeRuns.runs.find((r) => r.nodeId === consumerId)
  expect(producerRun?.status).toBe('done')
  expect(consumerRun?.status).toBe('done')

  // 单端口模式：stdout 的字节原样成为端口值（AC-27）。
  const producerOut = nodeRuns.outputs.find((o) => o.nodeRunId === producerRun?.id)
  expect(producerOut?.port).toBe('stdout')
  expect(producerOut?.value).toContain(PRODUCED)

  // 全链的承重断言：下游端口里出现了上游的值，说明边 → 端口名 → AW_PORT_STDOUT
  // → 脚本进程 env 这一串真的通了，而不是两端各自跑了一遍。
  const consumerOut = nodeRuns.outputs.find((o) => o.nodeRunId === consumerRun?.id)
  expect(consumerOut?.value).toContain(`${CONSUMED_PREFIX}${PRODUCED}`)

  // ── 7. 见 stdout：producer 的每行 stdout 逐行进 node_run_events（kind='text'）──
  await page.reload()
  await expect(page.locator('.status-chip', { hasText: /^done$/i }).first()).toBeVisible({
    timeout: 20_000,
  })
  await page.locator(`.react-flow__node[data-id="${producerId}"] .canvas-node`).click()
  const tabBar = page.locator('.tabs--inspector')
  // 页签的可及名把 badge 计数拼在标签后面（"Events1" / "Output1"，见 NodeDetailDrawer 的
  // TabBar badge）。exact 匹配在这两个页签上必然落空——只有无 badge 的 Session 才碰巧能用。
  await tabBar.getByRole('tab', { name: /^Events/ }).click()
  await expect(page.locator('.events-list', { hasText: PRODUCED })).toBeVisible({ timeout: 20_000 })

  // ── 8. output 拿到值：下游节点抽屉的 Output 页签渲染同一个值 ───────────────
  await page.locator(`.react-flow__node[data-id="${consumerId}"] .canvas-node`).click()
  await tabBar.getByRole('tab', { name: /^Output/ }).click()
  await expect(
    page.locator('.task-output-card__body', { hasText: `${CONSUMED_PREFIX}${PRODUCED}` }),
  ).toBeVisible({ timeout: 20_000 })
})

// RFC-319 B63 —— HUMAN-47 / HUMAN-X6：任务反馈（写给未来的自己）与它的蒸馏去向。
//
// 这一屏的价值全在「写下去之后会怎样」：任务跑完了，人回头写一句「下次别再用
// 那个模板了」。这句话要么进了记忆蒸馏、以后真的会被用上，要么就只是躺在一个
// 没人看的列表里。差别在界面上只有一个小徽标，所以它必须是真的：
//
//   * **写下去要真的排进蒸馏**（HUMAN-47）。后端在插入行的同一条链路里 enqueue 一个
//     distill job 并把 `distilled` 置位（`services/taskFeedback.ts:48-70`）。徽标要是
//     写死的，人会以为每条都进了蒸馏，实际可能一条都没排上。
//   * **连点要有节流**（HUMAN-47）。纯客户端的 3 秒闸（`TaskFeedbackList.tsx:40,128-135`），
//     窗口起点是**上一次被放行的点击**那一刻，与那一行何时落库无关。没有它，一次手抖就往
//     同一个任务里灌好几条一模一样的笔记，蒸馏那头还得逐条处理。
//   * **看不见的任务与不存在的任务，404 必须逐字节同形**（HUMAN-47）。两者一旦能分辨，
//     任何人都能拿任务 id 探测「这个 id 存不存在」——`routes/taskFeedback.ts:67-80`
//     的注释逐字写着这条曾被 byte-oracle 抓到过残余可区分性。
//   * **深链要能定位到具体那一条**（HUMAN-X6）。蒸馏出来的记忆候选会带着来源链接指回
//     这条反馈；链接点开落不到那一行，追溯就断了。
//
// 覆盖边界（如实记）：`routes/taskFeedback.ts` 自己那句「不可见 ⇒ 404」**测不出来**——
// 把它改成可区分的 403 文案，本用例照样绿。原因是这条路由挂在 `/api/tasks/:id/*` 的
// 可见性中间件之下，外人根本走不到路由自己的那一行；真正兜住这条保证的是
// `routes/tasks.ts:1204-1208` 的中间件（改它当场红）。路由里那句是**双保险的第二层**，
// 注释也这么写着。记在这里，免得后人看到「改了没红」误以为没覆盖。
//
// 判据取自源码单一事实源：
//   services/taskFeedback.ts:48-72        插入 + enqueueDistillJob + distilled 置位
//   routes/taskFeedback.ts:67-80          两个 404 分支逐字节同形（含带引号文案）
//   shared/schemas/taskFeedback.ts:17-19  bodyMd trim + 1..4000
//   components/tasks/TaskFeedbackList.tsx:40          RATE_LIMIT_MS（本文件在运行时读它，见下）
//   components/tasks/TaskFeedbackList.tsx:126-137     闸门判据与「被挡则不发请求、不清草稿」
//   components/tasks/TaskFeedbackList.tsx:76-79       提交成功才清空草稿（用作提交完成的真实信号）
//   components/tasks/TaskFeedbackList.tsx:83-87       提示条自动消失的 RATE_LIMIT_MS 定时器
//   components/tasks/TaskFeedbackList.tsx:42-44,91-122  锚点 id 与 hash 定位 + 移焦

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const NOTE_ONE = 'RFC-319 B63: next time, skip the boilerplate template.'
const NOTE_TWO = 'RFC-319 B63: and pin the runtime version.'
const DOUBLE_TAP_NOTE = 'RFC-319 B63: rapid double tap.'
const AFTER_COOLDOWN_NOTE = 'RFC-319 B63: after the cooldown.'

const FEEDBACK_LIST_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'frontend',
  'src',
  'components',
  'tasks',
  'TaskFeedbackList.tsx',
)

/**
 * 冷却窗口的长度**从生产源码里读出来**，不在用例里另拍一个数。
 *
 * 单一事实源是 `TaskFeedbackList.tsx:40` 的 `const RATE_LIMIT_MS = 3000`——同一个常量
 * 同时管两件事：闸门判据 `Date.now() - lastSubmitAt < RATE_LIMIT_MS`（同文件 130-131）
 * 与提示条自动消失的定时器 `setTimeout(…, RATE_LIMIT_MS)`（同文件 83-87）。下面「差 1ms
 * 仍被挡 / 正好到点就放行」两条边界断言都由它推导，所以它一旦改名或改值，必须在这里
 * 当场炸出一句人话——而不是让那两条断言以「莫名其妙超时」的形态红，让接手的人从头查起。
 */
function readRateLimitMs(): number {
  const source = readFileSync(FEEDBACK_LIST_SOURCE, 'utf-8')
  const match = /const RATE_LIMIT_MS = (\d+)\b/.exec(source)
  if (match === null) {
    throw new Error(
      `${FEEDBACK_LIST_SOURCE} 里读不到 RATE_LIMIT_MS —— 连点闸换了形状，本用例的窗口判据必须跟着改`,
    )
  }
  const ms = Number(match[1])
  // 从源码读常量让「差 1ms / 走满」那两条边界判据不依赖硬编码数字，但也带来一个洞：
  // 期望值跟着常量一起变，于是**改冷却时长本身**这条变异永远咬不中（实测 3000 → 6000
  // 时整份文件仍然全绿）。所以这里给它钉一个合理区间——判的不是「等于 3 秒」，
  // 而是「还在『防手抖』这个量级上」。低于 500ms 挡不住真实的连点（触控板双击、
  // 回车按住重复），高于 10s 就不再是防手抖而是把人锁在门外：写完一条想接着补一句，
  // 得干等十几秒，而界面只给一条「太快了」的提示，不说还要等多久。
  // 这里用 throw 而不是 expect：它跑在模块加载期（下面 `const RATE_LIMIT_MS = readRateLimitMs()`），
  // 一句人话比一条 collection 期的断言失败好读得多。
  if (ms < 500 || ms > 10_000) {
    throw new Error(
      `连点冷却被调到了 ${ms}ms，已经不在「防手抖」的量级（500ms–10s）上。` +
        '低于 500ms 挡不住真实连点（触控板双击、回车按住重复）；高于 10s 就不是防手抖而是把人' +
        '锁在门外——写完一条想接着补一句要干等十几秒，而界面只给一条「太快了」，不说还要等多久。' +
        '若这是有意调整，请连同本文件的判据一起改。',
    )
  }
  return ms
}

const RATE_LIMIT_MS = readRateLimitMs()

let daemon: DaemonHandle
let repoDir: string
let taskId: string
/** 一个**非管理员**的第二个人：管理员看得见所有任务，用他测不出「不可见」。 */
let outsiderToken: string

function apiFetch(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

interface FeedbackRow {
  id: string
  bodyMd: string
  distilled: boolean
  distillJobId: string | null
}

async function feedbackRows(): Promise<FeedbackRow[]> {
  return (await api<{ items: FeedbackRow[] }>(`/api/tasks/${taskId}/feedback`)).items
}

async function openFeedbackTab(page: Page, hash = ''): Promise<void> {
  await page.goto(`${daemon.baseUrl}/tasks/${encodeURIComponent(taskId)}?tab=feedback${hash}`)
  await expect(page.getByTestId('task-feedback')).toBeVisible()
}

function seedAuth(page: Page): Promise<void> {
  return page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b63-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 b63 fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon({ stubMode: 'basic' })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b63-worker',
      description: 'RFC-319 B63 fixture',
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b63-wf',
      description: 'RFC-319 B63 fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'worker',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-b63-worker',
            promptTemplate: 'Work on {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'worker', portName: 'answer' } }],
            position: { x: 640, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e_in_worker',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'worker', portName: 'topic' },
          },
          {
            id: 'e_worker_out',
            source: { nodeId: 'worker', portName: 'answer' },
            target: { nodeId: 'out_1', portName: 'answer' },
          },
        ],
      },
    }),
  })
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b63-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'retro notes' },
    }),
  })
  taskId = task.id
  // 反馈面板对任何状态都开放，但让任务跑完更贴近真实场景（人是回头写复盘的）。
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 180_000,
    })
    .toBe('done')

  const username = 'rfc319-b63-outsider'
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      displayName: 'RFC-319 B63 Outsider',
      role: 'user',
      password: 'outsider-pass-9F!x',
    }),
  })
  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'outsider-pass-9F!x' }),
  })
  expect(loginRes.ok, `login: ${loginRes.status}`).toBe(true)
  outsiderToken = ((await loginRes.json()) as { sessionToken: string }).sessionToken
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
})

test('写下一条反馈：它要真的排进蒸馏，而不是只在列表里躺着 @nightly', async ({ page }) => {
  await seedAuth(page)
  await openFeedbackTab(page)
  await expect(page.getByTestId('task-feedback-empty')).toBeVisible()

  await page.getByTestId('task-feedback-textarea').fill(NOTE_ONE)
  await page.getByTestId('task-feedback-submit').click()

  await expect(page.getByTestId('task-feedback-list')).toBeVisible()
  await expect(page.getByTestId('task-feedback-distilled')).toHaveCount(1)

  // 服务端对账：徽标背后必须真有一个蒸馏任务，否则那个徽标就是句空话。
  const rows = await feedbackRows()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.bodyMd).toBe(NOTE_ONE)
  expect(rows[0]!.distilled, '徽标说进了蒸馏，行上却没置位').toBe(true)
  expect(rows[0]!.distillJobId, '置了位却没有 job id —— 那条笔记不会被任何人处理').not.toBeNull()
})

test('连点要被拦住：一次手抖不该往同一个任务里灌两条一样的笔记 @nightly', async ({ page }) => {
  await seedAuth(page)

  // ——为什么这一条**不能**靠墙钟等待（旧写法在 CI 上真红过，commit 188dda224）——
  //
  // 闸门判的是浏览器里的 `Date.now() - lastSubmitAt`（`TaskFeedbackList.tsx:130-131`），
  // 而窗口起点 `lastSubmitAt` 打在「上一次**被放行的点击**」那一刻（同文件 135），既不是
  // 那一行落库的时刻，更不是测试进程观察到它的时刻。旧写法在两次点击之间夹了一次服务端
  // 轮询（`expect.poll` 还带 100/250/500/1000ms 的退避量化），CI 一忙，这段间隔就可能超过
  // RATE_LIMIT_MS：第二次点击于是被**合法**放行、提示条根本不该出现，用例白等 15 秒然后红。
  // 红的不是产品，是用例自己——而且「重跑就过了」正好是本仓明令禁止的通过依据。
  //
  // 改法：只把浏览器里的 Date 钉死。`page.clock.setFixedTime` 不动 setTimeout / rAF，
  // 所以提示条自己那条 RATE_LIMIT_MS 定时器照旧走真实时间（下面等它消失仍是真实信号），
  // 但「两次点击相隔多久」从此由用例说了算，与机器快慢彻底脱钩。
  const windowStart = Date.now()
  await page.clock.setFixedTime(windowStart)

  // 被闸住的那一下必须**连请求都不发**。数请求比数行数更早也更硬：行数要等服务端写完才
  // 看得见，请求计数在点击的那一刻就定了——不用「先睡一秒看看会不会多出来」。
  const submits: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/feedback')) submits.push(req.url())
  })

  await openFeedbackTab(page)
  await expect(page.getByTestId('task-feedback-list')).toBeVisible()
  const rowsBefore = (await feedbackRows()).length

  // 第一条：正常写进去，把节流窗口的起点打在 `windowStart` 上。
  await page.getByTestId('task-feedback-textarea').fill(NOTE_TWO)
  await page.getByTestId('task-feedback-submit').click()
  // 真实信号：组件是在 mutation 成功回调里才清空草稿的（`TaskFeedbackList.tsx:76-79`）。
  // 等这个，而不是等「一秒应该够了吧」——不成立就说明这一条压根没提交成功。
  await expect(page.getByTestId('task-feedback-textarea')).toHaveValue('')
  expect(submits.length, '第一条根本没发出去 —— 后面整条连点链路都无从谈起').toBe(1)
  // 草稿被清空 ⇒ POST 已经成功返回；服务端是先落库再回包（`services/taskFeedback.ts:48-72`），
  // 所以这里既不用轮询也不用等待，行数必须已经加一。
  const baseline = rowsBefore + 1
  expect((await feedbackRows()).length, '提交回了成功，库里却没有这一行').toBe(baseline)

  // ① 手抖再点一次：钉死的 Date 让两次点击的间隔恒为 0ms，必然落在窗口内，提示条必须出现。
  //    不出现，人根本不知道自己这一下被吃掉了，只会以为没点上、接着再点。
  await page.getByTestId('task-feedback-textarea').fill(DOUBLE_TAP_NOTE)
  await page.getByTestId('task-feedback-submit').click()
  await expect(page.getByTestId('task-feedback-rate-limit')).toBeVisible()
  // 被闸住不该顺手把人写的字也吞掉——吞了的话，这一下就从「稍后再来」变成了「白写一遍」。
  await expect(page.getByTestId('task-feedback-textarea')).toHaveValue(DOUBLE_TAP_NOTE)

  // ② 本条的核心：这一下一个写请求都不许发出去。请求计数为 0 ⇒ 没有任何在途写入，
  //    因此紧跟着这一次行数对账是确定性的，不需要拿 sleep 去赌「要是发了现在也该到了」。
  expect(submits.length, '节流只挡了界面、请求照样发出去了 —— 同一条笔记会被灌进去两份').toBe(1)
  expect((await feedbackRows()).length, '被闸住的那一下还是往任务里灌进了一行').toBe(baseline)

  // ②b 窗口到底有多长，也按源码常量钉到边界上，而不是「等个三秒差不多了」。
  //     先等提示条自己消失——它由同一个 RATE_LIMIT_MS 定时器驱动（`TaskFeedbackList.tsx:83-87`）
  //     且走真实时间，等它消失就是「界面已解锁」的真实信号；余量给足，慢机器上晚几百毫秒无妨。
  //     提示条不肯消失 ⇒ 人被永久卡在只读状态里，再也写不进第二条。
  const bannerGone = { timeout: RATE_LIMIT_MS + 12_000 }
  await expect(page.getByTestId('task-feedback-rate-limit')).toHaveCount(0, bannerGone)
  // 距上次放行还差 1ms —— 仍在窗口内，仍须被挡。草稿还留着上一条，直接再点即可。
  await page.clock.setFixedTime(windowStart + RATE_LIMIT_MS - 1)
  await page.getByTestId('task-feedback-submit').click()
  await expect(page.getByTestId('task-feedback-rate-limit')).toBeVisible()
  expect(
    submits.length,
    `差 1ms 就把连点放行了 —— 实际冷却窗口短于源码写的 ${RATE_LIMIT_MS}ms`,
  ).toBe(1)

  // ③ 冷却整整走满就要能继续写：这道闸只挡连点，不是把人挡在门外。
  await expect(page.getByTestId('task-feedback-rate-limit')).toHaveCount(0, bannerGone)
  await page.clock.setFixedTime(windowStart + RATE_LIMIT_MS)
  await page.getByTestId('task-feedback-textarea').fill(AFTER_COOLDOWN_NOTE)
  await page.getByTestId('task-feedback-submit').click()
  await expect(page.getByTestId('task-feedback-textarea')).toHaveValue('')

  // 收尾对账：整条用例自始至终只该有两次真正的写请求（第一条 + 冷却之后那条），
  // 手抖那两下一次都不许落库。任何一条不成立，用户看到的就是同一个任务里躺着重复的笔记。
  const finalRows = await feedbackRows()
  expect(submits.length, '整条用例里只该有两次真正的写请求 —— 多出来的就是没被挡住的连点').toBe(2)
  expect(finalRows.length, '冷却走满仍写不进去 —— 节流从「挡连点」变成了「把人挡在门外」').toBe(
    baseline + 1,
  )
  expect(
    finalRows.map((row) => row.bodyMd),
    '被闸住的那一下最终还是落了库 —— 同一个任务里躺着两条手抖出来的笔记',
  ).not.toContain(DOUBLE_TAP_NOTE)
  expect(finalRows[finalRows.length - 1]!.bodyMd, '冷却之后写下的那条不是最新一行').toBe(
    AFTER_COOLDOWN_NOTE,
  )
})

test('正文校验，以及「看不见」与「不存在」必须逐字节同形 @nightly', async () => {
  // 空正文 / 超长都要被拒——不然蒸馏那头会收到一条没有信息量的作业。
  const empty = await apiFetch(`/api/tasks/${taskId}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ bodyMd: '   ' }),
  })
  expect(empty.status).toBe(422)
  const tooLong = await apiFetch(`/api/tasks/${taskId}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ bodyMd: 'x'.repeat(4001) }),
  })
  expect(tooLong.status).toBe(422)

  // 探测面：不存在的任务 vs 存在但看不见的任务。两者的状态码与**响应体**都必须一样，
  // 否则谁都能拿任务 id 逐个试出「这个 id 是不是真的」。
  const missingId = '01ZZZZZZZZZZZZZZZZZZZZZZZZ'
  const missing = await apiFetch(`/api/tasks/${missingId}/feedback`, {}, outsiderToken)
  const invisible = await apiFetch(`/api/tasks/${taskId}/feedback`, {}, outsiderToken)
  expect(missing.status).toBe(404)
  expect(invisible.status, '别人的私有任务必须也是 404，而不是 403').toBe(404)
  const missingBody = (await missing.text()).replace(missingId, '<id>')
  const invisibleBody = (await invisible.text()).replace(taskId, '<id>')
  expect(invisibleBody, '两个 404 的响应体不一样 —— 拿任务 id 就能探测它到底存不存在').toBe(
    missingBody,
  )

  // ——**写**面同样要同形（HUMAN-47 的另一半，此前只验了读）——
  //
  // 只把读面同形化，探测面一点没少：外人换个动词（POST 而不是 GET）照样能逐个 id
  // 试出「这个任务是不是真的存在」。而写面比读面更容易漏——读面往往被列表过滤顺手
  // 挡住，写面却常常先落一层「参数校验 / 找不到条目」的分支，于是「不存在」返回
  // 404，「存在但看不见」返回 403 或另一段文案。这里逐字节比对两条 POST 的响应体。
  const probeBody = JSON.stringify({ bodyMd: 'RFC-319 B63: outsider write probe.' })
  const missingPost = await apiFetch(
    `/api/tasks/${missingId}/feedback`,
    { method: 'POST', body: probeBody },
    outsiderToken,
  )
  const invisiblePost = await apiFetch(
    `/api/tasks/${taskId}/feedback`,
    { method: 'POST', body: probeBody },
    outsiderToken,
  )
  expect(missingPost.status, '往不存在的任务写反馈必须 404').toBe(404)
  expect(invisiblePost.status, '往别人的私有任务写反馈必须也是 404，而不是 403').toBe(404)
  const missingPostBody = (await missingPost.text()).replace(missingId, '<id>')
  const invisiblePostBody = (await invisiblePost.text()).replace(taskId, '<id>')
  expect(
    invisiblePostBody,
    '两条 POST 的 404 响应体不一样 —— 换个动词就能拿任务 id 探测它到底存不存在',
  ).toBe(missingPostBody)

  // 被拒的那一次不许留下任何痕迹：状态码同形但行照落，等于换个地方泄露同一件事
  // （而且这条笔记会挂在一个外人根本看不见的任务上，谁都不会再发现它）。
  const rows = await feedbackRows()
  expect(
    rows.map((row) => row.bodyMd),
    '外人被 404 挡住了，反馈却还是落进了任务里',
  ).not.toContain('RFC-319 B63: outsider write probe.')
})

test('深链要落到具体那一条：蒸馏出来的记忆指回来时，追溯不能断在半路 @nightly', async ({
  page,
}) => {
  await seedAuth(page)
  const rows = await feedbackRows()
  // 挑**最后**那一条：落在第一条上可能只是「本来就在视口里」，说明不了定位真的发生过。
  const target = rows[rows.length - 1]!
  await openFeedbackTab(page, `#feedback-${target.id}`)

  const row = page.getByTestId(`task-feedback-row-${target.id}`)
  await expect(row).toBeVisible()
  // 移焦是这条契约里可判定的那一半：滚动位置会因视口高度而异，焦点不会。
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.id ?? ''), { timeout: 15_000 })
    .toBe(`feedback-${target.id}`)

  // 认不出的锚点不许把焦点乱扔到别的行上。
  // 先手动 blur：只改 hash 属于同文档导航，页面不会重载，上一步落在目标行上的焦点会
  // 原样留着——不清掉的话这条断言测的是上一步的残留，不是本步的行为。
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await openFeedbackTab(page, '#feedback-01ZZZZZZZZZZZZZZZZZZZZZZZZ')
  await expect(page.getByTestId('task-feedback-list')).toBeVisible()
  await page.waitForTimeout(500)
  expect(
    await page.evaluate(() => document.activeElement?.id ?? ''),
    '锚点认不出来时把焦点扔到了某一行上 —— 人会以为那就是链接指的那条',
  ).not.toContain('feedback-')
})

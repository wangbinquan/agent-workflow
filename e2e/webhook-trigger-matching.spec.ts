// RFC-319 B16 —— Webhook 触发规则的条件匹配与熔断（EVENT-18 / EVENT-19）。
//
// 触发规则决定「代码平台发生什么事的时候，平台自动开一份工作」。它的两条边界
// 都属于**多花钱且没人看见**的那一类：
//
//   * 条件匹配漏 ⇒ 规则在它不该管的仓库 / 分支 / 事件上开工。每一次都是一个
//     真实的 agent 进程和一份真实的 diff，而作者不会收到任何通知。
//   * 熔断漏 ⇒ 「任务推分支 → 流水线失败 → 触发规则 → 任务再推」这个环
//     可以无限转下去。这不是理论问题：`ignoreUsernames` 的存在就说明它发生过。
//
// 判据取自源码单一事实源：
//   `evaluateCircuit`（services/webhook/matching.ts:119）—— 计数 ≥ 上限 → open，
//     fire 记 `skipped-circuit-open`；事件作者 ∉ ignoreUsernames ⇒ 计数清零
//     （「人已介入」）。
//   `webhookStreamKeyOf`（modules/integration/domain/mrTerminalControl.ts:76）
//     —— 无 MR 的事件按 `${repoPath}|branch:${branch}` 分流。
//   `resetWebhookTriggerStream`（services/webhookTriggers.ts:397）—— 人工重置
//     按 streamKey 把计数清零。

import { expect, test } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

const REPO_PATH = 'rfc319/trigger-fixture'

/** 事件体共用的 project 块。仓库四个字段缺一不可，否则入口以
 *  `webhook-delivery-unsupported: missing project fields` 拒收（实测）。 */
function projectBlock(repoPath: string): Record<string, unknown> {
  return {
    path_with_namespace: repoPath,
    web_url: `https://gitlab.invalid/${repoPath}`,
    git_http_url: `https://gitlab.invalid/${repoPath}.git`,
    git_ssh_url: `git@gitlab.invalid:${repoPath}.git`,
  }
}

/** GitLab Pipeline Hook。`status` 决定事件类型（failed / success，见 gitlabAdapter.ts:358）。 */
function pipelineBody(
  options: {
    repoPath?: string
    branch?: string
    author?: string
    status?: 'failed' | 'success'
  } = {},
): string {
  const repoPath = options.repoPath ?? REPO_PATH
  const n = ++sequence
  return JSON.stringify({
    object_kind: 'pipeline',
    user: { username: options.author ?? 'rfc319-bot' },
    project: projectBlock(repoPath),
    object_attributes: {
      id: n,
      ref: options.branch ?? 'main',
      status: options.status ?? 'failed',
      sha: `sha${n}`,
      url: `https://gitlab.invalid/${repoPath}/-/pipelines/${n}`,
    },
  })
}

/** GitLab Push Hook。分支来自 `ref`（gitlabAdapter.ts:212）。 */
function pushBody(options: { branch?: string; author?: string } = {}): string {
  const n = ++sequence
  return JSON.stringify({
    object_kind: 'push',
    user: { username: options.author ?? 'rfc319-human' },
    project: projectBlock(REPO_PATH),
    ref: `refs/heads/${options.branch ?? 'main'}`,
    before: `before${n}`,
    after: `after${n}`,
  })
}

/**
 * GitLab Note Hook（MR 评论）。note 事件的分支过滤走**目标分支**
 * （matching.ts:56-62），所以 target_branch 固定为 main，让它只可能栽在
 * 命令前缀这一维上。
 */
function noteBody(options: { comment: string; author?: string }): string {
  const n = ++sequence
  return JSON.stringify({
    object_kind: 'note',
    user: { username: options.author ?? 'rfc319-human' },
    project: projectBlock(REPO_PATH),
    object_attributes: {
      id: n,
      note: options.comment,
      noteable_type: 'MergeRequest',
      url: `https://gitlab.invalid/${REPO_PATH}/-/merge_requests/1#note_${n}`,
    },
    merge_request: {
      iid: 1,
      id: 1001,
      title: 'rfc319 fixture MR',
      url: `https://gitlab.invalid/${REPO_PATH}/-/merge_requests/1`,
      source_branch: 'feature/rfc319',
      target_branch: 'main',
      last_commit: { id: `commit${n}` },
    },
  })
}

interface Endpoint {
  id: string
  urlToken: string
  secret: string
}

async function seedEndpoint(): Promise<Endpoint> {
  return jsonOf<Endpoint>(
    await req('/api/webhook-endpoints', {
      method: 'POST',
      body: JSON.stringify({ name: `rfc319-endpoint-${++sequence}`, provider: 'gitlab' }),
    }),
    'create endpoint',
  )
}

async function seedWorkflow(): Promise<string> {
  const created = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-trigger-wf-${++sequence}`,
        description: 'RFC-319 webhook trigger fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'echo', bind: { nodeId: 'in_1', portName: 'topic' } }],
              position: { x: 320, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_out',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'out_1', portName: 'echo' },
            },
          ],
        },
      }),
    }),
    'seed workflow',
  )
  return created.id
}

async function seedTrigger(
  endpointId: string,
  workflowId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return jsonOf<{ id: string }>(
    await req('/api/webhook-triggers', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-trigger-${++sequence}`,
        endpointId,
        enabled: true,
        repoScope: { kind: 'exact', paths: [REPO_PATH] },
        eventTypes: ['pipeline_failed'],
        maxConsecutiveFires: 2,
        // 事件仓库并未注册进平台，所以走临时工作区；这条用例关心的是
        // **要不要开工**，不是开出来的工作跑成什么样。临时工作区与
        // `autoRegisterRepos` 互斥（实测 `scratch-auto-register-conflict`）——
        // 没有事件仓库可注册。
        autoRegisterRepos: false,
        launchKind: 'workflow',
        launchRefId: workflowId,
        launchPayload: {
          scratch: true,
          inputs: { topic: { kind: 'template', template: 'pipeline failed' } },
        },
        ...overrides,
      }),
    }),
    'create trigger',
  )
}

async function deliver(
  endpoint: Endpoint,
  body: string,
  hook = 'Pipeline Hook',
): Promise<Response> {
  return fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gitlab-token': endpoint.secret,
      'x-gitlab-event': hook,
      'x-gitlab-event-uuid': `rfc319-uuid-${++sequence}`,
    },
    body,
  })
}

interface FireRow {
  outcome: string
}

/** 触发历史。投递是异步分发的，所以按「至少 N 条」轮询而不是读一次。 */
async function firesOf(triggerId: string, atLeast: number): Promise<FireRow[]> {
  const deadline = Date.now() + 30_000
  let rows: FireRow[] = []
  while (Date.now() < deadline) {
    const res = await req(`/api/webhook-triggers/${triggerId}/fires`)
    if (res.ok) {
      const body = (await res.json()) as FireRow[] | { items?: FireRow[] }
      rows = Array.isArray(body) ? body : (body.items ?? [])
      if (rows.length >= atLeast) return rows
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return rows
}

// ---------------------------------------------------------------------------
// EVENT-18 —— 条件匹配：仓库范围 / 事件类型 / 分支 glob / 作者忽略名单
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-18: all five matching dimensions gate a fire independently, and the author list deliberately does not gate pipeline facts', async () => {
  const endpoint = await seedEndpoint()
  const workflowId = await seedWorkflow()
  const trigger = await seedTrigger(endpoint.id, workflowId, {
    eventTypes: ['pipeline_failed', 'push', 'note'],
    branchFilter: 'main',
    commandPrefix: '/fix',
    ignoreUsernames: ['rfc319-noisy-bot'],
    // 熔断在这条用例里必须让开路：它验的是**要不要命中**，不是命中之后的节流。
    maxConsecutiveFires: 100,
  })

  const fireCount = async (): Promise<number> => (await firesOf(trigger.id, 0)).length

  // 正向：五维全中 ⇒ 开工。这条必须先成立，否则后面每一条「没开工」都是恒真。
  expect((await deliver(endpoint, pipelineBody())).ok).toBe(true)
  await expect
    .poll(fireCount, {
      timeout: 30_000,
      message: '完全匹配的事件没有触发 ⇒ 后面所有断言都证明不了任何东西',
    })
    .toBeGreaterThanOrEqual(1)
  const baseline = await fireCount()

  // 五条「不该命中」，逐条独立说明它挡的是哪一维。
  const misses: Array<[string, string, string]> = [
    // ① 仓库范围：exact 名单之外。
    ['repo-scope', pipelineBody({ repoPath: 'rfc319/some-other-repo' }), 'Pipeline Hook'],
    // ② 事件类型：同一个仓、同一个分支，只是 status=success ⇒ pipeline_succeeded，
    //    不在 eventTypes 里。刻意选它而不是 tag_push——tag_push 会先栽在分支过滤上，
    //    那样这一条就不是在验事件类型。
    ['event-type', pipelineBody({ status: 'success' }), 'Pipeline Hook'],
    // ③ 分支 glob。
    ['branch-filter', pipelineBody({ branch: 'release/9.9' }), 'Pipeline Hook'],
    // ④ 评论命令前缀：note 事件，目标分支是 main（过得了分支这一维），
    //    正文不以 `/fix` 开头。
    ['command-prefix', noteBody({ comment: 'looks good to me' }), 'Note Hook'],
    // ⑤ 忽略作者：push 事件（作者过滤只作用于 AUTHOR_FILTERED_EVENT_TYPES）。
    ['author-ignored', pushBody({ author: 'rfc319-noisy-bot' }), 'Push Hook'],
  ]
  for (const [, body, hook] of misses) {
    expect((await deliver(endpoint, body, hook)).ok).toBe(true)
  }

  // 分发是异步的：给它一段与正向那条同量级的时间，期间计数不得增长。
  await new Promise((r) => setTimeout(r, 2000))
  expect(
    await fireCount(),
    '规则在它声明范围之外触发了 ⇒ 每一次都是一个真实的 agent 进程和一份真实的 diff，' +
      '而仓库的作者不会收到任何通知',
  ).toBe(baseline)

  // 反过来的一条，同样要锁：**流水线事实不按作者过滤**。
  // bot 推分支引发的流水线失败必须还能触发「修到绿」，否则自动化在最需要它的
  // 那个场景里恰好失灵（matching.ts:44-48 的设计裁决）。忘掉这条不对称的人，
  // 会顺手把 ignoreUsernames 加进 pipeline 分支，而症状是「自动修复再也不启动」。
  expect((await deliver(endpoint, pipelineBody({ author: 'rfc319-noisy-bot' }))).ok).toBe(true)
  await expect
    .poll(fireCount, {
      timeout: 30_000,
      message: '忽略名单把 pipeline 事件也挡住了 ⇒ bot 引发的流水线失败再也触发不了修复',
    })
    .toBe(baseline + 1)
})

// ---------------------------------------------------------------------------
// EVENT-19 —— 熔断：连续同流触发达上限 → skipped-circuit-open，可人工重置
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-19: consecutive fires on one stream trip the breaker, and a manual reset re-arms it', async () => {
  const endpoint = await seedEndpoint()
  const workflowId = await seedWorkflow()
  // 作者恒在忽略名单里 ⇒ `evaluateCircuit` 不会因「人已介入」清零，计数持续累加。
  // 这正是真实事故的形状：机器人推分支、流水线失败、规则再开工。
  const trigger = await seedTrigger(endpoint.id, workflowId, {
    maxConsecutiveFires: 2,
    ignoreUsernames: ['rfc319-bot'],
  })

  for (let i = 0; i < 4; i += 1) {
    expect((await deliver(endpoint, pipelineBody())).ok).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
  }

  const fires = await firesOf(trigger.id, 3)
  const opened = fires.filter((f) => f.outcome === 'skipped-circuit-open')
  expect(
    opened.length,
    '连续四次同流触发都放行了 ⇒ 「任务推分支 → 流水线失败 → 再开工」这个环没有上限',
  ).toBeGreaterThan(0)
  const launched = fires.filter((f) => f.outcome !== 'skipped-circuit-open')
  expect(
    launched.length,
    `熔断把上限之内的触发也挡了（launched=${launched.length}）⇒ 规则等于没生效`,
  ).toBeGreaterThanOrEqual(2)

  // 人工重置：闸门重新合上，下一条同流事件又能开工。
  // 没有这一步，熔断就是个单向门——一旦跳闸只能改规则或等 24 小时窗口。
  const reset = await req(`/api/webhook-triggers/${trigger.id}/streams/reset`, {
    method: 'POST',
    body: JSON.stringify({ streamKey: `${REPO_PATH}|branch:main` }),
  })
  expect(reset.status, `人工重置失败: ${await reset.clone().text()}`).toBe(200)

  const before = fires.length
  expect((await deliver(endpoint, pipelineBody())).ok).toBe(true)
  const afterReset = await firesOf(trigger.id, before + 1)
  const newest = afterReset[0]
  expect(newest?.outcome, '人工重置之后同流事件仍被熔断挡着 ⇒ 跳闸之后没有恢复手段').not.toBe(
    'skipped-circuit-open',
  )
})

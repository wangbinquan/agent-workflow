// RFC-359 AC-1 / AC-6（plan §5hn 之后的盘点，第 1 刀）—— **任务详情的纯读四件**在两个引擎上
// 投影出同一份。
//
// 为什么这条测试存在：启动面已经全合（批次一 / 二 ①–⑧）。`TaskRouteOperations` 这一对剩下的是
// 「任务路由的其余动词」——SQLite 那 276 行全是转给 `services/task.ts` 的薄壳，PostgreSQL 那
// 2555 行是原生实现。合它之前先把等价性钉住，这是前八刀验证过的次序。
//
// 这一刀取**差异面最小**的一组：`node-runs` 的投影。它不需要真跑任务——直接把 `node_runs` /
// `doc_versions` / `clarify_rounds` 播种成确定的形状，读的就是投影本身，
// 而投影正是这一对唯一可能分叉的地方（PG 那侧自带评审轮次计时、clarify 轮次、nav kind）。
import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { clarifyRounds, docVersions, nodeRuns } from '@/db/schema'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const TOKEN = 'r'.repeat(64)
const NOW = 1_788_278_400_000

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

async function createAgent(app: Hono, name: string): Promise<string> {
  const res = await req(app, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'rfc359 read parity',
    }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

/** 两节点：一个 agent（跑完）、一个 review（等人审）。几何写成非规范值。 */
function definitionFor(writerAgentId: string) {
  return {
    $schema_version: 5,
    inputs: [],
    nodes: [
      {
        id: 'writer',
        kind: 'agent-single',
        agentId: writerAgentId,
        agentName: 'writer',
        promptTemplate: 'write it',
        position: { x: 71, y: 233 },
      },
    ],
    edges: [],
  }
}

/** 逐次必然不同的那几格。其余整条响应体都比。 */
const VOLATILE_RUN_KEYS = new Set(['taskId'])

function comparableRuns(body: Record<string, unknown>): unknown {
  const runs = (body['runs'] as ReadonlyArray<Record<string, unknown>>).map((run) => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(run).sort()) {
      if (VOLATILE_RUN_KEYS.has(key)) continue
      out[key] = run[key]
    }
    return out
  })
  return { runs, outputs: body['outputs'] }
}

const projected = new Map<string, unknown>()

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— 任务 node-runs 投影的两个引擎对等',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-read-parity-',
  },
  (scope) => {
    let app: Hono

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    test('同一批 node_runs / doc_versions / clarify_rounds：两个引擎投影出同一份 node-runs', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const writerId = await createAgent(app, `read-writer-${suffix}`)
      const wfRes = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `read-wf-${suffix}`,
          description: 'rfc359 read parity',
          definition: definitionFor(writerId),
        }),
      })
      expect(wfRes.status, await wfRes.clone().text()).toBe(201)
      const workflow = (await wfRes.json()) as { id: string }

      const launched = await req(app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow.id,
          name: 'rfc359 read parity',
          scratch: true,
        }),
      })
      expect(launched.status, await launched.clone().text()).toBe(201)
      const taskId = String(((await launched.json()) as { id: string }).id)

      // **确定形状的播种**：三条 run 覆盖三种时间线位置（未开始 / 跑完 / 等人审），
      // 外加一条评审版本与一条 clarify 轮次，把 PG 那侧独有的派生（轮次计时 / nav kind /
      // clarify 状态）全都点亮——分叉只可能在这些派生里。
      await scope.harness.db.insert(nodeRuns).values([
        {
          id: 'rr-pending-0001',
          taskId,
          nodeId: 'writer',
          status: 'pending',
          retryIndex: 0,
          iteration: 0,
          operationGeneration: 0,
        },
        {
          id: 'rr-done-0001',
          taskId,
          nodeId: 'writer',
          status: 'done',
          retryIndex: 0,
          iteration: 1,
          startedAt: NOW,
          finishedAt: NOW + 1_000,
          operationGeneration: 0,
        },
        {
          id: 'rr-review-0001',
          taskId,
          nodeId: 'writer',
          status: 'awaiting_review',
          retryIndex: 0,
          iteration: 2,
          startedAt: NOW + 2_000,
          operationGeneration: 0,
        },
      ])
      await scope.harness.db.insert(docVersions).values({
        id: 'dv-0001',
        taskId,
        reviewNodeId: 'writer',
        reviewNodeRunId: 'rr-review-0001',
        sourceNodeId: 'writer',
        sourcePortName: 'report',
        versionIndex: 1,
        itemIndex: 0,
        roundGeneration: 0,
        reviewIteration: 0,
        bodyPath: 'reviews/dv-0001.md',
        decision: 'pending',
        createdAt: NOW + 2_500,
      })
      await scope.harness.db.insert(clarifyRounds).values({
        id: 'cr-0001',
        taskId,
        kind: 'self',
        askingNodeId: 'writer',
        askingNodeRunId: 'rr-done-0001',
        intermediaryNodeId: 'writer',
        intermediaryNodeRunId: 'rr-done-0001',
        questionsJson: '[]',
        status: 'answered',
        createdAt: NOW + 900,
      })

      const res = await req(app, `/api/tasks/${taskId}/node-runs`)
      expect(res.status, await res.clone().text()).toBe(200)
      const body = (await res.json()) as Record<string, unknown>

      // 先钉住这一侧**本身**的正确性——两个引擎同样地错也会让相等断言绿掉。
      const runs = body['runs'] as ReadonlyArray<Record<string, unknown>>
      expect(
        runs.map((run) => run['id']),
        '未开始的那条必须排在最前（两个引擎的 NULL 默认落位相反）',
      ).toEqual(['rr-pending-0001', 'rr-done-0001', 'rr-review-0001'])

      projected.set(scope.harness.capabilities.provider, comparableRuns(body))
      if (projected.size < 2) return
      expect(
        projected.get('postgresql'),
        '两个引擎的 node-runs 投影不一致（plan §5hn 之后的盘点，第 1 刀）',
      ).toEqual(projected.get('sqlite'))
    })
  },
)

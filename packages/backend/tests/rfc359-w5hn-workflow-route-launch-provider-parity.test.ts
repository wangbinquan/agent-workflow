// RFC-359 AC-1 / AC-6（plan §5hn 批次二 ④）—— **JSON `POST /api/tasks`** 在两个引擎上落出同一行。
//
// 为什么这条测试存在：批次一 / 二 ③ 合了代理与工作组两条路由，批次二 ①② 合了定时 / webhook。
// 剩下的最大一条是 **工作流 JSON 路由**：SQLite 仍走
// `sqliteTaskRouteOperations` → `startExecution` → `startTask`（三千行的老启动器），
// PostgreSQL 走 `launches.launch` → 根启动内核。这是**最主要的那条启动路**，
// 也是本 RFC 剩下的最大一对孪生。
//
// 合它之前先把等价性钉住——这是前三刀验证过的次序。判据形状照抄：
// **拒绝清单**（把逐次必然不同的那几格摘掉、其余整行都比）+ 各自的正确性断言。
import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { eq } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import { comparableTaskRow } from './helpers/taskRowParity'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const TOKEN = 'j'.repeat(64)

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

/** 逐次必然不同的那几格（口径同前三条基线）。 */
const VOLATILE = new Set([
  'id',
  'startedAt',
  'finishedAt',
  'expiresAt',
  'deletedAt',
  'branch',
  'repoPath',
  'worktreePath',
  'baseCommit',
  'workflowId',
  'workflowName',
  'repos',
  // 调度器异步接手，读回来时可能已经从 pending 翻到 running——时间相关，不是引擎差异。
  'status',
  // **已知差异，单独钉住**（见下）。
  'spaceNodes',
])

function comparableTask(task: Record<string, unknown>): Record<string, unknown> {
  const snapshot = task['workflowSnapshot'] as
    | { nodes?: ReadonlyArray<Record<string, unknown>>; edges?: ReadonlyArray<unknown> }
    | undefined
  const comparable: Record<string, unknown> = {}
  for (const key of Object.keys(task).sort()) {
    if (VOLATILE.has(key)) continue
    comparable[key] =
      key === 'workflowSnapshot'
        ? {
            nodeIds: (snapshot?.nodes ?? []).map((node) => node['id']).sort(),
            nodeKinds: (snapshot?.nodes ?? []).map((node) => node['kind']).sort(),
            edgeCount: (snapshot?.edges ?? []).length,
            // 作者自绘的工作流：几何必须**原样**保留（不是内置宿主，不做规范排版）。
            positions: (snapshot?.nodes ?? []).map((node) => JSON.stringify(node['position'])),
          }
        : task[key]
  }
  comparable['repoShape'] = (task['repos'] as ReadonlyArray<Record<string, unknown>>).map(
    (repo) => ({ mountPath: repo['mountPath'], scratch: repo['scratch'] }),
  )
  return comparable
}

/**
 * 作者自绘的两节点工作流。几何刻意写成非规范值（`{x:137,y:421}` / `{x:733,y:61}`），
 * 用来证明它**没被重排**——规范排版只对平台自有的合成宿主做（plan §5hn 批次一）。
 * 不连边、不声明 workflow 级输入：本条要比的是**落库那一行**，不是编排语义，
 * 而静态校验对孤立输入 / 缺端口会直接 422，把用例挡在判据之前。
 */
function definitionFor(writerAgentId: string, reviewerAgentId: string) {
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
        position: { x: 137, y: 421 },
      },
      {
        id: 'reviewer',
        kind: 'agent-single',
        agentId: reviewerAgentId,
        agentName: 'reviewer',
        promptTemplate: 'review it',
        position: { x: 733, y: 61 },
      },
    ],
    edges: [],
  }
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
      bodyMd: 'rfc359 route parity',
    }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

const launched = new Map<string, Record<string, unknown>>()
const persisted = new Map<string, Record<string, unknown>>()

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— 工作流 JSON 路由启动的两个引擎落库对等',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-workflow-route-parity-',
  },
  (scope) => {
    let app: Hono

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    test('同一份 POST /api/tasks：两个引擎落出的 task 行逐字相同', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const writerId = await createAgent(app, `route-writer-${suffix}`)
      const reviewerId = await createAgent(app, `route-reviewer-${suffix}`)
      const wfRes = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `route-wf-${suffix}`,
          description: 'rfc359 route parity',
          definition: definitionFor(writerId, reviewerId),
        }),
      })
      expect(wfRes.status, await wfRes.clone().text()).toBe(201)
      const workflow = (await wfRes.json()) as { id: string }

      const response = await req(app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow.id,
          name: 'rfc359 workflow route parity',
          scratch: true,
          maxDurationMs: 600_000,
          maxTotalTokens: 250_000,
        }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const task = (await response.json()) as Record<string, unknown>

      // 先钉住这一侧**本身**确实是工作流路由落出来的——两个引擎同样地错也会让相等断言绿掉。
      expect(task['workflowId'], '必须挂在被选中的工作流上').toBe(workflow.id)
      expect(task['launchOrigin'] ?? 'manual', '直连 JSON 启动不是定时/事件来源').toBe('manual')

      const comparable = comparableTask(task)
      // 作者几何不得被重排（规范排版只对平台自有的合成宿主做）。
      expect(
        (comparable['workflowSnapshot'] as { positions: string[] }).positions,
        '作者自绘的坐标必须原样冻结进快照',
      ).toEqual(['{"x":137,"y":421}', '{"x":733,"y":61}'])

      // **已知差异，钉的是缺陷不是契约**（与 §5hn 批次二 ③ 的 `spaceNodes` 同一处，
      // 只是这一条落在**工作流 JSON 路由**上——它还没合，SQLite 仍走
      // `startExecution` → `startTask`）。成因：`startTask` 的读投影在没有冻结的
      // `task_space_nodes` 行时**兜底派生** `minimalNodePaths(repos.map(r => r.mountPath))`，
      // scratch 那一个挂载点是空串，于是派生出一个 **path 为空**的节点；
      // 根启动内核则原样返回工作区真正规划的 `nodePaths`——scratch 上就是空的。
      // PG 那半更诚实。合并 `startTask` 那一刀把它统一时，下面这条会红并要求销账。
      expect(
        (task['spaceNodes'] as readonly unknown[]).length,
        `${scope.harness.capabilities.provider}：scratch 启动的 spaceNodes 形状变了。` +
          'SQLite 应为 1（兜底派生出一个空路径节点）、PostgreSQL 应为 0（工作区没规划目录）。' +
          '若两侧一致了，说明合并把这处差异统一了——把这条改成相等断言并在 plan 里销账。',
      ).toBe(scope.harness.capabilities.provider === 'sqlite' ? 1 : 0)

      const row = (
        await scope.harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, String(task['id'])))
          .limit(1)
      )[0] as unknown as Record<string, unknown>
      expect(row, '任务行必须真的落库了').toBeDefined()
      persisted.set(scope.harness.capabilities.provider, comparableTaskRow(row))

      launched.set(scope.harness.capabilities.provider, comparable)
      if (launched.size < 2) return
      expect(
        persisted.get('postgresql'),
        '两个引擎**落库那一行**不一致（响应体一致不代表行一致——响应是现算的投影）',
      ).toEqual(persisted.get('sqlite'))
      expect(
        launched.get('postgresql'),
        '两个引擎的工作流 JSON 路由启动落库结果不一致——合并 startTask 之前必须先解释清楚（plan §5hn 批次二 ④）',
      ).toEqual(launched.get('sqlite'))
    })
  },
)

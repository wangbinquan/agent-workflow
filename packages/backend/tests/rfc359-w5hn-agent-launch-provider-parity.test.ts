// RFC-359 AC-1 / AC-6（plan §5hn 批次一）—— 单代理启动在两个引擎上**落出同一行**。
//
// 为什么这条测试存在：单代理启动（`POST /api/agents/:id/tasks`）在两个 provider 上走的是
// **两份各约 200 行的编排**——SQLite 走 `services/agentLaunch.ts#startAgentTask`（末端 `startTask`），
// PostgreSQL 走 `postgresqlTaskRouteLaunchOperations.ts#launchAgent`（末端启动内核）。
// plan §5hn 的先行对账把十二步前置链逐项点过：十一步对得上，连宿主快照都用**同一个**
// `buildAgentHostSnapshot`（PG 从 `services/agentLaunch` import 它），唯一差别是最后怎么落库。
//
// 但那份对账是按**函数名出现与否**点的——它证明不了「两侧传给同一个函数的实参也一样」。
// 这条用例补的正是那一格：同一份 launch 请求打到同一条路由，**两个引擎落出的 task 行逐字相同**。
//
// 它同时补上一个 AC-6 缺口：`rfc165-agent-launch.test.ts` 是 SQLite 单引擎的
// （`createInMemoryDb`），PG 侧那份 `launchAgent` 编排此前**没有任何行为用例**。
//
// 合并两份编排（§5hn 批次一）之前，这条必须是绿的——它是「合并没有改变用户可见行为」的基线。
import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { AGENT_HOST_INPUT_KEY, AGENT_HOST_WORKFLOW_ID } from '@/services/agentLaunch'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const TOKEN = 'c'.repeat(64)

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

function agentPayload(name: string): Record<string, unknown> {
  return {
    name,
    description: 'rfc359 parity agent',
    outputs: ['agent-result'],
    outputKinds: { 'agent-result': 'string' },
    syncOutputsOnIterate: false,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'do the thing',
  }
}

/**
 * 两个引擎各记一份「启动后 task 行的可比投影」，两条 lane 都到齐时当场逐字比对。
 *
 * 不用两个 describe 分别记录 / 比较——CI 跑 `--randomize`，用例顺序不可依赖
 * （本仓实撞过：`rfc359-w5-composition-root-route-surface` 第一版就是那么写的，
 * 比较那条先跑，看到空账本直接绿）。比较折进 lane 用例本身，谁最后到齐谁做比较。
 */
const launched = new Map<string, Record<string, unknown>>()

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— 单代理启动的两个引擎落库对等',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-agent-launch-parity-',
  },
  (scope) => {
    let app: Hono

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    test('同一份 launch 请求：两个引擎落出的 task 行逐字相同', async () => {
      const name = `parity-${ulid().slice(-8).toLowerCase()}`
      const created = await req(app, '/api/agents', {
        method: 'POST',
        body: JSON.stringify(agentPayload(name)),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const agent = (await created.json()) as { id: string }

      const response = await req(app, `/api/agents/${agent.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'rfc359 parity launch',
          description: 'fix the flaky test',
          scratch: true,
          allowClarify: false,
        }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const task = (await response.json()) as Record<string, unknown>

      // 可比投影：剔掉天然按次不同的那几格（id / 时间戳 / 分支名 / 工作区路径 /
      // 本次随机的 agent 名），其余**必须**逐字相同。
      const snapshot = task['workflowSnapshot'] as
        | { nodes?: ReadonlyArray<Record<string, unknown>>; edges?: ReadonlyArray<unknown> }
        | undefined
      const comparable = {
        status: task['status'],
        workflowId: task['workflowId'],
        spaceKind: task['spaceKind'],
        inputs: task['inputs'],
        scratch: task['scratch'],
        catalogVisibility: task['catalogVisibility'],
        // 快照按**形状**比：节点 id / 种类 / 是否都带布局，边数。
        // 具体坐标与 agent 名逐次不同，不进比较面。
        snapshotNodeIds: (snapshot?.nodes ?? []).map((node) => node['id']).sort(),
        snapshotNodeKinds: (snapshot?.nodes ?? []).map((node) => node['kind']).sort(),
        snapshotEdgeCount: (snapshot?.edges ?? []).length,
      }
      // **已知差异，单独钉住**（plan §5hn 批次一实测）：内置宿主快照的**规范排版**
      // 在 SQLite 上是**写时冻结**的（`services/task.ts` 的 `startTask` 对
      // `workflow.builtin === true` 走 `layoutBuiltinWorkflowSnapshotJson`），
      // 而启动内核直接 `JSON.stringify(subject.workflowSnapshot)` 落库、
      // 靠**读时**投影补排版（`postgresqlTaskRouteOperations.ts` 的
      // `projectWorkflowSnapshotForRead`）。于是**启动响应体**与库里那一行在两个引擎上不同。
      //
      // 它不进上面那个相等面，是因为这条用例要守的是「其余十一步的实参也一样」——
      // 把这一格混进去只会让整条红成一团、盖住别的漂移。
      // **这一格自己的守法是反向的**：下面钉的是**今天的**状态，
      // §5hn 批次一把两份编排合一、内核也改成写时冻结之后，这条会红并要求改成相等——
      // 那正是销账的时刻。
      const everyNodePositioned = (snapshot?.nodes ?? []).every(
        (node) => node['position'] !== undefined,
      )
      expect(
        everyNodePositioned,
        `${scope.harness.capabilities.provider}：内置宿主快照的写时排版状态变了。` +
          'SQLite 应为 true（startTask 写时冻结）、PostgreSQL 应为 false（内核不排版，读时投影补）。' +
          '若 PostgreSQL 变成 true，说明 §5hn 的合并把这处差异关掉了——把这条改成相等断言并在 plan 里销账。',
      ).toBe(scope.harness.capabilities.provider === 'sqlite')

      // 先钉住这一侧本身确实是「单代理启动」落出来的，避免两边**同样地错**也叫对等。
      expect(comparable.workflowId, '单代理启动必须挂在 __agent_host__ 锚上').toBe(
        AGENT_HOST_WORKFLOW_ID,
      )
      expect(
        (task['inputs'] as Record<string, unknown> | undefined)?.[AGENT_HOST_INPUT_KEY],
        '启动 description 必须落进宿主输入端口',
      ).toBe('fix the flaky test')
      expect(task['sourceAgentName'], '必须盖上来源 agent 名').toBe(name)

      // 语料下限：比较面不能是空壳。`toEqual({}, {})` 恒真，
      // 「两个引擎一致」与「投影塌了」在那种形状下同形（RFC-317 T13「零与合规同形」）。
      expect(comparable.snapshotNodeIds.length, '宿主快照节点扫成空 ⇒ 比较面失效').toBeGreaterThan(
        1,
      )
      expect(comparable.snapshotEdgeCount, '宿主快照边扫成 0 ⇒ 比较面失效').toBeGreaterThan(0)

      launched.set(scope.harness.capabilities.provider, comparable)
      if (launched.size < 2) return

      const sqlite = launched.get('sqlite')
      const postgresql = launched.get('postgresql')
      expect(
        postgresql,
        '两个引擎的单代理启动落库结果不一致——合并两份编排前必须先解释清楚这处差异（plan §5hn）',
      ).toEqual(sqlite)
    })
  },
)

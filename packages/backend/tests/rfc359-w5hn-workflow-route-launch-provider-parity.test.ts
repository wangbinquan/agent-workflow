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
// **合一之后怎么给这条做变异**（2026-09-17 实做记下）：两侧共用一份实现之后，
// 改**共享实现**的变异再也咬不住这条相等断言——两个 lane 会一起变，相等照样成立。
// 这不是判据失效，是相等面的本分换了：合并前它护的是「换终端没换行为」，
// 合并后它护的是「将来别再分叉」。要证明它还活着，变异必须只动**一侧**——
// 实测把 SQLite 路由的 payload `name` 缀一截（`{ ...task, name: \`${task.name}_MUT\` }`）
// 当场红在行级比对上。
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
const inputContract = new Map<string, unknown>()

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

      // **已销账**（plan §5hn 批次二 ④）：此前 SQLite 的读投影在没有冻结的 `task_space_nodes`
      // 行时**兜底派生** `minimalNodePaths(repos.map(r => r.mountPath))`，scratch 那个挂载点是
      // 空串，于是派生出一个 **path 为空**的节点；根启动内核则原样返回工作区真正规划的
      // `nodePaths`。工作流 JSON 路由改走内核之后两侧都是空——**这是用户可见的响应形状变化，
      // 方向是「变诚实」**：没有规划目录就返回空，而不是一个凭空派生出来的空路径节点
      //（与 §5hn 批次二 ③ 在工作组那条路上做的是同一件事）。
      expect(
        (task['spaceNodes'] as readonly unknown[]).length,
        'scratch 启动没有规划目录，spaceNodes 就该是空的（plan §5hn 批次二 ④）',
      ).toBe(0)

      // **落库那一行**也要比：响应体是 `taskProjection(...)` 现算的投影，不是回读
      //（变异实证见 `tests/helpers/taskRowParity.ts` 的头注释）。
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
        '两个引擎的工作流 JSON 路由启动响应体不一致（plan §5hn 批次二 ④）',
      ).toEqual(launched.get('sqlite'))
    })

    test('call 目标改名后启动：两个引擎以**同一个错误契约**拒掉', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const calleeName = `callee-${suffix}`
      const emptyDefinition = { $schema_version: 5, inputs: [], nodes: [], edges: [] }

      const calleeRes = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: calleeName, description: '', definition: emptyDefinition }),
      })
      expect(calleeRes.status, await calleeRes.clone().text()).toBe(201)
      const callee = (await calleeRes.json()) as {
        id: string
        version: number
        definition: unknown
      }

      const callerRes = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `caller-${suffix}`,
          description: '',
          definition: {
            $schema_version: 5,
            inputs: [],
            nodes: [
              {
                id: 'call1',
                kind: 'call-workflow',
                workflowName: calleeName,
                position: { x: 10, y: 20 },
              },
            ],
            edges: [],
          },
        }),
      })
      expect(callerRes.status, await callerRes.clone().text()).toBe(201)
      const caller = (await callerRes.json()) as { id: string }

      // `call-workflow` 按**名字**解析（durable name + 可选 id 缓存）——改名即让引用悬空。
      // 这是删除之外唯一能到达该状态的路径：删被引用的工作流会 409 `workflow-in-use`。
      const renamed = await req(app, `/api/workflows/${callee.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: callee.version,
          clientMutationId: ulid(),
          snapshot: { name: `renamed-${suffix}`, description: '', definition: callee.definition },
        }),
      })
      expect(renamed.status, await renamed.clone().text()).toBe(200)

      const launch = await req(app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: caller.id,
          name: 'dangling call launch',
          scratch: true,
        }),
      })
      expect(launch.status, await launch.clone().text()).toBe(422)
      const body = (await launch.json()) as {
        code?: string
        details?: { issues?: ReadonlyArray<{ code?: string }> }
      }

      // **已销账**（plan §5hn 批次二 ④）：此前同一条规则在两条不同的门上生效——
      // SQLite 的路由先跑带 candidate 的静态校验（`workflow-invalid` + `issues[]`），
      // PostgreSQL 没有那道门，一路走到冻结调用闭包才被 `workflow-call-ref-missing` 拒掉
      // （不带 `issues[]`，编辑器指不到出错节点）。
      // 处置是把**候选上下文**透传进启动期校验（`validateHostWorkflow(definition, candidate)`），
      // 两侧因此在同一道门上以同一个契约拒掉。统一到 `issues[]` 这一侧是因为
      // 工作流编辑器的校验面板靠它把出错节点高亮出来。
      expect(body.code, '两个引擎必须回同一个错误码').toBe('workflow-invalid')
      expect(
        body.details?.issues?.some((issue) => issue.code === 'call-workflow-ref-missing'),
        'issues[] 必须点名是哪条 call-node 规则——编辑器靠它定位节点',
      ).toBe(true)
    })

    // RFC-359 AC-1（plan §5hn 批次二 ④）—— **启动输入契约**在两个引擎上是同一道门。
    //
    // 为什么这条测试存在：批次二 ④ 把 SQLite 的工作流 JSON 路由接到共用的启动参与者上，
    // e2e `workflow-matrix.spec.ts` 的「missing required」当场红了——期望 422，实际放行。
    // 追下去是又一条 AC-1 缺口：`assertWorkflowLaunchInputs` 只长在 `startTask` 那一侧
    //（`services/task.ts`），共用的参与者 / 内核上没有，**于是 PostgreSQL 从来没执行过
    // 这条契约**：同一个缺必填的启动，SQLite 422，PostgreSQL 201 照跑，必填项当空串执行。
    // 修在工作流臂上（两侧同一道门），这条测试锁的就是「它对两个引擎都在」。
    test('缺必填 / 未声明键：两个引擎以**同一个启动输入契约**拒掉', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const writerId = await createAgent(app, `contract-writer-${suffix}`)
      const wfRes = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `contract-wf-${suffix}`,
          description: 'rfc359 launch input contract',
          definition: {
            $schema_version: 5,
            // 声明一个必填输入，并用 `input` 节点接进 agent——孤立输入过不了静态校验，
            // 会在契约这道门**之前**就 422，把判据顶掉。
            inputs: [{ kind: 'text', key: 'subject', label: 'Subject', required: true }],
            nodes: [
              {
                id: 'subject_input',
                kind: 'input',
                inputKey: 'subject',
                position: { x: 20, y: 20 },
              },
              {
                id: 'writer',
                kind: 'agent-single',
                agentId: writerId,
                agentName: 'writer',
                promptTemplate: 'write about {{subject}}',
                position: { x: 360, y: 20 },
              },
            ],
            edges: [
              {
                id: 'subject_to_writer',
                source: { nodeId: 'subject_input', portName: 'subject' },
                target: { nodeId: 'writer', portName: 'subject' },
              },
            ],
          },
        }),
      })
      expect(wfRes.status, await wfRes.clone().text()).toBe(201)
      const workflow = (await wfRes.json()) as { id: string }

      const launchWith = async (inputs: Record<string, string>) => {
        const res = await req(app, '/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            workflowId: workflow.id,
            name: 'rfc359 launch input contract',
            scratch: true,
            inputs,
          }),
        })
        const body = (await res.clone().json()) as {
          code?: string
          details?: { issues?: ReadonlyArray<{ key?: string; code?: string }> }
        }
        return {
          status: res.status,
          code: body.code,
          issues: (body.details?.issues ?? []).map((issue) => `${issue.key}:${issue.code}`).sort(),
        }
      }

      const missing = await launchWith({})
      const unknown = await launchWith({ subject: 'ok', stale: 'invisible' })

      // 先各自钉死这一侧的正确性——两个引擎**同样地错**也会让相等断言绿掉。
      expect(missing.status, '缺必填必须 422，不能当空串放行').toBe(422)
      expect(missing.code, '错误码是启动输入契约的那一个').toBe('workflow-inputs-invalid')
      expect(missing.issues, 'issues[] 必须点名是哪个键缺了——启动表单靠它定位字段').toEqual([
        'subject:required-input-missing',
      ])
      expect(unknown.status, '未声明的键必须 422').toBe(422)
      expect(unknown.code, '错误码是启动输入契约的那一个').toBe('workflow-inputs-invalid')
      expect(unknown.issues, 'issues[] 必须点名是哪个键没声明').toEqual(['stale:unknown-input'])

      inputContract.set(scope.harness.capabilities.provider, { missing, unknown })
      if (inputContract.size < 2) return
      expect(
        inputContract.get('postgresql'),
        '两个引擎的启动输入契约不一致（plan §5hn 批次二 ④：修 627290a94 推的红时才发现 PG 一直没这道门）',
      ).toEqual(inputContract.get('sqlite'))
    })
  },
)

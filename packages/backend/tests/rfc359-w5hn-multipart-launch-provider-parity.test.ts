// RFC-359 AC-1 / AC-6（plan §5hn 批次二 ⑥）—— **multipart `POST /api/tasks`** 在两个引擎上落出同一行。
//
// 为什么这条测试存在：`startExecution` 在生产上只剩这最后一条调用路。批次一 / 二 ③④⑤ 的次序
// 每次都一样——**先把等价性钉住，再合**：合并前它见证「两侧是不是同一个判断」，合并后它锁
// 「将来别再分叉」。判据形状照抄工作流路由那条基线：**拒绝清单**（把逐次必然不同的那几格摘掉、
// 其余整行都比）+ 各自的正确性断言 + 行级比对（响应体是现算的投影，不是回读，见
// `tests/helpers/taskRowParity.ts` 头注释的变异实证）。
//
// 用 `scratch: true`：multipart + scratch 是合法组合（上传物落进新建的 scratch 仓），
// 这样不必起 git smart-HTTP 远端夹具，也就不把网络时序混进等价性判据里。
import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { eq } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import { comparableTaskRow } from './helpers/taskRowParity'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const TOKEN = 'm'.repeat(64)

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

function multipart(payload: object, files: ReadonlyArray<[string, string, string]>): FormData {
  const fd = new FormData()
  fd.set('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
  for (const [inputKey, filename, body] of files) {
    fd.append(`files[${inputKey}][]`, new Blob([body]), filename)
  }
  return fd
}

async function postMultipart(app: Hono, fd: FormData): Promise<Response> {
  return app.request('/api/tasks', {
    method: 'POST',
    body: fd,
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
}

/** 逐次必然不同的那几格（口径同前四条基线）。 */
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
            // `agentId` 是每个 lane 各自新建的 ULID，天然不同——比的是「引用了几个 agent」。
            agentRefs: (snapshot?.nodes ?? []).filter((node) => node['agentId'] !== undefined)
              .length,
          }
        : task[key]
  }
  comparable['repoShape'] = (task['repos'] as ReadonlyArray<Record<string, unknown>>).map(
    (repo) => ({ mountPath: repo['mountPath'], scratch: repo['scratch'] }),
  )
  return comparable
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
      bodyMd: 'rfc359 multipart parity',
    }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

/**
 * 一个带 upload 输入的两节点工作流。几何写成非规范值，用来证明作者自绘的坐标**没被重排**
 * （规范排版只对平台自有的合成宿主做）。
 */
function definitionWith(uploadKey: string, writerAgentId: string) {
  return {
    $schema_version: 5,
    inputs: [
      {
        kind: 'upload',
        key: uploadKey,
        label: 'Attachments',
        required: false,
        targetDir: 'inputs/refs',
        accept: ['.txt'],
        maxCount: 3,
        maxFileBytes: 1024 * 1024,
      },
    ],
    nodes: [
      { id: 'refs_input', kind: 'input', inputKey: uploadKey, position: { x: 31, y: 617 } },
      {
        id: 'writer',
        kind: 'agent-single',
        agentId: writerAgentId,
        agentName: 'writer',
        promptTemplate: 'summarize {{' + uploadKey + '}}',
        position: { x: 409, y: 128 },
      },
    ],
    edges: [
      {
        id: 'refs_to_writer',
        source: { nodeId: 'refs_input', portName: uploadKey },
        target: { nodeId: 'writer', portName: uploadKey },
      },
    ],
  }
}

const launched = new Map<string, Record<string, unknown>>()
const persisted = new Map<string, Record<string, unknown>>()
const danglingCall = new Map<string, unknown>()

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— multipart 启动的两个引擎落库对等',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-multipart-parity-',
  },
  (scope) => {
    let app: Hono

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    test('同一份 multipart POST /api/tasks：两个引擎落出的 task 行逐字相同', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const writerId = await createAgent(app, `mp-writer-${suffix}`)
      const wfRes = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `mp-wf-${suffix}`,
          description: 'rfc359 multipart parity',
          definition: definitionWith('refs', writerId),
        }),
      })
      expect(wfRes.status, await wfRes.clone().text()).toBe(201)
      const workflow = (await wfRes.json()) as { id: string }

      const response = await postMultipart(
        app,
        multipart(
          {
            workflowId: workflow.id,
            name: 'rfc359 multipart parity',
            scratch: true,
            inputs: { refs: '' },
            maxDurationMs: 600_000,
            maxTotalTokens: 250_000,
          },
          [
            ['refs', 'a.txt', 'alpha'],
            ['refs', 'b.txt', 'beta'],
          ],
        ),
      )
      expect(response.status, await response.clone().text()).toBe(201)
      const task = (await response.json()) as Record<string, unknown>

      // 先钉住这一侧**本身**确实是 multipart 路由落出来的——两个引擎同样地错也会让相等断言绿掉。
      expect(task['workflowId'], '必须挂在被选中的工作流上').toBe(workflow.id)
      expect(
        (task['inputs'] as Record<string, string>)['refs'],
        '上传物的仓内路径必须回填进 inputs[]——这正是 multipart 与 JSON 启动的分野',
      ).toBe('inputs/refs/a.txt\ninputs/refs/b.txt')

      // 作者几何不得被重排（规范排版只对平台自有的合成宿主做）。
      expect(
        (comparableTask(task)['workflowSnapshot'] as { positions: string[] }).positions,
        '作者自绘的坐标必须原样冻结进快照',
      ).toEqual(['{"x":31,"y":617}', '{"x":409,"y":128}'])

      // **合并前的已知差异，钉住它**（合并后这条会自己红，届时改成相等断言销账）：
      // SQLite 的读投影在没有冻结的 `task_space_nodes` 行时**兜底派生**
      // `minimalNodePaths(repos.map(r => r.mountPath))`，scratch 那个挂载点是空串，
      // 于是派生出一个 **path 为空**的节点；根启动内核则原样返回工作区真正规划的 `nodePaths`。
      // 这是同一处兜底派生的**第三次**出现（前两次：工作组路由 §5hn 批次二 ③、
      // 工作流 JSON 路由 §5hn 批次二 ④），两次的处置都是「变诚实」——没有规划目录就返回空。
      expect(
        (task['spaceNodes'] as readonly unknown[]).length,
        scope.harness.capabilities.provider === 'sqlite'
          ? 'SQLite 此刻仍在兜底派生一个空路径节点（合并后应为 0）'
          : 'PostgreSQL 返回工作区真正规划的 nodePaths（scratch 没有规划目录 ⇒ 0）',
      ).toBe(scope.harness.capabilities.provider === 'sqlite' ? 1 : 0)

      // **落库那一行**也要比：响应体是 `taskProjection(...)` 现算的投影，不是回读。
      const row = (
        await scope.harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, String(task['id'])))
          .limit(1)
      )[0] as unknown as Record<string, unknown>
      expect(row, '任务行必须真的落库了').toBeDefined()
      persisted.set(scope.harness.capabilities.provider, comparableTaskRow(row))
      const comparable = comparableTask(task)
      // 合并之前把这一格摘掉——它是**已知且已钉住**的那处差异（见上面的 `spaceNodes` 断言），
      // 留在相等面里只会让整条判据红在一个已经写清楚的地方，挡住别的差异被看见。
      delete comparable['spaceNodes']
      launched.set(scope.harness.capabilities.provider, comparable)
      if (launched.size < 2) return
      expect(
        persisted.get('postgresql'),
        '两个引擎**落库那一行**不一致（响应体一致不代表行一致——响应是现算的投影）',
      ).toEqual(persisted.get('sqlite'))
      expect(
        launched.get('postgresql'),
        '两个引擎的 multipart 启动响应体不一致（plan §5hn 批次二 ⑥）',
      ).toEqual(launched.get('sqlite'))
    })

    test('call 目标改名后 multipart 启动：两个引擎以**同一个错误契约**拒掉', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const calleeName = `mp-callee-${suffix}`
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
          name: `mp-caller-${suffix}`,
          description: '',
          definition: {
            $schema_version: 5,
            inputs: [
              {
                kind: 'upload',
                key: 'refs',
                label: 'Attachments',
                required: false,
                targetDir: 'inputs/refs',
                accept: ['.txt'],
                maxCount: 3,
                maxFileBytes: 1024 * 1024,
              },
            ],
            nodes: [
              { id: 'refs_input', kind: 'input', inputKey: 'refs', position: { x: 10, y: 10 } },
              {
                id: 'call1',
                kind: 'call-workflow',
                workflowName: calleeName,
                position: { x: 210, y: 20 },
              },
            ],
            edges: [
              {
                id: 'refs_to_call',
                source: { nodeId: 'refs_input', portName: 'refs' },
                target: { nodeId: 'call1', portName: 'refs' },
              },
            ],
          },
        }),
      })
      expect(callerRes.status, await callerRes.clone().text()).toBe(201)
      const caller = (await callerRes.json()) as { id: string }

      // `call-workflow` 按**名字**解析——改名即让引用悬空（删被引用的工作流会 409）。
      const renamed = await req(app, `/api/workflows/${callee.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: callee.version,
          clientMutationId: ulid(),
          snapshot: {
            name: `mp-renamed-${suffix}`,
            description: '',
            definition: callee.definition,
          },
        }),
      })
      expect(renamed.status, await renamed.clone().text()).toBe(200)

      const launch = await postMultipart(
        app,
        multipart(
          {
            workflowId: caller.id,
            name: 'dangling call multipart launch',
            scratch: true,
            inputs: { refs: '' },
          },
          [['refs', 'a.txt', 'alpha']],
        ),
      )
      const body = (await launch.clone().json()) as {
        code?: string
        details?: { issues?: ReadonlyArray<{ code?: string }> }
      }
      const shape = {
        status: launch.status,
        code: body.code,
        hasCallRefIssue:
          body.details?.issues?.some((issue) => issue.code === 'call-workflow-ref-missing') ??
          false,
      }
      danglingCall.set(scope.harness.capabilities.provider, shape)
      if (danglingCall.size < 2) return
      expect(
        danglingCall.get('postgresql'),
        '两个引擎的 multipart 悬空 call 引用错误契约不一致（plan §5hn 批次二 ⑥）',
      ).toEqual(danglingCall.get('sqlite'))
    })
  },
)

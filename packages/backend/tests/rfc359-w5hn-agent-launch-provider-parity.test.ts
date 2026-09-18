// RFC-359 AC-1 / AC-6（plan §5hn 批次一）—— 单代理启动在两个引擎上**落出同一行**。
//
// 为什么这条测试存在：单代理启动（`POST /api/agents/:id/tasks`）在两个 provider 上走的是
// **两份各约 200 行的编排**——SQLite 走 `services/agentLaunch.ts#startAgentTask`（末端 `startTask`），
// PostgreSQL 走 `taskRouteLaunchOperations.ts#launchAgent`（末端启动内核）。
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
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { AGENT_HOST_INPUT_KEY, AGENT_HOST_WORKFLOW_ID } from '@/services/agentLaunch'
import { tasks } from '@/db/schema'
import { comparableTaskRow } from './helpers/taskRowParity'
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
/**
 * RFC-359 AC-1（plan §5hn 批次二 ④）——**落库那一行**也要比。
 * 响应体是 `taskProjection(...)` 现算的投影，不是回读：变异实证显示，只比响应体时
 * 把内核 INSERT 的 `name` 改掉**照样绿**。标题写着「落库对等」就得真去读库。
 */
const persistedRows = new Map<string, Record<string, unknown>>()
/** 带上传那一支单独记一份：两条路的落点（packed 路径）必须逐字相同。 */
const uploaded = new Map<string, Record<string, unknown>>()

function multipartLaunch(payload: object, files: Array<[string, string, string]>): FormData {
  const form = new FormData()
  form.set('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
  for (const [inputKey, filename, body] of files) {
    form.append(`files[${inputKey}][]`, new Blob([body]), filename)
  }
  return form
}

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
        snapshotEveryNodePositioned: (snapshot?.nodes ?? []).every(
          (node) => node['position'] !== undefined,
        ),
      }
      // **已销账**（plan §5hn 批次一）：内置宿主快照的规范排版，此前 SQLite 是**写时冻结**
      // （`services/task.ts` 的 `startTask` 对 `workflow.builtin === true`），
      // 启动内核却直接 stringify 落库、只靠**读时**投影补——于是启动响应体与库里那一行
      // 在两个引擎上不同。现在内核也在**入口规范化一次**（`subject.builtin` 决定），
      // 落库与返回投影用同一份，两个引擎因此都为 true。
      //
      // 这一格于是**回到相等面**：它不再是「已知差异」，而是两侧共同的正向判据。
      expect(
        (snapshot?.nodes ?? []).every((node) => node['position'] !== undefined),
        `${scope.harness.capabilities.provider}：平台自有的合成宿主快照必须**写时**冻结规范排版。` +
          '读时投影补得了页面，补不了导出与直接读库的下游（plan §5hn）。',
      ).toBe(true)

      // 先钉住这一侧**本身**确实是「单代理启动」落出来的——否则两个引擎**同样地错**
      // 也会让下面那条相等断言绿掉（相等只证明「一致」，不证明「对」）。
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

      const row = (
        await scope.harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, String(task['id'])))
          .limit(1)
      )[0] as unknown as Record<string, unknown>
      expect(row, '任务行必须真的落库了').toBeDefined()
      persistedRows.set(
        scope.harness.capabilities.provider,
        comparableTaskRow(row, ['sourceAgentId', 'sourceAgentName', 'name']),
      )

      launched.set(scope.harness.capabilities.provider, comparable)
      if (launched.size < 2) return

      const sqlite = launched.get('sqlite')
      const postgresql = launched.get('postgresql')
      expect(
        postgresql,
        '两个引擎的单代理启动落库结果不一致——合并两份编排前必须先解释清楚这处差异（plan §5hn）',
      ).toEqual(sqlite)
    })

    // plan §5hn 判据三：上传那一支两条路的实现不同——SQLite 走
    // `materializeSpace` + `applyUploadsToWorktree` 再交给 `startTask`，
    // 内核走 `uploads` 参数在事务内落。**落点必须逐字相同**，所以动实现之前先把它钉住。
    test('带上传的单代理启动：两个引擎落出的 packed 路径逐字相同', async () => {
      const name = `parity-up-${ulid().slice(-8).toLowerCase()}`
      const created = await req(app, '/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          ...agentPayload(name),
          // 声明一个 path<ext> 端口：这类端口只能经 multipart 绑定文件（RFC-218）。
          inputs: [{ name: 'doc', kind: 'path<md>' }],
        }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const agent = (await created.json()) as { id: string }

      const form = multipartLaunch(
        { name: 'rfc359 parity upload', scratch: true, allowClarify: false, inputs: {} },
        [['doc', 'note.md', 'rfc359 upload payload']],
      )
      const response = await app.request(`/api/agents/${agent.id}/tasks`, {
        method: 'POST',
        body: form,
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const task = (await response.json()) as Record<string, unknown>

      const inputs = (task['inputs'] ?? {}) as Record<string, string>
      const packed = inputs['doc'] ?? ''
      // 落点按**相对工作区的完整路径**比。绝对前缀含 taskId / 临时目录、逐次不同，
      // 所以减掉 worktree 前缀——但**剩下的每一段都要比**：
      // 只比最后一两段会漏掉「多插了一层 inputs 子目录」这类差异（第一版就是这么写的，
      // 拿 `inputsSubdir` 做变异**咬不住**，改成相对全路径后立刻咬住）。
      const worktree = String(task['worktreePath'] ?? '')
      const comparable = {
        packedLineCount: packed.length === 0 ? 0 : packed.split('\n').length,
        packedRelative: packed
          .split('\n')
          .map((line) =>
            worktree.length > 0 && line.startsWith(worktree) ? line.slice(worktree.length) : line,
          ),
        spaceKind: task['spaceKind'],
        status: task['status'],
      }
      expect(
        worktree.length,
        '拿不到 worktreePath ⇒ 相对化失效，比较面会退化成绝对路径',
      ).toBeGreaterThan(0)
      expect(comparable.packedLineCount, '上传物必须落下来（packed 为空 ⇒ 判据失效）').toBe(1)

      uploaded.set(scope.harness.capabilities.provider, comparable)
      if (uploaded.size < 2) return
      expect(
        uploaded.get('postgresql'),
        '两个引擎的上传落点不一致——合并前必须先解释清楚（plan §5hn 判据三）',
      ).toEqual(uploaded.get('sqlite'))
    })
  },
)

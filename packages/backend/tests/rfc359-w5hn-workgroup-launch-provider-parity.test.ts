// RFC-359 AC-1 / AC-6（plan §5hn 批次二 ③）—— 工作组启动在两个引擎上**落出同一行**。
//
// 为什么这条测试存在：工作组启动是 §5hn 批次二里最大的一对——
// `legacy/workgroup/launch.ts#startWorkgroupTask`（470 行，直接读库：`getWorkgroupById`
// + `canViewResource`）对 `taskRouteLaunchOperations#arms.launchWorkgroup`
// （收端口：`workgroup.loadVisible` / `loadExistingAgentIds` / `ensureHostWorkflow` / `integrity`）。
// 检查项（`expectedWorkgroupId` / `expectedWorkgroupVersion` / `memberAgentIds` 派生）逐项对得上，
// 差别还是那一处：**读库的那半只服务一个引擎**。
//
// 合并 470 行之前先把等价性钉住——这是 agent 那一刀（§5hn 批次一）验证过的次序：
// 先有基线，换终端时才知道「行为没动」不是自我说服。
// 判据形状照抄那条：相等面 + 各自的正确性断言（相等只证明「一致」，不证明「对」）。
import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { tasks } from '@/db/schema'
import { comparableTaskRow } from './helpers/taskRowParity'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { WORKGROUP_HOST_WORKFLOW_ID } from '@/modules/resource-catalog/infrastructure/legacy/workgroup/launch'

const TOKEN = 'd'.repeat(64)

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

const launched = new Map<string, Record<string, unknown>>()
/**
 * RFC-359 AC-1（plan §5hn 批次二 ④）——**落库那一行**也要比。
 * 响应体是 `taskProjection(...)` 现算的投影，不是回读：变异实证显示，只比响应体时
 * 把内核 INSERT 的 `name` 改掉**照样绿**。标题写着「落库对等」就得真去读库。
 */
const persistedRows = new Map<string, Record<string, unknown>>()

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— 工作组启动的两个引擎落库对等',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-workgroup-launch-parity-',
  },
  (scope) => {
    let app: Hono

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    test('同一份 launch 请求：两个引擎落出的 task 行逐字相同', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const agentRes = await req(app, '/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: `wg-lead-${suffix}`,
          description: '',
          outputs: [],
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
          bodyMd: 'lead',
        }),
      })
      expect(agentRes.status, await agentRes.clone().text()).toBe(201)
      const agent = (await agentRes.json()) as { id: string }

      const groupRes = await req(app, '/api/workgroups', {
        method: 'POST',
        body: JSON.stringify({
          name: `wg-${suffix}`,
          description: '',
          instructions: '',
          mode: 'leader_worker',
          leaderDisplayName: 'lead',
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 5,
          completionGate: false,
          members: [{ memberType: 'agent', agentId: agent.id, displayName: 'lead', roleDesc: '' }],
        }),
      })
      expect(groupRes.status, await groupRes.clone().text()).toBe(201)
      const group = (await groupRes.json()) as { id: string; version: number }

      const response = await req(app, `/api/workgroups/${group.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ name: 'rfc359 wg parity', goal: 'ship it', scratch: true }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const task = (await response.json()) as Record<string, unknown>

      const snapshot = task['workflowSnapshot'] as
        | { nodes?: ReadonlyArray<Record<string, unknown>>; edges?: ReadonlyArray<unknown> }
        | undefined
      // **拒绝清单，不是允许清单**：把逐次必然不同的那几格摘掉，**其余整个任务行都比**。
      // 允许清单的第一版漏掉了 `workflowName` / `workflowVersion`，拿它们做变异**咬不住**——
      // 允许清单只能保护「我想到的字段」，而这条用例的意义恰恰在于守住我没想到的那些。
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
        'workgroupId',
        'workgroupName',
        'sourceAgentId',
        'sourceAgentName',
        'name',
        // `repos[]` 里嵌着同样逐次不同的 baseCommit / repoPath / worktreePath，
        // 顶层的拒绝清单罩不到它——整格摘掉，改由下面的 `repoShape` 比它的**形状**。
        'repos',
      ])
      const comparable: Record<string, unknown> = {}
      for (const key of Object.keys(task).sort()) {
        if (VOLATILE.has(key)) continue
        comparable[key] =
          key === 'workflowSnapshot'
            ? {
                // 快照按形状比：坐标与 agent 名逐次不同。
                nodeIds: (snapshot?.nodes ?? []).map((node) => node['id']).sort(),
                nodeKinds: (snapshot?.nodes ?? []).map((node) => node['kind']).sort(),
                edgeCount: (snapshot?.edges ?? []).length,
                // 工作组宿主也是平台自有的合成宿主，同样必须**写时**冻结规范排版（plan §5hn）。
                everyNodePositioned: (snapshot?.nodes ?? []).every(
                  (node) => node['position'] !== undefined,
                ),
              }
            : task[key]
      }

      comparable['repoShape'] = (task['repos'] as ReadonlyArray<Record<string, unknown>>).map(
        (repo) => ({ mountPath: repo['mountPath'], scratch: repo['scratch'] }),
      )

      // **已销账**（plan §5hn 批次二 ③）：此前 SQLite 的读投影在没有冻结的 `task_space_nodes`
      // 行时**兜底派生**（`minimalNodePaths(repos.map(r => r.mountPath))`），scratch 那个挂载点
      // 是空串，于是派生出一个 path 为空的节点；而启动内核原样返回工作区真正规划的 `nodePaths`。
      // 工作组启动改走内核之后，两侧都是空——**这是用户可见的响应形状变化，方向是「变诚实」**：
      // 没有规划目录就返回空，而不是一个凭空派生出来的空路径节点。
      expect(
        (task['spaceNodes'] as readonly unknown[]).length,
        'scratch 启动没有规划目录，spaceNodes 就该是空的（plan §5hn 批次二 ③）',
      ).toBe(0)

      // 先钉住这一侧**本身**确实是工作组启动落出来的——两个引擎同样地错也会让相等断言绿掉。
      expect(task['workflowId'], '工作组启动必须挂在 __workgroup_host__ 锚上').toBe(
        WORKGROUP_HOST_WORKFLOW_ID,
      )
      expect(
        (comparable['workflowSnapshot'] as { nodeIds: string[] }).nodeIds,
        '合成宿主必须有 leader / member / clarify 三个节点',
      ).toEqual(['__wg_clarify__', '__wg_leader__', '__wg_member__'])
      expect(
        (comparable['workflowSnapshot'] as { edgeCount: number }).edgeCount,
        '宿主边扫成 0 ⇒ 比较面失效',
      ).toBeGreaterThan(0)

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
        comparableTaskRow(row, [
          'workgroupId',
          'workgroupName',
          'workgroupConfigJson',
          'sourceAgentId',
          'sourceAgentName',
          'name',
        ]),
      )

      launched.set(scope.harness.capabilities.provider, comparable)
      if (launched.size < 2) return
      expect(
        launched.get('postgresql'),
        '两个引擎的工作组启动落库结果不一致——合并 470 行之前必须先解释清楚这处差异（plan §5hn 批次二）',
      ).toEqual(launched.get('sqlite'))
      expect(
        persistedRows.get('postgresql'),
        '两个引擎**落库那一行**不一致（响应体一致不代表行一致——响应是现算的投影）',
      ).toEqual(persistedRows.get('sqlite'))
    })
  },
)

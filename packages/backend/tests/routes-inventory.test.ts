// RFC-029 T6 — integration tests for
// GET /api/tasks/:taskId/node-runs/:nodeRunId/inventory.
// Locks: 200 captured / 200 unavailable (NULL column) / 200 malformed
// RFC-297: 响应形状由 InventorySnapshot 换成 {observation, declaration}。
// (corrupt JSON) / 404 task / 404 node-run / 410 non-agent kind.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  RuntimeInventoryResponse,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
}

interface SeedOpts {
  nodeKind?:
    | 'agent-single'
    | 'agent-multi'
    | 'input'
    | 'output'
    | 'wrapper-git'
    | 'review'
    | 'clarify'
  inventoryJson?: string | null
  /** RFC-297: 冻结在 node_run 上的运行时协议（NULL = 早于 RFC-111 的行 = opencode）。 */
  runtime?: 'opencode' | 'claude-code' | null
  startupVerificationJson?: string | null
  runStatus?: 'done' | 'running' | 'failed'
}

async function seed(
  db: DbClient,
  opts: SeedOpts = {},
): Promise<{ taskId: string; nodeRunId: string }> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  const nodeId = 'n1'
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      {
        id: nodeId,
        kind: opts.nodeKind ?? 'agent-single',
        agentName: 'coder',
      } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/test',
    worktreePath: '/tmp/test',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: 1000,
  })
  const nodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: opts.runStatus ?? 'done',
    promptText: 'go',
    startedAt: 1000,
    inventorySnapshotJson: opts.inventoryJson ?? null,
    runtime: opts.runtime ?? null,
    startupVerificationJson: opts.startupVerificationJson ?? null,
  })
  return { taskId, nodeRunId }
}

// RFC-297 —— 用户实证 bug 的**端到端**回归锁：Claude Code 运行时下的清单。
//
// 纯函数层（facesFromStartupObservation）已在 rfc297-inventory-read 覆盖；这一组
// 锁的是 DB 行 → 按 driver 表态分派 → HTTP 响应 这条完整链路，因为 bug 恰恰出在
// 分派上：旧读端只认 opencode 的快照列，claude 行拿到 NULL 后被当成「插件失败」。
describe('RFC-297 GET /inventory — claude-code 运行时', () => {
  const claudeVerification = JSON.stringify({
    declared: {
      mcpServers: ['rag'],
      skippedDisabledMcps: [],
      skills: ['lint', 'never-loaded'],
      subagents: ['auditor'],
      plugins: [],
      tools: null,
      droppedParams: [],
      unsupported: [],
      unobservable: [],
    },
    observation: {
      state: 'verified',
      source: 'claude-init',
      mcpServers: [{ name: 'rag', status: 'connected' }],
      tools: ['Read', 'Write'],
      agents: ['auditor', 'general-purpose'],
      skills: ['lint'],
    },
    verification: {
      observation: 'verified',
      mcpUnusable: [],
      skillsMissing: ['never-loaded'],
      subagentsMissing: [],
      toolsMissing: [],
      pluginsMissing: [],
    },
  })

  test('inventory 列恒 NULL 的 claude run 也能拿到清单（不再报「插件失败」）', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, {
      runtime: 'claude-code',
      inventoryJson: null, // claude 从不写这一列
      startupVerificationJson: claudeVerification,
    })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as RuntimeInventoryResponse
    expect(body.observation.state).toBe('captured')
    if (body.observation.state !== 'captured') return
    const { faces } = body.observation
    expect(faces.agents?.map((a) => a.key)).toEqual(['auditor', 'general-purpose'])
    expect(faces.skills?.map((s) => s.key)).toEqual(['lint', 'never-loaded'])
    expect(faces.tools?.map((t) => t.key)).toEqual(['Read', 'Write'])
    expect(faces.mcps?.map((m) => [m.key, m.status])).toEqual([['rag', 'connected']])
  })

  test('来源对账：注入的记 injected、运行时自带记 ambient、声明未加载记 declared-missing', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, {
      runtime: 'claude-code',
      startupVerificationJson: claudeVerification,
    })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    const body = (await res.json()) as RuntimeInventoryResponse
    if (body.observation.state !== 'captured') throw new Error('expected captured')
    const { faces } = body.observation
    expect(faces.agents?.find((a) => a.key === 'auditor')?.provenance).toBe('injected')
    expect(faces.agents?.find((a) => a.key === 'general-purpose')?.provenance).toBe('ambient')
    // 与告警 banner 报的 skillsMissing 是同一个名字（同源判定）。
    expect(faces.skills?.find((s) => s.key === 'never-loaded')?.provenance).toBe('declared-missing')
    // declared.tools === null（本轮未约束工具集）→ 工具全部算 ambient，不产生缺失。
    expect(faces.tools?.every((t) => t.provenance === 'ambient')).toBe(true)
  })

  test('响应带回 claude 的表态：plugins 面 unsupported、tools 面 supported', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, {
      runtime: 'claude-code',
      startupVerificationJson: claudeVerification,
    })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    const body = (await res.json()) as RuntimeInventoryResponse
    expect(body.declaration.plugins.support).toBe('unsupported')
    expect(body.declaration.tools.support).toBe('supported')
    // claude 只按名字报告，富字段整列不该出现在界面上。
    expect(body.declaration.agents.fields.mode).toBe('unsupported')
    expect(body.declaration.mcps.fields.status).toBe('supported')
  })

  test('claude run 完全没有验证记录 → unavailable，且 reason 不再甩锅插件', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, {
      runtime: 'claude-code',
      inventoryJson: null,
      startupVerificationJson: null,
    })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    const body = (await res.json()) as RuntimeInventoryResponse
    expect(body.observation.state).toBe('unavailable')
    if (body.observation.state === 'unavailable') {
      expect(body.observation.reason).toBe('no-observation-recorded')
      // 旧行为会给出 'file-missing'（→「插件可能加载失败」）。
      expect(body.observation.reason).not.toBe('file-missing')
    }
  })

  test('NULL runtime（RFC-111 之前的存量行）仍按 opencode 处理', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runtime: null, inventoryJson: null })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    const body = (await res.json()) as RuntimeInventoryResponse
    // opencode 的观测源是快照文件，缺失即 file-missing（保持既有诊断）。
    expect(body.observation.state).toBe('unavailable')
    if (body.observation.state === 'unavailable') {
      expect(body.observation.reason).toBe('file-missing')
    }
    expect(body.declaration.tools.support).toBe('unsupported')
  })
})

describe('GET /api/tasks/:id/node-runs/:nodeRunId/inventory', () => {
  beforeEach(() => {
    resetBroadcastersForTests()
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('200 captured: persisted snapshot is returned verbatim through zod validation', async () => {
    const { db, app } = buildApp()
    const snapshot = {
      captured: true,
      schemaVersion: 1,
      capturedAt: 1700000000000,
      agents: [
        {
          name: 'coder',
          mode: 'primary',
          modelProviderId: 'anthropic',
          modelId: 'claude-opus-4-7',
          source: 'inline',
        },
      ],
      skills: [{ name: 'foo', source: 'managed', path: '/x', description: null }],
      mcps: [{ name: 'memcache', type: 'local', status: 'connected', hint: null }],
      plugins: [{ specifier: 'file:///a.mjs', source: 'inline' }],
    }
    const { taskId, nodeRunId } = await seed(db, { inventoryJson: JSON.stringify(snapshot) })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as RuntimeInventoryResponse
    expect(body.observation.state).toBe('captured')
    if (body.observation.state === 'captured') {
      expect(body.observation.faces.agents?.[0]?.name).toBe('coder')
      expect(body.observation.faces.mcps?.[0]?.status).toBe('connected')
    }
    // RFC-297：响应同时带上该 run 所用运行时的静态表态，前端据此选列。
    expect(body.declaration.plugins.support).toBe('supported')
    expect(body.declaration.tools.support).toBe('unsupported')
  })

  test('200 captured:false reason=file-missing when column is NULL (legacy row or pre-run-not-yet)', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { inventoryJson: null })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as RuntimeInventoryResponse
    expect(body.observation.state).toBe('unavailable')
    if (body.observation.state === 'unavailable') {
      expect(body.observation.reason).toBe('file-missing')
    }
  })

  test('200 captured:false reason=parse-failed when stored JSON is corrupt', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { inventoryJson: '{ broken json' })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as RuntimeInventoryResponse
    expect(body.observation.state).toBe('malformed')
    if (body.observation.state === 'malformed') {
      expect(body.observation.reason).toBe('parse-failed')
    }
  })

  test('404 when the task does not exist', async () => {
    const { db, app } = buildApp()
    const { nodeRunId } = await seed(db)
    const res = await req(app, `/api/tasks/no_such_task/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(404)
  })

  test('404 when node_run does not belong to the task', async () => {
    const { db, app } = buildApp()
    const { taskId } = await seed(db)
    const otherId = ulid()
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${otherId}/inventory`)
    expect(res.status).toBe(404)
  })

  test('410 for non-agent node kinds', async () => {
    const { db, app } = buildApp()
    for (const kind of ['wrapper-git', 'review', 'clarify', 'input', 'output'] as const) {
      const { taskId, nodeRunId } = await seed(db, { nodeKind: kind })
      const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
      expect(res.status).toBe(410)
    }
  })
})

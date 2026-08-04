// RFC-257 T14 — 全链路端到端：mock GitLab 的 HTTP POST 打进真 app（真三段式
// 路由 + 真 createWebhookDispatcher），只在 launch 处注入 fake（落真 tasks 行）。
// T5 测试用 fake dispatcher、T6 直调 dispatch —— 本文件补的正是两者之间的
// 「HTTP 入站 → 真 dispatcher」接线（AC-5/AC-18 的组合面 + tasks 归属列）。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import { createApp } from '../src/server'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createUser } from '../src/services/users'
import {
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
  workflows,
} from '../src/db/schema'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 3))
const SECRET = 'e2e-secret'

async function waitFor<T>(fn: () => Promise<T | null>, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== null) return v
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function harness() {
  const db = createInMemoryDb(MIGRATIONS)
  const owner = await createUser(db, {
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'fix-wf',
    description: '',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    version: 1,
    ownerUserId: owner.id,
    visibility: 'private',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(webhookEndpoints).values({
    id: 'ep-1',
    name: 'gl',
    provider: 'gitlab',
    urlToken: 'aw_whk_e2e',
    secretEnc: box.seal(SECRET),
    enabled: true,
  })
  await db.insert(webhookTriggers).values({
    id: 'tr-1',
    name: '修到绿',
    endpointId: 'ep-1',
    ownerUserId: owner.id,
    repoScope: JSON.stringify({ kind: 'prefix', prefix: 'platform/' }),
    eventTypes: JSON.stringify(['pipeline_failed']),
    ignoreUsernames: JSON.stringify(['aw-bot']),
    launchKind: 'workflow',
    launchRefId: workflowId,
    launchPayload: JSON.stringify({ inputs: {} }),
  })
  const canceled: string[] = []
  // 真 dispatcher；只在 launch/cancel 处注入（fake launch 落真 tasks 行，
  // 让归属列与 supersede 走真实查询面）。
  const dispatcher = createWebhookDispatcher({
    db,
    configPath: '/nonexistent/config.json',
    secretBox: box,
    getDefaultRuntime: async () => null,
    launch: async (actor, rendered, invoker) => {
      if (invoker.type !== 'webhook') throw new Error('bad invoker')
      const taskId = ulid()
      await db.insert(tasks).values({
        id: taskId,
        name: (rendered.payload as { name: string }).name,
        workflowId,
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: `/wt/${taskId}`,
        baseBranch: 'main',
        branch: `aw/${taskId}`,
        status: 'running',
        ownerUserId: actor.user.id,
        inputs: '{}',
        startedAt: Date.now(),
        webhookTriggerId: invoker.webhookTriggerId,
        webhookFireId: invoker.webhookFireId,
      })
      return taskId
    },
    cancel: async (taskId) => {
      canceled.push(taskId)
      await db.update(tasks).set({ status: 'canceled' }).where(eq(tasks.id, taskId))
    },
  })
  const app = createApp({
    token: 'a'.repeat(64),
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox: box,
    webhookDispatcher: dispatcher,
  })
  return { db, app, canceled, ownerId: owner.id }
}

function pipelineFailedBody(uuid: string): { body: string; headers: Record<string, string> } {
  return {
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Pipeline Hook',
      'x-gitlab-event-uuid': uuid,
    },
    body: JSON.stringify({
      object_kind: 'pipeline',
      user: { username: 'aw-bot' },
      project: {
        path_with_namespace: 'platform/api',
        git_http_url: 'https://gitlab.example.com/platform/api.git',
        git_ssh_url: 'git@gitlab.example.com:platform/api.git',
      },
      object_attributes: { id: 1, ref: 'feature/x', status: 'failed', sha: 'abc' },
      merge_request: { iid: 42, source_branch: 'feature/x', target_branch: 'main' },
    }),
  }
}

describe('RFC-257 T14 · HTTP 入站 → 真分发器 → 任务行（全链路）', () => {
  test('pipeline_failed 事件落任务；第二发 supersede 第一发；归属列成链', async () => {
    const h = await harness()
    const first = pipelineFailedBody('uuid-e2e-1')
    const res = await h.app.request('/webhooks/gitlab/aw_whk_e2e', {
      method: 'POST',
      headers: first.headers,
      body: first.body,
    })
    expect(res.status).toBe(200)
    const { deliveryId } = (await res.json()) as { deliveryId: string }

    // 异步分发推进到 matched + fires launched + 真 tasks 行
    const fire = await waitFor(async () => {
      const rows = await h.db
        .select()
        .from(webhookTriggerFires)
        .where(eq(webhookTriggerFires.deliveryId, deliveryId))
      return rows[0] ?? null
    })
    expect(fire.outcome).toBe('launched')
    expect(fire.streamKey).toBe('platform/api|mr:42')
    const delivery = (
      await h.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId))
    )[0]
    expect(delivery?.status).toBe('matched')
    const task = (
      await h.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, fire.taskId ?? ''))
        .limit(1)
    )[0]
    expect(task?.webhookTriggerId).toBe('tr-1')
    expect(task?.webhookFireId).toBe(fire.id)
    expect(task?.ownerUserId).toBe(h.ownerId)
    expect(task?.name).toBe('[修到绿] platform/api!42')

    // 第二发（同 MR）：supersede 取消第一发的任务
    const second = pipelineFailedBody('uuid-e2e-2')
    const res2 = await h.app.request('/webhooks/gitlab/aw_whk_e2e', {
      method: 'POST',
      headers: second.headers,
      body: second.body,
    })
    expect(res2.status).toBe(200)
    await waitFor(async () => (h.canceled.length > 0 ? true : null))
    expect(h.canceled).toEqual([task?.id ?? '(missing)'])
    const running = await h.db.select().from(tasks).where(eq(tasks.status, 'running'))
    expect(running.length).toBe(1) // 每流至多一活任务（AC-9/AC-11）
  })
})

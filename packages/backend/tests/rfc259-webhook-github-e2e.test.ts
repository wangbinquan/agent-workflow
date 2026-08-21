// RFC-259 — GitHub 全链路端到端（proposal AC-13，镜像 rfc257-webhook-e2e）：
// mock GitHub 的 HMAC 签名 POST 打进真 app（真三段式路由 + 真
// createWebhookDispatcher），只在 launch 处注入 fake（落真 tasks 行）。
// 锁「HTTP 入站（HMAC 验签 + 事件头判别）→ 真 dispatcher → 任务归属列」
// 这条 GitHub 形态的接线，含同 PR 二发 supersede。
import { createHmac } from 'node:crypto'
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
import {
  createWebhookDispatcher,
  renderedLaunchPayload,
} from '../src/services/webhook/webhookDispatch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 4))
const SECRET = 'gh-e2e-secret'

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
    role: 'admin',
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
    id: 'ep-gh',
    name: 'gh',
    provider: 'github',
    urlToken: 'aw_whk_gh_e2e',
    secretEnc: box.seal(SECRET),
    enabled: true,
  })
  await db.insert(webhookTriggers).values({
    id: 'tr-gh',
    name: '修到绿',
    endpointId: 'ep-gh',
    ownerUserId: owner.id,
    repoScope: JSON.stringify({ kind: 'prefix', prefix: 'acme/' }),
    eventTypes: JSON.stringify(['pipeline_failed']),
    ignoreUsernames: JSON.stringify(['aw-bot']),
    launchKind: 'workflow',
    launchRefId: workflowId,
    launchPayload: JSON.stringify({ inputs: {} }),
  })
  const canceled: string[] = []
  const dispatcher = createWebhookDispatcher({
    db,
    configPath: '/nonexistent/config.json',
    secretBox: box,
    getDefaultRuntime: async () => null,
    launch: async (actor, rendered, invoker) => {
      if (invoker.type !== 'event') throw new Error('bad invoker')
      const taskId = ulid()
      await db.insert(tasks).values({
        id: taskId,
        name: (renderedLaunchPayload(rendered) as never as { name: string }).name,
        workflowId,
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: `/wt/${taskId}`,
        baseBranch: 'main',
        branch: `aw/${taskId}`,
        status: 'running',
        launchOrigin: 'event',
        ownerUserId: actor.user.id,
        inputs: '{}',
        startedAt: Date.now(),
        eventSubscriptionId: invoker.eventSubscriptionId,
        eventDeliveryId: invoker.eventDeliveryId,
        triggerContextJson: JSON.stringify(invoker.triggerContext),
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

/** workflow_run failure（GitHub Actions 修到绿的入口事件；同仓 PR #42）。 */
function workflowRunFailed(delivery: string): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    action: 'completed',
    workflow_run: {
      id: 9001,
      head_branch: 'feature/x',
      head_sha: 'abc123',
      conclusion: 'failure',
      actor: { login: 'aw-bot' },
      pull_requests: [
        { number: 42, head: { ref: 'feature/x', sha: 'abc123' }, base: { ref: 'main', sha: 'z' } },
      ],
    },
    repository: {
      full_name: 'acme/api',
      clone_url: 'https://github.com/acme/api.git',
      ssh_url: 'git@github.com:acme/api.git',
    },
    sender: { login: 'aw-bot' },
  })
  return {
    body,
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET)
        .update(Buffer.from(body, 'utf8'))
        .digest('hex')}`,
      'x-github-event': 'workflow_run',
      'x-github-delivery': delivery,
    },
  }
}

describe('RFC-259 · GitHub HTTP 入站 → 真分发器 → 任务行（全链路 AC-13）', () => {
  test('workflow_run failure 落任务；第二发 supersede 第一发；归属列成链', async () => {
    const h = await harness()
    const first = workflowRunFailed('guid-e2e-1')
    const res = await h.app.request('/webhooks/github/aw_whk_gh_e2e', {
      method: 'POST',
      headers: first.headers,
      body: first.body,
    })
    expect(res.status).toBe(200)
    const { deliveryId } = (await res.json()) as { deliveryId: string }

    const fire = await waitFor(async () => {
      const rows = await h.db
        .select()
        .from(webhookTriggerFires)
        .where(eq(webhookTriggerFires.deliveryId, deliveryId))
      return rows[0] ?? null
    })
    expect({ outcome: fire.outcome, error: fire.error }).toEqual({
      outcome: 'launched',
      error: null,
    })
    expect(fire.streamKey).toBe('acme/api|mr:42') // PR number 维度（fork 空数组时才落 branch）
    const delivery = (
      await h.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId))
    )[0]
    expect(delivery?.status).toBe('matched')
    expect(delivery?.gitlabEventHeader).toBe('workflow_run') // D8：provider 原始事件头
    const task = (
      await h.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, fire.taskId ?? ''))
        .limit(1)
    )[0]
    expect(task?.launchOrigin).toBe('event')
    expect(task?.eventSubscriptionId).toBeTruthy()
    expect(task?.eventDeliveryId).toBe(fire.id)
    expect(task?.ownerUserId).toBe(h.ownerId)
    expect(task?.name).toBe('[修到绿] acme/api!42')

    const second = workflowRunFailed('guid-e2e-2')
    const res2 = await h.app.request('/webhooks/github/aw_whk_gh_e2e', {
      method: 'POST',
      headers: second.headers,
      body: second.body,
    })
    expect(res2.status).toBe(200)
    await waitFor(async () => (h.canceled.length > 0 ? true : null))
    expect(h.canceled).toEqual([task?.id ?? '(missing)'])
    const running = await h.db.select().from(tasks).where(eq(tasks.status, 'running'))
    expect(running.length).toBe(1) // 每流至多一活任务
  })
})

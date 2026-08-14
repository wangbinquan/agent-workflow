// RFC-257 T14 — 全链路端到端：mock GitLab 的 HTTP POST 打进真 app（真三段式
// 路由 + 真 createWebhookDispatcher），只在 launch 处注入 fake（落真 tasks 行）。
// T5 测试用 fake dispatcher、T6 直调 dispatch —— 本文件补的正是两者之间的
// 「HTTP 入站 → 真 dispatcher」接线（AC-5/AC-18 的组合面 + tasks 归属列）。
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
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
  webhookMrControlEffects,
  webhookTriggerFires,
  webhookTriggers,
  workflows,
} from '../src/db/schema'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'
import { composeMrTerminalControl } from '../src/modules/integration/composition/webhookTerminalControl'

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
  const terminalControl = composeMrTerminalControl(db)
  await terminalControl.reconcileOnBoot()
  // 真 dispatcher；只在 launch/cancel 处注入（fake launch 落真 tasks 行，
  // 让归属列与 supersede 走真实查询面）。
  const dispatcher = createWebhookDispatcher({
    db,
    configPath: '/nonexistent/config.json',
    secretBox: box,
    getDefaultRuntime: async () => null,
    terminalControl,
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
        triggerContextJson: JSON.stringify(invoker.triggerContext),
        ...(invoker.sourceTerminationSnapshot === undefined
          ? {}
          : {
              sourceTerminationBinding: invoker.sourceTerminationSnapshot.binding,
              sourceTerminationLaunchRev: invoker.sourceTerminationSnapshot.launchRevision,
              sourceTerminationFence: invoker.sourceTerminationSnapshot.fence,
              sourceTerminationEffectRev: invoker.sourceTerminationSnapshot.effectRevision,
            }),
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
    webhookTerminalControl: terminalControl,
  })
  return { db, app, canceled, ownerId: owner.id, terminalControl }
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

function mergeRequestBody(
  uuid: string,
  action: 'open' | 'close' | 'merge',
): { body: string; headers: Record<string, string> } {
  return {
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Merge Request Hook',
      'x-gitlab-event-uuid': uuid,
    },
    body: JSON.stringify({
      object_kind: 'merge_request',
      user: { username: 'author' },
      project: {
        id: 77,
        path_with_namespace: 'platform/api',
        git_http_url: 'https://gitlab.example.com/platform/api.git',
        git_ssh_url: 'git@gitlab.example.com:platform/api.git',
      },
      object_attributes: {
        iid: 42,
        action,
        state: action === 'open' ? 'opened' : action === 'merge' ? 'merged' : 'closed',
        source_branch: 'feature/x',
        target_branch: 'main',
      },
    }),
  }
}

function githubPullRequestBody(
  uuid: string,
  action: 'opened' | 'closed',
  merged = false,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    action,
    number: 42,
    repository: {
      id: 77,
      full_name: 'platform/api',
      clone_url: 'https://github.example.com/platform/api.git',
      ssh_url: 'git@github.example.com:platform/api.git',
      html_url: 'https://github.example.com/platform/api',
      owner: { login: 'platform' },
      name: 'api',
      default_branch: 'main',
    },
    pull_request: {
      id: 4242,
      number: 42,
      title: 'Fix everything',
      html_url: 'https://github.example.com/platform/api/pull/42',
      merged,
      head: { ref: 'feature/x', sha: 'abc' },
      base: { ref: 'main' },
    },
    sender: { id: 9, login: 'author' },
  })
  return {
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET)
        .update(Buffer.from(body, 'utf8'))
        .digest('hex')}`,
      'x-github-event': 'pull_request',
      'x-github-delivery': uuid,
    },
    body,
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
    await h.terminalControl.stop()
  })

  test('RFC-303 protected MR open launches once; close is control-only and durably cancels it', async () => {
    const h = await harness()
    await h.db
      .update(webhookTriggers)
      .set({
        eventTypes: JSON.stringify(['mr_opened']),
        ignoreUsernames: '[]',
        cancelOnMrTerminal: true,
      })
      .where(eq(webhookTriggers.id, 'tr-1'))
    const opened = mergeRequestBody('uuid-open', 'open')
    const openResponse = await h.app.request('/webhooks/gitlab/aw_whk_e2e', {
      method: 'POST',
      headers: opened.headers,
      body: opened.body,
    })
    expect(openResponse.status).toBe(200)
    const openDeliveryId = ((await openResponse.json()) as { deliveryId: string }).deliveryId
    const task = await waitFor(async () => {
      const fire = (
        await h.db
          .select()
          .from(webhookTriggerFires)
          .where(eq(webhookTriggerFires.deliveryId, openDeliveryId))
      )[0]
      if (fire?.taskId === null || fire?.taskId === undefined) return null
      return (await h.db.select().from(tasks).where(eq(tasks.id, fire.taskId)).limit(1))[0] ?? null
    })
    expect(task.sourceTerminationBinding).not.toBeNull()

    const closed = mergeRequestBody('uuid-close', 'close')
    const closeResponse = await h.app.request('/webhooks/gitlab/aw_whk_e2e', {
      method: 'POST',
      headers: closed.headers,
      body: closed.body,
    })
    expect(closeResponse.status).toBe(200)
    const closeDeliveryId = ((await closeResponse.json()) as { deliveryId: string }).deliveryId
    const canceled = await waitFor(async () => {
      const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]
      return row?.status === 'canceled' ? row : null
    })
    expect(canceled.sourceTerminationFence).toBe('closed')
    expect(canceled.errorSummary).toContain('已关闭')
    const effect = await waitFor(async () => {
      const row = (
        await h.db
          .select()
          .from(webhookMrControlEffects)
          .where(eq(webhookMrControlEffects.deliveryId, closeDeliveryId))
      )[0]
      return row?.status === 'succeeded' ? row : null
    })
    expect(effect.kind).toBe('fence-closed')
    expect(
      await h.db
        .select()
        .from(webhookTriggerFires)
        .where(eq(webhookTriggerFires.deliveryId, closeDeliveryId)),
    ).toHaveLength(0)
    expect(await h.db.select().from(tasks)).toHaveLength(1)
    await h.terminalControl.stop()
  })

  test('RFC-303 GitHub protected PR open launches once; merged close is control-only', async () => {
    const h = await harness()
    await h.db
      .update(webhookEndpoints)
      .set({ provider: 'github' })
      .where(eq(webhookEndpoints.id, 'ep-1'))
    await h.db
      .update(webhookTriggers)
      .set({
        eventTypes: JSON.stringify(['mr_opened']),
        ignoreUsernames: '[]',
        cancelOnMrTerminal: true,
      })
      .where(eq(webhookTriggers.id, 'tr-1'))

    const opened = githubPullRequestBody('guid-open', 'opened')
    const openResponse = await h.app.request('/webhooks/github/aw_whk_e2e', {
      method: 'POST',
      headers: opened.headers,
      body: opened.body,
    })
    expect(openResponse.status).toBe(200)
    const openDeliveryId = ((await openResponse.json()) as { deliveryId: string }).deliveryId
    const task = await waitFor(async () => {
      const fire = (
        await h.db
          .select()
          .from(webhookTriggerFires)
          .where(eq(webhookTriggerFires.deliveryId, openDeliveryId))
      )[0]
      if (fire?.taskId === null || fire?.taskId === undefined) return null
      return (await h.db.select().from(tasks).where(eq(tasks.id, fire.taskId)).limit(1))[0] ?? null
    })
    expect(task.sourceTerminationBinding).toStartWith('st1:')

    const merged = githubPullRequestBody('guid-merged', 'closed', true)
    const mergedResponse = await h.app.request('/webhooks/github/aw_whk_e2e', {
      method: 'POST',
      headers: merged.headers,
      body: merged.body,
    })
    expect(mergedResponse.status).toBe(200)
    const mergedDeliveryId = ((await mergedResponse.json()) as { deliveryId: string }).deliveryId
    const canceled = await waitFor(async () => {
      const row = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0]
      return row?.status === 'canceled' ? row : null
    })
    expect(canceled.sourceTerminationFence).toBe('merged')
    expect(canceled.errorSummary).toContain('已合入')
    const effect = await waitFor(async () => {
      const row = (
        await h.db
          .select()
          .from(webhookMrControlEffects)
          .where(eq(webhookMrControlEffects.deliveryId, mergedDeliveryId))
      )[0]
      return row?.status === 'succeeded' ? row : null
    })
    expect(effect.kind).toBe('fence-merged')
    if (task.sourceTerminationBinding === null) throw new Error('expected frozen source binding')
    expect(effect.binding).toBe(task.sourceTerminationBinding)
    expect(
      await h.db
        .select()
        .from(webhookTriggerFires)
        .where(eq(webhookTriggerFires.deliveryId, mergedDeliveryId)),
    ).toHaveLength(0)
    expect(await h.db.select().from(tasks)).toHaveLength(1)
    await h.terminalControl.stop()
  })
})

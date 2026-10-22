// RFC-395 II-pre：改接生产启动 / 读取路径，保留原断言意图。
// RFC-269 regression — webhook trigger context is execution input.
//
// The original implementation launched first and UPDATEd trigger_context_json
// afterwards. launchTestTask had already kicked scheduler, whose one-time task read
// could therefore cache NULL for the whole run. These tests lock the corrected
// publication boundary: attribution + context are visible at task commit,
// before scheduler kickoff; non-webhook NULL stays distinct from webhook `{}`;
// and serialization failure cannot leave a schedulable task behind.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import type { TriggerContext } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { launchTestTask, type TestTaskLaunchOptions } from './helpers/productionTaskLaunch'
import type { ExecutionInvoker } from '../src/services/execution/types'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ACTOR = buildActor({
  user: {
    id: '__system__',
    username: 'system',
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
})
const SESSION_ACTOR = buildActor({
  user: {
    id: '__system__',
    username: 'system',
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
const PAT_ACTOR = buildActor({
  user: {
    id: '__system__',
    username: 'system',
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'pat',
})

type Harness = { db: DbClient; appHome: string; workflowId: string }

// RFC-395 II-pre：invoker 直接交给生产内核，归属转换由 rootLaunchMetadata 唯一负责。
function launchOptionsForInvoker(
  actor: Actor,
  invoker: ExecutionInvoker,
): Partial<TestTaskLaunchOptions> {
  return { actor, invoker }
}

function buildHarness(): Harness {
  const db = createInMemoryDb(MIGRATIONS)
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc269-trigger-context-'))
  const workflowId = 'wf-rfc269-trigger-context'
  db.insert(workflows)
    .values({
      id: workflowId,
      name: 'rfc269-trigger-context',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    })
    .run()
  return { db, appHome, workflowId }
}

async function launchAndObserveCommit(
  h: Harness,
  invoker: ExecutionInvoker,
  name: string,
  actor: Actor = ACTOR,
): Promise<typeof tasks.$inferSelect> {
  let committedRow: typeof tasks.$inferSelect | undefined
  const task = await launchTestTask(
    { workflowId: h.workflowId, name, inputs: {}, scratch: true },
    {
      ...launchOptionsForInvoker(actor, invoker),
      db: h.db,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      appHome: h.appHome,
      awaitScheduler: true,
      coordinator: {
        async submit(event) {
          committedRow = (
            await h.db.select().from(tasks).where(eq(tasks.id, event.taskId)).limit(1)
          )[0]
          return { kind: 'accepted', taskId: event.taskId }
        },
      },
    },
  )
  expect(committedRow?.id).toBe(task.id)
  expect(task).not.toHaveProperty('launchOrigin')
  return committedRow!
}

describe('RFC-269 webhook trigger context publication boundary', () => {
  let h: Harness | undefined
  afterEach(() => {
    if (h !== undefined) rmSync(h.appHome, { recursive: true, force: true })
  })

  test('task commit exposes attribution + context before scheduler kickoff', async () => {
    h = buildHarness()
    const context = {
      trigger: {
        webhook: { event_type: 'note' as const, repo_path: 'platform/api', mr_iid: '42' },
      },
    }
    const row = await launchAndObserveCommit(
      h,
      {
        type: 'webhook',
        webhookTriggerId: 'trigger-1',
        webhookFireId: 'fire-1',
        triggerContext: context,
      },
      'atomic-context',
    )

    expect(row.webhookTriggerId).toBe('trigger-1')
    expect(row.webhookFireId).toBe('fire-1')
    expect(row.launchOrigin).toBe('webhook')
    expect(JSON.parse(row.triggerContextJson!)).toEqual(context)
  })

  test('minimal webhook context persists its discriminator while non-webhook launch stays NULL', async () => {
    h = buildHarness()
    const webhook = await launchAndObserveCommit(
      h,
      {
        type: 'webhook',
        webhookTriggerId: 'trigger-empty',
        webhookFireId: 'fire-empty',
        triggerContext: { trigger: { webhook: { event_type: 'push' } } },
      },
      'empty-webhook-context',
    )
    const user = await launchAndObserveCommit(
      h,
      { type: 'user', launchKind: 'direct-json' },
      'daemon-api-context',
    )

    expect(JSON.parse(webhook.triggerContextJson!)).toEqual({
      trigger: { webhook: { event_type: 'push' } },
    })
    expect(user.triggerContextJson).toBeNull()
    expect(user.webhookTriggerId).toBeNull()
    expect(user.webhookFireId).toBeNull()
    expect(user.launchOrigin).toBe('api')
  })

  test('trusted actor source and business invoker produce the complete root-origin matrix', async () => {
    h = buildHarness()
    const cases: Array<{
      name: string
      actor: Actor
      invoker: ExecutionInvoker
      expected: (typeof tasks.$inferSelect)['launchOrigin']
    }> = [
      {
        name: 'session-json',
        actor: SESSION_ACTOR,
        invoker: { type: 'user', launchKind: 'direct-json' },
        expected: 'manual',
      },
      {
        name: 'session-multipart',
        actor: SESSION_ACTOR,
        invoker: { type: 'user', launchKind: 'direct-multipart' },
        expected: 'manual',
      },
      {
        name: 'pat-json',
        actor: PAT_ACTOR,
        invoker: { type: 'user', launchKind: 'direct-json' },
        expected: 'api',
      },
      {
        name: 'daemon-json',
        actor: ACTOR,
        invoker: { type: 'user', launchKind: 'direct-json' },
        expected: 'api',
      },
      {
        name: 'scheduled-daemon',
        actor: ACTOR,
        invoker: { type: 'scheduled', scheduledTaskId: 'schedule-rfc301' },
        expected: 'scheduled',
      },
      {
        name: 'webhook-daemon',
        actor: ACTOR,
        invoker: {
          type: 'webhook',
          webhookTriggerId: 'trigger-rfc301',
          webhookFireId: 'fire-rfc301',
          triggerContext: { trigger: { webhook: { event_type: 'push' } } },
        },
        expected: 'webhook',
      },
    ]

    for (const entry of cases) {
      const row = await launchAndObserveCommit(h, entry.invoker, entry.name, entry.actor)
      expect(row.launchOrigin).toBe(entry.expected)
    }
  })

  test('caller spoofing and incomplete source metadata fail closed before publication', async () => {
    h = buildHarness()
    // RFC-359 AC-1（plan §5hn 批次二 ⑦）：门面删除后改直调 `launchTestTask`，
    // invoker → deps 的映射由本文件顶部那份（原 `depsForInvoker`）承担。
    const payload = {
      workflowId: h.workflowId,
      name: 'spoofed-origin',
      inputs: {},
      scratch: true,
      launchOrigin: 'webhook',
      launch_origin: 'webhook',
    }
    const baseDeps = () => ({
      db: h!.db,
      schedulerDriver: createTaskExecutionTestTopology({ db: h!.db, driver: 'real' })
        .schedulerDriver,
      appHome: h!.appHome,
    })

    const attempts = [
      // ② 定时启动但 scheduledTaskId 是空白。
      launchTestTask(payload, {
        ...launchOptionsForInvoker(ACTOR, { type: 'scheduled' as const, scheduledTaskId: ' ' }),
        ...baseDeps(),
      }),
      // ③ webhook 启动但 fireId 是空白。
      launchTestTask(payload, {
        ...launchOptionsForInvoker(ACTOR, {
          type: 'webhook' as const,
          webhookTriggerId: 'trigger-only',
          webhookFireId: ' ',
          triggerContext: { trigger: { webhook: { event_type: 'push' as const } } },
        }),
        ...baseDeps(),
      }),
    ]

    const results = await Promise.allSettled(attempts)
    expect(
      results.map((result) =>
        result.status === 'rejected' && typeof result.reason === 'object' && result.reason !== null
          ? (result.reason as { code?: string }).code
          : null,
      ),
    ).toEqual(['task-launch-schedule-metadata-invalid', 'task-launch-webhook-metadata-invalid'])
    expect(await h.db.select().from(tasks)).toHaveLength(0)
    const scratchRoot = join(h.appHome, 'scratch')
    expect(existsSync(scratchRoot) ? readdirSync(scratchRoot) : []).toEqual([])
  })

  test('invalid source-shaped context is rejected before task or scratch publication', async () => {
    h = buildHarness()
    let committed = false
    const brokenContext = {
      trigger: { webhook: { event_type: 'not-an-event' } },
    } as unknown as TriggerContext

    await expect(
      launchTestTask(
        {
          workflowId: h.workflowId,
          name: 'broken-context',
          inputs: {},
          scratch: true,
        },
        {
          ...launchOptionsForInvoker(ACTOR, {
            type: 'webhook',
            webhookTriggerId: 'trigger-broken',
            webhookFireId: 'fire-broken',
            triggerContext: brokenContext,
          }),
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          appHome: h.appHome,
          coordinator: {
            async submit(event) {
              committed = true
              return { kind: 'accepted', taskId: event.taskId }
            },
          },
        },
      ),
    ).rejects.toThrow('the frozen task trigger context is invalid')

    expect(committed).toBe(false)
    expect(await h.db.select().from(tasks)).toHaveLength(0)
    const scratchRoot = join(h.appHome, 'scratch')
    expect(existsSync(scratchRoot) ? readdirSync(scratchRoot) : []).toEqual([])
  })
})

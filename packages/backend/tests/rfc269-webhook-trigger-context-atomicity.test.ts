// RFC-269 regression — webhook trigger context is execution input.
//
// The original implementation launched first and UPDATEd trigger_context_json
// afterwards. startTask had already kicked scheduler, whose one-time task read
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
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { startTask, type StartTaskDeps } from '../src/services/task'
import { directTaskInitiatorFromActorSource } from '../src/modules/task-execution/inbound/directTaskInitiator'
import type { ExecutionInvoker } from '../src/services/execution/types'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ACTOR = { user: { id: '__system__' }, source: 'daemon' } as Actor
const SESSION_ACTOR = { user: { id: '__system__' }, source: 'session' } as Actor
const PAT_ACTOR = { user: { id: '__system__' }, source: 'pat' } as Actor

type Harness = { db: DbClient; appHome: string; workflowId: string }

/**
 * RFC-359 AC-1（plan §5hn 批次二 ⑦）：invoker → `StartTaskDeps` 的映射。
 *
 * 这段原本在 `services/execution/executor.ts#depsForInvoker` 里。那个「统一执行门面」是
 * **启动编排的第二份写法**，已随两个引擎的启动路合一整份删除；它做的这件映射，生产上现在
 * 由根启动内核的 `rootLaunchMetadata(actor, invoker)` 做。
 *
 * 本用例锁的是**发布边界**——归属与触发上下文必须写在**首次 INSERT** 里，而不是随后一条
 * UPDATE（那会和调度器那次一次性读任务竞争）。`startTask` 上的 `workflowLaunchCommitHook`
 * 是唯一能观察到「提交那一刻」的钩子，所以这条判据留在 `startTask` 这一侧；
 * 内核那条路上同一个不变量是**结构性**的（所有字段在同一条 INSERT 里，提交之后才
 * `coordinator.submit`），由 `rfc359-w5hn-scheduled-launch-provider-parity` 等几条行级基线覆盖。
 * 要在内核那侧也做成显式判据，办法是注入一个在 `submit` 里回读任务行的协调器——
 * 记在 plan §5hn 批次二 ⑦ 的待办里。
 */
function startTaskDepsForInvoker(actor: Actor, invoker: ExecutionInvoker): Partial<StartTaskDeps> {
  if (invoker.type === 'scheduled') {
    return { scheduledTaskId: invoker.scheduledTaskId, launchProvenance: { kind: 'schedule' } }
  }
  if (invoker.type === 'webhook') {
    return {
      webhookTriggerId: invoker.webhookTriggerId,
      webhookFireId: invoker.webhookFireId,
      triggerContext: invoker.triggerContext,
      sourceTerminationSnapshot: invoker.sourceTerminationSnapshot,
      launchProvenance: { kind: 'webhook' },
    }
  }
  if (invoker.type === 'event') {
    return {
      eventSubscriptionId: invoker.eventSubscriptionId,
      eventDeliveryId: invoker.eventDeliveryId,
      triggerContext: invoker.triggerContext,
      sourceTerminationSnapshot: invoker.sourceTerminationSnapshot,
      launchProvenance: { kind: 'event' },
    }
  }
  if (invoker.type === 'node') throw new Error('node invoker is not part of this lock')
  return {
    launchProvenance: {
      kind: invoker.launchKind,
      initiator: directTaskInitiatorFromActorSource(actor.source),
    },
  }
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
  const task = await startTask(
    { workflowId: h.workflowId, name, inputs: {}, scratch: true },
    {
      ...startTaskDepsForInvoker(actor, invoker),
      db: h.db,
      schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
        .schedulerDriver,
      appHome: h.appHome,
      awaitScheduler: true,
      workflowLaunchCommitHook: async (event) => {
        if (event.stage !== 'task-committed') return
        committedRow = (
          await h.db.select().from(tasks).where(eq(tasks.id, event.taskId)).limit(1)
        )[0]
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
    // RFC-359 AC-1（plan §5hn 批次二 ⑦）：门面删除后改直调 `startTask`，
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
      // ① 直连启动却带上定时元数据。
      startTask(payload, {
        ...startTaskDepsForInvoker(SESSION_ACTOR, {
          type: 'user' as const,
          launchKind: 'direct-json' as const,
        }),
        ...baseDeps(),
        scheduledTaskId: 'spoofed-schedule',
      }),
      // ② 定时启动但 scheduledTaskId 是空白。
      startTask(payload, {
        ...startTaskDepsForInvoker(ACTOR, { type: 'scheduled' as const, scheduledTaskId: ' ' }),
        ...baseDeps(),
      }),
      // ③ webhook 启动但 fireId 是空白。
      startTask(payload, {
        ...startTaskDepsForInvoker(ACTOR, {
          type: 'webhook' as const,
          webhookTriggerId: 'trigger-only',
          webhookFireId: ' ',
          triggerContext: { trigger: { webhook: { event_type: 'push' as const } } },
        }),
        ...baseDeps(),
      }),
      // **已退役的第 ④ 项**：原本是「调用方自己预置 `launchProvenance`」→ 门面的
      // `task-launch-provenance-conflict`。那条守卫属于 `startExecution`（「根来源归门面所有」），
      // 门面删除后这个冲突**结构上不可能**：内核那条路根本没有 `launchProvenance` 这一格
      //（来源由 `rootLaunchMetadata(actor, invoker)` 算），`startTask` 那条路调用方只传
      // provenance、不传 invoker，没有第二个来源可冲突。
      // `task-launch-provenance-conflict` 这个码本身没有消失——它在 `startTask` 里守的是
      // **子任务不得携带根来源**（`rfc301-task-launch-origin-inheritance` 锁着那一条）。
    ]

    const results = await Promise.allSettled(attempts)
    expect(
      results.map((result) =>
        result.status === 'rejected' && typeof result.reason === 'object' && result.reason !== null
          ? (result.reason as { code?: string }).code
          : null,
      ),
    ).toEqual([
      'task-launch-direct-metadata-invalid',
      'task-launch-schedule-metadata-invalid',
      'task-launch-webhook-metadata-invalid',
    ])
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
      startTask(
        {
          workflowId: h.workflowId,
          name: 'broken-context',
          inputs: {},
          scratch: true,
        },
        {
          ...startTaskDepsForInvoker(ACTOR, {
            type: 'webhook',
            webhookTriggerId: 'trigger-broken',
            webhookFireId: 'fire-broken',
            triggerContext: brokenContext,
          }),
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          appHome: h.appHome,
          workflowLaunchCommitHook: (event) => {
            if (event.stage === 'task-committed') committed = true
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

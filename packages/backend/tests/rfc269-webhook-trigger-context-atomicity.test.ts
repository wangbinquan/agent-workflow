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
import { startExecution } from '../src/services/execution/executor'
import type { ExecutionInvoker } from '../src/services/execution/types'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ACTOR = { user: { id: '__system__' } } as Actor

type Harness = { db: DbClient; appHome: string; workflowId: string }

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
): Promise<typeof tasks.$inferSelect> {
  let committedRow: typeof tasks.$inferSelect | undefined
  const task = await startExecution(
    h.db,
    ACTOR,
    {
      kind: 'workflow',
      refId: h.workflowId,
      invoker,
      payload: { workflowId: h.workflowId, name, inputs: {}, scratch: true },
    },
    {
      db: h.db,
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
  return committedRow!
}

describe('RFC-269 webhook trigger context publication boundary', () => {
  let h: Harness | undefined
  afterEach(() => {
    if (h !== undefined) rmSync(h.appHome, { recursive: true, force: true })
  })

  test('task commit exposes attribution + context before scheduler kickoff', async () => {
    h = buildHarness()
    const context = { repo_path: 'platform/api', mr_iid: '42' }
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
    expect(JSON.parse(row.triggerContextJson!)).toEqual(context)
  })

  test('empty webhook context persists as {} while non-webhook launch stays NULL', async () => {
    h = buildHarness()
    const webhook = await launchAndObserveCommit(
      h,
      {
        type: 'webhook',
        webhookTriggerId: 'trigger-empty',
        webhookFireId: 'fire-empty',
        triggerContext: {},
      },
      'empty-webhook-context',
    )
    const user = await launchAndObserveCommit(h, { type: 'user' }, 'manual-context')

    expect(webhook.triggerContextJson).toBe('{}')
    expect(user.triggerContextJson).toBeNull()
    expect(user.webhookTriggerId).toBeNull()
    expect(user.webhookFireId).toBeNull()
  })

  test('context serialization failure rolls back the task and never reaches commit', async () => {
    h = buildHarness()
    let committed = false
    const brokenContext = {
      toJSON(): never {
        throw new Error('trigger-context-serialize-failed')
      },
    } as unknown as TriggerContext

    await expect(
      startExecution(
        h.db,
        ACTOR,
        {
          kind: 'workflow',
          refId: h.workflowId,
          invoker: {
            type: 'webhook',
            webhookTriggerId: 'trigger-broken',
            webhookFireId: 'fire-broken',
            triggerContext: brokenContext,
          },
          payload: {
            workflowId: h.workflowId,
            name: 'broken-context',
            inputs: {},
            scratch: true,
          },
        },
        {
          db: h.db,
          appHome: h.appHome,
          workflowLaunchCommitHook: (event) => {
            if (event.stage === 'task-committed') committed = true
          },
        },
      ),
    ).rejects.toThrow('trigger-context-serialize-failed')

    expect(committed).toBe(false)
    expect(await h.db.select().from(tasks)).toHaveLength(0)
    const scratchRoot = join(h.appHome, 'scratch')
    expect(existsSync(scratchRoot) ? readdirSync(scratchRoot) : []).toEqual([])
  })
})

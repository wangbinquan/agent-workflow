// RFC-298 — task detail derives a minimal webhook source link from the task's
// own frozen context. Raw context remains private, historical flat rows are
// supported, corrupt rows fail closed, and inherited child context works
// without any webhook trigger/delivery join.

import { describe, expect, test } from 'bun:test'
import type { TriggerContext } from '@agent-workflow/shared'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { getTask, listTasks } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type TestDb = ReturnType<typeof createInMemoryDb>

function seedWorkflow(db: TestDb): string {
  const id = ulid()
  const now = Date.now()
  db.insert(workflows)
    .values({
      id,
      name: 'RFC-298 fixture workflow',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

function seedTask(
  db: TestDb,
  workflowId: string,
  options: {
    triggerContextJson?: string | null
    parentTaskId?: string
    webhookTriggerId?: string
    webhookFireId?: string
  } = {},
): string {
  const id = ulid()
  const now = Date.now()
  db.insert(tasks)
    .values({
      id,
      name: `RFC-298 task ${id}`,
      workflowId,
      workflowSnapshot: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      repoPath: '/tmp/rfc298-repo',
      worktreePath: `/tmp/rfc298-${id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'done',
      inputs: '{}',
      startedAt: now - 100,
      finishedAt: now,
      triggerContextJson: options.triggerContextJson ?? null,
      parentTaskId: options.parentTaskId ?? null,
      webhookTriggerId: options.webhookTriggerId ?? null,
      webhookFireId: options.webhookFireId ?? null,
    })
    .run()
  return id
}

function canonical(fields: TriggerContext['trigger']['webhook']): string {
  return JSON.stringify({ trigger: { webhook: fields } })
}

describe('RFC-298 getTask webhook source projection', () => {
  test('canonical note context projects the comment link and no raw fields', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = seedWorkflow(db)
    const commentUrl =
      'https://gitlab.example/platform/api/-/merge_requests/42#note_12345678901234567890'
    const taskId = seedTask(db, workflowId, {
      webhookTriggerId: 'trigger-1',
      webhookFireId: 'fire-1',
      triggerContextJson: canonical({
        event_type: 'note',
        provider: 'gitlab',
        project_web_url: 'https://gitlab.example/platform/api',
        mr_url: 'https://gitlab.example/platform/api/-/merge_requests/42',
        comment_url: commentUrl,
        comment_text: 'private comment body must never enter the task wire',
        event_json: '{"secret":"raw event must stay private"}',
      }),
    })

    const detail = await getTask(db, taskId)
    expect(detail?.webhookSourceLink).toEqual({ kind: 'comment', url: commentUrl })
    expect(detail).not.toHaveProperty('triggerContextJson')
    expect(detail).not.toHaveProperty('triggerContext')
    expect(detail).not.toHaveProperty('comment_text')
    expect(detail).not.toHaveProperty('event_json')
    expect(JSON.stringify(detail)).not.toContain('private comment body')
    expect(JSON.stringify(detail)).not.toContain('raw event must stay private')
  })

  test('historical flat context follows the same fallback and reports the selected target kind', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = seedWorkflow(db)
    const mrUrl = 'https://github.example/acme/widgets/pull/7'
    const taskId = seedTask(db, workflowId, {
      triggerContextJson: JSON.stringify({
        event_type: 'note',
        provider: 'github',
        comment_url: 'javascript:alert(1)',
        mr_url: mrUrl,
        project_web_url: 'https://github.example/acme/widgets',
      }),
    })

    expect((await getTask(db, taskId))?.webhookSourceLink).toEqual({
      kind: 'merge_request',
      url: mrUrl,
    })
  })

  test('a child with inherited context projects its source without webhook attribution rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = seedWorkflow(db)
    const parentTaskId = seedTask(db, workflowId)
    const pipelineUrl = 'https://github.example/acme/widgets/actions/runs/101'
    const childTaskId = seedTask(db, workflowId, {
      parentTaskId,
      triggerContextJson: canonical({
        event_type: 'pipeline_failed',
        provider: 'github',
        pipeline_url: pipelineUrl,
        project_web_url: 'https://github.example/acme/widgets',
      }),
    })

    const detail = await getTask(db, childTaskId)
    expect(detail?.parentTaskId).toBe(parentTaskId)
    expect(detail?.webhookSourceLink).toEqual({ kind: 'pipeline', url: pipelineUrl })
    const stored = db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === childTaskId)
    expect(stored?.webhookTriggerId).toBeNull()
    expect(stored?.webhookFireId).toBeNull()
  })

  test('non-webhook, corrupt and all-unsafe contexts fail closed to null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = seedWorkflow(db)
    const cases = [
      seedTask(db, workflowId),
      seedTask(db, workflowId, { triggerContextJson: '{broken' }),
      seedTask(db, workflowId, {
        triggerContextJson: canonical({
          event_type: 'note',
          comment_url: 'data:text/plain,no',
          mr_url: 'https://user:token@example.test/mr',
          project_web_url: 'file:///tmp/project',
        }),
      }),
      seedTask(db, workflowId, {
        triggerContextJson: JSON.stringify({
          trigger: { webhook: { event_type: 'note', unknown: 'strict-schema-rejects-me' } },
        }),
      }),
    ]

    for (const taskId of cases) {
      expect((await getTask(db, taskId))?.webhookSourceLink).toBeNull()
    }
  })

  test('list summaries remain narrow and never gain the detail-only link', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = seedWorkflow(db)
    const taskId = seedTask(db, workflowId, {
      triggerContextJson: canonical({
        event_type: 'mr_opened',
        mr_url: 'https://gitlab.example/group/repo/-/merge_requests/1',
      }),
    })

    const summary = (await listTasks(db, { limit: 100 })).find((row) => row.id === taskId)
    expect(summary).toBeDefined()
    expect(summary).not.toHaveProperty('webhookSourceLink')
  })
})

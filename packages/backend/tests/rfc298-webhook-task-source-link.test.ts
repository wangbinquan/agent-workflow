import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
// RFC-298 — task detail derives a minimal webhook source link from the task's
// own frozen context. Raw context remains private, historical flat rows are
// supported, corrupt rows fail closed, and inherited child context works
// without any webhook trigger/delivery join.

import { expect, test } from 'bun:test'
import type { TriggerContext } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { tasks, workflows } from '../src/db/schema'
import { getTask, listTasks } from '../src/services/task'

function seedWorkflowWrite(db: ProviderNeutralDatabase) {
  const id = ulid()
  const now = Date.now()
  const write = db
    .insert(workflows)
    .values({
      id,
      name: 'RFC-298 fixture workflow',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { id, write }
}

function seedTaskWrite(
  db: ProviderNeutralDatabase,
  workflowId: string,
  options: {
    triggerContextJson?: string | null
    parentTaskId?: string
    webhookTriggerId?: string
    webhookFireId?: string
  } = {},
  lineage?: (id: string) => { executionLineageId: string; lineageSlotPathJson: string },
) {
  const id = ulid()
  const now = Date.now()
  const write = db
    .insert(tasks)
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
      ...lineage?.(id),
    })
    .run()
  return { id, write }
}

type FixtureLineage = {
  executionLineageId: string
  frames: { stableNodeKey: string; frozenOccurrenceKey: string; workflowRevision: null }[]
}

// Match the original SQLite seed's observed root and inherited child frames.
function createProviderSeeds() {
  const lineageByTaskId = new Map<string, FixtureLineage>()
  return {
    async seedWorkflow(db: ProviderNeutralDatabase): Promise<string> {
      const { id, write } = seedWorkflowWrite(db)
      await write
      return id
    },
    async seedTask(
      db: ProviderNeutralDatabase,
      workflowId: string,
      options: Parameters<typeof seedTaskWrite>[2] = {},
    ): Promise<string> {
      const { id, write } = seedTaskWrite(db, workflowId, options, (taskId) => {
        const parent =
          options.parentTaskId === undefined ? undefined : lineageByTaskId.get(options.parentTaskId)
        const frames = [
          ...(parent?.frames ?? []),
          {
            stableNodeKey: parent === undefined ? 'task-root' : 'child-task',
            frozenOccurrenceKey: taskId,
            workflowRevision: null,
          },
        ]
        const executionLineageId = parent?.executionLineageId ?? taskId
        lineageByTaskId.set(taskId, { executionLineageId, frames })
        return { executionLineageId, lineageSlotPathJson: JSON.stringify(frames) }
      })
      await write
      return id
    },
  }
}

function canonical(fields: TriggerContext['trigger']['webhook']): string {
  return JSON.stringify({ trigger: { webhook: fields } })
}

describeEachProvider('RFC-298 getTask webhook source projection', (harness) => {
  test('canonical note context projects the comment link and no raw fields', async () => {
    const db = harness.db
    const { seedWorkflow, seedTask } = createProviderSeeds()
    const workflowId = await seedWorkflow(db)
    const commentUrl =
      'https://gitlab.example/platform/api/-/merge_requests/42#note_12345678901234567890'
    const taskId = await seedTask(db, workflowId, {
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
    const db = harness.db
    const { seedWorkflow, seedTask } = createProviderSeeds()
    const workflowId = await seedWorkflow(db)
    const mrUrl = 'https://github.example/acme/widgets/pull/7'
    const taskId = await seedTask(db, workflowId, {
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
    const db = harness.db
    const { seedWorkflow, seedTask } = createProviderSeeds()
    const workflowId = await seedWorkflow(db)
    const parentTaskId = await seedTask(db, workflowId)
    const pipelineUrl = 'https://github.example/acme/widgets/actions/runs/101'
    const childTaskId = await seedTask(db, workflowId, {
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
    const stored = (await db.select().from(tasks).all()).find((row) => row.id === childTaskId)
    expect(stored?.webhookTriggerId).toBeNull()
    expect(stored?.webhookFireId).toBeNull()
  })
})

// RFC-359 AC-6：这一条原来自建单引擎库 + 同步种子，而同文件另外两个 describe 早已双引擎。
// 改吃 harness 的库与既有的 `createProviderSeeds()`（异步种子），两个引擎各跑一遍。
describeEachProvider('RFC-298 getTask webhook source projection', (harness) => {
  test('non-webhook, corrupt and all-unsafe contexts fail closed to null', async () => {
    const db = harness.db
    const { seedWorkflow, seedTask } = createProviderSeeds()
    const workflowId = await seedWorkflow(db)
    const cases = [
      await seedTask(db, workflowId),
      await seedTask(db, workflowId, { triggerContextJson: '{broken' }),
      await seedTask(db, workflowId, {
        triggerContextJson: canonical({
          event_type: 'note',
          comment_url: 'data:text/plain,no',
          mr_url: 'https://user:token@example.test/mr',
          project_web_url: 'file:///tmp/project',
        }),
      }),
      await seedTask(db, workflowId, {
        triggerContextJson: JSON.stringify({
          trigger: { webhook: { event_type: 'note', unknown: 'strict-schema-rejects-me' } },
        }),
      }),
    ]

    for (const taskId of cases) {
      expect((await getTask(db, taskId))?.webhookSourceLink).toBeNull()
    }
  })
})

describeEachProvider('RFC-298 getTask webhook source projection', (harness) => {
  test('list summaries remain narrow and never gain the detail-only link', async () => {
    const db = harness.db
    const { seedWorkflow, seedTask } = createProviderSeeds()
    const workflowId = await seedWorkflow(db)
    const taskId = await seedTask(db, workflowId, {
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

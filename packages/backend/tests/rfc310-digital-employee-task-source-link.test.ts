// User regression 2026-08-23: an internal TaskEngine execution launched for a
// digital employee round must retain the owning Case, so direct/reloaded task
// details can render the same stable backlink without a cross-context join.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { getTask, listTasks } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-310 digital employee task source link', () => {
  test('detail projects task-owned Case provenance while list summaries stay narrow', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = ulid()
    const taskId = ulid()
    const now = Date.now()
    const definition = JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] })
    db.insert(workflows)
      .values({
        id: workflowId,
        name: 'RFC-310 source-link workflow',
        definition,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(tasks)
      .values({
        id: taskId,
        name: 'RFC-310 source-link task',
        workflowId,
        workflowSnapshot: definition,
        repoPath: '/tmp/rfc310-source-link-repo',
        worktreePath: '/tmp/rfc310-source-link-worktree',
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        status: 'running',
        inputs: '{}',
        startedAt: now,
        digitalEmployeeRoundId: 'round-42',
        digitalEmployeeCaseId: 'case-42',
      })
      .run()

    expect((await getTask(db, taskId))?.digitalEmployeeCaseId).toBe('case-42')
    const summary = (await listTasks(db, { limit: 100 })).find((row) => row.id === taskId)
    expect(summary).toBeDefined()
    expect(summary).not.toHaveProperty('digitalEmployeeCaseId')
  })

  test('both workflow and synthesized-host launch paths freeze the Case on the task row', () => {
    const execution = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'digitalEmployeeExecution.ts',
      ),
      'utf8',
    )
    const taskService = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'services', 'task.ts'),
      'utf8',
    )

    // SQLite has workflow + synthesized-host arms; PostgreSQL uses the same
    // closed launch provenance through its provider-neutral launch port.
    expect(execution.match(/caseId: plan\.caseRef\.id/g)).toHaveLength(3)
    expect(taskService).toContain(
      'digitalEmployeeCaseId: deps.digitalEmployeeLaunch?.caseId ?? null',
    )
  })
})

// User regression 2026-08-23: an internal TaskEngine execution launched for a
// digital employee round must retain the owning Case, so direct/reloaded task
// details can render the same stable backlink without a cross-context join.

import { describeEachProvider } from './helpers/eachProvider'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { tasks, workflows } from '../src/db/schema'
import { getTask, listTasks } from '../src/services/task'

describe('RFC-310 digital employee task source link', () => {
  describeEachProvider('database behavior', (harness) => {
    test('detail projects task-owned Case provenance while list summaries stay narrow', async () => {
      const db = harness.db
      const workflowId = ulid()
      const taskId = ulid()
      const now = Date.now()
      const definition = JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] })
      await db
        .insert(workflows)
        .values({
          id: workflowId,
          name: 'RFC-310 source-link workflow',
          definition,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      await db
        .insert(tasks)
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

    // RFC-359 AC-1（plan §5hl）：3 → 1。此前两个 provider 各一份 composer、SQLite 那份又分
    // workflow / 合成宿主两条 `startTask` 臂，于是同一件事写了三遍。合一后**只有一次启动调用**
    // （启动内核），Case 冻结也就只有一处——这条判据要的「每条启动路都冻结 Case」因此更强了：
    // 从「三处都别忘」变成「只有一处，忘不了」。数字变小是收敛，不是覆盖变少。
    expect(execution.match(/caseId: plan\.caseRef\.id/g)).toHaveLength(1)
    // 那一处必须确实挂在启动内核的 `internal` 上，而不是飘在别处。
    expect(execution).toContain('digitalEmployeeLaunch: {')
    expect(execution).toContain('actionRunId: plan.roundRef,')
    expect(taskService).toContain(
      'digitalEmployeeCaseId: deps.digitalEmployeeLaunch?.caseId ?? null',
    )
  })
})

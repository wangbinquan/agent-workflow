// CI-1: the soak terminalizes the same synthetic rows after the epoch-2 split.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { prepareSoakDataset } from '../../../scripts/rfc338-maintenance-soak'
import { nodeRunFixture, readNodeRunFixtures, taskFixture, workflowFixture } from './helpers/model'

test('soak clears only active runtime PIDs, preserves finished history and is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cib-soak-fixture-'))
  const path = join(root, 'db.sqlite')
  const db = openDb({ path })
  try {
    await workflowFixture(db, { id: 'soak-workflow', name: 'soak-workflow', definition: '{}' })
    for (const status of ['pending', 'running', 'done', 'failed'] as const) {
      await taskFixture(db, {
        id: status,
        workflowId: 'soak-workflow',
        workflowSnapshot: '{}',
        repoPath: '/fixture',
        worktreePath: '/fixture',
        baseBranch: 'main',
        branch: 'fixture',
        inputs: '{}',
        status,
        startedAt: 100,
        finishedAt: status === 'done' || status === 'failed' ? 200 : null,
      })
      await nodeRunFixture(db, {
        id: `run-${status}`,
        taskId: status,
        nodeId: 'node',
        status,
        startedAt: 100,
        finishedAt: status === 'done' || status === 'failed' ? 200 : null,
        pid: 123,
        exitCode: status === 'failed' ? 7 : null,
      })
    }
    const readRuns = async () =>
      (await readNodeRunFixtures(db)).sort((a, b) => a.id.localeCompare(b.id))
    const before = await readRuns()
    expect(prepareSoakDataset(path)).toMatchObject({
      tasksTerminalized: 2,
      nodeRunsTerminalized: 2,
    })
    const after = await readRuns()
    const rows = after.map(({ id, status, finishedAt, exitCode, pid }) => ({
      id,
      status,
      finished_at: finishedAt,
      exit_code: exitCode,
      pid,
    }))
    expect(rows).toEqual([
      { id: 'run-done', status: 'done', finished_at: 200, exit_code: null, pid: 123 },
      { id: 'run-failed', status: 'failed', finished_at: 200, exit_code: 7, pid: 123 },
      { id: 'run-pending', status: 'done', finished_at: 100, exit_code: 0, pid: null },
      { id: 'run-running', status: 'done', finished_at: 100, exit_code: 0, pid: null },
    ])
    expect(db.$client.query('SELECT id, status, finished_at FROM tasks ORDER BY id').all()).toEqual(
      [
        { id: 'done', status: 'done', finished_at: 200 },
        { id: 'failed', status: 'failed', finished_at: 200 },
        { id: 'pending', status: 'done', finished_at: 100 },
        { id: 'running', status: 'done', finished_at: 100 },
      ],
    )
    expect(after.filter((row) => row.status === 'failed')).toEqual(
      before.filter((row) => row.status === 'failed'),
    )
    expect(after.find((row) => row.id === 'run-done')).toEqual(
      before.find((row) => row.id === 'run-done'),
    )
    expect(prepareSoakDataset(path)).toMatchObject({
      tasksTerminalized: 0,
      nodeRunsTerminalized: 0,
    })
    const repeated = await readRuns()
    expect(repeated).toHaveLength(4)
    expect(repeated).toEqual(after)
  } finally {
    db.$client.close()
    rmSync(root, { recursive: true, force: true })
  }
})

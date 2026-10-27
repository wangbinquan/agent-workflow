// Q-3: persisted target facts survive disposing and recomposing the unified daemon graph.
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { TaskSchema, TaskNodeRunsSchema } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'
import { taskFixture, nodeRunFixture } from './helpers/model'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { plannedFixture } from './helpers/rfc395V3SwitchFixture'

describeEachProvider('Q-3 application restart after committed first business write', (h) => {
  test('recomposed routes preserve task/run ids, frozen deleted-source facts and the rollback fence', async () => {
    const firstWrite = () =>
      rawRows<{ generation_id: string; first_live_write_at: number | null }>(
        h.db,
        sql.raw(
          `SELECT generation_id, first_live_write_at FROM ${metaTableName(h.capabilities.provider, 'first_write')}`,
        ),
      )
    expect((await firstWrite())[0]!.first_live_write_at).toBeNull()
    const failedWriter = async () => {
      await h.session.transaction(async (tx) => {
        await taskFixture(tx, {
          id: 'q3-after-first-write',
          name: 'frozen deleted workflow',
          workflowId: 'q3-deleted-source',
          workflowVersion: 7,
          workflowSnapshot: { $schema_version: 5, inputs: [], nodes: [], edges: [] },
          repoPath: '',
          worktreePath: '',
          baseBranch: '',
          branch: 'original',
          repos: [],
          spaceKind: 'scratch',
          inputs: '{"original":"保留"}',
          status: 'done',
          startedAt: 123,
        })
        await nodeRunFixture(tx, {
          id: 'q3-persisted-run',
          taskId: 'q3-after-first-write',
          nodeId: 'worker',
          status: 'done',
        })
      })
      throw new Error('q3-process-lost-after-business-commit')
    }
    await expect(failedWriter()).rejects.toThrow('q3-process-lost-after-business-commit')
    const marker = (await firstWrite())[0]!
    expect(marker.first_live_write_at).not.toBeNull()
    const read = async () => {
      const app = await createProviderHttpApplication(h, { token: 'q3-restart', dbVersion: 1 })
      try {
        const routes = app.runtime.taskExecution.routes.tasks
        return {
          task: TaskSchema.parse(await routes.get('q3-after-first-write')),
          runs: TaskNodeRunsSchema.parse(await routes.nodeRuns('q3-after-first-write')),
        }
      } finally {
        await app.dispose()
      }
    }
    const before = await read()
    const after = await read()
    expect(after).toEqual(before)
    expect(after.task).toMatchObject({
      id: 'q3-after-first-write',
      workflowId: 'q3-deleted-source',
      workflowName: null,
      workflowVersion: 7,
      repoCount: 1,
      inputs: { original: '保留' },
    })
    expect(after.task.repos).toHaveLength(1)
    expect(after.runs.runs.map((row) => row.id)).toEqual(['q3-persisted-run'])
    expect((await firstWrite())[0]).toEqual(marker)
    const f = await plannedFixture()
    try {
      await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
      f.control.firstWrite = Number(marker.first_live_write_at)
      await expect(f.app.rollback({ operationId: f.operationId })).rejects.toThrow(
        'reverse-migration-required',
      )
    } finally {
      f.close()
    }
  }, 30000)
})

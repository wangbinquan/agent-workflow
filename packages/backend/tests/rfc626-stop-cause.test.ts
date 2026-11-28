// RFC-626 §3.2.4 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md): a task the
// automatic upgrade ends is written as canceled with a reason of its own, defined where every
// other task stop reason is (task-execution/domain/sourceTermination.ts): summary
// `ended by upgrade`, code `ended-by-upgrade`. The conversion's settlers write these two
// values into the task row and the product reads them back, so they are locked here as
// literals as well as through the projection.
//
// The digital-employee executor decides from the task row what a canceled task means: only a
// cancellation by the user counted as "stopped"; every other canceled task was a failure that
// may be retried. A task the upgrade ended is mostly something left over from months ago and
// must not start running again by itself, so the new reason is treated like a cancellation by
// the user. The other reasons keep the path they had — a resource limit still retries.
import { describe, expect, test } from 'bun:test'
import { taskFixture, workflowFixture } from './helpers/model'
import { describeEachProvider } from './helpers/eachProvider'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { composeDigitalEmployeeTestTasks } from './helpers/taskCancellation'
import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition/workspacePresence'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeDigitalEmployeeExecutionCore,
  type DigitalEmployeeExecutionDependencies,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { taskStopProjection } from '@/modules/task-execution/domain/sourceTermination'

describe('RFC-626 the stop reason of a task the upgrade ended', () => {
  test('it has a summary and a code of its own', () => {
    expect(taskStopProjection({ kind: 'upgrade' })).toEqual({
      code: 'ended-by-upgrade',
      summary: 'ended by upgrade',
    })
  })

  test('every other reason is what it was', () => {
    expect(taskStopProjection({ kind: 'user' })).toEqual({
      code: 'canceled-by-user',
      summary: 'canceled by user',
    })
    expect(taskStopProjection({ kind: 'daemon-shutdown' })).toEqual({
      code: 'daemon-shutdown',
      summary: 'interrupted by daemon shutdown',
    })
    expect(taskStopProjection({ kind: 'parent-cascade', parentTaskId: 'parent' })).toEqual({
      code: 'canceled-by-parent-cascade',
      summary: 'canceled by parent task',
    })
    expect(
      taskStopProjection({
        kind: 'resource-reaped',
        summary: 'task-time-limit-exceeded',
        message: 'the task ran longer than its limit',
      }),
    ).toEqual({ code: 'resource-reaped', summary: 'task-time-limit-exceeded' })
    const delivery = {
      kind: 'webhook-terminal',
      deliveryId: 'delivery',
      streamRevision: 1,
    } as const
    expect(taskStopProjection({ ...delivery, terminal: 'closed' }).code).toBe('webhook-mr-closed')
    expect(taskStopProjection({ ...delivery, terminal: 'merged' }).code).toBe('webhook-mr-merged')
    // No two reasons share a summary: the executor tells them apart by it.
    const summaries = [
      taskStopProjection({ kind: 'upgrade' }),
      taskStopProjection({ kind: 'user' }),
      taskStopProjection({ kind: 'daemon-shutdown' }),
      taskStopProjection({ kind: 'parent-cascade', parentTaskId: 'parent' }),
      taskStopProjection({ ...delivery, terminal: 'closed' }),
      taskStopProjection({ ...delivery, terminal: 'merged' }),
    ].map((projection) => projection.summary)
    expect(new Set(summaries).size).toBe(summaries.length)
  })
})

describeEachProvider(
  'RFC-626 the digital-employee executor and a task the upgrade ended',
  (harness) => {
    async function seed(input: {
      readonly id: string
      readonly status: 'canceled' | 'failed'
      readonly errorSummary: string | null
    }): Promise<void> {
      await workflowFixture(
        harness.db,
        {
          id: `wf-${input.id}`,
          name: `wf-${input.id}`,
          definition: '{}',
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        { onConflict: 'ignore' },
      )
      await taskFixture(harness.db, {
        id: input.id,
        name: input.id,
        workflowId: `wf-${input.id}`,
        workflowSnapshot: '{}',
        repoPath: '/tmp/rfc626',
        worktreePath: '/tmp/rfc626',
        baseBranch: 'main',
        branch: `agent-workflow/${input.id}`,
        baseCommit: null,
        status: input.status,
        inputs: '{}',
        startedAt: 1,
        finishedAt: 2,
        errorSummary: input.errorSummary,
        executionLineageId: input.id,
        lineageSlotPathJson: JSON.stringify([
          { stableNodeKey: 'task-root', frozenOccurrenceKey: input.id, workflowRevision: null },
        ]),
      })
    }
    function core() {
      return composeDigitalEmployeeExecutionCore({
        ...composeDatabaseDigitalEmployeeExecutionPorts(harness.db),
        ...composeDigitalEmployeeTestTasks(
          harness.db,
          epoch2RuntimeTestPorts(harness.db).historyRestrictions,
          composeHumanGateOpenParticipantFactory(),
          createFileWorkspacePresenceQueries(),
        ),
      } as unknown as DigitalEmployeeExecutionDependencies)
    }

    test('ended by the upgrade is stopped, exactly as canceled by the user is', async () => {
      // The literal the conversion writes into `tasks.error_summary`.
      await seed({ id: 'task-upgrade', status: 'canceled', errorSummary: 'ended by upgrade' })
      await seed({ id: 'task-user', status: 'canceled', errorSummary: 'canceled by user' })
      const ended = await core().inspect('task-upgrade')
      const canceled = await core().inspect('task-user')
      if (canceled.kind !== 'stopped') throw new Error(`a user cancellation is ${canceled.kind}`)
      expect(canceled.metering.sourceRef).toBe('task:task-user')
      expect(ended).toEqual({
        kind: 'stopped',
        metering: { ...canceled.metering, sourceRef: 'task:task-upgrade' },
      })
    })

    test('the reason read back is the one the projection defines', async () => {
      await seed({
        id: 'task-projected',
        status: 'canceled',
        errorSummary: taskStopProjection({ kind: 'upgrade' }).summary,
      })
      expect((await core().inspect('task-projected')).kind).toBe('stopped')
    })

    test('canceled for any other reason keeps its path: a failure that may be retried', async () => {
      const reasons = [
        'task-time-limit-exceeded',
        taskStopProjection({ kind: 'parent-cascade', parentTaskId: 'parent' }).summary,
        taskStopProjection({ kind: 'daemon-shutdown' }).summary,
        'ended by upgrade and something else',
        null,
      ]
      for (const [index, errorSummary] of reasons.entries()) {
        const id = `task-other-${index}`
        await seed({ id, status: 'canceled', errorSummary })
        expect((await core().inspect(id)).kind).toBe('failed')
      }
    })

    test('the reason alone does not make a task stopped: it has to be canceled', async () => {
      await seed({ id: 'task-failed', status: 'failed', errorSummary: 'ended by upgrade' })
      expect((await core().inspect('task-failed')).kind).toBe('failed')
    })
  },
)

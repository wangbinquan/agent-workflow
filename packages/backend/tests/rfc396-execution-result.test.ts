// Real-model acceptance found a designer result masking the later clarified result.
// Exercise the production read model and execution core, including persisted generations.
import { nodeRunFixture, nodeRunOutputFixture, taskFixture, workflowFixture } from './helpers/model'
import { expect, test } from 'bun:test'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeDigitalEmployeeExecutionCore,
  type DigitalEmployeeExecutionDependencies,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-396 workflow result belongs to the task output', (harness) => {
  for (const terminal of ['done', 'inactive', 'skipped', 'missing'] as const)
    test(`${terminal}: intermediate and stale results cannot replace the final result`, async () => {
      const definition = JSON.stringify({
        nodes: [
          { id: 'designer', kind: 'agent-single' },
          { id: 'clarifier', kind: 'agent-single' },
          { id: 'result', kind: 'output', ports: [{ name: 'agent-result' }] },
        ],
      })
      await workflowFixture(harness.db, {
        id: 'workflow',
        name: 'graph',
        definition,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      await taskFixture(harness.db, {
        id: 'task',
        name: 'graph',
        workflowId: 'workflow',
        workflowSnapshot: definition,
        repoPath: '/fixture',
        worktreePath: '/fixture',
        baseBranch: 'main',
        branch: 'fixture',
        status: 'done',
        inputs: '{}',
        startedAt: 1,
        finishedAt: 5,
        digitalEmployeeRoundId: 'round',
      })
      await nodeRunFixture(harness.db, [
        { id: 'designer-run', taskId: 'task', nodeId: 'designer', seq: 1, status: 'done' },
        { id: 'z-old-output', taskId: 'task', nodeId: 'result', seq: 2, status: 'done' },
        { id: 'clarifier-run', taskId: 'task', nodeId: 'clarifier', seq: 3, status: 'done' },
        {
          id: 'a-new-output',
          taskId: 'task',
          nodeId: 'result',
          seq: 4,
          iteration: 1,
          status: terminal === 'skipped' ? 'skipped' : 'done',
        },
      ])
      await nodeRunOutputFixture(harness.db, [
        {
          nodeRunId: 'designer-run',
          portName: 'agent-result',
          content: 'invalid first design',
          active: true,
        },
        {
          nodeRunId: 'z-old-output',
          portName: 'agent-result',
          content: 'old generation',
          active: true,
        },
        {
          nodeRunId: 'clarifier-run',
          portName: 'agent-result',
          content: 'intermediate clarified result',
          active: true,
        },
        ...(terminal === 'missing' || terminal === 'skipped'
          ? []
          : [
              {
                nodeRunId: 'a-new-output',
                portName: 'agent-result',
                content: 'final clarified result',
                active: terminal !== 'inactive',
              },
            ]),
      ])
      const validated: (string | null)[] = []
      const core = composeDigitalEmployeeExecutionCore({
        ...composeDatabaseDigitalEmployeeExecutionPorts(harness.db),
        workspace: {
          async validate(input) {
            validated.push(input.outputJson)
            return { ok: true }
          },
        },
      } as DigitalEmployeeExecutionDependencies)
      const result = await core.inspect('task')
      if (terminal === 'done') {
        expect(result).toMatchObject({ kind: 'completed', outputJson: 'final clarified result' })
        expect(validated).toEqual(['final clarified result'])
      } else {
        expect(result).toMatchObject({ kind: 'failed', errorCode: 'execution-output-missing' })
        expect(validated).toEqual([null])
      }
    })
})

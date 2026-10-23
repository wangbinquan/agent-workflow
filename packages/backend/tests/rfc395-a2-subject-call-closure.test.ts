// RFC-395 II-a A2: call nodes resolve frozen v2 edges from the subject namespace, without a host row.
import { expect, test } from 'bun:test'
import {
  runCallWorkflowNode,
  type SchedulerState,
} from '@/modules/task-execution/composition/nodeMechanics'
import { callEdgeKey } from '@/services/execution/closure'
import { TASK_DEFINITION_HOSTS } from '@/modules/task-execution/public/queries'
import { createLogger } from '@/util/log'

test('workgroup call-workflow reads the persisted host edge before entering node execution', async () => {
  const boundary = new Error('reached node execution after resolving the frozen definition')
  const log = createLogger('rfc395-subject-closure')
  const definition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
  // This test ends at the first persistence call: a missing edge returns a domain failure earlier.
  const state = {
    taskId: 'task',
    task: {
      subject: { kind: 'workgroup', sourceId: 'group' },
      workflowId: 'deliberately-not-the-definition-anchor',
      refClosureJson: JSON.stringify({
        closureVersion: 2,
        workflows: {
          [callEdgeKey(TASK_DEFINITION_HOSTS.workgroup.id, 'call')]: {
            id: 'child',
            version: 3,
            definition,
          },
        },
        workgroups: {},
      }),
    },
    definition,
    log,
    containerOf: new Map(),
    opts: {
      persistence: {
        nodeExecution: {
          async list() {
            throw boundary
          },
        },
      },
    },
  } as unknown as SchedulerState
  await expect(
    runCallWorkflowNode(state, {
      node: { id: 'call', kind: 'call-workflow', workflowName: 'child-name' },
      iteration: 0,
      containerRunId: null,
      log,
    }),
  ).rejects.toBe(boundary)
})

test('wrong subject anchor cannot resolve a frozen workflow edge', async () => {
  const boundary = new Error('reached node execution after resolving the frozen definition')
  const log = createLogger('rfc395-subject-closure')
  const definition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
  // This test ends at the first persistence call: a missing edge returns a domain failure earlier.
  const state = {
    taskId: 'task',
    task: {
      subject: { kind: 'workgroup', sourceId: 'group' },
      workflowId: 'deliberately-not-the-definition-anchor',
      refClosureJson: JSON.stringify({
        closureVersion: 2,
        workflows: {
          [callEdgeKey('deliberately-not-the-definition-anchor', 'call')]: {
            id: 'child',
            version: 3,
            definition,
          },
        },
        workgroups: {},
      }),
    },
    definition,
    log,
    containerOf: new Map(),
    opts: {
      persistence: {
        nodeExecution: {
          async list() {
            throw boundary
          },
        },
      },
    },
  } as unknown as SchedulerState
  await expect(
    runCallWorkflowNode(state, {
      node: { id: 'call', kind: 'call-workflow', workflowName: 'child-name' },
      iteration: 0,
      containerRunId: null,
      log,
    }),
  ).resolves.toMatchObject({ kind: 'failed', message: 'workflow-call-ref-missing' })
})

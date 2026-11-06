// RFC-395 II-a A2: call nodes resolve frozen v2 edges from the subject namespace, without a host row.
// RFC-404: the call node runs through its executor and explicit ports instead of nodeMechanics.ts.
import { expect, test } from 'bun:test'
import { createChildCallNodeExecutionPorts } from '@/modules/task-execution/composition/childCallNodeExecution'
import type { TaskMechanicsState } from '@/modules/task-execution/composition/taskMechanicsState'
import type { NodeStepRequest } from '@/modules/task-execution/domain/nodeExecution'
import { CallWorkflowNodeExecutor } from '@/modules/task-execution/engine/node/call-workflow/callWorkflowNodeExecutor'
import { callEdgeKey } from '@/modules/resource-catalog/domain/callClosure'
import { TASK_DEFINITION_HOSTS } from '@/modules/task-execution/public/queries'
import { createLogger } from '@/util/log'

function runCall(state: TaskMechanicsState) {
  return new CallWorkflowNodeExecutor(createChildCallNodeExecutionPorts(state)).execute({
    node: { id: 'call', kind: 'call-workflow', workflowName: 'child-name' },
    iteration: 0,
    containerRunId: null,
  } as unknown as NodeStepRequest<'call-workflow'>)
}

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
  } as unknown as TaskMechanicsState
  await expect(runCall(state)).rejects.toBe(boundary)
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
  } as unknown as TaskMechanicsState
  await expect(runCall(state)).resolves.toMatchObject({
    kind: 'failed',
    message: 'workflow-call-ref-missing',
  })
})

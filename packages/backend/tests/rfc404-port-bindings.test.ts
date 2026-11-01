// RFC-404: the call-node binding only adds task-level facts — the inherited child runtime, the
// scheduler driver, the delegated owner actor and the execution context — and forwards what the
// engine body assembled unchanged. Locks the split between engine (node request) and composition
// (task-level inheritance) that replaced the call body inside nodeMechanics.ts.
import { expect, test } from 'bun:test'
import { createChildCallNodeExecutionPorts } from '@/modules/task-execution/composition/childCallNodeExecution'
import { pickInheritableRunConfig } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type {
  ChildCallWorkflowLaunch,
  ChildCallWorkgroupLaunch,
} from '@/modules/task-execution/application/ports/childCallNodeExecution'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { NotFoundError } from '@/util/errors'

interface Recorded {
  launchWorkflow: Record<string, unknown>[]
  launchWorkgroup: Record<string, unknown>[]
  resumeChild: Record<string, unknown>[]
  cancelChild: Record<string, unknown>[]
  forCall: Record<string, unknown>[]
  patch: Record<string, unknown>[]
}

function fixture() {
  const calls: Recorded = {
    launchWorkflow: [],
    launchWorkgroup: [],
    resumeChild: [],
    cancelChild: [],
    forCall: [],
    patch: [],
  }
  let cancelError: Error | null = null
  const schedulerDriver = {
    async resumeChild(input: Record<string, unknown>) {
      calls.resumeChild.push(input)
    },
    async cancelChild(input: Record<string, unknown>) {
      calls.cancelChild.push(input)
      if (cancelError !== null) throw cancelError
    },
    isTaskActive: (taskId: string) => taskId === 'active-child',
  }
  const executionContext = { sentinel: 'execution-context' }
  const raw = {
    taskId: 'parent-task',
    task: {
      id: 'parent-task',
      name: 'Parent',
      subject: { kind: 'workflow', sourceId: 'wf-parent' },
      refClosureJson: null as string | null,
      invocationDepth: undefined as number | undefined,
      parentTaskId: undefined as string | null | undefined,
      ownerUserId: 'owner-1' as string | null,
      worktreePath: '/parent/worktree',
      branch: 'agent-workflow/parent-task',
    },
    repos: [{ mountPath: '', worktreePath: '/parent/worktree' }],
    collaboratorUserIds: ['member-1'],
    triggerContext: { source: 'webhook', deliveryId: 'delivery-1' } as unknown,
    opts: {
      appHome: '/app-home',
      maxConcurrentNodes: 3,
      maxInvocationDepth: 5,
      executionContext,
      childLaunch: {
        async launchWorkflow(request: Record<string, unknown>) {
          calls.launchWorkflow.push(request)
        },
        async launchWorkgroup(request: Record<string, unknown>) {
          calls.launchWorkgroup.push(request)
        },
      },
      identityAccess: {
        delegatedRequests: {
          async forCall(input: Record<string, unknown>) {
            calls.forCall.push(input)
            return input.ownerUserId === 'inactive-owner'
              ? null
              : { actor: { user: { id: input.ownerUserId } } }
          },
        },
      },
      persistence: {
        nodeExecution: {
          async patch(input: Record<string, unknown>) {
            calls.patch.push(input)
            return true
          },
        },
      },
    },
    topology: { schedulerDriver },
  }
  const state = raw as unknown as TaskMechanicsState
  const expectedRuntime = () => ({
    ...(raw.triggerContext === null ? {} : { triggerContext: raw.triggerContext }),
    actorUserId: raw.task.ownerUserId ?? undefined,
    runConfig: pickInheritableRunConfig(state.opts),
  })
  return {
    raw,
    state,
    calls,
    schedulerDriver,
    executionContext,
    expectedRuntime,
    failCancelWith: (error: Error) => {
      cancelError = error
    },
  }
}

test('launch arms add the inherited runtime and scheduler driver without rewriting the node request', async () => {
  const { raw, state, calls, schedulerDriver, expectedRuntime } = fixture()
  const ports = createChildCallNodeExecutionPorts(state)
  const workflow = {
    actor: { user: { id: 'owner-1' } },
    workflowId: 'child-workflow',
    frozenWorkflowVersion: 3,
    payload: { workflowId: 'child-workflow', name: 'Parent › call' },
    parentTaskId: 'parent-task',
    parentNodeRunId: 'call-run',
    invocationDepth: 1,
    materializedSpace: { taskId: 'child-1' },
    frozenSnapshotJson: '{}',
    refClosureJson: null,
  } as unknown as ChildCallWorkflowLaunch
  await ports.children.launchWorkflow(workflow)
  const workflowRuntime = expectedRuntime()
  // The runtime is computed when the launch happens, not when the ports were built.
  raw.triggerContext = { source: 'webhook', deliveryId: 'delivery-2' }
  const workgroup = {
    actor: { user: { id: 'owner-1' } },
    frozenGroup: { id: 'group', version: 1, group: {} },
    goal: 'goal',
    name: 'Parent › group',
    collaboratorUserIds: ['member-1'],
    parentTaskId: 'parent-task',
    parentNodeRunId: 'call-run',
    invocationDepth: 1,
    materializedSpace: { taskId: 'child-2' },
  } as unknown as ChildCallWorkgroupLaunch
  await ports.children.launchWorkgroup(workgroup)
  const workgroupRuntime = expectedRuntime()

  for (const [recorded, request, runtimeExpected, runtimeAt] of [
    [calls.launchWorkflow, workflow, workflowRuntime, 'delivery-1'],
    [calls.launchWorkgroup, workgroup, workgroupRuntime, 'delivery-2'],
  ] as const) {
    expect(recorded).toHaveLength(1)
    const sent = recorded[0]!
    const { runtime, schedulerDriver: driver, ...forwarded } = sent
    expect(forwarded).toEqual({ ...(request as unknown as Record<string, unknown>) })
    for (const [key, value] of Object.entries(request)) expect(sent[key]).toBe(value)
    expect(driver).toBe(schedulerDriver)
    expect(runtime).toEqual(runtimeExpected)
    expect((runtime as { triggerContext: { deliveryId: string } }).triggerContext.deliveryId).toBe(
      runtimeAt,
    )
  }
})

test('resume passes only the child id and the inherited runtime; cancel cascades with the parent cause', async () => {
  const { state, calls, expectedRuntime, failCancelWith } = fixture()
  const ports = createChildCallNodeExecutionPorts(state)
  await ports.children.resumeChild('child-1')
  expect(calls.resumeChild).toEqual([{ taskId: 'child-1', runtime: expectedRuntime() }])
  await ports.children.cancelChild('child-1')
  expect(calls.cancelChild).toEqual([
    { taskId: 'child-1', cause: { kind: 'parent-cascade', parentTaskId: 'parent-task' } },
  ])
  // The binding does not decide which cancel races are tolerable — the engine body does.
  const missing = new NotFoundError('task-not-found', 'gone')
  failCancelWith(missing)
  await expect(ports.children.cancelChild('child-2')).rejects.toBe(missing)
  expect(ports.children.isTaskActive('active-child')).toBe(true)
  expect(ports.children.isTaskActive('child-1')).toBe(false)
})

test('a NULL owner gets the permissionless legacy projection; any other owner goes through the delegated request', async () => {
  const { raw, state, calls } = fixture()
  const ports = createChildCallNodeExecutionPorts(state)
  raw.task.ownerUserId = null
  const legacy = await ports.children.resolveActor('call-workflow', 'call-run')
  expect(legacy?.user.id).toBe('__system__')
  expect(legacy?.source).toBe('daemon')
  expect(legacy?.permissions.size).toBe(0)
  expect(calls.forCall).toEqual([])

  raw.task.ownerUserId = 'owner-1'
  const delegated = await ports.children.resolveActor('call-workgroup', 'call-run')
  expect(delegated?.user.id).toBe('owner-1')
  expect(calls.forCall).toEqual([
    {
      kind: 'call-workgroup',
      ownerUserId: 'owner-1',
      parentTaskId: 'parent-task',
      parentNodeRunId: 'call-run',
    },
  ])
  raw.task.ownerUserId = 'inactive-owner'
  expect(await ports.children.resolveActor('call-workflow', 'call-run')).toBeNull()
})

test('task facts are read on use with the historical fallbacks; ledger patches carry the execution context', async () => {
  const { raw, state, calls, executionContext } = fixture()
  const ports = createChildCallNodeExecutionPorts(state)
  expect(ports.task.invocationDepth).toBe(0)
  expect(ports.task.parentTaskId).toBeNull()
  expect(ports.task.refClosureJson).toBeNull()
  raw.task.invocationDepth = 2
  raw.task.parentTaskId = 'grand-parent'
  raw.task.refClosureJson = '{"closureVersion":2,"workflows":{},"workgroups":{}}'
  expect(ports.task.invocationDepth).toBe(2)
  expect(ports.task.parentTaskId).toBe('grand-parent')
  expect(ports.task.refClosureJson).toBe(raw.task.refClosureJson)
  expect(ports.task.workflowAnchorId).toBe('wf-parent')
  expect(ports.budget.maxInvocationDepth()).toBe(5)

  await ports.ledger.patch({ nodeRunId: 'call-run', values: { identity: { childTaskId: 'c' } } })
  expect(calls.patch).toEqual([
    {
      nodeRunId: 'call-run',
      values: { identity: { childTaskId: 'c' } },
      executionContext,
    },
  ])
})

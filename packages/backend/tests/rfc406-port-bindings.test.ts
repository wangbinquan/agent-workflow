// RFC-406: the workgroup host lane joined the agent-single executor's ports. Its few extra capabilities
// are bound in composition and only add task-level facts — the orchestrator / catalog injection choice,
// the execution context on the status write and the merge-state abandon, the collaboration runtime —
// while every value is still read when the body asks for it. Also locks the workgroup engine hook that
// moved from nodeMechanics.ts into nodeExecution.ts.
import { expect, test } from 'bun:test'
import { createAgentNodeExecutionPorts } from '@/modules/task-execution/composition/agentNodeExecution'
import { buildNodeExecutionWorkgroupHooks } from '@/modules/task-execution/composition/nodeExecution'
import { ORCHESTRATOR_AGENT_ID } from '@/modules/task-execution/domain/orchestratorAgentIdentity'
import { CLARIFY_FORBIDDEN_PREFIX } from '@agent-workflow/shared'
import type { TaskMechanicsState } from '@/modules/task-execution/composition/taskMechanicsState'

type Calls = Record<string, unknown[]>

function recorder(calls: Calls, name: string, result: unknown = undefined) {
  return (...args: unknown[]) => {
    ;(calls[name] ??= []).push(args.length === 1 ? args[0] : args)
    return Promise.resolve(result)
  }
}

function fixture() {
  const calls: Calls = {}
  const family = (label: string) => ({
    runtimeBindings: {},
    materialReferences: {
      references: (snapshot: unknown) => {
        ;(calls[label + ':references'] ??= []).push(snapshot)
        return { material: label }
      },
    },
    open: () => {
      throw new Error('not opened in this test')
    },
  })
  const raw = {
    taskId: 'task-1',
    task: { repoPath: '/repo', worktreePath: '/worktree' },
    repos: [
      { mountPath: 'repo-a', worktreePath: '/worktree/repo-a', baseCommit: null as string | null },
    ],
    taskExecutionResources: {
      injection: recorder(calls, 'injection', {
        kind: 'failed',
        summary: 'gone',
        message: 'agent-not-found',
      }),
    },
    opts: {
      executionContext: { sentinel: 'context-1' } as unknown,
      taskAgentRuns: family('family-1') as unknown,
      collaborationRuntime: {
        isTaskClarifySuppressed: recorder(calls, 'isTaskClarifySuppressed', true),
        dismissOpenClarifyParksForAutonomous: recorder(calls, 'dismiss', {
          dismissedSessions: 1,
          canceledParkRuns: [],
          requeuedAssignments: [],
        }),
      } as unknown,
      persistence: {
        nodeRuns: { set: recorder(calls, 'set', true) },
        mergeStates: { tryTransition: recorder(calls, 'tryTransition', true) },
      } as unknown,
    },
  }
  return { raw, state: raw as unknown as TaskMechanicsState, calls, family }
}

const orchestrator = (extra: Record<string, unknown> = {}) =>
  ({
    id: ORCHESTRATOR_AGENT_ID,
    name: 'orchestrator',
    dependsOn: [],
    skills: [],
    mcp: [],
    plugins: [],
    ...extra,
  }) as never

test('hostInjection: the orchestrator is synthetic over the current family; any other agent comes from the session', async () => {
  const { raw, state, calls, family } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  // Read when the host asks: a family swapped after the ports were built is the one used.
  raw.opts.taskAgentRuns = family('family-2') as unknown
  const synthetic = await ports.resources.hostInjection(orchestrator())
  expect(synthetic.kind).toBe('ok')
  if (synthetic.kind === 'ok') {
    expect(synthetic.spec.agent.id).toBe(ORCHESTRATOR_AGENT_ID)
    expect(synthetic.spec.dependents).toEqual([])
    expect(synthetic.spec.mcps).toEqual([])
    expect(synthetic.spec.material as unknown).toEqual({ material: 'family-2' })
  }
  expect(calls['family-1:references']).toBeUndefined()
  expect(calls.injection).toBeUndefined()
  // An internal agent that declares managed resources keeps its typed failure.
  const refused = await ports.resources.hostInjection(orchestrator({ skills: ['skill-1'] }))
  expect(refused).toMatchObject({ kind: 'failed', message: 'internal-agent-resources-unsupported' })

  const member = await ports.resources.hostInjection({ id: 'agent-7', name: 'member' } as never)
  expect(calls.injection).toEqual(['agent-7'])
  expect(member).toEqual({ kind: 'failed', summary: 'gone', message: 'agent-not-found' })
})

test('the status write and the merge-state abandon carry the execution context; suppression calls go through unchanged', async () => {
  const { raw, state, calls } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  const write = {
    nodeRunId: 'run-1',
    to: 'failed',
    allowedFrom: ['done'],
    allowTerminal: true,
    reason: 'wg-clarify-suppressed-late',
  } as const
  await ports.ledger.setNodeRunStatus(write as never)
  expect(calls.set).toEqual([{ ...write, executionContext: raw.opts.executionContext }])
  expect(await ports.workspace.abandonMerge('run-1', 'discard-writes')).toBe(true)
  expect(calls.tryTransition).toEqual([
    {
      nodeRunId: 'run-1',
      event: { kind: 'abandon', reason: 'discard-writes' },
      executionContext: raw.opts.executionContext,
    },
  ])
  raw.opts.executionContext = undefined
  await ports.workspace.abandonMerge('run-2', 'wg-merge-conflict-unresolved')
  expect(calls.tryTransition![1]).toEqual({
    nodeRunId: 'run-2',
    event: { kind: 'abandon', reason: 'wg-merge-conflict-unresolved' },
  })

  const query = { taskId: 'task-1', nodeId: '__wg_member__', shardKey: 'member-1' }
  expect(await ports.collaboration.isTaskClarifySuppressed(query)).toBe(true)
  expect(calls.isTaskClarifySuppressed![0]).toBe(query)
  const dismissal = { taskId: 'task-1' }
  expect(
    (await ports.collaboration.dismissOpenClarifyParksForAutonomous(dismissal)).dismissedSessions,
  ).toBe(1)
  expect(calls.dismiss![0]).toBe(dismissal)
})

test('repo mounts are read on use and the clarify-forbidden prefix is the shared constant', () => {
  const { raw, state } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  expect(ports.task.repoMounts).toEqual(['repo-a'])
  raw.repos = [
    { mountPath: '', worktreePath: '/worktree', baseCommit: null },
    { mountPath: 'lib', worktreePath: '/worktree/lib', baseCommit: null },
  ]
  expect(ports.task.repoMounts).toEqual(['', 'lib'])
  expect(ports.rules.clarifyForbiddenPrefix).toBe(CLARIFY_FORBIDDEN_PREFIX)
})

test('the workgroup engine hook refuses a canonical delta when no repository has a base commit', async () => {
  const { state } = fixture()
  const hooks = buildNodeExecutionWorkgroupHooks(state, () => {
    throw new Error('the gateway is only built when a host turn runs')
  })
  expect(typeof hooks.broadcastNodeStatus).toBe('function')
  await expect(hooks.getCanonicalFilesChanged!()).rejects.toThrow(
    'no base commit on any repo — cannot compute canonical delta',
  )
})

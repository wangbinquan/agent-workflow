// RFC-415: the digital employee execution core and the action executors run on application ports; composition binds
// the provider. These cases lock the bindings: `launchDigitalEmployeeHost` turns the core's host launch into exactly the
// root launch request the core used to build (both subject kinds, with and without a repository scene), and the action
// environment supplies the status read and the standalone workspace entry check the runners used to reach directly.
import { expect, test } from 'bun:test'
import { taskFixture, workflowFixture } from './helpers/model'
import { describeEachProvider } from './helpers/eachProvider'
import { launchDigitalEmployeeHost } from '@/modules/task-execution/infrastructure/hostTaskLaunch'
import { createActionExecutionEnvironment } from '@/modules/task-execution/composition/actionExecutionEnvironment'
import { localActionWorkspaceEntries } from '@/modules/task-execution/infrastructure/local/localActionWorkspaceEntries'

const snapshot = { $schema_version: 2, inputs: [], nodes: [], edges: [] } as never
const task = { name: 'employee:round-1', inputs: { prompt: 'x' }, maxDurationMs: 1000 } as never

function launchDeps() {
  const requests: Record<string, unknown>[] = []
  const actor = { sentinel: 'actor' }
  const deps = {
    resolveActor: async () => actor as never,
    resourceAuthorityFor: (value: unknown) => ({ authorityFor: value }) as never,
    launch: {
      async launch(request: Record<string, unknown>) {
        requests.push(request)
        return { id: 'launched-1' } as never
      },
    },
  }
  return { deps, requests, actor }
}

test('a workflow host launch keeps the authored geometry and no borrowed workspace', async () => {
  const { deps, requests, actor } = launchDeps()
  const result = await launchDigitalEmployeeHost(deps as never, {
    taskId: 'task-1',
    roundRef: 'round-1',
    caseId: 'case-1',
    task,
    subject: {
      kind: 'workflow',
      workflowId: 'wf-1',
      workflowName: 'Review',
      workflowVersion: 7,
      workflowSnapshot: snapshot,
    },
    repository: null,
  })
  expect(result).toEqual({ id: 'launched-1' })
  expect(requests).toEqual([
    {
      actor,
      resourceAuthority: { authorityFor: actor },
      invoker: { type: 'user', launchKind: 'direct-json' },
      task,
      subject: {
        subject: { kind: 'workflow', sourceId: 'wf-1' },
        workflowName: 'Review',
        workflowVersion: 7,
        workflowSnapshot: snapshot,
        builtin: false,
      },
      internal: {
        catalogVisibility: 'internal',
        preallocatedTaskId: 'task-1',
        digitalEmployeeLaunch: { actionRunId: 'round-1', caseId: 'case-1' },
      },
    },
  ])
})

test('a synthesized host launch on a repository scene borrows the workspace and its input mounts', async () => {
  const { deps, requests } = launchDeps()
  await launchDigitalEmployeeHost(deps as never, {
    taskId: 'task-2',
    roundRef: 'round-2',
    caseId: 'case-2',
    task,
    subject: { kind: 'digital-employee', workflowSnapshot: snapshot },
    repository: {
      platformInputPaths: ['.agent-workflow/inputs/a'],
      workspacePath: '/scene',
      baselineSha: 'b'.repeat(40),
    },
  })
  const request = requests[0] as {
    subject: unknown
    internal: { workspace: { prepare: unknown } } & Record<string, unknown>
  }
  expect(request.subject).toEqual({
    subject: { kind: 'digital-employee', sourceId: null },
    workflowVersion: 1,
    workflowSnapshot: snapshot,
    builtin: true,
  })
  const { workspace, ...internal } = request.internal
  expect(internal).toEqual({
    catalogVisibility: 'internal',
    preallocatedTaskId: 'task-2',
    digitalEmployeeLaunch: { actionRunId: 'round-2', caseId: 'case-2' },
    platformInputPaths: ['.agent-workflow/inputs/a'],
  })
  expect(typeof workspace.prepare).toBe('function')
})

function environmentDeps(db: unknown, overrides: Record<string, unknown> = {}) {
  return {
    db,
    resolveActor: async () => ({}) as never,
    resourceAuthorityFor: () => ({}) as never,
    launch: { launch: async () => ({ id: 'x' }) as never },
    cancelTask: async () => undefined,
    readModels: { executionOutcome: {}, statusProjection: {} },
    agents: { get: async () => null },
    ...overrides,
  } as never
}

test('the action environment selects the standalone entry check unless the deployment supplied one', () => {
  expect(createActionExecutionEnvironment(environmentDeps({})).workspaceEntries).toBe(
    localActionWorkspaceEntries,
  )
  const hosted = { exists: async () => true }
  expect(
    createActionExecutionEnvironment(environmentDeps({}, { workspaceEntries: hosted }))
      .workspaceEntries,
  ).toBe(hosted)
})

describeEachProvider('RFC-415 action environment status read', (harness) => {
  test('the environment reads the task row status and an absent row as null', async () => {
    await workflowFixture(
      harness.db,
      {
        id: 'wf-rfc415',
        name: 'wf-rfc415',
        definition: '{}',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      { onConflict: 'ignore' },
    )
    await taskFixture(harness.db, {
      id: 'rfc415-task',
      name: 'rfc415-task',
      workflowId: 'wf-rfc415',
      workflowSnapshot: '{}',
      repoPath: '/tmp/rfc415',
      worktreePath: '/tmp/rfc415/task',
      baseBranch: 'main',
      branch: 'agent-workflow/rfc415-task',
      baseCommit: null,
      status: 'done',
      inputs: '{}',
      startedAt: 1,
      executionLineageId: 'rfc415-task',
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: 'rfc415-task', workflowRevision: null },
      ]),
    })
    const env = createActionExecutionEnvironment(environmentDeps(harness.db))
    expect(await env.taskStatus('rfc415-task')).toBe('done')
    expect(await env.taskStatus('rfc415-missing')).toBeNull()
  })
})

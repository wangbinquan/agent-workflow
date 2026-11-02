// RFC-419: the action host task launch moved from the composition environment into the infrastructure host launch
// adapter, next to the borrowed workspace participant it uses. These cases lock the moved mapping and its binding: the
// kernel request (task options with and without a wall-time budget, copied inputs, the synthesized digital-employee
// subject, internal facts and the borrowed workspace), the environment returning the launched id, and the borrowed
// workspace's single commit-or-rollback state machine.
import { expect, test } from 'bun:test'
import {
  borrowedPostgresqlWorkspace,
  launchActionHostTask,
} from '@/modules/task-execution/infrastructure/hostTaskLaunch'
import { createActionExecutionEnvironment } from '@/modules/task-execution/composition/actionExecutionEnvironment'

const snapshot = { $schema_version: 2, inputs: [], nodes: [], edges: [] }

function launchDeps() {
  const requests: Record<string, unknown>[] = []
  const actor = { sentinel: 'actor' }
  return {
    requests,
    actor,
    deps: {
      resolveActor: async () => actor as never,
      resourceAuthorityFor: (value: unknown) => ({ authorityFor: value }) as never,
      launch: {
        async launch(request: Record<string, unknown>) {
          requests.push(request)
          return { id: 'launched-1' } as never
        },
      },
    } as never,
  }
}

function actionInput(wallTimeMs: number | null) {
  return {
    name: 'employee:action-1',
    inputs: { prompt: 'go' },
    wallTimeMs,
    snapshot,
    actionRunId: 'action-run-1',
    platformInputPaths: ['.agent-workflow/inputs/a'],
    workspacePath: '/scene',
    baselineSha: 'c'.repeat(40),
  } as never
}

test('an action host launch maps onto the kernel with the synthesized subject and the borrowed workspace', async () => {
  const { deps, requests, actor } = launchDeps()
  const input = actionInput(null)
  expect(await launchActionHostTask(deps, input)).toBe('launched-1')
  const request = requests[0] as {
    task: { inputs: unknown }
    internal: { workspace: { prepare: unknown } } & Record<string, unknown>
  } & Record<string, unknown>
  const { internal, ...rest } = request
  const { workspace, ...facts } = internal
  expect(rest as Record<string, unknown>).toEqual({
    actor,
    resourceAuthority: { authorityFor: actor },
    invoker: { type: 'user', launchKind: 'direct-json' },
    task: { name: 'employee:action-1', inputs: { prompt: 'go' } },
    subject: {
      subject: { kind: 'digital-employee', sourceId: null },
      workflowVersion: 1,
      builtin: true,
      workflowSnapshot: snapshot,
    },
  })
  expect(request.task.inputs).not.toBe((input as { inputs: unknown }).inputs)
  expect(facts).toEqual({
    catalogVisibility: 'internal',
    digitalEmployeeLaunch: { actionRunId: 'action-run-1' },
    platformInputPaths: ['.agent-workflow/inputs/a'],
  })
  expect(typeof workspace.prepare).toBe('function')
  await launchActionHostTask(deps, actionInput(90_000))
  expect((requests[1] as { task: unknown }).task).toEqual({
    name: 'employee:action-1',
    inputs: { prompt: 'go' },
    maxDurationMs: 90_000,
  })
})

test('the action environment launches through the adapter and returns the launched id', async () => {
  const { deps, requests } = launchDeps()
  const environment = createActionExecutionEnvironment({
    ...(deps as object),
    db: {},
    cancelTask: async () => undefined,
    readModels: { executionOutcome: {}, statusProjection: {} },
    agents: { get: async () => null },
  } as never)
  expect(await environment.launchHostTask(actionInput(null))).toBe('launched-1')
  expect(requests).toHaveLength(1)
})

test('the borrowed workspace prepares the caller directory and settles exactly once', async () => {
  const participant = borrowedPostgresqlWorkspace({
    workspacePath: '/scene',
    baselineSha: 'd'.repeat(40),
  })
  const committed = await participant.prepare({ taskId: 'task-1' } as never)
  expect(committed).toMatchObject({
    taskId: 'task-1',
    kind: 'single',
    spaceKind: 'internal',
    repoPath: '/scene',
    worktreePath: '/scene',
    baseBranch: 'd'.repeat(40),
    baseCommit: 'd'.repeat(40),
    branch: '',
    earlyError: null,
  })
  committed.commit()
  expect(() => committed.commit()).toThrow('borrowed-workspace-already-committed')
  await expect(committed.rollback()).rejects.toThrow('borrowed-workspace-already-committed')
  const rolledBack = await participant.prepare({ taskId: 'task-2' } as never)
  expect(await rolledBack.rollback()).toEqual({ taskId: 'task-2', complete: true, failures: [] })
  await expect(rolledBack.rollback()).rejects.toThrow('borrowed-workspace-already-rolled-back')
  expect(() => rolledBack.commit()).toThrow('borrowed-workspace-already-rolled-back')
})

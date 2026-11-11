// RFC-395 II-pre：生产启动 / 延续依赖及工作区租约改接线，保留既有断言。
// RFC-332 — TaskEngine contracts, single-consumer cutover and architecture locks.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { ulid } from 'ulid'
import { decodeTaskWorkgroupConfig } from '@/modules/task-execution/domain/taskWorkgroupConfig'
import { taskDriveSubmission } from '@/modules/task-execution/application/drive/taskDriveTypes'
import { resolveTaskDriveConfig } from '../src/modules/task-execution/application/drive/taskDriveTypes'
import {
  TASK_ENGINE_KINDS,
  type TaskEngine,
  type TaskEngineKind,
} from '../src/modules/task-execution/domain/taskEngine'
import {
  ClosedTaskEngineRegistry,
  resolveTaskEngineSelection,
} from '../src/modules/task-execution/engine/task/taskEngineRegistry'
import type { TaskDriveRuntimeOptions } from '../src/modules/task-execution/public/commands'
import {
  createNoopTaskDriveCoordinator,
  createPoisonTaskDriveCoordinator,
  createRecordingTaskDriveCoordinator,
} from './helpers/taskDriveTestApplication'
import { TASK_SERVICE_SUCCESSORS, readTaskServiceSuccessors } from './helpers/taskServiceSuccessors'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8')
}

// RFC-478: services/task.ts is gone; the files that inherited its content are scanned instead.
function taskDriveRequests(method: 'drive' | 'kick'): readonly ts.ObjectLiteralExpression[] {
  return TASK_SERVICE_SUCCESSORS.flatMap((rel) =>
    driveRequestsIn(`packages/backend/src/${rel}`, method),
  )
}

function driveRequestsIn(
  path: string,
  method: 'drive' | 'kick',
): readonly ts.ObjectLiteralExpression[] {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true)
  const requests: ts.ObjectLiteralExpression[] = []
  const visit = (node: ts.Node): void => {
    const firstArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method &&
      /schedulerDriver$/.test(node.expression.expression.getText(file)) &&
      firstArgument !== undefined &&
      ts.isObjectLiteralExpression(firstArgument)
    ) {
      requests.push(firstArgument)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return requests
}

function fakeEngine(kind: TaskEngineKind): TaskEngine {
  return {
    kind,
    async drive() {
      return { kind: 'ok' }
    },
  }
}

describe('RFC-332 T3-T4 — additive drive and engine contracts', () => {
  test('submission has exactly three durable fields and rejects blank ids', () => {
    const submission = taskDriveSubmission({
      taskId: 'task-1',
      intentId: 'intent-1',
      completionMode: 'background',
    })
    expect(Object.keys(submission).sort()).toEqual(['completionMode', 'intentId', 'taskId'])
    expect(Object.isFrozen(submission)).toBe(true)
    expect(() => taskDriveSubmission({ ...submission, taskId: '' })).toThrow(
      'task drive submission requires taskId',
    )
    expect(() => taskDriveSubmission({ ...submission, intentId: '' })).toThrow(
      'task drive submission requires intentId',
    )
  })

  test('resolved runtime is one frozen instance snapshot', () => {
    const sourceOptions: TaskDriveRuntimeOptions = {
      appHome: '/tmp/rfc332',
      binaryOverride: ['bun', 'run'],
      maxConcurrentNodes: 7,
    }
    const resolved = resolveTaskDriveConfig(sourceOptions)
    expect(resolved).toEqual({
      appHome: '/tmp/rfc332',
      runtime: { binaryOverride: ['bun', 'run'], maxConcurrentNodes: 7 },
      ensureWorkspaceProfiles: false,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.runtime)).toBe(true)
    expect(resolveTaskDriveConfig({ appHome: '/tmp/rfc332' }).ensureWorkspaceProfiles).toBe(false)
    expect(() => resolveTaskDriveConfig({ appHome: '' })).toThrow(
      'task drive config requires appHome',
    )
  })

  test('recording/no-op/poison coordinators are explicit and instance-local', async () => {
    const first = createRecordingTaskDriveCoordinator()
    const second = createRecordingTaskDriveCoordinator((input) => ({
      kind: 'settled',
      taskId: input.taskId,
    }))
    const submission = taskDriveSubmission({
      taskId: 'task-1',
      intentId: 'intent-1',
      completionMode: 'await-settle',
    })
    await expect(first.coordinator.submit(submission)).resolves.toEqual({
      kind: 'accepted',
      taskId: 'task-1',
    })
    await expect(second.coordinator.submit(submission)).resolves.toEqual({
      kind: 'settled',
      taskId: 'task-1',
    })
    expect(first.submissions).toEqual([submission])
    expect(second.submissions).toEqual([submission])
    await expect(createNoopTaskDriveCoordinator().submit(submission)).resolves.toEqual({
      kind: 'not-attached',
      taskId: 'task-1',
    })
    await expect(
      createPoisonTaskDriveCoordinator('rfc332-poison').submit(submission),
    ).rejects.toThrow('rfc332-poison')
  })

  test('registry is exactly dag/workgroup-turns/dw-generate', () => {
    const engines = Object.fromEntries(
      TASK_ENGINE_KINDS.map((kind) => [kind, fakeEngine(kind)]),
    ) as Record<TaskEngineKind, TaskEngine>
    const registry = new ClosedTaskEngineRegistry(engines)
    expect(TASK_ENGINE_KINDS).toEqual(['dag', 'workgroup-turns', 'dw-generate'])
    for (const kind of TASK_ENGINE_KINDS) expect(registry.resolve(kind)).toBe(engines[kind])

    expect(
      () =>
        new ClosedTaskEngineRegistry({
          ...engines,
          'code-round': fakeEngine('dag'),
        } as unknown as Record<TaskEngineKind, TaskEngine>),
    ).toThrow('task-engine-registry-keys')
    expect(
      () =>
        new ClosedTaskEngineRegistry({
          ...engines,
          dag: fakeEngine('dw-generate'),
        }),
    ).toThrow('task-engine-registry-kind-mismatch:dag')
  })

  test('public task-drive contract does not expose command/runtime bags', () => {
    const contract = source(
      'packages/backend/src/modules/task-execution/application/drive/taskDriveTypes.ts',
    )
    const ports = source(
      'packages/backend/src/modules/task-execution/application/ports/taskEngine.ts',
    )
    expect(contract).not.toMatch(
      /\b(?:DbClient|AbortController|TaskContinuationDependencies|SchedulerState)\b/,
    )
    expect(ports).not.toMatch(/\b(?:DbClient|TaskContinuationDependencies|SchedulerState)\b/)
    expect(ports).not.toContain('Record<string, (...args:')
  })
})

describe('RFC-332 T10-T13 — single-consumer production cutover', () => {
  test('the production drive converges on one TaskEngine adapter assembled in bootstrap', () => {
    const task = readTaskServiceSuccessors()
    expect(taskDriveRequests('kick')).toHaveLength(0)
    expect(taskDriveRequests('drive')).toHaveLength(0)
    // RFC-332 converged the command admissions and RFC-333's post-commit wake on one coordinator
    // factory; RFC-359 AC-1 and RFC-395 II-pre retired the old admissions. RFC-424 moved the remaining
    // test-only continuations and the wake to tests/helpers: production assembles the factory once, in
    // bootstrap, and services/task.ts assembled none (RFC-478: nor do the files that inherited its content).
    expect(task).not.toContain('createTaskDriveCoordinatorFactory')
    expect(task).not.toContain('wakeHumanGateContinuation')
    const bundle = source('packages/backend/src/bootstrap/daemonModules/taskExecution.ts')
    expect(bundle.match(/createTaskDriveCoordinatorFactory\(\{/g)).toHaveLength(1)
    const factory = source(
      'packages/backend/src/modules/task-execution/application/drive/taskDriveCoordinatorFactory.ts',
    )
    expect(factory.match(/new DefaultTaskDriveCoordinator\(/g)).toHaveLength(1)
    expect(factory).toContain('...context.runtime.runtime,')
  })

  test('boot recovery delegates repository preparation without querying prep rows', () => {
    const boot = source('packages/backend/src/modules/task-execution/composition/taskAutoResume.ts')
    expect(boot).toContain('retryRepoPrep: (taskId) => input.repositoryPreparation.retry(taskId)')
    expect(boot).not.toContain('eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)')
    expect(boot).not.toContain('retryNode(')
  })

  test('registry owner keeps the exact three-engine truth table', () => {
    const workgroupId = ulid()
    expect(
      resolveTaskEngineSelection({ subject: { kind: 'workflow', sourceId: 'authored' } }, null),
    ).toEqual({
      engine: 'dag',
      wgDispatch: null,
    })
    expect(
      resolveTaskEngineSelection(
        {
          subject: { kind: 'workgroup', sourceId: workgroupId },
          workgroupConfig: decodeTaskWorkgroupConfig(JSON.stringify({ mode: 'leader_worker' })),
        },
        null,
      ),
    ).toEqual({ engine: 'workgroup-turns', wgDispatch: 'turn-engine' })
    expect(
      resolveTaskEngineSelection(
        {
          subject: { kind: 'workgroup', sourceId: workgroupId },
          workgroupConfig: decodeTaskWorkgroupConfig(JSON.stringify({ mode: 'dynamic_workflow' })),
        },
        'awaiting_confirm',
      ),
    ).toEqual({ engine: 'dw-generate', wgDispatch: 'dw-generate' })
    expect(
      resolveTaskEngineSelection(
        {
          subject: { kind: 'workgroup', sourceId: workgroupId },
          workgroupConfig: decodeTaskWorkgroupConfig(JSON.stringify({ mode: 'dynamic_workflow' })),
        },
        'executing',
      ),
    ).toEqual({ engine: 'dag', wgDispatch: 'dw-execute' })
  })

  test('legacy scheduler has no task-level drive, scope, or frontier body', () => {
    // RFC-412: services/scheduler.ts is deleted; none of these bodies can live there.
    expect(() => source('packages/backend/src/services/scheduler.ts')).toThrow()
    const scheduler = ''
    // RFC-408: the task-level drive (the former orchestrator body) is the task control plane in
    // engine/task/runTask.ts; the composition only binds its ports.
    const orchestrator = source(
      'packages/backend/src/modules/task-execution/engine/task/runTask.ts',
    )
    const binding = source(
      'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts',
    )
    // RFC-409: the scope loop moved into the scope interpreter layer.
    const scope = source('packages/backend/src/modules/task-execution/engine/scope/runScope.ts')
    // RFC-408: the DAG structural graph moved to engine/scope/.
    const graph = source('packages/backend/src/modules/task-execution/engine/scope/dagGraph.ts')
    // RFC-409: the frontier moved into the scope interpreter layer.
    const frontier = source(
      'packages/backend/src/modules/task-execution/engine/scope/dagFrontier.ts',
    )
    expect(scheduler).not.toMatch(/\bfunction\s+runTaskInner\b/)
    expect(scheduler).not.toMatch(/\bfunction\s+runTaskWithTopology\b/)
    expect(scheduler).not.toMatch(/\bfunction\s+runScope\b/)
    expect(scheduler).not.toMatch(/\bfunction\s+deriveFrontier\b/)
    expect(scheduler).not.toMatch(/\bfunction\s+(?:buildScopeUpstreams|findScopeCycle)\b/)
    expect(orchestrator).toContain('export async function runTask<Admission>(')
    expect(binding).not.toMatch(/\bfunction\s+runTaskEngineOrchestratorInner\b/)
    expect(binding).toContain('runTask(createTaskRunPorts(opts, topology, runtimeComponents))')
    expect(scope).toContain('function runScope(')
    expect(graph).toContain('function buildScopeUpstreams(')
    expect(graph).toContain('function findScopeCycle(')
    expect(frontier).toContain('function deriveFrontier(')
  })
})

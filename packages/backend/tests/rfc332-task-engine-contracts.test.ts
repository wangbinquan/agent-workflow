// RFC-332 — TaskEngine contracts, single-consumer cutover and architecture locks.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { ulid } from 'ulid'
import { taskDriveSubmission } from '../src/modules/task-execution/public/commands'
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
import type { TaskDriveRuntimeOptions } from '../src/modules/task-execution/public/topology'
import {
  buildCanonicalArtifacts,
  hasScheduleTargetToken,
  targetContextFor,
  targetRemoveAfterWaveFor,
} from './architecture/rfc294Canonical'
import {
  createNoopTaskDriveCoordinator,
  createPoisonTaskDriveCoordinator,
  createRecordingTaskDriveCoordinator,
} from './helpers/taskDriveTestApplication'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8')
}

function taskDriveRequests(method: 'drive' | 'kick'): readonly ts.ObjectLiteralExpression[] {
  const path = 'packages/backend/src/services/task.ts'
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
      ensureWorkspaceProfiles: true,
    }
    const resolved = resolveTaskDriveConfig(sourceOptions)
    expect(resolved).toEqual({
      appHome: '/tmp/rfc332',
      runtime: { binaryOverride: ['bun', 'run'], maxConcurrentNodes: 7 },
      ensureWorkspaceProfiles: true,
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
    expect(contract).not.toMatch(/\b(?:DbClient|AbortController|StartTaskDeps|SchedulerState)\b/)
    expect(ports).not.toMatch(/\b(?:DbClient|StartTaskDeps|SchedulerState)\b/)
    expect(ports).not.toContain('Record<string, (...args:')
  })
})

describe('RFC-332 T10-T13 — single-consumer production cutover', () => {
  test('four admissions converge on one TaskEngine application adapter and no kick remains', () => {
    const task = source('packages/backend/src/services/task.ts')
    expect(taskDriveRequests('kick')).toHaveLength(0)
    expect(taskDriveRequests('drive')).toHaveLength(1)
    expect(task.match(/createTaskDriveCoordinator\(\{/g)).toHaveLength(4)
  })

  test('boot recovery delegates repository preparation without querying prep rows', () => {
    const boot = source('packages/backend/src/cli/start.ts')
    expect(boot).toContain('retryRepoPrep: async (taskId) =>')
    expect(boot).toContain('await retryRepositoryPreparation(db, taskId, resumeDeps)')
    expect(boot).not.toContain('eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)')
    expect(boot).not.toContain('await retryNode(db, taskId, latest.id')
  })

  test('registry owner keeps the exact three-engine truth table', () => {
    const workgroupId = ulid()
    expect(resolveTaskEngineSelection({ workgroupId: null }, null)).toEqual({
      engine: 'dag',
      wgDispatch: null,
    })
    expect(
      resolveTaskEngineSelection(
        { workgroupId, workgroupConfigJson: JSON.stringify({ mode: 'leader_worker' }) },
        null,
      ),
    ).toEqual({ engine: 'workgroup-turns', wgDispatch: 'turn-engine' })
    expect(
      resolveTaskEngineSelection(
        { workgroupId, workgroupConfigJson: JSON.stringify({ mode: 'dynamic_workflow' }) },
        'awaiting_confirm',
      ),
    ).toEqual({ engine: 'dw-generate', wgDispatch: 'dw-generate' })
    expect(
      resolveTaskEngineSelection(
        { workgroupId, workgroupConfigJson: JSON.stringify({ mode: 'dynamic_workflow' }) },
        'executing',
      ),
    ).toEqual({ engine: 'dag', wgDispatch: 'dw-execute' })
  })

  test('legacy scheduler has no task-level drive, scope, or frontier body', () => {
    const scheduler = source('packages/backend/src/services/scheduler.ts')
    const orchestrator = source(
      'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts',
    )
    const scope = source('packages/backend/src/modules/task-execution/composition/taskDagScope.ts')
    const graph = source('packages/backend/src/modules/task-execution/composition/taskDagGraph.ts')
    const frontier = source(
      'packages/backend/src/modules/task-execution/composition/dagFrontier.ts',
    )
    expect(scheduler).not.toMatch(/\bfunction\s+runTaskInner\b/)
    expect(scheduler).not.toMatch(/\bfunction\s+runTaskWithTopology\b/)
    expect(scheduler).not.toMatch(/\bfunction\s+runScope\b/)
    expect(scheduler).not.toMatch(/\bfunction\s+deriveFrontier\b/)
    expect(scheduler).not.toMatch(/\bfunction\s+(?:buildScopeUpstreams|findScopeCycle)\b/)
    expect(orchestrator).toContain('function runTaskEngineOrchestratorInner(')
    expect(scope).toContain('function runScope(')
    expect(graph).toContain('function buildScopeUpstreams(')
    expect(graph).toContain('function findScopeCycle(')
    expect(frontier).toContain('function deriveFrontier(')
  })
})

describe('RFC-332 T6 — canonical scheduler token and wave projection', () => {
  test('schedule is a semantic token; scheduler is not', () => {
    expect(hasScheduleTargetToken('packages/backend/src/services/scheduleLaunch.ts')).toBe(true)
    expect(hasScheduleTargetToken('packages/backend/src/services/tasks.ts', 'scheduledTask')).toBe(
      true,
    )
    expect(hasScheduleTargetToken('packages/backend/src/services/scheduler.ts')).toBe(false)
    expect(targetContextFor('packages/backend/src/services/scheduler.ts', 'runTaskInner')).toBe(
      'task-execution',
    )
    expect(
      targetContextFor('packages/backend/src/services/scheduleLaunch.ts', 'launchSchedule'),
    ).toBe('integration')
  })

  test('scheduler key symbols project to their exact W2 removal wave', () => {
    const path = 'packages/backend/src/services/scheduler.ts'
    expect(targetRemoveAfterWaveFor(path, 'runTaskInner')).toBe('W2-B')
    expect(targetRemoveAfterWaveFor(path, 'runScope')).toBe('W2-B')
    expect(targetRemoveAfterWaveFor(path, 'deriveFrontier')).toBe('W2-B')
    expect(targetRemoveAfterWaveFor(path, 'buildWorkgroupHooks')).toBe('W2-C')
    expect(targetRemoveAfterWaveFor(path, 'runOneNode')).toBe('W2-C')
    expect(targetRemoveAfterWaveFor(path, 'runWrapperNode')).toBe('W2-D')
    expect(targetRemoveAfterWaveFor(path, 'replayPendingMerges')).toBe('W2-D')
    expect(targetRemoveAfterWaveFor(path, 'emitStatus')).toBe('W3')
    expect(targetRemoveAfterWaveFor(path, 'maybeRunCommitPush')).toBe('W5')
  })

  // This is the same source-complete canonical inventory build guarded by the
  // RFC-294/RFC-328 60s budgets. Keep the full corpus oracle, but do not cap it
  // at 15s while the macOS shard is running the rest of the backend suite.
  test('compatibility exceptions carry their exact owner wave and RFC provenance', () => {
    const artifacts = buildCanonicalArtifacts(REPO_ROOT)
    const exceptions = artifacts.crossContextImports['architectureExceptions'] as Array<
      Record<string, unknown>
    >
    const bridge = (fromFile: string, toSymbol: string): Record<string, unknown> | undefined =>
      exceptions.find((entry) => entry.fromPath === fromFile && entry.toSymbol === toSymbol)

    const scope = 'packages/backend/src/modules/task-execution/composition/taskDagScope.ts'
    const application =
      'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts'
    expect(bridge(scope, 'runOneNode')).toMatchObject({
      introducedByRFC: 'RFC-332',
      removeAfterWave: 'W2-C',
    })
    expect(bridge(application, 'replayPendingMerges')).toMatchObject({
      introducedByRFC: 'RFC-332',
      removeAfterWave: 'W2-D',
    })
    expect(bridge(application, 'emitStatus')).toMatchObject({
      introducedByRFC: 'RFC-332',
      removeAfterWave: 'W3',
    })
    expect(bridge(scope, 'maybeRunCommitPush')).toMatchObject({
      introducedByRFC: 'RFC-332',
      removeAfterWave: 'W5',
    })
    expect(
      bridge('packages/backend/src/services/startTaskDeps.ts', 'driveTaskEngineApplication'),
    ).toMatchObject({ introducedByRFC: 'RFC-332', removeAfterWave: 'W2-D' })
    expect(
      exceptions.find(
        (entry) =>
          entry.fromPath === 'packages/backend/src/services/task.ts' &&
          entry.toPath ===
            'packages/backend/src/modules/task-execution/composition/taskDriveLegacy.ts',
      ),
    ).toMatchObject({ introducedByRFC: 'RFC-332', removeAfterWave: 'W4' })

    const reportMetrics = artifacts.report['metrics'] as Record<string, unknown>
    const valueSccs = reportMetrics['backendValueSccs'] as string[][]
    expect(
      valueSccs.some((component) =>
        component.some((file) => file.includes('/modules/task-execution/')),
      ),
    ).toBe(false)
  }, 60_000)
})

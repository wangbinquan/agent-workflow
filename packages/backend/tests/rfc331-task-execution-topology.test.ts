// RFC-331 — topology cut behavior and architecture ratchets.
// Functionality only: these tests lock request shape, status/call-graph parity,
// explicit fixture topology and the three dependency cuts.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createSqliteTaskExecutionReadModels } from '../src/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels'
import type { SchedulerDriverPort } from '../src/modules/task-execution/public/commands'
import { getCallTargets } from '../src/services/structuralDiff/callGraph/expandService'
import { backendUnits, importEdges, sourceUnit, type SourceUnit } from './architecture/census'
import {
  createNoopSchedulerDriver,
  createPoisonSchedulerDriver,
  createRecordingSchedulerDriver,
} from './helpers/taskExecutionTestTopology'

type TaskDriveRequest = Parameters<SchedulerDriverPort['drive']>[0]

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8')
}

const RFC331_LEGACY_CONSUMERS = new Set([
  'packages/backend/src/cli/start.ts',
  'packages/backend/src/routes/clarify.ts',
  'packages/backend/src/routes/reviews.ts',
  'packages/backend/src/routes/taskQuestions.ts',
  'packages/backend/src/routes/tasks.ts',
  'packages/backend/src/services/autoRepair.ts',
  'packages/backend/src/services/fusion.ts',
  'packages/backend/src/services/multipartTaskStart.ts',
  'packages/backend/src/services/scheduler.ts',
  'packages/backend/src/services/startTaskDeps.ts',
  'packages/backend/src/services/structuralDiff/callGraph/expandService.ts',
  'packages/backend/src/services/task.ts',
  'packages/backend/src/services/workgroup/taskActions.ts',
])

const REGISTERED_PREEXISTING_DEEP_IMPORTS = new Set([
  'packages/backend/src/cli/start.ts:@/modules/task-execution/infrastructure/sqliteTaskLifecycleEventPublisher',
  // RFC-334 moved activation behind the node execution gateway; the scheduler
  // deep import is intentionally extinct rather than transferred to a new legacy consumer.
  'packages/backend/src/services/task.ts:@/modules/task-execution/application/branchTrace',
])

function legacyDeepImports(units: readonly SourceUnit[]): string[] {
  const imports: string[] = []
  for (const unit of units) {
    if (!RFC331_LEGACY_CONSUMERS.has(unit.path)) continue
    for (const edge of importEdges(unit)) {
      if (
        /^@\/modules\/task-execution\/(?:application|infrastructure)(?:\/|$)/.test(edge.specifier)
      ) {
        imports.push(`${unit.path}:${edge.specifier}`)
      }
    }
  }
  return imports.sort()
}

function topologyBoundaryViolations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  for (const unit of units) {
    for (const edge of importEdges(unit)) {
      const target = edge.specifier
      if (
        unit.path === 'packages/backend/src/services/task.ts' &&
        /(?:^@\/services\/scheduler$|(?:^|\/)scheduler$)/.test(target)
      ) {
        violations.push(`task-to-scheduler:${edge.syntax}`)
      }
      if (
        unit.path === 'packages/backend/src/services/scheduler.ts' &&
        /(?:^@\/services\/task$|(?:^|\/)task$)/.test(target)
      ) {
        violations.push(`scheduler-to-task:${edge.syntax}`)
      }
      if (
        unit.path === 'packages/backend/src/services/structuralDiff/callGraph/expandService.ts' &&
        /(?:^@\/services\/task$|(?:^|\/)task$)/.test(target)
      ) {
        violations.push(`callgraph-to-task:${edge.syntax}`)
      }
      if (
        RFC331_LEGACY_CONSUMERS.has(unit.path) &&
        /^@\/modules\/task-execution\/(?:application|infrastructure)(?:\/|$)/.test(target)
      ) {
        const key = `${unit.path}:${target}`
        if (!REGISTERED_PREEXISTING_DEEP_IMPORTS.has(key)) {
          violations.push(`legacy-deep-import:${key}`)
        }
      }
      if (target.includes('tests/helpers/taskExecutionTestTopology')) {
        violations.push(`production-test-topology:${unit.path}`)
      }
    }
  }
  return violations.sort()
}

function objectKeys(node: ts.ObjectLiteralExpression, file: ts.SourceFile): Set<string> {
  const keys = new Set<string>()
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) continue
    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)
    ) {
      keys.add(property.name.getText(file).replace(/^['"]|['"]$/g, ''))
    }
  }
  return keys
}

function driveRequestObjects(): Array<Set<string>> {
  const path = 'packages/backend/src/services/task.ts'
  const text = source(path)
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const requests: Array<Set<string>> = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'drive' &&
      /schedulerDriver$/.test(node.expression.expression.getText(file)) &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      requests.push(objectKeys(node.arguments[0], file))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return requests
}

describe('RFC-331 scheduler topology contract', () => {
  test('recording/no-op/poison drivers are instance-local and explicit', async () => {
    const recording = createRecordingSchedulerDriver((taskId) => taskId === 'active-child')
    const request = {
      taskId: 'root',
      appHome: '/tmp/rfc331',
      signal: new AbortController().signal,
      executionContext: {} as TaskDriveRequest['executionContext'],
    } satisfies TaskDriveRequest
    await recording.driver.drive(request)
    await recording.driver.cancelChild({ taskId: 'cancel-child', cascadeFromParent: true })
    await recording.driver.resumeChild({
      taskId: 'resume-child',
      runtime: { runConfig: { appHome: '/tmp/rfc331' } },
    })
    expect(recording.driver.isTaskActive('active-child')).toBe(true)
    expect(recording.kicks).toEqual([request])
    expect(recording.cancellations).toEqual([{ taskId: 'cancel-child', cascadeFromParent: true }])
    expect(recording.resumptions.map((item) => item.taskId)).toEqual(['resume-child'])
    expect(recording.activeChecks).toEqual(['active-child'])

    const noop = createNoopSchedulerDriver()
    await expect(noop.drive(request)).resolves.toBeUndefined()
    expect(noop.isTaskActive('anything')).toBe(false)
    const poison = createPoisonSchedulerDriver('rfc331-poison')
    await expect(poison.drive(request)).rejects.toThrow('rfc331-poison')
    expect(() => poison.isTaskActive('anything')).toThrow('rfc331-poison')
  })

  test('the single TaskEngine application adapter carries the required envelope and never leaks db', () => {
    const requests = driveRequestObjects()
    expect(requests).toHaveLength(1)
    for (const keys of requests) {
      expect([...keys].sort()).toEqual(
        expect.arrayContaining(['appHome', 'executionContext', 'signal', 'taskId']),
      )
      expect(keys.has('db')).toBe(false)
    }
    const task = source('packages/backend/src/services/task.ts')
    expect(task).toContain("schedulerDriver: Pick<SchedulerDriverPort, 'drive'>")
    expect(task).not.toContain('schedulerDriver?:')
  })
})

describe('RFC-331 purpose-specific read models', () => {
  test('status projection and legacy single-repo fallback preserve the old read shape', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(workflows).values({
      id: 'wf-rfc331',
      name: 'wf-rfc331',
      definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
      description: '',
      version: 1,
      schemaVersion: 3,
    })
    await db.insert(tasks).values({
      id: 'task-rfc331',
      name: 'task-rfc331',
      workflowId: 'wf-rfc331',
      workflowSnapshot: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
      repoPath: '/tmp/rfc331/repo',
      worktreePath: '/tmp/rfc331/worktree',
      baseBranch: 'main',
      branch: 'agent-workflow/task-rfc331',
      status: 'failed',
      errorSummary: 'fixture-error',
      inputs: '{}',
      startedAt: Date.now(),
    })

    const reads = createSqliteTaskExecutionReadModels(db)
    expect(await reads.statusProjection.find('task-rfc331')).toEqual({
      taskId: 'task-rfc331',
      status: 'failed',
      errorSummary: 'fixture-error',
    })
    expect(await reads.callGraphWorkspace.find('task-rfc331')).toEqual({
      taskId: 'task-rfc331',
      worktreePath: '/tmp/rfc331/worktree',
      repos: [{ worktreeDirName: '', worktreePath: '/tmp/rfc331/worktree' }],
    })
    expect(await reads.statusProjection.find('missing')).toBeNull()
    expect(await reads.callGraphWorkspace.find('missing')).toBeNull()
    db.$client.close()
  })

  test('call-graph keeps task-missing first and multi-repo unresolved behavior', async () => {
    await expect(
      getCallTargets({ find: async () => null }, 'missing', 'src/A.ts#A.run'),
    ).rejects.toMatchObject({ code: 'task-not-found', status: 404 })

    await expect(
      getCallTargets(
        {
          find: async () => ({
            taskId: 'multi',
            worktreePath: '/unused',
            repos: [
              { worktreeDirName: 'a', worktreePath: '/unused/a' },
              { worktreeDirName: 'b', worktreePath: '/unused/b' },
            ],
          }),
        },
        'multi',
        'c/src/A.ts#A.run',
      ),
    ).rejects.toMatchObject({ code: 'call-target-repo-unresolved', status: 404 })
  })
})

describe('RFC-331 architecture cuts', () => {
  test('production corpus has all three cuts, public-only consumers and no test topology import', () => {
    const units = backendUnits(REPO_ROOT)
    expect(units.length).toBeGreaterThan(800)
    expect(
      [...RFC331_LEGACY_CONSUMERS].every((path) => units.some((unit) => unit.path === path)),
    ).toBe(true)
    expect(legacyDeepImports(units)).toEqual([...REGISTERED_PREEXISTING_DEEP_IMPORTS].sort())
    expect(topologyBoundaryViolations(units)).toEqual([])
  })

  test('each forbidden edge has an independent negative fixture', () => {
    const mutations = [
      sourceUnit(
        'packages/backend/src/services/task.ts',
        "import { runTaskWithTopology } from '@/services/scheduler'\n",
      ),
      sourceUnit(
        'packages/backend/src/services/scheduler.ts',
        "const task = await import('@/services/task')\n",
      ),
      sourceUnit(
        'packages/backend/src/services/structuralDiff/callGraph/expandService.ts',
        "import type { Task } from '@/services/task'\n",
      ),
      sourceUnit(
        'packages/backend/src/services/startTaskDeps.ts',
        "import { createSqliteTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels'\n",
      ),
      sourceUnit(
        'packages/backend/src/services/task.ts',
        "import { createTaskExecutionTestTopology } from '../../tests/helpers/taskExecutionTestTopology'\n",
      ),
    ]
    expect(mutations.map((unit) => topologyBoundaryViolations([unit]))).toEqual([
      ['task-to-scheduler:static-import'],
      ['scheduler-to-task:dynamic-import'],
      ['callgraph-to-task:static-import'],
      [
        'legacy-deep-import:packages/backend/src/services/startTaskDeps.ts:@/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels',
      ],
      ['production-test-topology:packages/backend/src/services/task.ts'],
    ])
  })

  test('direct scheduler fixtures use the explicit test topology entry', () => {
    const testUnits = source('packages/backend/tests/helpers/taskExecutionTestTopology.ts')
    expect(testUnits).toContain('runTaskWithRealTestTopology')
    expect(source('packages/backend/src/services/scheduler.ts')).not.toContain(
      'createLegacySchedulerTestTopology',
    )
  })

  test('ephemeral status publisher cannot create a second durable event path', () => {
    const unit = sourceUnit(
      'packages/backend/src/modules/task-execution/infrastructure/webSocketTaskStatusPublisher.ts',
      source(
        'packages/backend/src/modules/task-execution/infrastructure/webSocketTaskStatusPublisher.ts',
      ),
    )
    const specifiers = importEdges(unit).map((edge) => edge.specifier)
    expect(specifiers).toContain('@/ws/broadcaster')
    expect(specifiers.some((value) => /outbox|lifecycleEvent|event-center|db\//i.test(value))).toBe(
      false,
    )
  })
})

// RFC-382: exercise the real session graph on both databases, including pre-fix controls.

import { agentFixture } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { WorkflowDefinitionSchema, type Config } from '@agent-workflow/shared'
import { actorOfDirectAuthority } from '@/auth/session'
import { borrowedPostgresqlWorkspace } from '@/modules/task-execution/composition/actionExecutionEnvironment'
import { validateWorkflowDef } from '@/modules/resource-catalog/infrastructure/legacy/workflow.validator'
import * as deferredPreparation from '@/modules/task-execution/composition/deferredRepositoryPreparation'
import { describeEachProvider } from './helpers/eachProvider'
import { taskBundleInput, seedBundleTask, emptyWorkflow } from './helpers/daemonTaskExecutionBundle'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

const homes: string[] = []
function home() {
  const value = mkdtempSync(join(tmpdir(), 'rfc382-task-'))
  homes.push(value)
  return value
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
const changed: Partial<Config> = {
  defaultRuntime: 'runtime-after',
  commitPushModel: 'commit-after',
  commitPushRuntime: 'commit-runtime-after',
  commitPushMaxRepairRetries: 4,
  commitPushDiffMaxBytes: 4321,
  taskCommitExcludePatterns: ['after/**'],
  commitPushLang: 'zh-CN',
  mergeAgentModel: 'merge-after',
  mergeAgentRuntime: 'merge-runtime-after',
  maxConcurrentNodes: 7,
  subagentLiveCapture: { pollMs: 100, consecutiveFailureLimit: 3 },
  gitCloneTimeoutMs: 12345,
  gitBaselineSyncWindowMs: 23456,
}
const projected = {
  defaultRuntime: changed.defaultRuntime,
  commitPushModel: changed.commitPushModel,
  commitPushRuntime: changed.commitPushRuntime,
  commitPushMaxRepairRetries: 4,
  commitPushDiffMaxBytes: 4321,
  commitPushExcludePatterns: ['after/**'],
  commitPushLang: 'zh-CN',
  mergeAgentModel: 'merge-after',
  mergeAgentRuntime: 'merge-runtime-after',
  maxConcurrentNodes: 7,
  subagentLiveCapture: { pollMs: 100, consecutiveFailureLimit: 3 },
}

describeEachProvider('RFC-382 session task execution bundle', (harness) => {
  test('construction is passive, outputs are complete and frozen, session state is owned once', () => {
    const fixture = taskBundleInput(harness, home())
    const statements = harness.recordStatements()
    const interval = spyOn(globalThis, 'setInterval')
    const timeout = spyOn(globalThis, 'setTimeout')
    try {
      const first = fixture.compose(),
        second = fixture.compose()
      expect(statements.statements).toHaveLength(0)
      expect(interval).not.toHaveBeenCalled()
      expect(timeout).not.toHaveBeenCalled()
      expect(Object.isFrozen(first)).toBe(true)
      for (const key of [
        'persistence',
        'resources',
        'resourceSnapshots',
        'routeLaunch',
        'routes',
        'launches',
        'trigger',
        'overview',
        'workgroupTaskRoom',
        'collaboration',
        'coordinator',
        'runConfiguration',
        'activeTaskIds',
        'isTaskActive',
        'background',
      ]) {
        expect(first).toHaveProperty(key)
      }
      expect(first.coordinator).not.toBe(second.coordinator)
      expect(first.persistence).not.toBe(second.persistence)
      expect(first.background).not.toBe(second.background)
      expect(first.repositoryPreparationRetry).not.toBe(second.repositoryPreparationRetry)
      expect(first.readModels).toBe(first.persistence.reads)
      // SQLite's existing process singleton is deliberately retained; PG owns a module per session.
      if (harness.capabilities.isolation !== 'exclusive') {
        expect(first.executionModule).not.toBe(second.executionModule)
        expect(first.executionModule.runtimeRegistry).not.toBe(
          second.executionModule.runtimeRegistry,
        )
      }
    } finally {
      statements.stop()
      interval.mockRestore()
      timeout.mockRestore()
    }
  })

  for (const mode of ['local-sync', 'selected'] as const) {
    test(`${mode}: next submission refreshes capture, clone timeout and baseline window at deferred preparation`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome, mode),
        bundle = fixture.compose()
      const preparation = spyOn(deferredPreparation, 'composeDeferredRepositoryPreparation')
      try {
        for (const [capture, clone, window] of [
          [{ pollMs: 100, consecutiveFailureLimit: 3 }, 12345, 23456],
          [{ pollMs: 250, consecutiveFailureLimit: 5 }, 9876, 8765],
        ] as const) {
          fixture.update({
            subagentLiveCapture: capture,
            gitCloneTimeoutMs: clone,
            gitBaselineSyncWindowMs: window,
          })
          const seeded = await seedBundleTask(harness, appHome)
          await bundle.coordinator.submit({
            taskId: seeded.taskId,
            intentId: seeded.intentId,
            completionMode: 'await-settle',
          })
          expect(preparation.mock.calls.at(-1)![0]).toMatchObject({
            cloneTimeoutMs: clone,
            gitBaselineSyncWindowMs: window,
          })
          expect(fixture.driven.at(-1)).toMatchObject({ subagentLiveCapture: capture })
        }
        expect(preparation).toHaveBeenCalledTimes(2)
      } finally {
        preparation.mockRestore()
      }
    })
    test(`${mode}: coordinator, automatic resume, lifecycle repair and host kernel use fresh projected settings and distill`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome, mode),
        bundle = fixture.compose()
      fixture.update(changed)
      const launch = await seedBundleTask(harness, appHome)
      await bundle.coordinator.submit({
        taskId: launch.taskId,
        intentId: launch.intentId,
        completionMode: 'await-settle',
      })
      const auto = await seedBundleTask(harness, appHome, 'interrupted', false)
      const resumed = await bundle.autoResume.run({
        taskIds: [auto.taskId],
        breaker: { maxPerWindow: 10, windowMs: 60000 },
      })
      expect(resumed.resumed).toContain(auto.taskId)
      await fixture.waitForDrive(2)
      await bundle.executionModule.runtimeRegistry.awaitReleasedSettled(auto.taskId)
      const repair = await seedBundleTask(harness, appHome, 'pending', false)
      const { lifecycleAlerts } = tablesOf(harness.db)
      await insertOne(harness.db, lifecycleAlerts, {
        id: ulid(),
        taskId: repair.taskId,
        rule: 'S4',
        severity: 'warning',
        detail: JSON.stringify({ pendingMs: 600000 }),
        detectedAt: Date.now() - 60000,
      })
      const repaired = await bundle.lifecycleRepair.run({
        enabledRules: ['S4'],
        maxPerWindow: 10,
        windowMs: 60000,
      })
      expect(
        repaired.repaired.some((row) => row.taskId === repair.taskId && row.outcome === 'success'),
      ).toBe(true)
      await fixture.waitForDrive(3)
      await bundle.executionModule.runtimeRegistry.awaitReleasedSettled(repair.taskId)
      const authority = await admitTestDirectAuthority(fixture.identityAccess.directAuthority, {
        source: 'daemon',
      })
      if (authority === null) throw new Error('daemon authority missing')
      const actor = actorOfDirectAuthority(authority)
      const host = await bundle.routeLaunch.workflow.launch({
        actor,
        resourceAuthority: { actor, authority: authority.authority, resources: bundle.resources },
        invoker: { type: 'user', launchKind: 'direct-json' },
        task: { name: 'host', inputs: {} },
        subject: {
          subject: { kind: 'workflow' as const, sourceId: launch.workflowId },
          workflowName: launch.workflowId,
          builtin: false,
          workflowVersion: 1,
          workflowSnapshot: WorkflowDefinitionSchema.parse(emptyWorkflow),
        },
        internal: {
          workspace: borrowedPostgresqlWorkspace({
            workspacePath: appHome,
            baselineSha: 'a'.repeat(40),
          }),
        },
      })
      await fixture.waitForDrive(4)
      await bundle.executionModule.runtimeRegistry.awaitReleasedSettled(host.id)
      expect(fixture.driven).toHaveLength(4)
      for (const request of fixture.driven) {
        expect(request).toMatchObject(projected)
        expect(request).not.toHaveProperty('commitPush')
        expect(request).not.toHaveProperty('mergeAgent')
        expect(request.agentRunSettled).toBeDefined()
        await request.agentRunSettled!.onAgentRunSettled({
          taskId: request.taskId,
          nodeRunId: ulid(),
          nodeId: 'agent',
          status: 'done',
        })
      }
      expect(fixture.distillRequests).toHaveLength(4)
      expect(await bundle.runConfiguration()).toMatchObject({
        ...projected,
        cloneTimeoutMs: 12345,
        gitBaselineSyncWindowMs: 23456,
      })
      fixture.update({
        subagentLiveCapture: { pollMs: 250, consecutiveFailureLimit: 5 },
        gitCloneTimeoutMs: 9876,
        gitBaselineSyncWindowMs: 8765,
      })
      expect(await bundle.runConfiguration()).toMatchObject({
        subagentLiveCapture: { pollMs: 250, consecutiveFailureLimit: 5 },
        cloneTimeoutMs: 9876,
        gitBaselineSyncWindowMs: 8765,
      })
    })
  }

  test('a thrown scheduler error fails task and claimed intent with its owner epoch', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome)
    fixture.schedulerDriver.drive = async () => {
      throw new Error('rfc382-engine-failure')
    }
    const bundle = fixture.compose(),
      seeded = await seedBundleTask(harness, appHome)
    await expect(
      bundle.coordinator.submit({
        taskId: seeded.taskId,
        intentId: seeded.intentId,
        completionMode: 'await-settle',
      }),
    ).rejects.toThrow('rfc382-engine-failure')
    expect(await seeded.row()).toMatchObject({
      status: 'failed',
      errorSummary: 'task drive failed',
      errorMessage: 'rfc382-engine-failure',
    })
    const { taskExecutionIntents } = tablesOf(harness.db)
    const [intent] = await harness.db
      .select()
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.id, seeded.intentId))
    expect(intent).toMatchObject({ state: 'failed', failureCode: 'task-drive-failed' })
    expect(intent!.claimedEpoch).toBeGreaterThan(0)
    expect(bundle.isTaskActive(seeded.taskId)).toBe(false)
  })

  test('live session registry drives maintenance inclusion and prune exclusion until settlement', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome)
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
        entered = resolve
      }),
      held = new Promise<void>((resolve) => {
        release = resolve
      })
    fixture.schedulerDriver.drive = async () => {
      entered()
      await held
    }
    const bundle = fixture.compose(),
      seeded = await seedBundleTask(harness, appHome)
    const running = bundle.coordinator.submit({
      taskId: seeded.taskId,
      intentId: seeded.intentId,
      completionMode: 'await-settle',
    })
    try {
      await ready
      expect(bundle.activeTaskIds()).toContain(seeded.taskId)
      expect(bundle.isTaskActive(seeded.taskId)).toBe(true)
      const source = readDaemonGraphSource()
      expect(source).toContain(
        'activeTaskIds: () => snapshotMaintenanceTaskIds(runtime.taskExecutionModules.activeTaskIds)',
      )
      expect(source).toContain('runtime.taskExecutionModules.isTaskActive(taskId)')
    } finally {
      release()
      await running
    }
    expect(bundle.activeTaskIds()).not.toContain(seeded.taskId)
    expect(bundle.isTaskActive(seeded.taskId)).toBe(false)
  })

  test('neutral dynamic validation accepts a built-in agent; the former PG catalog context rejects it', async () => {
    const fixture = taskBundleInput(harness, home()),
      bundle = fixture.compose(),
      id = ulid()
    await agentFixture(harness.db, {
      id,
      name: `builtin-${id}`,
      builtin: true,
      schemaVersion: 2,
      bodyMd: 'fixture',
    })
    const authority = await admitTestDirectAuthority(fixture.identityAccess.directAuthority, {
      source: 'daemon',
    })
    if (authority === null) throw new Error('daemon authority missing')
    const oldAgents = await fixture.resourceCatalog.agentCatalog.queries.list(authority.actor)
    const context = await bundle.validationContext.load()
    const definition = WorkflowDefinitionSchema.parse({
      $schema_version: 5,
      inputs: [],
      nodes: [{ id: 'a', kind: 'agent-single', agentId: id, agentName: `builtin-${id}` }],
      edges: [],
    })
    const oldResult = validateWorkflowDef(definition, { ...context, agents: [...oldAgents] })
    expect(oldAgents.some((agent) => agent.id === id)).toBe(false)
    expect(oldResult.issues.some((error) => error.code === 'agent-not-found')).toBe(true)
    const result = validateWorkflowDef(definition, context)
    expect(context.agents.some((agent) => agent.id === id)).toBe(true)
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  })
})

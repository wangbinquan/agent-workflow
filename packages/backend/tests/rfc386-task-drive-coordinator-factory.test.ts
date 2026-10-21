// RFC-386: real provider claims exercise shared profiles, live child settings and epoch-scoped failures.
// Former wiring controls preserve missing settings/profiles; current epoch wiring and an unscoped
// negative control distinguish existing behavior from the factory consolidation.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { DEFAULT_DISTILL_POLICY, type Config } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { composeDaemonTaskExecutionModules } from '@/bootstrap/daemonModules/taskExecution'
import { composeGateContinuationPreDrive } from '@/modules/task-execution/composition/gateContinuationPreDrive'
import {
  tasks,
  taskRepos,
  nodeRuns,
  taskExecutionIntents,
  memoryDistillJobs,
  users,
} from '@/db/schema'
import { createLogger } from '@/util/log'
import { gitDiffSnapshot } from '@/util/git'
import { bindWorkspaceExcludeParticipant } from '@/modules/source-control/composition'
import {
  setMemoryDistillPolicyProvider,
  resetMemoryDistillPolicyProviderForTest,
} from '@/modules/memory/application/distill/schedule'
import {
  createTaskDriveCoordinatorFactory,
  CHILD_LAUNCH_FAILURE,
  TASK_RESUME_FAILURE,
  type TaskDriveCoordinatorFactory,
} from '@/modules/task-execution/application/drive/taskDriveCoordinatorFactory'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '@/modules/task-execution/application/drive/taskDriveTypes'
import {
  pickInheritableRunConfig,
  type TaskDriveRuntimeOptions,
} from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  TASK_EXECUTION_INTENT_KINDS,
  shouldRebuildWorkspaceProfiles,
} from '@/modules/task-execution/domain/executionIntent'
import { ownershipTokenKey } from '@/modules/task-execution/domain/ownership'
import { createChildExecutionLaunchOperations } from '@/modules/task-execution/infrastructure/childExecutionLaunchOperations'
import {
  resumeTaskProjection,
  prepareResumeTaskProjection,
  drivePreparedTaskResume,
} from '@/modules/task-execution/infrastructure/childTaskLifecycleParticipant'
import { describeEachProvider, type ProviderDatabaseHarness } from './helpers/eachProvider'
import { taskBundleInput, seedBundleTask, emptyWorkflow } from './helpers/daemonTaskExecutionBundle'
import { composeTestChildLaunchWorkgroup } from './helpers/taskExecutionTestTopology'
import { mintSequenceRun } from './helpers/rfc374Fixtures'

type Bundle = ReturnType<ReturnType<typeof taskBundleInput>['compose']>
const homes: string[] = []
function home() {
  const path = mkdtempSync(join(tmpdir(), 'rfc386-'))
  homes.push(path)
  return path
}
afterEach(() => {
  resetMemoryDistillPolicyProviderForTest()
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
const settings: Partial<Config> = {
  commitPushModel: 'live-commit',
  commitPushRuntime: 'live-commit-runtime',
  mergeAgentModel: 'live-merge',
  mergeAgentRuntime: 'live-merge-runtime',
  commitPushLang: 'zh-CN',
  commitPushMaxRepairRetries: 7,
  commitPushDiffMaxBytes: 4321,
  taskCommitExcludePatterns: ['live/**'],
  defaultNodeRetries: 4,
}
const liveAgentSettings = {
  commitPushModel: 'live-commit',
  commitPushRuntime: 'live-commit-runtime',
  mergeAgentModel: 'live-merge',
  mergeAgentRuntime: 'live-merge-runtime',
  commitPushLang: 'zh-CN',
  commitPushMaxRepairRetries: 7,
  commitPushDiffMaxBytes: 4321,
}

// C11/C12 previously resolved only the parent picker. The real lifecycle and engine remain.
function formerChildFactory(bundle: Bundle): TaskDriveCoordinatorFactory {
  return {
    session: bundle.coordinator,
    coordinatorFor(profile) {
      if (!profile.runConfig || !profile.engine)
        throw new Error('former child fixture needs parent and engine')
      return new DefaultTaskDriveCoordinator({
        runtime: resolveTaskDriveConfig(pickInheritableRunConfig(profile.runConfig.parent)),
        lifecycle: bundle.driverLifecycle,
        admittedContinuation: profile.admittedContinuation,
        repositoryPreparation: skipRepositoryPreparation,
        engineOrchestrator: {
          drive: (context) =>
            profile.engine!.drive({
              taskId: context.taskId,
              appHome: context.runtime.appHome,
              ...context.runtime.runtime,
              signal: context.signal,
              executionContext: context.execution,
            }),
        },
        failureReporter: { report() {} },
      })
    },
  }
}
async function childRequest(harness: ProviderDatabaseHarness, appHome: string) {
  const parent = await seedBundleTask(harness, appHome, 'running', false)
  const childId = ulid(),
    userId = ulid()
  await harness.db.insert(users).values({
    id: userId,
    username: userId,
    displayName: userId,
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  await harness.db.update(tasks).set({ ownerUserId: userId }).where(eq(tasks.id, parent.taskId))
  const run = await mintSequenceRun(harness.db, parent.taskId, {
    nodeId: 'call',
    status: 'pending',
  })
  await harness.db
    .update(nodeRuns)
    .set({
      status: 'running',
      childTaskId: childId,
      continuationSlotKey: 'call:node',
      operationGeneration: 0,
    })
    .where(eq(nodeRuns.id, run))
  const parentConfig = pickInheritableRunConfig({
    appHome,
    daemonGeneration: 'parent-generation',
    defaultNodeRetries: 2,
    commitPushExcludePatterns: ['parent/**'],
  })
  return {
    actor: buildActor({
      user: { id: userId, username: userId, displayName: userId, role: 'admin', status: 'active' },
      source: 'session',
    }),
    parentTaskId: parent.taskId,
    parentNodeRunId: run,
    invocationDepth: 1,
    materializedSpace: {
      kind: 'single' as const,
      spaceKind: 'inherited' as const,
      taskId: childId,
      worktreePath: appHome,
      branch: childId,
      baseCommit: null,
      earlyError: null,
      resolvedSources: [
        {
          repoPath: appHome,
          baseBranch: 'main',
          repoUrl: null,
          cachedRepoId: null,
          pathFetchError: null,
          ffWarnings: [],
        },
      ],
      repos: [
        {
          repoIndex: 0,
          repoPath: appHome,
          repoUrl: null,
          cachedRepoId: null,
          baseBranch: 'main',
          branch: childId,
          baseCommit: null,
          worktreePath: appHome,
          worktreeDirName: '',
          mountPath: '',
          subdir: '',
          readonly: false,
          submoduleInitOk: true,
          submoduleInitError: null,
          hasSubmodules: false,
        },
      ],
      nodePaths: [],
      cleanup: {
        taskId: childId,
        ownedRoot: null,
        worktrees: [],
        state: 'owned' as const,
        report: null,
      },
    },
    runtime: { runConfig: parentConfig, actorUserId: userId },
    workflowId: parent.workflowId,
    frozenWorkflowVersion: 1,
    payload: { workflowId: parent.workflowId, name: 'child', inputs: {}, autoCommitPush: false },
    frozenSnapshotJson: JSON.stringify(emptyWorkflow),
    refClosureJson: null,
  }
}
function resumeDependencies(
  bundle: Bundle,
  fixture: ReturnType<typeof taskBundleInput>,
  factory = bundle.coordinatorFactory,
) {
  return {
    db: fixture.input.db,
    persistence: bundle.persistence,
    coordinatorFactory: factory,
    runtimeSessionLeases: fixture.input.observation.runtimeSessionLeases,
    workspacePresence: fixture.input.observation.workspacePresence,
    log: createLogger('rfc386'),
    activity: {
      isActive: bundle.isTaskActive,
      awaitReleasedSettled: (id: string) =>
        bundle.executionModule.runtimeRegistry.awaitReleasedSettled(id),
    },
  }
}

async function awaitDriverSettled(bundle: Bundle, taskId: string): Promise<void> {
  const registry = bundle.executionModule.runtimeRegistry
  const token = registry.tokenForTask(taskId)
  if (token !== null) {
    expect(
      await registry.awaitStopped({ token, tokenKey: ownershipTokenKey(token) }),
    ).toMatchObject({
      kind: 'released',
    })
  }
}

describeEachProvider('RFC-386 coordinator factory', (harness) => {
  test('passive factory shares lifecycle, gate/preparation, lazy engine and live configuration across session and profiles', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome),
      bundle = fixture.compose()
    const trace: string[] = []
    let live: TaskDriveRuntimeOptions = { appHome, defaultNodeRetries: 1, commitPushModel: 'first' }
    const statements = harness.recordStatements(),
      timer = spyOn(globalThis, 'setInterval')
    const factory = createTaskDriveCoordinatorFactory({
      runConfiguration: () => {
        trace.push('configuration')
        return live
      },
      lifecycle: {
        attach: (request) => {
          trace.push('attach')
          return bundle.driverLifecycle.attach(request)
        },
        releaseAndFinalize: (request) => {
          trace.push('release')
          return bundle.driverLifecycle.releaseAndFinalize(request)
        },
      },
      gateContinuationPreDrive: {
        async run() {
          trace.push('gate')
          return { kind: 'ready' }
        },
      },
      repositoryPreparation: {
        async run() {
          trace.push('preparation')
          return { kind: 'ready' }
        },
      },
      engine: () => {
        trace.push('engine')
        return fixture.schedulerDriver
      },
      failures: bundle.persistence,
      log: createLogger('rfc386'),
    })
    try {
      expect(Object.isFrozen(factory)).toBe(true)
      expect(statements.statements).toHaveLength(0)
      expect(timer).not.toHaveBeenCalled()
      expect(trace).toEqual([])
    } finally {
      statements.stop()
      timer.mockRestore()
    }
    for (const coordinator of [
      factory.session,
      factory.coordinatorFor({
        admittedContinuation: {
          async run() {
            trace.push('rollback')
            return { kind: 'ready' }
          },
        },
      }),
    ]) {
      const seeded = await seedBundleTask(harness, appHome)
      await coordinator.submit({ ...seeded, completionMode: 'await-settle' })
    }
    expect(trace).toEqual([
      'attach',
      'configuration',
      'gate',
      'preparation',
      'engine',
      'release',
      'attach',
      'configuration',
      'rollback',
      'gate',
      'preparation',
      'engine',
      'release',
    ])
    const inherited = factory.coordinatorFor({
      runConfig: {
        kind: 'inherit-parent',
        parent: {
          appHome,
          defaultNodeRetries: 9,
          commitPushModel: 'must-not-inherit',
        } as TaskDriveRuntimeOptions,
      },
      engine: fixture.schedulerDriver,
    })
    live = { appHome, defaultNodeRetries: 3, commitPushModel: 'second' }
    const seeded = await seedBundleTask(harness, appHome)
    await inherited.submit({ ...seeded, completionMode: 'await-settle' })
    expect(fixture.driven.at(-1)).toMatchObject({
      defaultNodeRetries: 9,
      commitPushModel: 'second',
    })
  })

  for (const kind of TASK_EXECUTION_INTENT_KINDS) {
    test(`claimed ${kind} selects the workspace profile policy`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome),
        bundle = fixture.compose()
      const seeded = await seedBundleTask(harness, appHome)
      await harness.db
        .update(taskExecutionIntents)
        .set({
          kind,
          payloadJson:
            kind === 'gate-continuation' ? JSON.stringify({ v: 1, event: 'resume' }) : '{}',
        })
        .where(eq(taskExecutionIntents.id, seeded.intentId))
      await bundle.coordinator.submit({ ...seeded, completionMode: 'await-settle' })
      const rebuild = !['launch', 'retry-repository-preparation'].includes(kind)
      expect(shouldRebuildWorkspaceProfiles(kind)).toBe(rebuild)
      expect(fixture.driven.at(-1)?.ensureWorkspaceProfiles).toBe(rebuild ? true : undefined)
    })
  }

  for (const mode of ['local-sync', 'selected'] as const)
    for (const former of [true, false]) {
      test(`${mode} ${former ? 'former wiring' : 'factory'}: call child launch and child resume ${former ? 'lack' : 'refresh'} built-in settings and distill without enabling commit/push`, async () => {
        const appHome = home(),
          fixture = taskBundleInput(harness, appHome, mode),
          bundle = fixture.compose()
        const request = await childRequest(harness, appHome)
        const factory = former ? formerChildFactory(bundle) : bundle.coordinatorFactory
        const launch = createChildExecutionLaunchOperations({
          db: harness.db,
          persistence: bundle.persistence,
          coordinatorFactory: factory,
          workgroup: composeTestChildLaunchWorkgroup(harness.db),
        })
        fixture.update(settings)
        await launch.launchWorkflow({ ...request, schedulerDriver: fixture.schedulerDriver })
        const childId = request.materializedSpace.taskId
        await awaitDriverSettled(bundle, childId)
        const [child] = await harness.db.select().from(tasks).where(eq(tasks.id, childId))
        expect(child?.autoCommitPush).toBe(false)
        expect(JSON.parse(child!.workflowSnapshot).nodes).toEqual([])
        await harness.db
          .update(tasks)
          .set({ status: 'interrupted', errorSummary: 'daemon-restart' })
          .where(eq(tasks.id, childId))
        fixture.update({ commitPushModel: 'resume-live' })
        await resumeTaskProjection(
          resumeDependencies(bundle, fixture, factory),
          { taskId: childId, runtime: request.runtime },
          { schedulerDriver: fixture.schedulerDriver },
          { completionMode: 'await-settle' },
        )
        expect(fixture.driven).toHaveLength(2)
        for (const [index, driven] of fixture.driven.entries()) {
          expect(driven).toMatchObject({
            defaultNodeRetries: 2,
            daemonGeneration: 'parent-generation',
            commitPushExcludePatterns: ['parent/**'],
          })
          expect(driven).not.toHaveProperty('autoCommitPush')
          if (former) {
            for (const key of Object.keys(liveAgentSettings)) expect(driven).not.toHaveProperty(key)
            expect(driven.agentRunSettled).toBeUndefined()
          } else {
            expect(driven).toMatchObject({
              ...liveAgentSettings,
              commitPushModel: index === 0 ? 'live-commit' : 'resume-live',
            })
            expect(driven.agentRunSettled).toBeDefined()
            await driven.agentRunSettled!.onAgentRunSettled({
              taskId: childId,
              nodeRunId: ulid(),
              nodeId: 'agent',
              status: 'done',
            })
          }
        }
        expect(fixture.distillRequests).toHaveLength(former ? 0 : 2)
      })
    }

  for (const failure of [CHILD_LAUNCH_FAILURE, TASK_RESUME_FAILURE])
    for (const wiring of [
      'factory',
      'former-current-epoch',
      'unscoped-negative-control',
    ] as const) {
      test(`${failure.reason} ${wiring}: failure ${wiring === 'unscoped-negative-control' ? 'also terminalizes' : 'preserves'} the pending successor`, async () => {
        const appHome = home(),
          fixture = taskBundleInput(harness, appHome),
          bundle = fixture.compose()
        const seeded = await seedBundleTask(harness, appHome),
          successorId = ulid()
        fixture.schedulerDriver.drive = async () => {
          await bundle.persistence.intents.submitContinuation({
            taskId: seeded.taskId,
            intentId: successorId,
            kind: 'gate-continuation',
            source: 'internal',
            actorUserId: null,
            payload: { v: 1, operationId: ulid() },
            now: Date.now(),
            advanceOperationGeneration: false,
            admissionMode: 'successor-after-claimed',
          })
          throw new Error('rfc386-engine-failure')
        }
        const terminalize = spyOn(bundle.persistence.intentTerminalization, 'terminalize')
        const transition = spyOn(bundle.persistence.runtimeLifecycle, 'trySet')
        const coordinator =
          wiring === 'factory'
            ? bundle.coordinatorFactory.coordinatorFor({ failure })
            : new DefaultTaskDriveCoordinator({
                runtime: resolveTaskDriveConfig({ appHome }),
                lifecycle: bundle.driverLifecycle,
                repositoryPreparation: skipRepositoryPreparation,
                engineOrchestrator: {
                  drive: (context) =>
                    fixture.schedulerDriver.drive({
                      taskId: context.taskId,
                      appHome,
                      signal: context.signal,
                      executionContext: context.execution,
                    }),
                },
                failureReporter: {
                  async report({ taskId, execution }) {
                    await bundle.persistence.intentTerminalization.terminalize({
                      taskId,
                      state: 'failed',
                      failureCode: failure.failureCode,
                      now: Date.now(),
                      ...(wiring === 'unscoped-negative-control'
                        ? {}
                        : { claimedOwnerEpoch: execution.token.epoch }),
                    })
                  },
                },
              })
        await expect(
          coordinator.submit({ ...seeded, completionMode: 'await-settle' }),
        ).rejects.toThrow('rfc386-engine-failure')
        const intents = await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.taskId, seeded.taskId))
        expect(intents.find((intent) => intent.id === seeded.intentId)).toMatchObject({
          state: 'failed',
          failureCode: failure.failureCode,
        })
        expect(intents.find((intent) => intent.id === successorId)?.state).toBe(
          wiring === 'unscoped-negative-control' ? 'failed' : 'pending',
        )
        if (wiring === 'factory') {
          expect(await seeded.row()).toMatchObject({
            status: 'failed',
            errorSummary: failure.errorSummary,
            errorMessage: 'rfc386-engine-failure',
          })
          expect(transition.mock.calls[0]![0].reason).toBe(failure.reason)
          expect(terminalize.mock.calls[0]![0]).toMatchObject({
            claimedOwnerEpoch: intents.find((intent) => intent.id === seeded.intentId)!
              .claimedEpoch,
          })
        }
        terminalize.mockRestore()
        transition.mockRestore()
        expect(bundle.isTaskActive(seeded.taskId)).toBe(false)
      })
    }

  test('configuration read failures use the same epoch reporter and always release the claim', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome),
      bundle = fixture.compose()
    const seeded = await seedBundleTask(harness, appHome)
    const factory = createTaskDriveCoordinatorFactory({
      runConfiguration: () => {
        throw new Error('configuration-unavailable')
      },
      lifecycle: bundle.driverLifecycle,
      gateContinuationPreDrive: skipRepositoryPreparation,
      repositoryPreparation: skipRepositoryPreparation,
      engine: () => fixture.schedulerDriver,
      failures: bundle.persistence,
      log: createLogger('rfc386'),
    })
    await expect(
      factory
        .coordinatorFor({ failure: CHILD_LAUNCH_FAILURE })
        .submit({ ...seeded, completionMode: 'await-settle' }),
    ).rejects.toThrow('configuration-unavailable')
    expect(await seeded.row()).toMatchObject({
      status: 'failed',
      errorSummary: 'child task launch failed',
    })
    expect(bundle.isTaskActive(seeded.taskId)).toBe(false)
    expect(fixture.driven).toHaveLength(0)
  })
  for (const mode of ['local-sync', 'selected'] as const) {
    test(`${mode}: a reused child profile reads live built-in agent settings, retains parent keys and supplies distillation`, async () => {
      const appHome = home()
      const fixture = taskBundleInput(harness, appHome, mode)
      const bundle = fixture.compose()
      // A wider parent object must still be projected through the registered keys.
      const parent = {
        appHome,
        daemonGeneration: 'parent-generation',
        defaultRuntime: 'parent-runtime',
        maxConcurrentNodes: 2,
        commitPushExcludePatterns: ['parent/**'],
        commitPushModel: 'stale-parent-commit',
        mergeAgentModel: 'stale-parent-merge',
        autoCommitPush: true,
      }
      const coordinator = bundle.coordinatorFactory.coordinatorFor({
        runConfig: { kind: 'inherit-parent', parent },
        failure: CHILD_LAUNCH_FAILURE,
      })
      for (const suffix of ['first', 'updated']) {
        fixture.update({
          commitPushModel: `commit-${suffix}`,
          commitPushRuntime: `commit-runtime-${suffix}`,
          mergeAgentModel: `merge-${suffix}`,
          mergeAgentRuntime: `merge-runtime-${suffix}`,
          commitPushLang: 'zh-CN',
          commitPushMaxRepairRetries: 5,
          commitPushDiffMaxBytes: 4567,
          taskCommitExcludePatterns: ['live/**'],
          maxConcurrentNodes: 7,
        })
        const seeded = await seedBundleTask(harness, appHome)
        await coordinator.submit({
          taskId: seeded.taskId,
          intentId: seeded.intentId,
          completionMode: 'await-settle',
        })
        const request = fixture.driven.at(-1)!
        expect(request).toMatchObject({
          daemonGeneration: parent.daemonGeneration,
          defaultRuntime: parent.defaultRuntime,
          maxConcurrentNodes: 2,
          commitPushExcludePatterns: ['parent/**'],
          commitPushModel: `commit-${suffix}`,
          commitPushRuntime: `commit-runtime-${suffix}`,
          mergeAgentModel: `merge-${suffix}`,
          mergeAgentRuntime: `merge-runtime-${suffix}`,
          commitPushLang: 'zh-CN',
          commitPushMaxRepairRetries: 5,
          commitPushDiffMaxBytes: 4567,
        })
        expect(request).not.toHaveProperty('autoCommitPush')
        await request.agentRunSettled!.onAgentRunSettled({
          taskId: seeded.taskId,
          nodeRunId: ulid(),
          nodeId: 'agent',
          status: 'done',
        })
      }
      expect(fixture.distillRequests).toHaveLength(2)
    })
  }

  test('root resume reads live session configuration after admission and preserves deferred recovery ordering', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome),
      bundle = fixture.compose()
    const seeded = await seedBundleTask(harness, appHome, 'interrupted', false)
    const dependencies = resumeDependencies(bundle, fixture)
    const input = {
      taskId: seeded.taskId,
      runtime: { runConfig: { appHome, defaultNodeRetries: 99 } },
    }
    const prepared = await prepareResumeTaskProjection(dependencies, input)
    fixture.update({ ...settings, defaultNodeRetries: 6 })
    const ready = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const trace: string[] = []
    const contexts: unknown[] = []
    const drive = fixture.schedulerDriver.drive
    fixture.schedulerDriver.drive = async (request) => {
      trace.push('engine')
      await drive(request)
    }
    await drivePreparedTaskResume(
      dependencies,
      input,
      { schedulerDriver: fixture.schedulerDriver },
      prepared,
      {
        completionMode: 'background',
        continuation: {
          async prepare(context, rollback) {
            contexts.push(context)
            trace.push('rollback')
            await rollback()
            return { kind: 'ready' }
          },
          async ready(context) {
            contexts.push(context)
            trace.push('wait-receipt')
            entered.resolve()
            await ready.promise
            return { kind: 'ready' }
          },
        },
      },
    )
    trace.push('receipt')
    await entered.promise
    expect(trace).toContain('receipt')
    expect(trace).not.toContain('engine')
    expect(contexts[1]).toEqual(contexts[0])
    ready.resolve()
    await awaitDriverSettled(bundle, seeded.taskId)
    expect(trace.at(-1)).toBe('engine')
    expect(fixture.driven[0]).toMatchObject({
      ...liveAgentSettings,
      defaultNodeRetries: 6,
      ensureWorkspaceProfiles: true,
    })
    expect(fixture.driven[0]!.agentRunSettled).toBeDefined()
  })

  test('child observer obeys the live distillation policy, including disabled agent-run sources', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome),
      bundle = fixture.compose()
    const seeded = await seedBundleTask(harness, appHome)
    await harness.db.update(tasks).set({ spaceKind: 'local' }).where(eq(tasks.id, seeded.taskId))
    await bundle.coordinatorFactory
      .coordinatorFor({ runConfig: { kind: 'inherit-parent', parent: { appHome } } })
      .submit({ ...seeded, completionMode: 'await-settle' })
    const observer = fixture.driven[0]!.agentRunSettled!
    setMemoryDistillPolicyProvider(() => ({
      ...DEFAULT_DISTILL_POLICY,
      sources: { ...DEFAULT_DISTILL_POLICY.sources, 'agent-run': false },
    }))
    await observer.onAgentRunSettled({
      taskId: seeded.taskId,
      nodeRunId: ulid(),
      nodeId: 'agent',
      status: 'done',
    })
    expect(
      await harness.db
        .select()
        .from(memoryDistillJobs)
        .where(eq(memoryDistillJobs.taskId, seeded.taskId)),
    ).toHaveLength(0)
    resetMemoryDistillPolicyProviderForTest()
    const nodeRunId = ulid()
    await observer.onAgentRunSettled({
      taskId: seeded.taskId,
      nodeRunId,
      nodeId: 'agent',
      status: 'done',
    })
    expect(
      await harness.db
        .select()
        .from(memoryDistillJobs)
        .where(eq(memoryDistillJobs.taskId, seeded.taskId)),
    ).toMatchObject([{ sourceKind: 'agent-run', sourceEventId: nodeRunId }])
  })

  for (const former of [true, false]) {
    test(`${former ? 'former PostgreSQL session wiring' : 'factory'}: a gate drive ${former ? 'retains' : 'repairs'} a changed exclude profile in the real engine`, async () => {
      const appHome = home(),
        repo = join(appHome, 'repository')
      mkdirSync(repo)
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'business.txt'), 'base\n')
      git('add', 'business.txt')
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      )
      const head = git('rev-parse', 'HEAD')
      const receipt = await bindWorkspaceExcludeParticipant({
        worktreePath: repo,
        appHome,
      }).ensure()
      const profilePath = git('config', '--worktree', '--path', '--get', 'core.excludesFile')
      const canonical = readFileSync(profilePath, 'utf8')
      mkdirSync(join(repo, '.agent-workflow'), { recursive: true })
      writeFileSync(join(repo, '.agent-workflow', 'trace.json'), '{}')
      writeFileSync(profilePath, '# changed during the prior agent run\n')
      expect(git('status', '--porcelain')).toContain('.agent-workflow/')
      expect(await gitDiffSnapshot(repo, head)).toContain('.agent-workflow/trace.json')
      const fixture = taskBundleInput(harness, appHome)
      const bundle = composeDaemonTaskExecutionModules({ ...fixture.input, testSeams: undefined })
      const seeded = await seedBundleTask(harness, repo)
      await harness.db
        .update(taskExecutionIntents)
        .set({ kind: 'gate-continuation', payloadJson: JSON.stringify({ v: 1, event: 'resume' }) })
        .where(eq(taskExecutionIntents.id, seeded.intentId))
      // Stop after the real profile stage, like RFC-370's selected-profile fixture.
      // Actual review/clarify decisions and pre-drive ordering are covered by RFC-382's paired cases.
      await harness.db
        .update(tasks)
        .set({ workflowSnapshot: '{}' })
        .where(eq(tasks.id, seeded.taskId))
      await harness.db.insert(taskRepos).values({
        taskId: seeded.taskId,
        repoIndex: 0,
        repoPath: repo,
        worktreePath: repo,
        branch: seeded.taskId,
        workspaceProfileVersion: receipt.version,
        workspaceProfileDigest: receipt.digest,
      })
      const coordinator = former
        ? new DefaultTaskDriveCoordinator({
            runtime: resolveTaskDriveConfig(await bundle.runConfiguration()),
            lifecycle: bundle.driverLifecycle,
            gateContinuationPreDrive: composeGateContinuationPreDrive({
              db: harness.db,
              persistence: bundle.persistence,
              memoryDistillEnqueuer: fixture.input.memory.memoryOperations.distillCommands,
            }),
            repositoryPreparation: skipRepositoryPreparation,
            // The former session had the gate pre-step but did not forward a profile rebuild flag.
            engineOrchestrator: {
              drive: (context) =>
                bundle.runtime.schedulerDriver.drive({
                  taskId: context.taskId,
                  appHome,
                  ...context.runtime.runtime,
                  signal: context.signal,
                  executionContext: context.execution,
                }),
            },
            failureReporter: { report() {} },
          })
        : bundle.coordinator
      await coordinator.submit({ ...seeded, completionMode: 'await-settle' })
      expect(await seeded.row()).toMatchObject({
        status: 'failed',
        errorSummary: 'snapshot-invalid',
      })
      expect(readFileSync(profilePath, 'utf8') === canonical).toBe(!former)
      expect(git('status', '--porcelain').includes('.agent-workflow/')).toBe(former)
      expect((await gitDiffSnapshot(repo, head)).includes('.agent-workflow/trace.json')).toBe(
        former,
      )
      expect(git('rev-parse', 'HEAD')).toBe(head)
    })
  }

  for (const entry of ['child-launch', 'child-resume', 'root-resume'] as const) {
    test(`${entry}: the real entry point selects the shared failure profile and epoch`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome),
        bundle = fixture.compose()
      const launch = createChildExecutionLaunchOperations({
        db: harness.db,
        persistence: bundle.persistence,
        coordinatorFactory: bundle.coordinatorFactory,
        workgroup: composeTestChildLaunchWorkgroup(harness.db),
      })
      const request = await childRequest(harness, appHome)
      const childId = request.materializedSpace.taskId
      if (entry === 'child-resume') {
        await launch.launchWorkflow({ ...request, schedulerDriver: fixture.schedulerDriver })
        await awaitDriverSettled(bundle, childId)
        await harness.db
          .update(tasks)
          .set({ status: 'interrupted', errorSummary: 'daemon-restart' })
          .where(eq(tasks.id, childId))
      }
      const taskId =
        entry === 'root-resume'
          ? (await seedBundleTask(harness, appHome, 'interrupted', false)).taskId
          : childId
      const failure = entry === 'child-launch' ? CHILD_LAUNCH_FAILURE : TASK_RESUME_FAILURE
      fixture.schedulerDriver.drive = async () => {
        throw new Error('entry-drive-failed')
      }
      const transition = spyOn(bundle.persistence.runtimeLifecycle, 'trySet')
      const terminalize = spyOn(bundle.persistence.intentTerminalization, 'terminalize')
      try {
        if (entry === 'child-launch') {
          await launch.launchWorkflow({ ...request, schedulerDriver: fixture.schedulerDriver })
          await awaitDriverSettled(bundle, taskId)
        } else {
          await expect(
            resumeTaskProjection(
              resumeDependencies(bundle, fixture),
              { taskId, runtime: request.runtime },
              { schedulerDriver: fixture.schedulerDriver },
              { completionMode: 'await-settle' },
            ),
          ).rejects.toThrow('entry-drive-failed')
        }
        const [task] = await harness.db.select().from(tasks).where(eq(tasks.id, taskId))
        expect(task).toMatchObject({ status: 'failed', errorSummary: failure.errorSummary })
        expect(transition.mock.calls[0]![0].reason).toBe(failure.reason)
        const terminal = terminalize.mock.calls[0]![0]
        expect(terminal.claimedOwnerEpoch).toBeGreaterThan(0)
        const intents = await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.taskId, taskId))
        expect(
          intents.find((intent) => intent.claimedEpoch === terminal.claimedOwnerEpoch),
        ).toMatchObject({ state: 'failed', failureCode: failure.failureCode })
        expect(bundle.isTaskActive(taskId)).toBe(false)
      } finally {
        transition.mockRestore()
        terminalize.mockRestore()
      }
    })
  }
})

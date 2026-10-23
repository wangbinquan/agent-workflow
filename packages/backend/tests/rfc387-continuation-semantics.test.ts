// RFC-387: both providers exercise session continuation semantics, with the former wiring retained as controls.
import {
  patchTaskFixture,
  patchWorkflowFixture,
  readTaskFixtures,
  workflowFixture,
  readNodeRunFixtures,
  readTaskRepoFixtures,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { composeTaskAutoResumeCommand } from '@/modules/task-execution/composition/taskAutoResume'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { REPO_PREP_NODE_ID } from '@agent-workflow/shared'
import { composeDaemonTaskExecutionModules } from '@/bootstrap/daemonModules/taskExecution'
import { createLogger } from '@/util/log'
import { createTaskDriveCoordinatorFactory } from '@/modules/task-execution/application/drive/taskDriveCoordinatorFactory'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import {
  resolveTaskDriveConfig,
  type TaskDriveCoordinator,
} from '@/modules/task-execution/application/drive/taskDriveTypes'
import { createFusionEngineTaskOperations } from '@/modules/task-execution/infrastructure/fusionEngineTaskOperations'
import { createRepositoryPreparationRetryCommand } from '@/modules/task-execution/infrastructure/repositoryPreparationRetryCommand'
import { composeDeferredRepositoryPreparation } from '@/modules/task-execution/composition/deferredRepositoryPreparation'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { DrizzleWorkspaceMaintenanceStore } from '@/modules/source-control/infrastructure/workspaceMaintenanceStore'
import { ownershipTokenKey } from '@/modules/task-execution/domain/ownership'
import { layoutBuiltinWorkflowSnapshotJson } from '@/services/task'
import { describeEachProvider, type ProviderDatabaseHarness } from './helpers/eachProvider'
import { seedBundleTask, taskBundleInput } from './helpers/daemonTaskExecutionBundle'
import { mintSequenceRun } from './helpers/rfc374Fixtures'

type Bundle = ReturnType<ReturnType<typeof taskBundleInput>['compose']>
const homes: string[] = []
function home() {
  const path = mkdtempSync(join(tmpdir(), 'rfc387-'))
  homes.push(path)
  return path
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
async function settled(bundle: Bundle, taskId: string) {
  const registry = bundle.executionModule.runtimeRegistry
  const token = registry.tokenForTask(taskId)
  if (token) await registry.awaitStopped({ token, tokenKey: ownershipTokenKey(token) })
}
async function gate(harness: ProviderDatabaseHarness, appHome: string) {
  const seeded = await seedBundleTask(harness, appHome)
  const { taskExecutionIntents } = tablesOf(harness.db)
  await harness.db
    .update(taskExecutionIntents)
    .set({ kind: 'gate-continuation', payloadJson: JSON.stringify({ v: 1, event: 'resume' }) })
    .where(eq(taskExecutionIntents.id, seeded.intentId))
  await patchTaskFixture(harness.db, { id: seeded.taskId }, { spaceKind: 'local' })
  return seeded
}
// C8/C10/C7 swallowed engine errors and omitted the distillation observer. The real lifecycle is unchanged.
async function formerSqlite(bundle: Bundle): Promise<TaskDriveCoordinator> {
  const { agentRunSettled: _observer, ...runtime } = await bundle.runConfiguration()
  return new DefaultTaskDriveCoordinator({
    runtime: resolveTaskDriveConfig(runtime),
    lifecycle: bundle.driverLifecycle,
    repositoryPreparation: skipRepositoryPreparation,
    engineOrchestrator: {
      async drive(context) {
        try {
          await bundle.runtime.schedulerDriver.drive({
            taskId: context.taskId,
            appHome: context.runtime.appHome,
            ...context.runtime.runtime,
            signal: context.signal,
            executionContext: context.execution,
          })
        } catch {
          /* Former createTaskDriveCoordinator logged and swallowed engine errors. */
        }
      },
    },
    failureReporter: { report() {} },
  })
}
async function retrySeed(harness: ProviderDatabaseHarness, appHome: string) {
  const seeded = await seedBundleTask(harness, appHome, 'interrupted', false)
  const cachedId = ulid()
  const { cachedRepos } = tablesOf(harness.db)
  await insertOne(harness.db, cachedRepos, {
    id: cachedId,
    urlHash: cachedId,
    urlRedacted: 'https://example.test/rfc387.git',
    localPath: join(appHome, 'absent-cache'),
    lastFetchedAt: 1,
    createdAt: 1,
  })
  await patchTaskFixture(
    harness.db,
    { id: seeded.taskId },
    {
      status: 'failed',
      worktreePath: '',
      cachedRepoId: cachedId,
      spaceKind: 'remote',
      failedNodeId: REPO_PREP_NODE_ID,
    },
  )
  await mintSequenceRun(harness.db, seeded.taskId, { nodeId: REPO_PREP_NODE_ID, status: 'failed' })
  return seeded
}
async function fusionSeed(harness: ProviderDatabaseHarness, appHome: string) {
  const taskId = ulid(),
    workflowId = ulid(),
    ownerUserId = ulid()
  const { users } = tablesOf(harness.db)
  await insertOne(harness.db, users, {
    id: ownerUserId,
    username: ownerUserId,
    displayName: 'Fusion owner',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  const definition = JSON.stringify({
    $schema_version: 5,
    inputs: [],
    nodes: [{ id: 'a', kind: 'agent-single', agentName: 'merger' }],
    edges: [],
  })
  await workflowFixture(harness.db, {
    id: workflowId,
    name: workflowId,
    definition,
    version: 1,
    schemaVersion: 5,
  })
  return {
    definition,
    command: {
      taskId,
      workflowId,
      ownerUserId,
      fusionId: ulid(),
      iteration: 1,
      seed: { base: [], overlay: null },
      name: 'fusion',
      inputs: {},
      initiator: 'manual' as const,
      platformInputPaths: [],
      completionMode: 'await-settle' as const,
    },
    workspaces: {
      prepare: async () => ({ worktreePath: appHome, baseCommit: 'base-commit' }),
      collect: async () => {
        throw new Error('unused collection')
      },
      release: async () => {},
    },
  }
}

describeEachProvider('RFC-387 session continuation semantics', (harness) => {
  for (const entry of ['gate', 'room', 'retry', 'fusion'] as const)
    for (const former of [true, false]) {
      test(`${entry} ${former ? 'former SQLite wiring' : 'session'}: live settings, distillation and engine failure`, async () => {
        const appHome = home(),
          fixture = taskBundleInput(harness, appHome),
          bundle = fixture.compose()
        const seeded = await gate(harness, appHome)
        const { taskExecutionIntents, memoryDistillJobs } = tablesOf(harness.db)
        if (entry === 'fusion')
          await patchTaskFixture(harness.db, { id: seeded.taskId }, { spaceKind: 'internal' })
        if (entry === 'retry' || entry === 'fusion')
          await harness.db
            .update(taskExecutionIntents)
            .set({
              kind: entry === 'retry' ? 'retry-repository-preparation' : 'launch',
              payloadJson: '{}',
            })
            .where(eq(taskExecutionIntents.id, seeded.intentId))
        // The former short-lived gate/retry paths hot-read settings too. The shared source preserves that behavior.
        fixture.update({
          commitPushModel: 'after-composition',
          mergeAgentModel: 'live-merge',
          defaultNodeRetries: 7,
        })
        const coordinator = former ? await formerSqlite(bundle) : bundle.coordinator
        const seen: Parameters<typeof fixture.schedulerDriver.drive>[0][] = []
        fixture.schedulerDriver.drive = async (request) => {
          seen.push(request)
          await request.agentRunSettled?.onAgentRunSettled({
            taskId: request.taskId,
            nodeRunId: ulid(),
            nodeId: 'agent',
            status: 'done',
          })
          throw new Error('rfc387-engine-failure')
        }
        const submitting = coordinator.submit({ ...seeded, completionMode: 'await-settle' })
        if (former) await submitting
        else await expect(submitting).rejects.toThrow('rfc387-engine-failure')
        expect(seen).toHaveLength(1)
        expect(seen[0]).toMatchObject({
          commitPushModel: 'after-composition',
          mergeAgentModel: 'live-merge',
          defaultNodeRetries: 7,
        })
        expect(seen[0]!.agentRunSettled !== undefined).toBe(!former)
        expect(await seeded.row()).toMatchObject(
          former
            ? { status: 'running' }
            : {
                status: 'failed',
                errorSummary: 'task drive failed',
                errorMessage: 'rfc387-engine-failure',
              },
        )
        expect(fixture.distillRequests).toHaveLength(former ? 0 : 1)
        expect(
          await harness.db
            .select()
            .from(memoryDistillJobs)
            .where(eq(memoryDistillJobs.taskId, seeded.taskId)),
        ).toHaveLength(former || entry === 'fusion' ? 0 : 1)
        const [intent] = await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, seeded.intentId))
        if (!former)
          expect(intent).toMatchObject({ state: 'failed', failureCode: 'task-drive-failed' })
      })
    }

  test('gate wake skips an active driver and the worker can claim the same durable intent after release', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome),
      bundle = fixture.compose()
    const seeded = await gate(harness, appHome)
    const controller = new AbortController()
    const attached = await bundle.driverLifecycle.attach({ ...seeded, controller })
    expect(attached.kind).toBe('attached')
    const submit = spyOn(bundle.coordinator, 'submit')
    await bundle.gateContinuation({ taskId: seeded.taskId, continuationRef: seeded.intentId })
    expect(submit).not.toHaveBeenCalled()
    const { taskExecutionIntents } = tablesOf(harness.db)
    const [first] = await harness.db
      .select()
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.id, seeded.intentId))
    const successorId = ulid()
    await insertOne(harness.db, taskExecutionIntents, {
      ...first!,
      id: successorId,
      state: 'pending',
      claimedEpoch: null,
      claimedAt: null,
      continuationSlotKey: 'next-decision',
      requestHash: successorId,
    })
    await bundle.driverLifecycle.releaseAndFinalize({ taskId: seeded.taskId, controller })
    await bundle.gateContinuation({ taskId: seeded.taskId, continuationRef: successorId })
    await settled(bundle, seeded.taskId)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(fixture.driven).toHaveLength(1)
    submit.mockRestore()
  })

  for (const former of [true, false])
    test(`${former ? 'former PostgreSQL room wiring' : 'session room'}: immediate post-commit drive`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome),
        bundle = fixture.compose()
      const seeded = await gate(harness, appHome)
      const room = former ? { driveAfterCommit: async () => {} } : bundle.roomContinuation
      await room.driveAfterCommit({ taskId: seeded.taskId, intentId: seeded.intentId })
      await settled(bundle, seeded.taskId)
      expect(fixture.driven).toHaveLength(former ? 0 : 1)
      if (!former) expect(fixture.driven[0]!.ensureWorkspaceProfiles).toBe(true)
    })

  for (const former of [true, false])
    test(`${former ? 'former SQLite room wiring' : 'session room'}: committed confirmation ${former ? 'rejects' : 'survives'} drive admission failure`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome),
        bundle = fixture.compose()
      const seeded = await gate(harness, appHome)
      const failure = spyOn(bundle.coordinator, 'submit').mockRejectedValue(
        new Error('configuration-read-failed'),
      )
      const continuation = { taskId: seeded.taskId, intentId: seeded.intentId }
      const result = former
        ? bundle.gateContinuation({ taskId: seeded.taskId, continuationRef: seeded.intentId })
        : bundle.roomContinuation.driveAfterCommit(continuation)
      if (former) await expect(result).rejects.toThrow('configuration-read-failed')
      else await expect(result).resolves.toBeUndefined()
      failure.mockRestore()
      const { taskExecutionIntents } = tablesOf(harness.db)
      const [intent] = await harness.db
        .select()
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, seeded.intentId))
      expect(intent!.state).toBe('pending')
      await bundle.gateContinuation({ taskId: seeded.taskId, continuationRef: seeded.intentId })
      await settled(bundle, seeded.taskId)
      expect(fixture.driven).toHaveLength(1)
    })

  for (const former of [true, false])
    test(`${former ? 'former PostgreSQL synchronous retry' : 'session background retry'}: clone wait, git failure and atomic duplicate admission`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome),
        bundle = fixture.compose()
      const seeded = await retrySeed(harness, appHome)
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      const binding = composeRepositoryPreparation({ db: harness.db, appHome })
      let preparations = 0
      const prepare = async () => {
        preparations++
        entered.resolve()
        await release.promise
        throw new Error('fatal: rfc387 clone failed')
      }
      const preparation = composeDeferredRepositoryPreparation({
        db: harness.db,
        appHome,
        gitBaselineSyncWindowMs: 0,
        repositoryPreparation: { ...binding, legacy: { ...binding.legacy, prepare } },
      })
      const factory = createTaskDriveCoordinatorFactory({
        runConfiguration: bundle.runConfiguration,
        lifecycle: bundle.driverLifecycle,
        gateContinuationPreDrive: skipRepositoryPreparation,
        repositoryPreparation: preparation,
        engine: () => fixture.schedulerDriver,
        failures: bundle.persistence,
        log: createLogger('rfc387'),
      })
      const command = createRepositoryPreparationRetryCommand({
        db: harness.db,
        coordinator: factory.session,
        isTaskActive: bundle.isTaskActive,
        awaitTaskSettled: (id) => bundle.executionModule.runtimeRegistry.awaitReleasedSettled(id),
      })
      let returned = false
      // Former PG awaited workspace.prepare before its pending CAS, and rethrew clone errors to HTTP.
      const pending = (
        former ? prepare().then(() => command.retry(seeded.taskId)) : command.retry(seeded.taskId)
      ).then(
        () => {
          returned = true
          return null
        },
        (error: unknown) => error,
      )
      try {
        await entered.promise
        if (!former) {
          expect(await pending).toBeNull()
          expect(returned).toBe(true)
          expect((await seeded.row()).status).toBe('pending')
          await expect(command.retry(seeded.taskId)).rejects.toMatchObject({
            code: 'task-still-running',
          })
        } else {
          expect(returned).toBe(false)
          expect((await seeded.row()).status).toBe('failed')
        }
      } finally {
        release.resolve()
      }
      if (former) expect(await pending).toEqual(new Error('fatal: rfc387 clone failed'))
      else {
        await settled(bundle, seeded.taskId)
        expect(await seeded.row()).toMatchObject({
          status: 'failed',
          errorMessage: expect.stringContaining('fatal: rfc387 clone failed'),
        })
        const runs = await readNodeRunFixtures(harness.db, { taskId: seeded.taskId })
        expect(runs.filter((row) => row.nodeId === REPO_PREP_NODE_ID)).toHaveLength(2)
        expect(runs.find((row) => row.retryIndex === 1)).toMatchObject({
          status: 'failed',
          errorMessage: expect.stringContaining('fatal: rfc387 clone failed'),
        })
      }
      expect(preparations).toBe(1)
      expect(fixture.driven).toHaveLength(0)
    })

  test('independent retry callers have one atomic pending/intent winner', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome),
      bundle = fixture.compose()
    const seeded = await retrySeed(harness, appHome)
    const both = Promise.withResolvers<void>()
    let arrived = 0,
      submissions = 0
    const makeCommand = () =>
      createRepositoryPreparationRetryCommand({
        db: harness.db,
        coordinator: {
          async submit({ taskId }) {
            submissions++
            return { kind: 'accepted', taskId }
          },
        },
        isTaskActive: () => false,
        async awaitTaskSettled() {
          if (++arrived === 2) both.resolve()
          await both.promise
        },
      })
    const results = await Promise.allSettled([
      makeCommand().retry(seeded.taskId),
      makeCommand().retry(seeded.taskId),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'task-still-running' },
    })
    expect(submissions).toBe(1)
    expect((await seeded.row()).status).toBe('pending')
    const { taskExecutionIntents } = tablesOf(harness.db)
    expect(
      await harness.db
        .select()
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.taskId, seeded.taskId)),
    ).toHaveLength(1)
    expect(bundle.isTaskActive(seeded.taskId)).toBe(false)
  })

  test('boot auto-resume submits every preparation retry without awaiting either clone', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome),
      bundle = fixture.compose()
    const seeds = [await retrySeed(harness, appHome), await retrySeed(harness, appHome)]
    for (const seed of seeds)
      await patchTaskFixture(
        harness.db,
        { id: seed.taskId },
        { status: 'interrupted', errorSummary: 'daemon-restart' },
      )
    const release = Promise.withResolvers<void>()
    const entered: string[] = []
    const factory = createTaskDriveCoordinatorFactory({
      runConfiguration: bundle.runConfiguration,
      lifecycle: bundle.driverLifecycle,
      gateContinuationPreDrive: skipRepositoryPreparation,
      repositoryPreparation: {
        async run(context) {
          entered.push(context.taskId)
          await release.promise
          return { kind: 'terminal-won' }
        },
      },
      engine: () => fixture.schedulerDriver,
      failures: bundle.persistence,
      log: createLogger('rfc387-boot'),
    })
    const retry = createRepositoryPreparationRetryCommand({
      db: harness.db,
      coordinator: factory.session,
      isTaskActive: bundle.isTaskActive,
      awaitTaskSettled: (id) => bundle.executionModule.runtimeRegistry.awaitReleasedSettled(id),
    })
    try {
      const result = await composeTaskAutoResumeCommand({
        recovery: bundle.recovery,
        resume: {
          async resume() {
            throw new Error('preparation must use retry')
          },
        },
        repositoryPreparation: retry,
      }).run({ breaker: { maxPerWindow: 5, windowMs: 60000 } })
      expect([...result.resumed].sort()).toEqual(seeds.map((seed) => seed.taskId).sort())
      expect(entered.sort()).toEqual([...result.resumed].sort())
      expect(fixture.driven).toHaveLength(0)
    } finally {
      release.resolve()
      for (const seed of seeds) await settled(bundle, seed.taskId)
    }
  })

  for (const former of [true, false])
    test(`${former ? 'former PostgreSQL fusion' : 'session fusion'}: freeze layout and terminalize only the claimed intent`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome),
        bundle = fixture.compose(),
        seed = await fusionSeed(harness, appHome)
      let successorId = ''
      fixture.schedulerDriver.drive = async () => {
        const { taskExecutionIntents } = tablesOf(harness.db)
        const [claimed] = await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.taskId, seed.command.taskId))
        successorId = ulid()
        await insertOne(harness.db, taskExecutionIntents, {
          ...claimed!,
          id: successorId,
          kind: 'resume',
          state: 'pending',
          claimedEpoch: null,
          claimedAt: null,
          failureCode: null,
          continuationSlotKey: 'successor',
          requestHash: successorId,
        })
        throw new Error('fusion-engine-failed')
      }
      const coordinator = former
        ? new DefaultTaskDriveCoordinator({
            runtime: resolveTaskDriveConfig(await bundle.runConfiguration()),
            lifecycle: bundle.driverLifecycle,
            repositoryPreparation: skipRepositoryPreparation,
            engineOrchestrator: {
              drive: (context) =>
                fixture.schedulerDriver.drive({
                  taskId: context.taskId,
                  appHome,
                  ...context.runtime.runtime,
                  signal: context.signal,
                  executionContext: context.execution,
                }),
            },
            failureReporter: {
              async report({ taskId, error, execution }) {
                await bundle.persistence.runtimeLifecycle.trySet({
                  taskId,
                  to: 'failed',
                  allowedFrom: ['pending', 'running'],
                  extra: { errorSummary: 'fusion engine task failed', errorMessage: String(error) },
                  executionContext: execution,
                  now: Date.now(),
                  reason: 'fusion-engine-launch',
                })
                await bundle.persistence.intentTerminalization.terminalize({
                  taskId,
                  state: 'failed',
                  failureCode: 'fusion-engine-launch-failed',
                  now: Date.now(),
                })
              },
            },
          })
        : bundle.coordinator
      const launchCoordinator: TaskDriveCoordinator = {
        async submit(request) {
          // Former PG inserted the raw definition. Use the same neutral admission with that exact old projection.
          if (former)
            await patchTaskFixture(
              harness.db,
              { id: request.taskId },
              { workflowSnapshot: seed.definition },
            )
          return coordinator.submit(request)
        },
      }
      const operations = createFusionEngineTaskOperations({
        db: harness.db,
        workspaces: seed.workspaces,
        coordinator: launchCoordinator,
        cancellation: bundle.cancellation,
      })
      await expect(operations.launch(seed.command)).rejects.toThrow('fusion-engine-failed')
      const { taskExecutionIntents } = tablesOf(harness.db)
      const [task] = await readTaskFixtures(harness.db, { id: seed.command.taskId })
      expect(task!.workflowSnapshot).toBe(
        former ? seed.definition : layoutBuiltinWorkflowSnapshotJson(seed.definition),
      )
      expect(task!.workflowSnapshot === seed.definition).toBe(former)
      const [successor] = await harness.db
        .select()
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, successorId))
      expect(successor!.state).toBe(former ? 'failed' : 'pending')
      expect(task!.errorSummary).toBe(former ? 'fusion engine task failed' : 'task drive failed')
    })

  for (const former of [true, false])
    test(`${former ? 'former SQLite fusion' : 'session fusion'}: an unattached launch ${former ? 'returns silently' : 'reports conflict'}`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome),
        bundle = fixture.compose(),
        seed = await fusionSeed(harness, appHome)
      const refused: TaskDriveCoordinator = {
        submit: async ({ taskId }) => ({ kind: 'not-attached', taskId }),
      }
      const operations = createFusionEngineTaskOperations({
        db: harness.db,
        workspaces: seed.workspaces,
        cancellation: bundle.cancellation,
        coordinator: former
          ? {
              async submit(request) {
                const receipt = await refused.submit(request)
                return receipt.kind === 'not-attached'
                  ? { kind: 'accepted', taskId: request.taskId }
                  : receipt
              },
            }
          : refused,
      })
      if (former) await expect(operations.launch(seed.command)).resolves.toBeUndefined()
      else
        await expect(operations.launch(seed.command)).rejects.toMatchObject({
          code: 'task-launch-not-attached',
        })
      expect((await operations.load(seed.command.taskId))!.status).toBe('pending')
      expect(fixture.driven).toHaveLength(0)
    })

  test('fusion cancels once through the session cancellation command', async () => {
    const appHome = home(),
      fixture = taskBundleInput(harness, appHome),
      bundle = fixture.compose(),
      seed = await fusionSeed(harness, appHome)
    await createFusionEngineTaskOperations({
      db: harness.db,
      workspaces: seed.workspaces,
      coordinator: bundle.coordinator,
      cancellation: bundle.cancellation,
    }).launch(seed.command)
    const canceled: string[] = []
    const operations = createFusionEngineTaskOperations({
      db: harness.db,
      workspaces: seed.workspaces,
      coordinator: bundle.coordinator,
      cancellation: {
        async cancel(request) {
          canceled.push(request.taskId)
          await bundle.cancellation.cancel(request)
        },
      },
    })
    await operations.cancel(seed.command.taskId)
    expect(canceled).toEqual([seed.command.taskId])
    expect((await operations.load(seed.command.taskId))!.status).toBe('canceled')
  })

  test('fresh fusion workspace gets an exclude profile from the real engine without a forced rebuild flag', async () => {
    const appHome = home(),
      repo = join(appHome, 'repository')
    mkdirSync(repo)
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    )
    mkdirSync(join(repo, '.agent-workflow'))
    writeFileSync(join(repo, '.agent-workflow', 'trace.json'), '{}')
    const fixture = taskBundleInput(harness, appHome),
      seed = await fusionSeed(harness, repo)
    const bundle = composeDaemonTaskExecutionModules({
      ...fixture.input,
      testSeams: undefined,
      selection: {
        ...fixture.input.selection,
        fusionWorkspaces: {
          ...seed.workspaces,
          prepare: async () => ({ worktreePath: repo, baseCommit: git('rev-parse', 'HEAD') }),
        },
      },
    })
    // Stop immediately after the real profile stage; no runtime process is needed.
    await patchWorkflowFixture(harness.db, { id: seed.command.workflowId }, { definition: '{}' })
    await bundle.fusion.launch(seed.command)
    const [projection] = await readTaskRepoFixtures(harness.db, { taskId: seed.command.taskId })
    expect(projection!.workspaceProfileVersion).toBe(1)
    expect(projection!.workspaceProfileDigest).toBeTruthy()
    expect(
      readFileSync(git('config', '--worktree', '--path', '--get', 'core.excludesFile'), 'utf8'),
    ).toContain('.agent-workflow')
    expect(git('status', '--porcelain')).not.toContain('.agent-workflow/')
  })

  for (const early of [false, true])
    test(`driver release ${early ? 'before engine' : 'after engine'}: failed cleanup settles and maintenance recovers the retained claim`, async () => {
      const appHome = home(),
        fixture = taskBundleInput(harness, appHome)
      let fail = true,
        removes = 0
      const store = new DrizzleWorkspaceMaintenanceStore(harness.db)
      const bundle = composeDaemonTaskExecutionModules({
        ...fixture.input,
        finalizeWorkspace: (id) => maintenance.finalizeClaimedWorkspace(id),
      })
      const maintenance = composeWorkspaceMaintenanceCommand({
        db: harness.db,
        appHome,
        terminalMaintenance: bundle.persistence.terminalMaintenance,
        isMaterializingTask: () => false,
        invalidateWorkspacePath: () => {},
        filesystem: {
          exists: async () => true,
          isMaterializingTask: () => false,
          removeWorkspace: async () => {
            removes++
            if (fail) throw new Error('cleanup unavailable')
            return true
          },
          removeIsoContainer: async () => false,
          isMerged: async () => false,
          listScratchDirectories: async () => [],
          listWorktreeLeaves: async () => [],
          listIsoTaskIds: async () => [],
          removeAgedPath: async () => false,
          runPartialCloneGc: async () => ({ scanned: 0, removed: 0 }),
        },
      })
      const seeded = await seedBundleTask(harness, appHome)
      const finish = async () => {
        await patchTaskFixture(
          harness.db,
          { id: seeded.taskId },
          { status: 'done', spaceKind: 'scratch', finishedAt: Date.now() },
        )
        expect(await store.claimWorkspace(seeded.taskId, Date.now())).toBe(true)
      }
      fixture.schedulerDriver.drive = finish
      const coordinator = early
        ? bundle.coordinatorFactory.coordinatorFor({
            admittedContinuation: {
              async run() {
                await finish()
                return { kind: 'terminal-won' }
              },
            },
          })
        : bundle.coordinator
      await expect(
        coordinator.submit({ ...seeded, completionMode: 'await-settle' }),
      ).resolves.toMatchObject({ kind: 'settled' })
      expect(bundle.isTaskActive(seeded.taskId)).toBe(false)
      expect((await seeded.row()).workspacePrunedAt).toBeNull()
      const { taskExecutionMaintenanceClaims } = tablesOf(harness.db)
      expect((await harness.db.select().from(taskExecutionMaintenanceClaims))[0]!.state).toBe(
        'claimed',
      )
      fail = false
      expect(
        await maintenance.recover({
          activeTaskIds: [],
          now: Date.now() + 1000,
          webhookClaims: 'all',
        }),
      ).toMatchObject({ completed: 1, failed: 0 })
      expect((await harness.db.select().from(taskExecutionMaintenanceClaims))[0]!.state).toBe(
        'completed',
      )
      expect((await seeded.row()).workspacePrunedAt).not.toBeNull()
      expect(removes).toBe(2)
    })
})

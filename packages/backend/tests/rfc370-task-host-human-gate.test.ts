// RFC-370 H: original HumanGate atoms and the ten real purpose callers.
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  DAEMON_RESTART_ERROR_SUMMARY,
  isDaemonInterruptionAbortReason,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  tasks,
  taskExecutionOwners,
  committedEvents,
  nodeRuns,
  nodeRunEvents,
  nodeRunOutputs,
  clarifyRounds,
  taskQuestions,
  docVersions,
  collaborationGateOperations,
  collaborationGateArtifacts,
} from '@/db/schema'
import { ClarifyGateOpenPreparation } from '@/modules/collaboration/application/prepareClarifyGateOpen'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'
import { DatabaseClarifyQuestionSnapshotReader } from '@/modules/collaboration/infrastructure/clarifyQuestionSnapshotReader'
import { DatabaseHumanGateOperationJournal } from '@/modules/collaboration/infrastructure/humanGateOperationJournal'
import { DatabaseManualQuestionOpenWriter } from '@/modules/collaboration/infrastructure/manualQuestionOpenWriter'
import { createClarifyRound } from '@/modules/collaboration/infrastructure/clarify/service'
import { dispatchReviewNode } from '@/modules/collaboration/infrastructure/review'
import { selectHumanGateTaskWrites } from '@/modules/task-execution/application/humanGateTaskWriteSelection'
import { selectTaskRuntimeLifecycleWrites } from '@/modules/task-execution/application/taskRuntimeLifecycleWriteSelection'
import type { HumanGateTaskLifecycle } from '@/modules/task-execution/application/ports/humanGateTaskLifecycle'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  taskHostWorkCapture,
  taskHostWorkForToken,
} from '@/modules/task-execution/application/taskHostAdmission'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { composeTaskHostExecutionAdmission } from '@/modules/task-execution/composition/hostExecutionAdmission'
import {
  parkPreparedHumanGate,
  settleManualQuestionParkObligations,
} from '@/modules/task-execution/composition/humanGate'
import type { TaskHostWriteBinding } from '@/modules/task-execution/infrastructure/hostExecutionWriteTransaction'
import { taskStopProjection } from '@/modules/task-execution/public/types'
import { refreshOwnershipToken } from '@/modules/task-execution/domain/ownership'
import {
  databaseSessionFor,
  databaseTransactionIsActive,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import { deferred, nextTurn, taskHostFixture } from './helpers/taskHostExecution'
import { inverseHumanGateTaskSelections } from './helpers/humanGateTaskStatementInverse'
import originalSources from './fixtures/rfc370-task-human-gate-original-sources.json'

const modules: { resetForTesting(): void }[] = []
const homes: string[] = []
afterEach(() => {
  registerAfterCommitEventPump(null)
  for (const module of modules) module.resetForTesting()
  modules.length = 0
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  homes.length = 0
})
const purposes = ['preparation', 'issuedResults'] as const
type Purpose = (typeof purposes)[number]
const atoms = [
  'parkPrepared',
  'settleManualQuestionParks',
  'trySetWhenNoManualQuestionParks',
] as const
type Atom = (typeof atoms)[number]
const NOW = 1_000
const enginePath =
  'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts'

async function fixture(db: ProviderNeutralDatabase) {
  const taskId = `human-gate-${ulid()}`
  const h = await taskHostFixture(db, taskId)
  modules.push(h.module)
  const calls = { preparation: 0, issuedResults: 0 }
  const controls: {
    beforeConsume?: (purpose: Purpose, tx: DatabaseTransaction) => Promise<void>
    reject?: Error
  } = {}
  const transactions: DatabaseTransaction[] = []
  const port = h.binding.port
  const binding: TaskHostWriteBinding = {
    transactionFor(tx) {
      expect(this).toBe(binding)
      expect(databaseTransactionIsActive(tx)).toBe(true)
      transactions.push(tx)
      return h.binding.transactionFor.call(h.binding, tx)
    },
    port: {
      capture(input) {
        return port.capture.call(port, input)
      },
      consumeRecovery(...args) {
        return port.consumeRecovery.call(port, ...args)
      },
      async consumeNewWork(...args) {
        calls.preparation++
        await controls.beforeConsume?.('preparation', transactions.at(-1)!)
        if (controls.reject !== undefined) throw controls.reject
        await port.consumeNewWork.call(port, ...args)
      },
      async consumeIssuedAck(...args) {
        calls.issuedResults++
        await controls.beforeConsume?.('issuedResults', transactions.at(-1)!)
        if (controls.reject !== undefined) throw controls.reject
        await port.consumeIssuedAck.call(port, ...args)
      },
    },
  }
  const presence = { exists: async () => true }
  const persistence = createTaskExecutionPersistence(db, {
    hostWrites: binding,
    workspacePresence: presence,
  })
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `human-gate-daemon-${taskId}`,
    persistence,
    host: {
      admission: composeTaskHostExecutionAdmission({ admission: h.source, writes: binding.port }),
      writes: binding,
    },
  })
  modules.push(module)
  const claimed = await module.claimPersisted({ intentId: h.intentId })
  module.claimGate.leave(claimed.permit)
  const work = taskHostWorkForToken(claimed.token)
  if (work === undefined) throw new Error('original-human-gate-work-missing')
  const context = createTaskExecutionContext({
    intentId: h.intentId,
    token: claimed.token,
    persistence,
    legacyConnection: db,
    hostWriteCapture: taskHostWorkCapture(work),
  })
  await db
    .update(tasks)
    .set({
      status: 'running',
      runningSince: 100,
      runningMs: 5,
      lifecycleEventRevision: 7,
      spaceKind: 'scratch',
    })
    .where(eq(tasks.id, taskId))
  await db.insert(nodeRuns).values({
    id: `${taskId}-asking`,
    taskId,
    nodeId: 'writer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  calls.preparation = 0
  calls.issuedResults = 0
  transactions.length = 0
  return {
    db,
    taskId,
    h,
    module,
    persistence,
    context,
    work,
    binding,
    presence,
    calls,
    controls,
    transactions,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function task(f: Fixture, db = f.db) {
  return db.select().from(tasks).where(eq(tasks.id, f.taskId)).get()
}
async function snapshot(f: Fixture, db: ProviderNeutralDatabase = f.db) {
  return {
    task: await task(f, db),
    owners: await db.select().from(taskExecutionOwners).orderBy(taskExecutionOwners.taskId),
    operations: await db
      .select()
      .from(collaborationGateOperations)
      .orderBy(collaborationGateOperations.id),
    artifacts: await db
      .select()
      .from(collaborationGateArtifacts)
      .orderBy(collaborationGateArtifacts.operationId, collaborationGateArtifacts.artifactKey),
    nodes: await db.select().from(nodeRuns).orderBy(nodeRuns.id),
    nodeEvents: await db.select().from(nodeRunEvents).orderBy(nodeRunEvents.id),
    rounds: await db.select().from(clarifyRounds).orderBy(clarifyRounds.id),
    questions: await db.select().from(taskQuestions).orderBy(taskQuestions.id),
    documents: await db.select().from(docVersions).orderBy(docVersions.id),
    events: await db.select().from(committedEvents).orderBy(committedEvents.id),
  }
}
async function prepared(f: Fixture) {
  const result = await new ClarifyGateOpenPreparation(
    new DatabaseHumanGateOperationPersistence(databaseSessionFor(f.db)),
    new DatabaseClarifyQuestionSnapshotReader(f.db),
  ).prepare({
    taskId: f.taskId,
    kind: 'self',
    askingNodeId: 'writer',
    askingNodeRunId: `${f.taskId}-asking`,
    askingShardKey: null,
    intermediaryNodeId: 'clarify',
    targetConsumerNodeId: null,
    parentNodeRunId: null,
    loopIter: 0,
    iteration: 0,
    questionsJson: '[{"id":"original-question","title":"Original question?"}]',
    questions: [{ id: 'original-question', title: 'Original question?' }],
    truncationWarningsJson: null,
    sourceSnapshotDigest: 'a'.repeat(64),
    idempotencyKey: `original-open:${f.taskId}`,
    expectedTaskRevision: 7,
    now: NOW,
  })
  if (result.kind !== 'prepared') throw new Error('expected original prepared gate')
  return result
}
async function manualQuestion(f: Fixture) {
  return new DatabaseManualQuestionOpenWriter(f.db, new DatabaseHumanGateOperationJournal()).create(
    {
      taskId: f.taskId,
      title: 'Original manual question?',
      body: 'Original body',
      targetNodeId: 'writer',
      actorUserId: 'original-user',
      now: NOW,
    },
  )
}
async function atom(f: Fixture, name: Atom, purpose: Purpose) {
  const view = selectHumanGateTaskWrites(f.persistence, purpose)
  if (name === 'parkPrepared') {
    const opening = await prepared(f)
    return () =>
      runWithTaskExecutionContext(f.context, () =>
        view.parkPrepared({ prepared: opening.prepared, token: f.context.token, now: NOW + 1 }),
      )
  }
  if (name === 'settleManualQuestionParks') {
    await manualQuestion(f)
    return () =>
      runWithTaskExecutionContext(f.context, () =>
        view.settleManualQuestionParks({ taskId: f.taskId, token: f.context.token, now: NOW + 1 }),
      )
  }
  return () =>
    runWithTaskExecutionContext(f.context, () =>
      view.trySetWhenNoManualQuestionParks({
        taskId: f.taskId,
        to: 'done',
        allowedFrom: ['running'],
        extra: { finishedAt: NOW + 1 },
        executionContext: f.context,
        now: NOW + 1,
        reason: 'original-human-gate-result',
      }),
    )
}
function causes(error: unknown): unknown[] {
  const found: unknown[] = []
  for (
    let next = error;
    next !== undefined && !found.includes(next);
    next = typeof next === 'object' && next !== null && 'cause' in next ? next.cause : undefined
  )
    found.push(next)
  return found
}
async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run
  } catch (error) {
    return error
  }
  throw new Error('expected original operation rejection')
}
function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(new URL('../../../' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}
function evaluate<T>(text: string, environment: Readonly<Record<string, unknown>>): T {
  const result = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  return new Function(...Object.keys(environment), result.outputText)(
    ...Object.values(environment),
  ) as T
}
/** Interpret the actual result-settle statements, including both original while-loops. */
function originalEngineTail(
  f: Fixture,
  result: { kind: string },
  persistence: TaskExecutionPersistence = f.persistence,
  signal?: AbortSignal,
): Promise<void> {
  const file = parse(enginePath)
  const functions = file.statements.filter(ts.isFunctionDeclaration)
  const engine = functions.find((node) => node.name?.text === 'runTaskEngineOrchestratorInner')
  if (engine?.body === undefined) throw new Error('original-human-gate-engine-missing')
  const statements = engine.body.statements
  const start = statements.findIndex((statement) =>
    statement.getText(file).startsWith("if (result.kind !== 'canceled'"),
  )
  if (start < 0) throw new Error('original-human-gate-engine-settle-missing')
  const helpers = functions
    .filter((node) =>
      ['taskStopCauseFromUnknown', 'failRuntimeTask', 'cancelRuntimeTask'].includes(
        node.name?.text ?? '',
      ),
    )
    .map((node) => node.getText(file))
    .join('\n')
  return evaluate<Promise<void>>(
    helpers +
      '\nreturn (async () => {\n' +
      statements
        .slice(start)
        .map((statement) => statement.getText(file))
        .join('\n') +
      '\n})()',
    {
      taskId: f.taskId,
      opts: { taskId: f.taskId, persistence, executionContext: f.context, signal },
      result,
      log: createLogger('rfc370-human-gate-tail'),
      selectHumanGateTaskWrites,
      selectTaskRuntimeLifecycleWrites,
      taskStopProjection,
      isDaemonInterruptionAbortReason,
      DAEMON_RESTART_ERROR_SUMMARY,
      withTaskReviewMutationLock,
      createLogger,
      Date: { now: () => NOW },
    },
  )
}
function initialManualPark(
  f: Fixture,
): ReturnType<HumanGateTaskLifecycle['settleManualQuestionParks']> {
  const file = parse(enginePath)
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'initialManualPark')
      expression = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (expression === undefined) throw new Error('original-initial-manual-park-missing')
  return evaluate('return (async () => (' + expression.getText(file) + '))()', {
    taskId: f.taskId,
    opts: { persistence: f.persistence, executionContext: f.context },
    selectHumanGateTaskWrites,
    Date: { now: () => NOW },
  })
}

describeEachProvider('RFC-370 original HumanGate purposes retain their transactions', (harness) => {
  test('native selectors retain the same whole adapter; incomplete selected views fail', async () => {
    const f = await fixture(harness.db)
    const native = createTaskExecutionPersistence(f.db, { workspacePresence: f.presence })
    for (const purpose of purposes) {
      expect(selectHumanGateTaskWrites(native, purpose)).toBe(native.humanGateLifecycle)
      expect(() =>
        selectHumanGateTaskWrites({ ...native, humanGateWriteMode: 'host-selected' }, purpose),
      ).toThrow('human-gate-task-write-purposes-not-composed')
    }
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 0 })
  })

  for (const purpose of purposes)
    for (const name of atoms) {
      test(`${purpose}/${name}: original rows precede consumption in the real transaction`, async () => {
        const f = await fixture(harness.db)
        const run = await atom(f, name, purpose)
        const before = await snapshot(f)
        let held: Awaited<ReturnType<typeof snapshot>> | undefined
        f.controls.beforeConsume = async (actualPurpose, tx) => {
          expect(actualPurpose).toBe(purpose)
          expect(databaseTransactionIsActive(tx)).toBe(true)
          held = await snapshot(f, tx)
          expect(held.task?.status).toBe(
            name === 'trySetWhenNoManualQuestionParks' ? 'done' : 'awaiting_human',
          )
          expect(held.task?.lifecycleEventRevision).toBe(8)
          expect(held.owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
          expect(held.events.length).toBeGreaterThan(before.events.length)
          if (name !== 'trySetWhenNoManualQuestionParks')
            expect(held.operations.at(-1)?.state).toBe('completed')
        }
        const result = await run()
        expect(held).toEqual(await snapshot(f))
        if (name === 'parkPrepared')
          expect(result).toMatchObject({ taskRevision: 8, gateRevision: 1 })
        if (name === 'settleManualQuestionParks')
          expect(result).toMatchObject({ parked: true, taskRevision: 8 })
        if (name === 'trySetWhenNoManualQuestionParks')
          expect(result).toEqual({ kind: 'settled', won: true })
        expect(f.calls[purpose]).toBe(1)
        expect(f.calls[purpose === 'preparation' ? 'issuedResults' : 'preparation']).toBe(0)
        expect(f.transactions).toHaveLength(1)
        expect(databaseTransactionIsActive(f.transactions[0]!)).toBe(false)
        expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
      })

      test(`${purpose}/${name}: host rejection rolls back every original row and retries the same work`, async () => {
        const f = await fixture(harness.db)
        const run = await atom(f, name, purpose)
        const before = await snapshot(f)
        const error = new Error('original-human-gate-host-rejected')
        f.controls.reject = error
        expect(causes(await rejection(run()))).toContain(error)
        expect(await snapshot(f)).toEqual(before)
        expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
        delete f.controls.reject
        await run()
        expect(f.calls[purpose]).toBe(2)
        expect((await task(f))?.lifecycleEventRevision).toBe(8)
        expect((await snapshot(f)).owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
      })

      test(`${purpose}/${name}: host wait keeps the call pending and publication follows COMMIT`, async () => {
        const f = await fixture(harness.db)
        const run = await atom(f, name, purpose)
        const entered = deferred(),
          release = deferred()
        let settled = false,
          published = 0,
          publisherRejected = false
        f.controls.beforeConsume = async (_, tx) => {
          expect(databaseTransactionIsActive(tx)).toBe(true)
          entered.resolve()
          await release.promise
        }
        registerAfterCommitEventPump({
          async publishNow(refs) {
            published++
            expect(refs.length).toBeGreaterThan(0)
            expect(f.transactions.every((tx) => !databaseTransactionIsActive(tx))).toBe(true)
            expect((await task(f))?.lifecycleEventRevision).toBe(8)
            publisherRejected = true
            throw new Error('original-human-gate-publisher-rejection')
          },
          nudge() {},
        })
        const pending = run().finally(() => {
          settled = true
        })
        try {
          await entered.promise
          await nextTurn()
          expect(settled).toBe(false)
          expect(published).toBe(0)
          release.resolve()
          await pending
          expect(settled).toBe(true)
          expect(published).toBe(1)
          expect(publisherRejected).toBe(true)
          expect((await task(f))?.lifecycleEventRevision).toBe(8)
        } finally {
          release.resolve()
          await pending
        }
      })
    }

  for (const purpose of purposes) {
    for (const name of atoms) {
      test(`${purpose}/${name}: original input and context survive the first durable await`, async () => {
        const f = await fixture(harness.db)
        const view = selectHumanGateTaskWrites(f.persistence, purpose)
        let pending: Promise<unknown>
        if (name === 'parkPrepared') {
          const opening = await prepared(f)
          const input = {
            prepared: opening.prepared,
            token: f.context.token as typeof f.context.token | undefined,
            now: NOW + 1,
          }
          pending = runWithTaskExecutionContext(f.context, () => view.parkPrepared(input))
          input.prepared = { ...opening.prepared, taskId: 'later-input' }
          input.token = undefined
          input.now = NOW + 9_999
        } else if (name === 'settleManualQuestionParks') {
          await manualQuestion(f)
          const input = {
            taskId: f.taskId,
            token: f.context.token as typeof f.context.token | undefined,
            now: NOW + 1,
          }
          pending = runWithTaskExecutionContext(f.context, () =>
            view.settleManualQuestionParks(input),
          )
          input.taskId = 'later-input'
          input.token = undefined
          input.now = NOW + 9_999
        } else {
          const input: Parameters<HumanGateTaskLifecycle['trySetWhenNoManualQuestionParks']>[0] = {
            taskId: f.taskId,
            to: 'done',
            allowedFrom: ['running'],
            extra: { finishedAt: NOW + 1 },
            executionContext: f.context,
            now: NOW + 1,
            reason: 'original-captured-result',
          }
          pending = runWithTaskExecutionContext(f.context, () =>
            view.trySetWhenNoManualQuestionParks(input),
          )
          Object.assign(input, {
            taskId: 'later-input',
            executionContext: undefined,
            now: NOW + 9_999,
          })
          ;(input.allowedFrom as string[]).splice(0, 1, 'pending')
          Object.assign(input.extra!, { finishedAt: NOW + 9_999 })
        }
        await pending
        const actual = await snapshot(f)
        expect(actual.task?.lifecycleEventRevision).toBe(8)
        expect(actual.owners.find((owner) => owner.taskId === f.taskId)?.updatedAt).toBe(NOW + 1)
        expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
        expect(f.calls[purpose]).toBe(1)
      })
    }

    test(`${purpose}: empty settle and native false/pending remain distinct`, async () => {
      const f = await fixture(harness.db)
      const view = selectHumanGateTaskWrites(f.persistence, purpose)
      expect(
        await runWithTaskExecutionContext(f.context, () =>
          view.settleManualQuestionParks({ taskId: f.taskId, token: f.context.token, now: NOW }),
        ),
      ).toEqual({ parked: false, taskRevision: 7, operationIds: [], eventRefs: [] })
      const before = await snapshot(f)
      expect(
        await runWithTaskExecutionContext(f.context, () =>
          view.trySetWhenNoManualQuestionParks({
            taskId: f.taskId,
            to: 'done',
            allowedFrom: ['pending'],
            executionContext: f.context,
            now: NOW,
            reason: 'original-false',
          }),
        ),
      ).toEqual({ kind: 'settled', won: false })
      expect(await snapshot(f)).toEqual(before)
      await manualQuestion(f)
      const pendingBefore = await snapshot(f)
      expect(
        await runWithTaskExecutionContext(f.context, () =>
          view.trySetWhenNoManualQuestionParks({
            taskId: f.taskId,
            to: 'done',
            allowedFrom: ['running'],
            executionContext: f.context,
            now: NOW,
            reason: 'original-pending',
          }),
        ),
      ).toEqual({ kind: 'manual-question-pending' })
      expect(await snapshot(f)).toEqual(pendingBefore)
      expect(f.calls[purpose]).toBe(1)
    })

    test(`${purpose}: original prepared input errors and ownerless input do not become owned`, async () => {
      const f = await fixture(harness.db)
      const opening = await prepared(f)
      const view = selectHumanGateTaskWrites(f.persistence, purpose)
      const before = await snapshot(f)
      for (const change of [{ taskId: '' }, { expectedTaskRevision: -1 }, { manifestDigest: '' }]) {
        expect(
          causes(
            await rejection(
              view.parkPrepared({
                prepared: { ...opening.prepared, ...change },
                token: f.context.token,
                now: NOW,
              }),
            ),
          ),
        ).toEqual([
          expect.objectContaining({ message: 'prepared-human-gate-task-or-manifest-mismatch' }),
        ])
      }
      expect(
        await rejection(
          runWithTaskExecutionContext(f.context, () =>
            view.parkPrepared({ prepared: opening.prepared, now: NOW }),
          ),
        ),
      ).toBeDefined()
      expect(await snapshot(f)).toEqual(before)
      expect(f.calls).toEqual({ preparation: 0, issuedResults: 0 })
    })

    test(`${purpose}: prepared revision failure retains the original error and all projections`, async () => {
      const f = await fixture(harness.db)
      const opening = await prepared(f)
      await f.db.update(tasks).set({ lifecycleEventRevision: 8 }).where(eq(tasks.id, f.taskId))
      const before = await snapshot(f)
      const input = { prepared: opening.prepared, token: f.context.token, now: NOW }
      const native = causes(
        await rejection(f.persistence.humanGateLifecycle.parkPrepared(input)),
      ).at(-1)
      const selected = causes(
        await rejection(
          runWithTaskExecutionContext(f.context, () =>
            selectHumanGateTaskWrites(f.persistence, purpose).parkPrepared(input),
          ),
        ),
      ).at(-1)
      expect(native).toBeInstanceOf(Error)
      expect(selected).toBeInstanceOf(Error)
      expect((selected as Error).constructor).toBe((native as Error).constructor)
      expect((selected as Error).message).toBe((native as Error).message)
      expect(await snapshot(f)).toEqual(before)
      expect(f.calls).toEqual({ preparation: 0, issuedResults: 0 })
    })

    test(`${purpose}: settled manual obligation keeps its empty result; terminal Task keeps obligations untouched`, async () => {
      const f = await fixture(harness.db)
      const question = await manualQuestion(f)
      await f.db
        .update(taskQuestions)
        .set({ autoDispatchDeferredAt: NOW + 1 })
        .where(eq(taskQuestions.id, question.id))
      const view = selectHumanGateTaskWrites(f.persistence, purpose)
      const before = await snapshot(f)
      expect(
        await runWithTaskExecutionContext(f.context, () =>
          view.settleManualQuestionParks({
            taskId: f.taskId,
            token: f.context.token,
            now: NOW + 2,
          }),
        ),
      ).toEqual({
        parked: false,
        taskRevision: 7,
        operationIds: [question.operation.id],
        eventRefs: [],
      })
      const settled = await snapshot(f)
      expect(settled.task).toEqual(before.task)
      expect(settled.events).toEqual(before.events)
      expect(settled.operations[0]?.state).toBe('completed')
      await manualQuestion(f)
      await f.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, f.taskId))
      const terminal = await snapshot(f)
      expect(
        await runWithTaskExecutionContext(f.context, () =>
          view.settleManualQuestionParks({
            taskId: f.taskId,
            token: f.context.token,
            now: NOW + 3,
          }),
        ),
      ).toEqual({ parked: false, taskRevision: null, operationIds: [], eventRefs: [] })
      const after = await snapshot(f)
      expect(after.task).toEqual(terminal.task)
      expect(after.operations).toEqual(terminal.operations)
      expect(after.events).toEqual(terminal.events)
      expect(f.calls[purpose]).toBe(2)
    })

    test(`${purpose}: original serializable body is wholly replayed after 40001`, async () => {
      const f = await fixture(harness.db)
      const run = await atom(f, 'parkPrepared', purpose)
      const before = await snapshot(f)
      let attempts = 0
      f.controls.beforeConsume = async (_, tx) => {
        attempts++
        expect((await task(f, tx))?.lifecycleEventRevision).toBe(8)
        if (attempts === 1)
          throw Object.assign(new Error('original-serialization-retry'), { code: '40001' })
      }
      const recording = harness.recordStatements()
      try {
        if (harness.capabilities.isolation === 'exclusive') {
          expect(await rejection(run())).toBeDefined()
          expect(await snapshot(f)).toEqual(before)
          expect(attempts).toBe(1)
        } else {
          await run()
          expect(attempts).toBe(2)
          expect((await snapshot(f)).owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
          expect((await task(f))?.lifecycleEventRevision).toBe(8)
          expect(
            recording.statements.filter((s) =>
              /SET TRANSACTION ISOLATION LEVEL SERIALIZABLE/i.test(s.sql),
            ),
          ).toHaveLength(2)
        }
      } finally {
        recording.stop()
      }
      expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
    })
  }

  test('selected public composition uses the original ownership binding and explicit dependency precedence', async () => {
    const f = await fixture(harness.db)
    const opening = await prepared(f)
    let explicitConsumed = 0
    const explicit: TaskHostWriteBinding = {
      transactionFor(tx) {
        expect(this).toBe(explicit)
        explicitConsumed++
        return f.binding.transactionFor.call(f.binding, tx)
      },
      port: f.binding.port,
    }
    await parkPreparedHumanGate({
      db: f.db,
      prepared: opening.prepared,
      executionContext: f.context,
      writePurpose: 'issuedResults',
      hostWrites: explicit,
      workspacePresence: f.presence,
      now: NOW,
    })
    expect(explicitConsumed).toBe(1)
    expect((await task(f))?.status).toBe('awaiting_human')
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
  })

  test('selected public paths reject missing binding, view and original work without native fallback', async () => {
    const f = await fixture(harness.db)
    const native = createTaskExecutionPersistence(f.db)
    const before = await snapshot(f)
    const badContexts = [
      {
        persistence: { ...f.persistence, ownership: native.ownership },
        token: f.context.token,
        message: 'human-gate-task-host-binding-not-composed',
      },
      {
        persistence: { ...f.persistence, humanGateWritePurposes: undefined },
        token: f.context.token,
        message: 'human-gate-task-write-purposes-not-composed',
      },
      {
        persistence: f.persistence,
        token: refreshOwnershipToken({
          token: f.context.token,
          leaseUntil: f.context.token.leaseUntil,
          ownerRevision: f.context.token.ownerRevision,
        }),
        message: 'task-host-admitted-work-required',
      },
    ]
    for (const bad of badContexts) {
      const context = createTaskExecutionContext({
        intentId: f.h.intentId,
        token: bad.token,
        persistence: bad.persistence,
      })
      expect(
        causes(
          await rejection(
            settleManualQuestionParkObligations({
              db: f.db,
              taskId: f.taskId,
              executionContext: context,
              writePurpose: 'issuedResults',
              now: NOW,
            }),
          ),
        ).some((cause) => cause instanceof Error && cause.message === bad.message),
      ).toBe(true)
    }
    expect(
      await rejection(
        settleManualQuestionParkObligations({
          db: f.db,
          taskId: f.taskId,
          executionContext: f.context,
          now: NOW,
        }),
      ),
    ).toBeDefined()
    expect(
      await rejection(
        selectHumanGateTaskWrites(f.persistence, 'issuedResults').settleManualQuestionParks({
          taskId: f.taskId,
          token: f.context.token,
          now: NOW,
        }),
      ),
    ).toBeDefined()
    expect(await snapshot(f)).toEqual(before)
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 0 })
  })

  test('H10 real Clarify producer records the original Agent result while draining; new preparation remains refused', async () => {
    const f = await fixture(harness.db)
    await f.h.selected.context.drain(f.h.receipt)
    f.h.lose()
    const result = await createClarifyRound({
      db: f.db,
      kind: 'self',
      taskId: f.taskId,
      executionContext: f.context,
      askingNodeId: 'writer',
      askingNodeRunId: `${f.taskId}-asking`,
      askingShardKey: null,
      intermediaryNodeId: 'clarify',
      iteration: 0,
      questions: [
        {
          id: 'original-question',
          title: 'Original question?',
          kind: 'single',
          recommended: false,
          options: [
            {
              label: 'First choice',
              description: '',
              recommended: false,
              recommendationReason: '',
            },
            {
              label: 'Second choice',
              description: '',
              recommended: false,
              recommendationReason: '',
            },
          ],
        },
      ],
      now: () => NOW,
    })
    expect(result.round.status).toBe('awaiting_human')
    expect((await task(f))?.status).toBe('awaiting_human')
    expect((await snapshot(f)).rounds).toHaveLength(1)
    expect((await snapshot(f)).questions).toHaveLength(1)
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
    const before = await snapshot(f)
    expect(
      await rejection(
        runWithTaskExecutionContext(f.context, () =>
          selectHumanGateTaskWrites(f.persistence, 'preparation').trySetWhenNoManualQuestionParks({
            taskId: f.taskId,
            to: 'running',
            allowedFrom: ['awaiting_human'],
            executionContext: f.context,
            now: NOW + 1,
            reason: 'new-dispatch-preparation',
          }),
        ),
      ),
    ).toBeDefined()
    expect(await snapshot(f)).toEqual(before)
  })

  for (const draining of [false, true]) {
    test(`H09 real Review producer ${draining ? 'rolls back a new gate while draining' : 'opens a gate through the selected public path'}`, async () => {
      const f = await fixture(harness.db)
      const home = mkdtempSync(join(tmpdir(), 'aw-rfc370-human-review-'))
      homes.push(home)
      const definition: WorkflowDefinition = {
        $schema_version: 4,
        inputs: [],
        nodes: [
          { id: 'writer', kind: 'agent-single', agentName: 'writer' } as WorkflowNode,
          {
            id: 'review',
            kind: 'review',
            inputSource: { nodeId: 'writer', portName: 'text' },
          } as unknown as WorkflowNode,
        ],
        edges: [],
      }
      await f.db.insert(nodeRunOutputs).values({
        nodeRunId: `${f.taskId}-asking`,
        portName: 'text',
        content: '# Original review body',
        kind: 'markdown',
      })
      if (draining) await f.h.selected.context.drain(f.h.receipt)
      const before = await snapshot(f)
      const pending = runWithTaskExecutionContext(f.context, () =>
        dispatchReviewNode({
          db: f.db,
          taskId: f.taskId,
          appHome: home,
          definition,
          node: definition.nodes[1]!,
          iteration: 0,
          scopeRoot: home,
        }),
      )
      if (draining) {
        const failure = await rejection(pending)
        expect(failure).toBeDefined()
        const after = await snapshot(f)
        expect(after.task).toEqual(before.task)
        expect(after.owners).toEqual(before.owners)
        expect(after.nodes).toEqual(before.nodes)
        expect(after.documents).toEqual([])
        expect(after.operations).toHaveLength(1)
        expect(after.operations[0]?.state).toBe('prepared')
        expect(after.events).toEqual(before.events)
      } else {
        expect((await pending).kind).toBe('awaiting_review')
        expect((await task(f))?.status).toBe('awaiting_review')
        expect((await snapshot(f)).documents).toHaveLength(1)
      }
      expect(f.calls).toEqual({ preparation: 1, issuedResults: 0 })
    })
  }

  test('H01 actual initial manual park consumes its durable obligation through issuedResults', async () => {
    const f = await fixture(harness.db)
    await manualQuestion(f)
    const result = await runWithTaskExecutionContext(f.context, () => initialManualPark(f))
    expect(result.parked).toBe(true)
    expect((await task(f))?.status).toBe('awaiting_human')
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
  })

  for (const kind of ['awaiting_review', 'done']) {
    test(`H02 and ${kind === 'done' ? 'H06/H07' : 'H03/H04'}: actual engine settle preserves canonical running and result purpose`, async () => {
      const f = await fixture(harness.db)
      await f.db
        .update(tasks)
        .set({ status: kind === 'done' ? 'awaiting_review' : 'awaiting_human' })
        .where(eq(tasks.id, f.taskId))
      await f.h.selected.context.drain(f.h.receipt)
      await runWithTaskExecutionContext(f.context, () => originalEngineTail(f, { kind }))
      expect((await task(f))?.status).toBe(kind === 'done' ? 'done' : 'awaiting_review')
      expect((await task(f))?.lifecycleEventRevision).toBe(9)
      expect(f.calls).toEqual({ preparation: 0, issuedResults: 3 })
      expect((await snapshot(f)).nodes).toHaveLength(1)
    })

    test(`${kind === 'done' ? 'H08' : 'H05'}: actual while-loop yields the already-computed outcome to a late manual obligation`, async () => {
      const f = await fixture(harness.db)
      await f.db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, f.taskId))
      let reads = 0
      const originalDrive = f.persistence.drive
      const drive = {
        load: originalDrive.load.bind(originalDrive),
        updateWorkspaceProfile: originalDrive.updateWorkspaceProfile.bind(originalDrive),
        async findStatus(taskId: string) {
          reads++
          if (reads === 1) await manualQuestion(f)
          return originalDrive.findStatus(taskId)
        },
      }
      await runWithTaskExecutionContext(f.context, () =>
        originalEngineTail(f, { kind }, { ...f.persistence, drive }),
      )
      expect(reads).toBe(1)
      expect((await task(f))?.status).toBe('awaiting_human')
      expect((await snapshot(f)).operations[0]?.state).toBe('completed')
      expect(f.calls).toEqual({ preparation: 0, issuedResults: 2 })
      expect((await snapshot(f)).nodes).toHaveLength(1)
    })
  }

  test('actual engine cancellation retains priority and performs no HumanGate projection', async () => {
    const f = await fixture(harness.db)
    await manualQuestion(f)
    const signal = new AbortController()
    signal.abort({ kind: 'user' })
    const before = await snapshot(f)
    await runWithTaskExecutionContext(f.context, () =>
      originalEngineTail(f, { kind: 'done' }, f.persistence, signal.signal),
    )
    const after = await snapshot(f)
    expect(after.task?.status).toBe('canceled')
    expect(after.operations).toEqual(before.operations)
    expect(after.questions).toEqual(before.questions)
    expect(after.nodes).toEqual(before.nodes)
    expect(f.calls).toEqual({ preparation: 0, issuedResults: 1 })
  })
})

test('finite HumanGate inverse restores every complete original production source before the lifecycle inverse', () => {
  for (const original of originalSources.files) {
    const current = parse(original.path)
    const restored = inverseHumanGateTaskSelections(current)
    expect(Buffer.byteLength(restored.text)).toBe(original.bytes)
    expect(createHash('sha256').update(restored.text).digest('hex')).toBe(original.sha256)
    const changed = ts.createSourceFile(
      current.fileName,
      current.text + '\n// unreviewed original-body change\n',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const inverse = inverseHumanGateTaskSelections(changed)
    expect(createHash('sha256').update(inverse.text).digest('hex')).not.toBe(original.sha256)
  }
  const printer = ts.createPrinter({ removeComments: true })
  for (const original of originalSources.calls) {
    const file = parse(original.path)
    const calls: ts.CallExpression[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (original.path === enginePath
          ? ['settleManualQuestionParks', 'trySetWhenNoManualQuestionParks'].includes(
              node.expression.name.text,
            )
          : node.expression.getText(file) === 'humanGateComposition.parkPreparedHumanGate')
      )
        calls.push(node)
      ts.forEachChild(node, walk)
    }
    walk(file)
    const population = originalSources.calls.filter((entry) => entry.path === original.path)
    expect(calls).toHaveLength(population.length)
    const current = calls[population.findIndex((entry) => entry.id === original.id)]!
    const args = [...current.arguments]
    if (original.path === enginePath) {
      const receiver = (current.expression as ts.PropertyAccessExpression).expression
      expect(ts.isCallExpression(receiver)).toBe(true)
      if (!ts.isCallExpression(receiver)) throw new Error('original-H-selection-missing')
      expect(receiver.expression.getText(file)).toBe('selectHumanGateTaskWrites')
      expect(receiver.arguments.map((arg) => arg.getText(file))).toEqual([
        'opts.persistence',
        "'issuedResults'",
      ])
    } else {
      const input = args[0]!
      if (!ts.isObjectLiteralExpression(input)) throw new Error('original-H-producer-input-missing')
      const purpose = input.properties.filter(
        (property) =>
          ts.isPropertyAssignment(property) && property.name.getText(file) === 'writePurpose',
      )
      expect(purpose).toHaveLength(1)
      expect((purpose[0] as ts.PropertyAssignment).initializer.getText(file)).toBe(
        "'" + original.purpose + "'",
      )
      args[0] = ts.factory.updateObjectLiteralExpression(
        input,
        ts.factory.createNodeArray(
          input.properties.filter((property) => !purpose.includes(property)),
          input.properties.hasTrailingComma,
        ),
      )
    }
    expect(args.map((arg) => printer.printNode(ts.EmitHint.Unspecified, arg, file))).toEqual(
      original.originalArguments,
    )
  }
  expect(originalSources.calls.map((call) => call.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => 'H' + String(i + 1).padStart(2, '0')),
  )
})

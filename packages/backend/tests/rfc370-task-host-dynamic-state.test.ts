// RFC-370 C2-W2-D: original generation checkpoints and the next Node preparation.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  DwStateSchema,
  initialDwState,
  WorkgroupRuntimeConfigSchema,
  type DwState,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, nodeRuns, tasks, taskExecutionOwners, workgroupTaskState } from '@/db/schema'
import {
  createTaskExecutionContext,
  currentTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  taskHostWorkCapture,
  taskHostWorkForToken,
} from '@/modules/task-execution/application/taskHostAdmission'
import { selectDynamicWorkflowStateWrites } from '@/modules/task-execution/application/dynamicWorkflowWriteSelection'
import { selectTaskNodeRunWrites } from '@/modules/task-execution/application/taskNodeWriteSelection'
import { composeDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import { DrizzleDynamicWorkflowPersistence } from '@/modules/task-execution/infrastructure/dynamicWorkflowPersistence'
import type { TaskHostWriteBinding } from '@/modules/task-execution/infrastructure/hostExecutionWriteTransaction'
import type {
  WorkgroupTurnHostOperations,
  WorkgroupTurnHostRequest,
  WorkgroupTurnHostResult,
} from '@/modules/task-execution/application/ports/workgroupTurnsOperations'
import {
  databaseTransactionIsActive,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { acquireWriterLease } from '@/platform/persistence/writerLease'
import {
  DW_GATE_CAUSE,
  DW_GENERATE_CAUSE,
  DW_MAX_GENERATE_ATTEMPTS,
  runDynamicWorkflowGenerate,
} from '@/services/dynamicWorkflowRunner'
import { DW_ORCHESTRATOR_NODE_ID, ORCHESTRATOR_WORKFLOW_PORT } from '@/services/orchestratorAgent'
import { buildWorkflowValidationContext } from '@/services/workflow.validator'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import {
  additionalTaskHostFixture,
  taskHostFixture,
  type TaskHostWorkFixture,
} from './helpers/taskHostExecution'

const modules: { resetForTesting(): void }[] = []
afterEach(() => {
  for (const module of modules) module.resetForTesting()
  modules.length = 0
})
const log = createLogger('rfc370-dynamic-state-test')
const purposes = ['preparation', 'issuedResults'] as const

async function claimContext(h: TaskHostWorkFixture) {
  const claimed = await h.claim()
  h.module.claimGate.leave(claimed.permit)
  const work = taskHostWorkForToken(claimed.token)
  if (work === undefined) throw new Error('missing-original-dynamic-work')
  const context = createTaskExecutionContext({
    intentId: h.intentId,
    token: claimed.token,
    persistence: h.persistence,
    legacyConnection: h.db,
    compatibility: { db: h.db },
    hostWriteCapture: taskHostWorkCapture(work),
  })
  return { context, work }
}

async function dynamicFixture(
  db: ProviderNeutralDatabase,
  options: Parameters<typeof taskHostFixture>[2] = {},
  dw: DwState = initialDwState(),
) {
  const taskId = `dynamic-state-${ulid()}`
  const calls = { newWork: 0, issuedAck: 0 }
  const h = await taskHostFixture(db, taskId, {
    ...options,
    beforeNewWork() {
      calls.newWork++
      options.beforeNewWork?.()
    },
    beforeIssuedAck() {
      calls.issuedAck++
      options.beforeIssuedAck?.()
    },
  })
  modules.push(h.module)
  const original = await claimContext(h)
  const agentId = `member-${taskId}`
  await db.insert(agents).values({ id: agentId, name: agentId, outputs: '["answer"]' })
  const config: WorkgroupRuntimeConfig = {
    workgroupId: `group-${taskId}`,
    workgroupName: taskId,
    mode: 'dynamic_workflow',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    instructions: 'original dynamic charter',
    goal: 'original dynamic goal',
    members: [
      {
        id: 'member-one',
        memberType: 'agent',
        agentId,
        agentName: agentId,
        userId: null,
        displayName: 'original-member',
        roleDesc: 'answer',
      },
    ],
  }
  expect(WorkgroupRuntimeConfigSchema.parse(config)).toEqual(config)
  await db
    .update(tasks)
    .set({ workgroupId: config.workgroupId, workgroupConfigJson: JSON.stringify(config) })
    .where(eq(tasks.id, taskId))
  await db.insert(workgroupTaskState).values({
    taskId,
    gateStatus: 'idle',
    dwStateJson: JSON.stringify(dw),
    updatedAt: 10,
  })
  const transactions: DatabaseTransaction[] = []
  const originalBinding = h.binding
  const binding: TaskHostWriteBinding = {
    port: originalBinding.port,
    transactionFor(tx) {
      expect(databaseTransactionIsActive(tx)).toBe(true)
      transactions.push(tx)
      return originalBinding.transactionFor(tx)
    },
  }
  const persistence = composeDynamicWorkflowPersistence(db, { hostWrites: binding })
  calls.newWork = 0
  calls.issuedAck = 0
  const stateRows = () =>
    db.select().from(workgroupTaskState).where(eq(workgroupTaskState.taskId, taskId))
  const owners = () =>
    db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
  const runs = () =>
    db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).orderBy(nodeRuns.id)
  const state = async () => DwStateSchema.parse(JSON.parse((await stateRows())[0]!.dwStateJson!))
  return {
    db,
    h,
    calls,
    transactions,
    persistence,
    config,
    agentId,
    ...original,
    stateRows,
    state,
    owners,
    runs,
  }
}
type Fixture = Awaited<ReturnType<typeof dynamicFixture>>

function save(f: Fixture, purpose: (typeof purposes)[number], state: DwState, now?: number) {
  return runWithTaskExecutionContext(f.context, () =>
    selectDynamicWorkflowStateWrites(f.persistence, purpose).saveState(f.h.taskId, state, now),
  )
}
function expectOriginalWork(f: Fixture) {
  expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
  expect(f.context.token.taskId).toBe(f.h.taskId)
}
function goodResult(): WorkgroupTurnHostResult {
  return {
    status: 'done',
    outputs: {
      [ORCHESTRATOR_WORKFLOW_PORT]: JSON.stringify({
        nodes: [
          { id: 'answer', agentToken: 'member#1', promptTemplate: 'original answer', inputs: [] },
        ],
        edges: [],
      }),
    },
  }
}
function scriptedHooks(f: Fixture, queue: WorkgroupTurnHostResult[], beforeResult?: () => void) {
  const requests: WorkgroupTurnHostRequest[] = []
  const checkpoints: DwState[] = []
  const hooks: WorkgroupTurnHostOperations = {
    async runHost(request) {
      requests.push(request)
      checkpoints.push(await f.state())
      beforeResult?.()
      return queue.shift() ?? { status: 'failed', outputs: {}, errorMessage: 'script exhausted' }
    },
  }
  return { hooks, requests, checkpoints }
}
function generate(f: Fixture, hooks: WorkgroupTurnHostOperations, signal?: AbortSignal) {
  return runWithTaskExecutionContext(f.context, () =>
    runDynamicWorkflowGenerate({
      persistence: f.persistence,
      nodeRuns: selectTaskNodeRunWrites(f.h.persistence, 'preparation'),
      validationContext: { load: () => buildWorkflowValidationContext(f.db) },
      taskId: f.h.taskId,
      log,
      hooks,
      ...(signal === undefined ? {} : { signal }),
    }),
  )
}

describeEachProvider(
  'RFC-370 Task dynamic-state purposes retain original generation',
  (harness) => {
    test('native default retains the original instance and all four real reader receivers', async () => {
      const f = await dynamicFixture(harness.db)
      const native = composeDynamicWorkflowPersistence(harness.db)
      expect(native).toBeInstanceOf(DrizzleDynamicWorkflowPersistence)
      expect(native.writeMode).toBeUndefined()
      expect(native.writePurposes).toBeUndefined()
      for (const purpose of purposes)
        expect(selectDynamicWorkflowStateWrites(native, purpose)).toBe(native)
      await harness.db.insert(nodeRuns).values({
        id: `holder-${f.h.taskId}`,
        taskId: f.h.taskId,
        nodeId: DW_ORCHESTRATOR_NODE_ID,
        status: 'awaiting_review',
        rerunCause: DW_GATE_CAUSE,
      })
      expect(await f.persistence.loadTask(f.h.taskId)).toEqual(await native.loadTask(f.h.taskId))
      expect(await f.persistence.loadAgent(f.agentId)).toEqual(await native.loadAgent(f.agentId))
      expect(await f.persistence.hasAwaitingConfirmationRun(f.h.taskId, DW_GATE_CAUSE)).toBe(true)
      expect(await native.hasAwaitingConfirmationRun(f.h.taskId, DW_GATE_CAUSE)).toBe(true)
      expect(await f.persistence.countNodeRuns(f.h.taskId, DW_ORCHESTRATOR_NODE_ID)).toBe(1)
      expect(await native.countNodeRuns(f.h.taskId, DW_ORCHESTRATOR_NODE_ID)).toBe(1)
      expect(await f.persistence.loadTask('missing')).toBeNull()
      expect(await f.persistence.loadAgent('missing')).toBeNull()
      expect(await f.persistence.hasAwaitingConfirmationRun('missing', DW_GATE_CAUSE)).toBe(false)
      expect(await f.persistence.countNodeRuns('missing', DW_ORCHESTRATOR_NODE_ID)).toBe(0)
      expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
    })

    test('selected writers are distinct and incomplete requested views never fall back to native', async () => {
      const f = await dynamicFixture(harness.db)
      expect(f.persistence).toBeInstanceOf(DrizzleDynamicWorkflowPersistence)
      expect(f.persistence.writeMode).toBe('host-selected')
      const views = f.persistence.writePurposes!
      expect(views.preparation).not.toBe(views.issuedResults)
      const explicitViews = Object.assign(new DrizzleDynamicWorkflowPersistence(harness.db), {
        writePurposes: views,
      })
      const incomplete = Object.assign(new DrizzleDynamicWorkflowPersistence(harness.db), {
        writeMode: 'host-selected' as const,
      })
      for (const purpose of purposes) {
        expect(selectDynamicWorkflowStateWrites(f.persistence, purpose)).toBe(views[purpose])
        expect(selectDynamicWorkflowStateWrites(explicitViews, purpose)).toBe(views[purpose])
        expect(() => selectDynamicWorkflowStateWrites(incomplete, purpose)).toThrow(
          'task-dynamic-workflow-write-purposes-not-composed',
        )
      }
      expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
    })

    for (const purpose of purposes) {
      test(`${purpose}: one original SQL and one consume share the actual transaction and work`, async () => {
        const f = await dynamicFixture(harness.db)
        const before = await f.owners()
        const dw: DwState = {
          phase: 'rejected',
          generateAttempts: 2,
          rejectRounds: 3,
          rejectionComment: 'original result',
        }
        const recording = harness.recordStatements()
        try {
          expect(await save(f, purpose, dw, 4321)).toBeUndefined()
          expect(
            recording.statements.filter((s) =>
              /^\s*update\s+(?:"agent_workflow"\.)?"?workgroup_task_state"?(?=\s)/i.test(s.sql),
            ),
          ).toHaveLength(1)
          expect(recording.statements.filter((s) => /^\s*commit\b/i.test(s.sql))).toHaveLength(1)
          expect(recording.statements.some((s) => /^\s*rollback\b/i.test(s.sql))).toBe(false)
        } finally {
          recording.stop()
        }
        expect(await f.state()).toEqual(dw)
        expect((await f.stateRows())[0]!.updatedAt).toBe(4321)
        expect(await f.owners()).toEqual(before)
        expect(f.transactions).toHaveLength(1)
        if (harness.capabilities.isolation === 'exclusive')
          expect(f.transactions[0]).toBe(harness.db)
        else expect(f.transactions[0]).not.toBe(harness.db)
        expect(f.calls).toEqual(
          purpose === 'preparation' ? { newWork: 1, issuedAck: 0 } : { newWork: 0, issuedAck: 1 },
        )
        expectOriginalWork(f)
      })

      test(`${purpose}: host rejection rolls back the real state and retries the same original work`, async () => {
        const error = new Error('original dynamic-state host failure')
        let fail = false
        const reject = () => {
          if (fail) throw error
        }
        const f = await dynamicFixture(
          harness.db,
          purpose === 'preparation' ? { beforeNewWork: reject } : { beforeIssuedAck: reject },
        )
        const before = { state: await f.stateRows(), owners: await f.owners() }
        fail = true
        const recording = harness.recordStatements()
        try {
          await expect(
            save(f, purpose, { ...initialDwState(), generateAttempts: 1 }, 55),
          ).rejects.toBe(error)
          expect(
            recording.statements.filter((s) =>
              /^\s*update\s+(?:"agent_workflow"\.)?"?workgroup_task_state"?(?=\s)/i.test(s.sql),
            ),
          ).toHaveLength(1)
          expect(recording.statements.filter((s) => /^\s*rollback\b/i.test(s.sql))).toHaveLength(1)
          expect(recording.statements.some((s) => /^\s*commit\b/i.test(s.sql))).toBe(false)
        } finally {
          recording.stop()
        }
        expect({ state: await f.stateRows(), owners: await f.owners() }).toEqual(before)
        expectOriginalWork(f)
        fail = false
        await save(f, purpose, { ...initialDwState(), generateAttempts: 1 }, 55)
        expect((await f.state()).generateAttempts).toBe(1)
        expect(await f.owners()).toEqual(before.owners)
        expect(f.calls).toEqual(
          purpose === 'preparation' ? { newWork: 2, issuedAck: 0 } : { newWork: 0, issuedAck: 2 },
        )
        expectOriginalWork(f)
      })

      test(`${purpose}: original NOT NULL SQL error precedes consume and permits the original retry`, async () => {
        const f = await dynamicFixture(harness.db)
        const before = { state: await f.stateRows(), owners: await f.owners() }
        const recording = harness.recordStatements()
        try {
          await expect(
            save(
              f,
              purpose,
              { ...initialDwState(), generateAttempts: 1 },
              null as unknown as number,
            ),
          ).rejects.toThrow()
          expect(recording.statements.filter((s) => /^\s*rollback\b/i.test(s.sql))).toHaveLength(1)
          expect(recording.statements.some((s) => /^\s*commit\b/i.test(s.sql))).toBe(false)
        } finally {
          recording.stop()
        }
        expect({ state: await f.stateRows(), owners: await f.owners() }).toEqual(before)
        expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
        await save(f, purpose, { ...initialDwState(), generateAttempts: 1 }, 88)
        expect((await f.state()).generateAttempts).toBe(1)
        expect(await f.owners()).toEqual(before.owners)
        expectOriginalWork(f)
      })

      test(`${purpose}: input JSON and default clock remain the entry snapshot across a wait and another Task`, async () => {
        const f = await dynamicFixture(harness.db)
        const other = await additionalTaskHostFixture(f.h, `other-${ulid()}`)
        const originalOther = await claimContext(other)
        const owners = await f.owners()
        const otherOwners = await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, other.taskId))
        f.calls.newWork = 0
        f.calls.issuedAck = 0
        const generated = { nodes: [{ label: 'before wait' }] }
        const dw = { ...initialDwState(), generatedDef: generated }
        const release = await acquireWriterLease(harness.db)
        const clock = spyOn(Date, 'now').mockReturnValue(7654)
        let pending!: Promise<void>
        try {
          pending = save(f, purpose, dw)
        } finally {
          clock.mockRestore()
        }
        try {
          generated.nodes[0]!.label = 'changed during wait'
          dw.generateAttempts = 9
          expect(
            runWithTaskExecutionContext(originalOther.context, () => currentTaskExecutionContext()),
          ).toBe(originalOther.context)
        } finally {
          release()
        }
        await pending
        expect(await f.state()).toEqual({
          ...initialDwState(),
          generatedDef: { nodes: [{ label: 'before wait' }] },
        })
        expect((await f.stateRows())[0]!.updatedAt).toBe(7654)
        expect(await f.owners()).toEqual(owners)
        expect(
          await harness.db
            .select()
            .from(taskExecutionOwners)
            .where(eq(taskExecutionOwners.taskId, other.taskId)),
        ).toEqual(otherOwners)
        expectOriginalWork(f)
        expect(taskHostWorkForToken(originalOther.context.token)).toBe(originalOther.work)
      })

      test(`${purpose}: original schema and JSON errors occur before a transaction or Task capture`, async () => {
        const f = await dynamicFixture(harness.db)
        const writer = selectDynamicWorkflowStateWrites(f.persistence, purpose)
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        const before = { state: await f.stateRows(), owners: await f.owners() }
        const recording = harness.recordStatements()
        try {
          await expect(
            writer.saveState(f.h.taskId, { ...initialDwState(), generateAttempts: -1 }),
          ).rejects.toMatchObject({ name: 'ZodError' })
          await expect(
            writer.saveState(f.h.taskId, { ...initialDwState(), generatedDef: cyclic }),
          ).rejects.toBeInstanceOf(TypeError)
          expect(recording.statements).toEqual([])
        } finally {
          recording.stop()
        }
        expect({ state: await f.stateRows(), owners: await f.owners() }).toEqual(before)
        expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
      })

      test(`${purpose}: an original missing state row remains a void no-op with no new row`, async () => {
        const f = await dynamicFixture(harness.db)
        await harness.db.delete(workgroupTaskState).where(eq(workgroupTaskState.taskId, f.h.taskId))
        const owners = await f.owners()
        expect(await save(f, purpose, initialDwState(), 99)).toBeUndefined()
        expect(await f.stateRows()).toEqual([])
        expect(await f.owners()).toEqual(owners)
        expectOriginalWork(f)
      })
    }

    test('native writer retains default and explicit clock, original JSON errors and missing-row no-op', async () => {
      const f = await dynamicFixture(harness.db)
      const native = composeDynamicWorkflowPersistence(harness.db)
      const clock = spyOn(Date, 'now').mockReturnValue(1234)
      let pending!: Promise<void>
      try {
        pending = native.saveState(f.h.taskId, initialDwState())
      } finally {
        clock.mockRestore()
      }
      expect(await pending).toBeUndefined()
      expect((await f.stateRows())[0]!.updatedAt).toBe(1234)
      await native.saveState(f.h.taskId, { ...initialDwState(), generateAttempts: 2 }, 5678)
      expect((await f.stateRows())[0]!.updatedAt).toBe(5678)
      const before = await f.stateRows()
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      await expect(
        native.saveState(f.h.taskId, { ...initialDwState(), generateAttempts: -1 }),
      ).rejects.toMatchObject({ name: 'ZodError' })
      await expect(
        native.saveState(f.h.taskId, { ...initialDwState(), generatedDef: cyclic }),
      ).rejects.toBeInstanceOf(TypeError)
      expect(await f.stateRows()).toEqual(before)
      expect(await native.saveState('missing', initialDwState())).toBeUndefined()
      expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
    })

    test('selected valid writes require their original Task context before any SQL', async () => {
      const f = await dynamicFixture(harness.db)
      const other = await additionalTaskHostFixture(f.h, `context-other-${ulid()}`)
      const originalOther = await claimContext(other)
      const before = { state: await f.stateRows(), owners: await f.owners() }
      f.calls.newWork = 0
      f.calls.issuedAck = 0
      const recording = harness.recordStatements()
      try {
        for (const purpose of purposes) {
          const writer = selectDynamicWorkflowStateWrites(f.persistence, purpose)
          await expect(writer.saveState(f.h.taskId, initialDwState())).rejects.toThrow(
            'task-host-execution-context-required',
          )
          await expect(
            runWithTaskExecutionContext(originalOther.context, () =>
              writer.saveState(f.h.taskId, initialDwState()),
            ),
          ).rejects.toThrow('task-host-execution-context-required')
        }
        expect(recording.statements).toEqual([])
      } finally {
        recording.stop()
      }
      expect({ state: await f.stateRows(), owners: await f.owners() }).toEqual(before)
      expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
      expectOriginalWork(f)
    })

    test('draining records the original received checkpoint while new preparation rolls back', async () => {
      const f = await dynamicFixture(harness.db)
      const before = { state: await f.stateRows(), owners: await f.owners() }
      f.h.lose()
      await expect(
        save(f, 'preparation', { ...initialDwState(), generateAttempts: 1 }, 20),
      ).rejects.toThrow()
      expect({ state: await f.stateRows(), owners: await f.owners() }).toEqual(before)
      await save(f, 'issuedResults', { ...initialDwState(), generateAttempts: 1 }, 21)
      expect((await f.state()).generateAttempts).toBe(1)
      expect(await f.owners()).toEqual(before.owners)
      expectOriginalWork(f)
    })

    test('actual successful generator saves its original result before a separately prepared confirmation gate', async () => {
      const f = await dynamicFixture(
        harness.db,
        {},
        { ...initialDwState(), rejectionComment: 'original human feedback' },
      )
      const script = scriptedHooks(f, [goodResult()])
      expect(await generate(f, script.hooks)).toMatchObject({ kind: 'awaiting_review' })
      const dw = await f.state()
      expect(dw.phase).toBe('awaiting_confirm')
      expect(dw.rejectionComment).toBeUndefined()
      expect(dw.generatedDef).toMatchObject({ nodes: [{ id: 'answer', agentId: f.agentId }] })
      expect(script.requests).toHaveLength(1)
      expect(script.requests[0]).toMatchObject({
        nodeId: DW_ORCHESTRATOR_NODE_ID,
        discardWrites: true,
      })
      expect(script.requests[0]!.promptTemplate).toContain('original human feedback')
      expect((await f.runs()).filter((r) => r.rerunCause === DW_GATE_CAUSE)).toMatchObject([
        { status: 'awaiting_review' },
      ])
      expect(f.calls).toEqual({ newWork: 3, issuedAck: 1 })
      expectOriginalWork(f)
    })

    test('actual human resume resets the original exhausted budget before the next dispatch', async () => {
      const f = await dynamicFixture(
        harness.db,
        {},
        { ...initialDwState(), generateAttempts: DW_MAX_GENERATE_ATTEMPTS, rejectRounds: 2 },
      )
      const script = scriptedHooks(f, [goodResult()])
      expect(await generate(f, script.hooks)).toMatchObject({ kind: 'awaiting_review' })
      expect(script.checkpoints).toEqual([{ ...initialDwState(), rejectRounds: 2 }])
      expect((await f.state()).generateAttempts).toBe(0)
      expect((await f.state()).rejectRounds).toBe(2)
      expect(f.calls).toEqual({ newWork: 4, issuedAck: 1 })
    })

    test('actual invalid generation acknowledges the failure before the separately prepared retry', async () => {
      const f = await dynamicFixture(harness.db)
      const script = scriptedHooks(f, [
        { status: 'done', outputs: { [ORCHESTRATOR_WORKFLOW_PORT]: 'not JSON' } },
        goodResult(),
      ])
      expect(await generate(f, script.hooks)).toMatchObject({ kind: 'awaiting_review' })
      expect(script.checkpoints.map((dw) => dw.generateAttempts)).toEqual([0, 1])
      expect(script.requests[1]!.promptTemplate).toContain(
        'Validation errors in your previous workflow',
      )
      expect(script.requests[1]!.promptTemplate).toContain('invalid JSON')
      expect(
        (await f.runs())
          .filter((r) => r.rerunCause === DW_GENERATE_CAUSE)
          .map((r) => r.retryIndex)
          .sort(),
      ).toEqual([0, 1])
      expect((await f.state()).generateAttempts).toBe(1)
      expect(f.calls).toEqual({ newWork: 4, issuedAck: 2 })
    })

    test('actual successful result survives draining refusal of its new gate and original reentry', async () => {
      const f = await dynamicFixture(harness.db)
      const script = scriptedHooks(f, [goodResult()], () => f.h.lose())
      await expect(generate(f, script.hooks)).rejects.toThrow()
      expect((await f.state()).phase).toBe('awaiting_confirm')
      expect(await f.runs()).toHaveLength(1)
      expect(f.calls).toEqual({ newWork: 2, issuedAck: 1 })
      const checkpoint = await f.stateRows()
      await expect(generate(f, script.hooks)).rejects.toThrow()
      expect(await f.stateRows()).toEqual(checkpoint)
      expect(script.requests).toHaveLength(1)
      expect(f.calls).toEqual({ newWork: 3, issuedAck: 1 })
      expectOriginalWork(f)
    })

    test('actual failed result survives draining refusal of its independently new retry', async () => {
      const f = await dynamicFixture(harness.db)
      const script = scriptedHooks(
        f,
        [{ status: 'failed', outputs: {}, errorMessage: 'original dispatch failure' }],
        () => f.h.lose(),
      )
      await expect(generate(f, script.hooks)).rejects.toThrow()
      expect((await f.state()).generateAttempts).toBe(1)
      expect(await f.runs()).toHaveLength(1)
      expect(script.requests).toHaveLength(1)
      expect(f.calls).toEqual({ newWork: 2, issuedAck: 1 })
      expectOriginalWork(f)
    })

    test('actual exhaustion keeps the original bounded attempts and each returned failure checkpoint', async () => {
      const f = await dynamicFixture(harness.db)
      const script = scriptedHooks(
        f,
        Array.from({ length: DW_MAX_GENERATE_ATTEMPTS }, () => ({
          status: 'failed' as const,
          outputs: {},
          errorMessage: 'original failure',
        })),
      )
      expect(await generate(f, script.hooks)).toMatchObject({
        kind: 'failed',
        detail: { summary: 'dw-generate-exhausted' },
      })
      expect(script.requests).toHaveLength(DW_MAX_GENERATE_ATTEMPTS)
      expect((await f.state()).generateAttempts).toBe(DW_MAX_GENERATE_ATTEMPTS)
      expect(f.calls).toEqual({
        newWork: DW_MAX_GENERATE_ATTEMPTS,
        issuedAck: DW_MAX_GENERATE_ATTEMPTS,
      })
    })

    for (const exit of ['canceled', 'unreaped'] as const) {
      test(`actual ${exit} return retains the original checkpoint without a state acknowledgement`, async () => {
        const f = await dynamicFixture(harness.db)
        const before = await f.stateRows()
        const script = scriptedHooks(f, [
          exit === 'canceled'
            ? { status: 'canceled', outputs: {} }
            : {
                status: 'failed',
                outputs: {},
                processUnreaped: true,
                errorMessage: 'original unreaped child',
              },
        ])
        const result = await generate(f, script.hooks)
        expect(result).toMatchObject(
          exit === 'canceled'
            ? { kind: 'canceled' }
            : { kind: 'failed', detail: { summary: 'dw-runtime-child-unreaped' } },
        )
        expect(await f.stateRows()).toEqual(before)
        expect(f.calls).toEqual({ newWork: 1, issuedAck: 0 })
      })
    }

    test('actual parked reentry uses its original existing holder without generation or another state save', async () => {
      const f = await dynamicFixture(
        harness.db,
        {},
        { ...initialDwState(), phase: 'awaiting_confirm' },
      )
      await harness.db.insert(nodeRuns).values({
        id: `holder-${f.h.taskId}`,
        taskId: f.h.taskId,
        nodeId: DW_ORCHESTRATOR_NODE_ID,
        status: 'awaiting_review',
        rerunCause: DW_GATE_CAUSE,
      })
      const before = await f.stateRows()
      const script = scriptedHooks(f, [])
      expect(await generate(f, script.hooks)).toMatchObject({ kind: 'awaiting_review' })
      expect(script.requests).toEqual([])
      expect(await f.stateRows()).toEqual(before)
      expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
    })
  },
)

function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}
function callsIn(file: ts.SourceFile, predicate: (call: ts.CallExpression) => boolean) {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && predicate(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}
test('dynamic source contract enumerates all three original saves, their inputs and four unchanged reads', () => {
  const file = source('services/dynamicWorkflowRunner.ts')
  const saves = callsIn(
    file,
    (call) =>
      ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'saveState',
  )
  expect(saves).toHaveLength(3)
  expect(saves.map((call) => call.arguments.map((arg) => arg.getText(file)))).toEqual(
    Array.from({ length: 3 }, () => ['taskId', 'dw']),
  )
  expect(
    saves.map((call) => {
      const receiver = (call.expression as ts.PropertyAccessExpression).expression
      expect(ts.isCallExpression(receiver)).toBe(true)
      const select = receiver as ts.CallExpression
      expect(select.expression.getText(file)).toBe('selectDynamicWorkflowStateWrites')
      return select.arguments.map((arg) => arg.getText(file))
    }),
  ).toEqual([
    ['persistence', "'preparation'"],
    ['persistence', "'issuedResults'"],
    ['persistence', "'issuedResults'"],
  ])
  const readers = callsIn(
    file,
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.expression.getText(file) === 'persistence',
  )
  expect(
    readers.map((call) => (call.expression as ts.PropertyAccessExpression).name.text).sort(),
  ).toEqual(['countNodeRuns', 'hasAwaitingConfirmationRun', 'loadAgent', 'loadTask'])
  const mints = callsIn(
    file,
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.getText(file) === 'nodeRuns.mint',
  )
  const sets = callsIn(
    file,
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.getText(file) === 'nodeRuns.set',
  )
  expect(mints).toHaveLength(2)
  expect(sets).toHaveLength(1)
})

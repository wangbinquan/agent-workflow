// RFC-370: Intent owns its primary execution facts on both providers. ACK loss
// preserves the original output and draft; cold recovery never calls a runtime.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { intentDrafts, users } from '../src/db/schema'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createIntentSessionAndReserveTurnForTest,
  intentPersistenceForTest,
  intentResourceCatalogBinding,
  intentDumpAuxiliaryForTest,
  intentGraphValidationForTest,
} from './helpers/intentResourceCatalogBinding'
import {
  runIntentTurn,
  type SelectedIntentTurnConfig,
} from '../src/modules/intent/application/turnEngine'
import {
  createIntentTurnExecutionLifecycle,
  IntentExecutionDeferredError,
} from '../src/modules/intent/application/executionLifecycle'
import { recoverIntentTurnsOnBoot } from '../src/modules/intent/application/maintenance'
import type { IntentExecutionCheckpoint } from '../src/modules/intent/application/ports/intentExecution'
import type { IntentSystemAgentRunFamily } from '../src/modules/intent/application/ports/intentSystemAgent'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import type { Actor } from '../src/auth/actor'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { dispatchIntentTurn } from '../src/modules/intent/application/dispatcher'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
const actor: Actor = {
  user: {
    id: 'intent-original-owner',
    username: 'intent-owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: new Set(),
}
const config: SelectedIntentTurnConfig = {
  runtime: {
    name: 'original-runtime',
    protocol: 'opencode',
    runtimeBinding: {
      owner: 'runtime-management',
      reference: 'original-runtime-binding',
      version: 7,
    },
    model: 'original-model',
    isSandbox: false,
    configDir: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    extraArgs: null,
  },
  lang: null,
  timeoutMs: 1000,
  stdoutCapBytes: 1024 * 1024,
  maxGenerateRounds: 50,
  maxQuestionRounds: 5,
  extraInstructions: null,
}
describeEachProvider('RFC-370 Intent primary receipts and original recovery', (scope) => {
  let root: string
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'aw-intent-primary-'))
    await scope.db
      .insert(users)
      .values({ ...actor.user, createdAt: Date.now(), updatedAt: Date.now() })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  for (const failure of ['prepared', 'started', 'terminal', 'settlement', 'material'] as const)
    test(`lost ${failure} ACK resumes the original turn once and preserves draft/budget`, async () => {
      const db = scope.db,
        persistence = intentPersistenceForTest(db)
      const { session, reservation } = await createIntentSessionAndReserveTurnForTest(
        db,
        actor,
        { message: 'create original agent' },
        root,
      )
      const checkpoint: IntentExecutionCheckpoint = {
        version: 1,
        revision: 0,
        sessionId: session.id,
        reservation,
        configSnapshot: DEFAULT_CONFIG,
        phase: 'reserved',
      }
      await persistence.writeExecutionCheckpoint({ checkpoint, expectedRevision: null })
      const owner = createIntentTurnExecutionLifecycle(),
        reported = deferred<unknown>()
      let models = 0,
        helpers = 0,
        failed = false
      const handle = owner.start({ current: () => true, reportFailure: reported.resolve })
      const originalWrite = persistence.writeExecutionCheckpoint.bind(persistence),
        originalSettle = persistence.settleTurn.bind(persistence)
      const write = spyOn(persistence, 'writeExecutionCheckpoint').mockImplementation(
        async (input) => {
          await originalWrite(input)
          if (input.checkpoint.phase === failure && !failed) {
            failed = true
            throw new Error('original ACK lost')
          }
        },
      )
      const settle = spyOn(persistence, 'settleTurn').mockImplementation(async (input) => {
        const outcome = await originalSettle(input)
        if (failure === 'settlement' && !failed) {
          failed = true
          throw new Error('original settlement ACK lost')
        }
        return outcome
      })
      const systemAgents: IntentSystemAgentRunFamily = {
        workspaces: { capture: (value) => value },
        retainedContents: {
          forget() {},
          release: async () => {
            if (failure === 'material' && !failed) {
              failed = true
              return { removed: false, reason: 'remove-failed' }
            }
            return { removed: true }
          },
        },
        async run(request) {
          const receipt = {
            executionRef: 'original-execution-' + ++helpers,
            retainedRef: 'original-material-' + helpers,
            startedAt: null,
            recoveryRef: 'original-prepared-helper',
          }
          const unactivated = (
            originalReceipt:
              | typeof receipt
              | {
                  executionRef: string
                  retainedRef: string
                  startedAt: number
                  recoveryRef: string
                },
          ) => ({
            status: 'spawn-failed' as const,
            executionNotActivated: true,
            executionReceipt: originalReceipt,
            exitCode: null,
            durationMs: 0,
            stderrTail: 'system-agent-execution-admission-expired',
            retainedRef: originalReceipt.retainedRef,
            scratchRetained: false,
            eventText: '',
            outputEvidence: emptySystemAgentOutputEvidence(),
          })
          await request.executionReceipts!.prepared(receipt)
          if (!request.admitExecution!()) return unactivated(receipt)
          await request.executionReceipts!.started({
            ...receipt,
            startedAt: 10,
            recoveryRef: 'original-started-helper',
          })
          if (!request.admitExecution!())
            return unactivated({
              ...receipt,
              startedAt: 10,
              recoveryRef: 'original-started-helper',
            })
          models++
          return {
            status: 'ok',
            exitCode: 0,
            durationMs: 5,
            stderrTail: '',
            retainedRef: receipt.retainedRef,
            scratchRetained: true,
            executionReceipt: { ...receipt, startedAt: 10, recoveryRef: 'original-started-helper' },
            outputEvidence: emptySystemAgentOutputEvidence(),
            eventText: `<workflow-output nonce="${reservation.envelopeNonce}"><port name="summary">Original</port><port name="changeset">${JSON.stringify({ $schema_version: 1, ops: [{ opId: 'op-1', action: 'create', resourceType: 'agent', tempRef: '$new:original', payload: { name: 'original', description: 'Original', outputs: ['result'], bodyMd: 'Original prompt' } }] })}</port></workflow-output>`,
          }
        },
      }
      const finished = deferred<void>()
      const work = owner.dispatch(reservation.turnId, async (control) => {
        const originalCheckpoint =
          (await persistence.readExecutionCheckpoint(reservation.turnId)) ?? checkpoint
        await runIntentTurn(
          {
            persistence,
            appHome: root,
            config,
            systemAgents,
            resourceCatalog: intentResourceCatalogBinding(db, actor, root),
            dumpAuxiliary: intentDumpAuxiliaryForTest(db),
            graphValidation: intentGraphValidationForTest(db),
            execution: { control, checkpoint: originalCheckpoint },
          },
          { sessionId: session.id, actor, reservation },
        )
        finished.resolve()
      })
      try {
        await reported.promise
        handle.stop()
        await expect(handle.drain()).rejects.toThrow('intent-original-execution-pending')
        const unissued = failure === 'prepared' || failure === 'started'
        expect(await owner.recoverOriginal(reservation.turnId)).toBe(!unissued)
        await Promise.all([work, handle.drain()])
        if (unissued) {
          expect(models).toBe(0)
          expect((await persistence.readExecutionCheckpoint(reservation.turnId))?.phase).toBe(
            'reserved',
          )
          const next = owner.start({ current: () => true })
          await finished.promise
          next.stop()
          await next.drain()
        }
        expect(failed).toBe(true)
        expect(models).toBe(1)
        expect(await db.select().from(intentDrafts)).toHaveLength(1)
        expect((await persistence.findSession(session.id))?.budgetJson).toBe(
          JSON.stringify({ generateRounds: 1, questionRounds: 0 }),
        )
        expect((await persistence.readExecutionCheckpoint(reservation.turnId))?.phase).toBe(
          'closed',
        )
      } finally {
        write.mockRestore()
        settle.mockRestore()
      }
    })

  test('the actual dispatcher retains an unactivated original helper and reuses the same turn and budget after activation', async () => {
    const db = scope.db,
      persistence = intentPersistenceForTest(db)
    const { session, reservation } = await createIntentSessionAndReserveTurnForTest(
      db,
      actor,
      { message: 'original deferred reservation' },
      root,
    )
    const execution = createIntentTurnExecutionLifecycle(),
      identity = composeIdentityAccess(db)
    let current = true,
      helpers = 0,
      models = 0
    const finished = deferred<void>()
    const systemAgents: IntentSystemAgentRunFamily = {
      workspaces: { capture: (value) => value },
      retainedContents: { forget() {}, release: async () => ({ removed: true }) },
      async run(request) {
        const receipt = {
          executionRef: 'original-helper-' + ++helpers,
          retainedRef: 'original-material-' + helpers,
          startedAt: null,
          recoveryRef: 'original-prepared-' + helpers,
        }
        await request.executionReceipts!.prepared(receipt)
        if (helpers === 1) {
          current = false
          return {
            status: 'spawn-failed',
            executionNotActivated: true,
            executionReceipt: receipt,
            exitCode: null,
            durationMs: 0,
            stderrTail: 'system-agent-execution-admission-expired',
            retainedRef: receipt.retainedRef,
            scratchRetained: false,
            eventText: '',
            outputEvidence: emptySystemAgentOutputEvidence(),
          }
        }
        await request.executionReceipts!.started({ ...receipt, startedAt: 10 })
        expect(request.admitExecution!()).toBe(true)
        models++
        return {
          status: 'ok',
          exitCode: 0,
          durationMs: 5,
          stderrTail: '',
          retainedRef: receipt.retainedRef,
          scratchRetained: false,
          executionReceipt: { ...receipt, startedAt: 10 },
          outputEvidence: emptySystemAgentOutputEvidence(),
          eventText: `<workflow-output nonce="${reservation.envelopeNonce}"><port name="summary">Original</port><port name="questions">[{"id":"q1","question":"Original?","options":["A","B"],"multiSelect":false}]</port></workflow-output>`,
        }
      },
    }
    const first = execution.start({ current: () => current })
    const deps = {
      persistence,
      identityAccess: { directAuthority: identity.directAuthority },
      appHome: root,
      configSnapshot: DEFAULT_CONFIG,
      runtimeResolver: {
        resolve: async () => ({
          runtime: config.runtime,
          effectiveDefaultRuntime: { name: config.runtime.name, protocol: config.runtime.protocol },
        }),
      },
      dumpAuxiliary: intentDumpAuxiliaryForTest(db),
      graphValidation: intentGraphValidationForTest(db),
      resourceCatalogFor: () => intentResourceCatalogBinding(db, actor, root),
      systemAgents,
      execution,
      events: {
        publish: (event: { type: string }) => {
          if (event.type === 'intent.turn.finished') {
            finished.resolve()
            throw new Error('auxiliary notification failed after primary settlement')
          }
        },
      },
    }
    await dispatchIntentTurn(deps, session.id, actor, reservation)
    first.stop()
    await first.drain()
    const deferredRecord = await persistence.readExecutionCheckpoint(reservation.turnId)
    expect(deferredRecord).toMatchObject({
      phase: 'reserved',
      reservation: { turnId: reservation.turnId, envelopeNonce: reservation.envelopeNonce },
      retiredUnissued: [{ receipt: { executionRef: 'original-helper-1' } }],
    })
    expect(JSON.parse((await persistence.findSession(session.id))!.budgetJson)).toEqual({
      generateRounds: 0,
      questionRounds: 0,
    })
    expect(models).toBe(0)
    current = true
    const next = execution.start({ current: () => current })
    await finished.promise
    next.stop()
    await next.drain()
    expect(models).toBe(1)
    expect(helpers).toBe(2)
    expect((await persistence.readExecutionCheckpoint(reservation.turnId))?.phase).toBe('closed')
    expect((await persistence.readExecutionCheckpoint(reservation.turnId))?.outcome?.kind).toBe(
      'questions',
    )
    expect(JSON.parse((await persistence.findSession(session.id))!.budgetJson)).toEqual({
      generateRounds: 0,
      questionRounds: 1,
    })
    await identity.shutdown()
  })

  test('boot cleanup preserves selected unknown facts; a reconstructed owner explicitly reaps the original ref and never runs a model', async () => {
    const db = scope.db,
      persistence = intentPersistenceForTest(db)
    const { session, reservation } = await createIntentSessionAndReserveTurnForTest(
      db,
      actor,
      { message: 'original unknown' },
      root,
    )
    const checkpoint: IntentExecutionCheckpoint = {
      version: 1,
      revision: 0,
      phase: 'started',
      sessionId: session.id,
      reservation,
      configSnapshot: DEFAULT_CONFIG,
      snapshot: {
        config,
        manifest: [],
        agentBranchPorts: {},
        session: reservation.launchSession,
        budget: reservation.budget,
      },
      receipt: {
        executionRef: 'original-execution',
        retainedRef: 'original-material',
        startedAt: 10,
        recoveryRef: 'original-durable-recovery',
      },
    }
    await persistence.writeExecutionCheckpoint({ checkpoint, expectedRevision: null })
    expect(await recoverIntentTurnsOnBoot(persistence)).toBe(0)
    const rebuilt = intentPersistenceForTest(db),
      execution = createIntentTurnExecutionLifecycle()
    let physical = false,
      models = 0,
      releases = 0
    const systemAgents: IntentSystemAgentRunFamily = {
      workspaces: { capture: (value) => value },
      retainedContents: {
        forget() {},
        release: async () => {
          releases++
          return { removed: true }
        },
      },
      run: async () => {
        models++
        throw new Error('cold recovery must not run')
      },
      recovery: {
        recoverReference: async (input) => {
          expect(input).toEqual({
            executionRef: 'original-execution',
            recoveryRef: 'original-durable-recovery',
          })
          return { executionRef: input.executionRef, state: physical ? 'reaped' : 'unknown' }
        },
      },
    }
    execution.configureRecovery({
      load: rebuilt.listExecutionCheckpoints.bind(rebuilt),
      async recover(original, control) {
        await runIntentTurn(
          {
            persistence: rebuilt,
            appHome: root,
            config,
            systemAgents,
            resourceCatalog: intentResourceCatalogBinding(db, actor, root),
            dumpAuxiliary: intentDumpAuxiliaryForTest(db),
            graphValidation: intentGraphValidationForTest(db),
            execution: { control, checkpoint: original },
          },
          { sessionId: original.sessionId, actor, reservation: original.reservation },
        )
      },
    })
    await expect(execution.prepare()).rejects.toThrow('intent-original-execution-pending')
    expect(await execution.recoverOriginal(reservation.turnId)).toBe(false)
    expect((await rebuilt.findSession(session.id))?.inFlightTurnId).toBe(reservation.turnId)
    physical = true
    expect(await execution.recoverOriginal(reservation.turnId)).toBe(true)
    expect((await rebuilt.readExecutionCheckpoint(reservation.turnId))?.phase).toBe('closed')
    expect((await rebuilt.findSession(session.id))?.inFlightTurnId).toBeNull()
    expect(models).toBe(0)
    expect(releases).toBe(1)
    await execution.prepare()
  })

  test('known cold output settles against the original manifest and graph repair reserves a durable successor in the same transaction', async () => {
    const db = scope.db,
      persistence = intentPersistenceForTest(db)
    const { session, reservation } = await createIntentSessionAndReserveTurnForTest(
      db,
      actor,
      { message: 'original known output' },
      root,
    )
    const checkpoint: IntentExecutionCheckpoint = {
      version: 1,
      revision: 0,
      phase: 'terminal',
      sessionId: session.id,
      reservation,
      configSnapshot: DEFAULT_CONFIG,
      snapshot: {
        config,
        manifest: [],
        agentBranchPorts: {},
        session: reservation.launchSession,
        budget: reservation.budget,
      },
      receipt: {
        executionRef: 'original',
        retainedRef: 'material',
        startedAt: 10,
        recoveryRef: 'physical-ref',
      },
      result: {
        status: 'ok',
        exitCode: 0,
        stderrTail: '',
        durationMs: 5,
        retainedRef: 'material',
        scratchRetained: true,
        outputEvidence: emptySystemAgentOutputEvidence(),
        eventText: `<workflow-output nonce="${reservation.envelopeNonce}"><port name="summary">Original question</port><port name="questions">[{"id":"q1","question":"Original question","options":["A","B"],"multiSelect":false}]</port></workflow-output>`,
      },
    }
    await persistence.writeExecutionCheckpoint({ checkpoint, expectedRevision: null })
    const owner = createIntentTurnExecutionLifecycle()
    let calls = 0,
      releases = 0
    const systemAgents: IntentSystemAgentRunFamily = {
      workspaces: { capture: (value) => value },
      retainedContents: {
        forget() {},
        release: async () => {
          releases++
          return { removed: true }
        },
      },
      run: async () => {
        calls++
        throw new Error('known output must not run again')
      },
    }
    owner.configureRecovery({
      load: persistence.listExecutionCheckpoints.bind(persistence),
      async recover(original, control) {
        await runIntentTurn(
          {
            persistence,
            appHome: root,
            config,
            systemAgents,
            resourceCatalog: intentResourceCatalogBinding(db, actor, root),
            dumpAuxiliary: intentDumpAuxiliaryForTest(db),
            graphValidation: intentGraphValidationForTest(db),
            execution: { control, checkpoint: original },
          },
          { sessionId: original.sessionId, actor, reservation: original.reservation },
        )
      },
    })
    await owner.prepare()
    expect(calls).toBe(0)
    expect(releases).toBe(1)
    expect((await persistence.readExecutionCheckpoint(reservation.turnId))?.outcome?.kind).toBe(
      'questions',
    )
    expect(JSON.parse((await persistence.findSession(session.id))!.budgetJson)).toEqual({
      generateRounds: 0,
      questionRounds: 1,
    })

    const second = await createIntentSessionAndReserveTurnForTest(
      db,
      actor,
      { message: 'original graph repair' },
      root,
    )
    const secondCheckpoint: IntentExecutionCheckpoint = {
      ...checkpoint,
      sessionId: second.session.id,
      reservation: second.reservation,
      snapshot: {
        ...checkpoint.snapshot!,
        session: second.reservation.launchSession,
        budget: second.reservation.budget,
      },
    }
    await persistence.writeExecutionCheckpoint({
      checkpoint: secondCheckpoint,
      expectedRevision: null,
    })
    const input: Parameters<typeof persistence.settleTurn>[0] = {
      sessionId: second.session.id,
      turnId: second.reservation.turnId,
      launchRevision: 0,
      kind: 'changeset',
      content: { graphErrors: 1, blockingErrors: 1 },
      scratchRetained: false,
      budgetDelta: { generateRounds: 1 },
      graphRepair: {
        turnId: 'original-repair-turn',
        envelopeNonce: 'original-repair-nonce',
        maxGenerateRounds: 50,
      },
      executionCheckpoint: secondCheckpoint,
      now: 20,
    }
    const settled = await persistence.settleTurn(input)
    expect(settled.graphRepair?.turnId).toBe('original-repair-turn')
    expect(await persistence.settleTurn(input)).toEqual(settled)
    const repair = await persistence.readExecutionCheckpoint('original-repair-turn')
    expect(repair).toMatchObject({
      phase: 'reserved',
      reservation: {
        turnId: 'original-repair-turn',
        envelopeNonce: 'original-repair-nonce',
        budget: { generateRounds: 1, questionRounds: 0 },
      },
    })
    expect(await recoverIntentTurnsOnBoot(persistence)).toBe(0)
  })
})

test('activation observes a detached original turn failure once and drain retains it', async () => {
  const owner = createIntentTurnExecutionLifecycle()
  const failure = new Error('original-turn-failed')
  const reported = deferred<void>()
  const errors: unknown[] = []
  let runs = 0
  await owner.dispatch('deferred-original-turn', async (control) => {
    runs += 1
    if (!control.current()) throw new IntentExecutionDeferredError()
    throw failure
  })
  expect(runs).toBe(1)
  const handle = owner.start({
    current: () => true,
    reportFailure(error) {
      errors.push(error)
      reported.resolve()
    },
  })
  await reported.promise
  handle.stop()
  await expect(handle.drain()).rejects.toBe(failure)
  expect(errors).toEqual([failure])
  expect(runs).toBe(2)
  expect(await owner.recoverOriginal('deferred-original-turn')).toBe(false)
})

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function source(path: string): string {
  return readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8')
}

describe('RFC-341 collaboration owner source locks', () => {
  test('review, clarify and question request surfaces own neither broadcaster nor continuation drive', () => {
    for (const path of [
      'routes/reviews.ts',
      'routes/clarify.ts',
      'routes/taskQuestions.ts',
      'services/reviewDecisionComposition.ts',
      'services/clarifyDecisionComposition.ts',
      'services/questionDispatchComposition.ts',
    ]) {
      const value = source(path)
      expect(value).not.toContain('@/ws/broadcaster')
      expect(value).not.toContain('wakeHumanGateContinuation')
      expect(value).not.toContain('composeHumanGateContinuationDriver')
    }
  })

  test('compiled restart barriers stop after commit and before every immediate event wake', () => {
    const cases = [
      {
        path: 'services/review.ts',
        publish: 'publishCommittedEventsAfterCommit(committed.eventRefs)',
      },
      {
        path: 'services/clarify/autoDispatch.ts',
        publish: 'publishCommittedEventsAfterCommit(prepared.capture.eventRefs)',
      },
      {
        path: 'services/taskQuestionDispatch.ts',
        publish: 'publishCommittedEventsAfterCommit(committedEventRefs)',
      },
    ] as const
    for (const entry of cases) {
      const value = source(entry.path)
      const publishAt = value.indexOf(entry.publish)
      const barrierAt = value.lastIndexOf('waitAtHumanGateDecisionCommitBarrier', publishAt)
      expect(barrierAt, entry.path).toBeGreaterThan(-1)
      expect(publishAt, entry.path).toBeGreaterThan(barrierAt)
    }
    for (const path of [
      'services/reviewDecisionComposition.ts',
      'services/clarifyDecisionComposition.ts',
      'services/questionDispatchComposition.ts',
    ]) {
      expect(source(path)).not.toContain('waitAtHumanGateDecisionCommitBarrier')
    }
  })

  test('clarify commit barrier precedes nested dispatch and replay never enters the seam', () => {
    const autoDispatch = source('services/clarify/autoDispatch.ts')
    const seal = source('services/clarify/seal.ts')
    const wrapperAt = autoDispatch.indexOf(
      'export async function autoDispatchClarifyRoundWithDecision',
    )
    const replayAt = autoDispatch.indexOf('if (replay !== null)', wrapperAt)
    const replayReturnAt = autoDispatch.indexOf('return {', replayAt)
    const barrierBindingAt = autoDispatch.indexOf('afterSealCommit: async () =>', replayReturnAt)
    const barrierWaitAt = autoDispatch.indexOf(
      'waitAtHumanGateDecisionCommitBarrier',
      barrierBindingAt,
    )
    const wrapperFinallyAt = autoDispatch.indexOf('} finally {', barrierWaitAt)
    const roundAt = autoDispatch.indexOf(
      'export async function autoDispatchClarifyRound(',
      wrapperFinallyAt,
    )
    const sealCallAt = autoDispatch.indexOf('const sealResult = await sealRoundQuestions({')
    const forwardedBarrierAt = autoDispatch.indexOf('afterCommit: args.afterSealCommit', sealCallAt)
    const distillAt = autoDispatch.indexOf('await enqueueDistillJob(', forwardedBarrierAt)
    const askerReadAt = autoDispatch.indexOf('const askerRows =', roundAt)
    const nestedDispatchAt = autoDispatch.indexOf('dispatchTaskQuestions(', askerReadAt)
    const txAt = seal.indexOf('const committed = dbTxSync(args.db, (tx) => {')
    const postCommitAt = seal.indexOf('await args.afterCommit?.()', txAt)
    const returnAt = seal.indexOf('return committed', postCommitAt)
    const firstPostCommitAwait = seal.slice(txAt, postCommitAt).match(/\b(?:await|yield)\b/)

    expect(wrapperAt).toBeGreaterThan(-1)
    expect(replayReturnAt).toBeGreaterThan(replayAt)
    expect(barrierBindingAt).toBeGreaterThan(replayReturnAt)
    expect(barrierWaitAt).toBeGreaterThan(barrierBindingAt)
    expect(wrapperFinallyAt).toBeGreaterThan(barrierWaitAt)
    expect(autoDispatch.slice(wrapperFinallyAt, roundAt)).not.toContain(
      'waitAtHumanGateDecisionCommitBarrier',
    )
    expect(forwardedBarrierAt).toBeGreaterThan(sealCallAt)
    expect(distillAt).toBeGreaterThan(forwardedBarrierAt)
    expect(askerReadAt).toBeGreaterThan(roundAt)
    expect(nestedDispatchAt).toBeGreaterThan(askerReadAt)
    expect(autoDispatch).not.toContain('await args.afterSealCommit?.()')
    expect(postCommitAt).toBeGreaterThan(txAt)
    expect(firstPostCommitAwait).toBeNull()
    expect(returnAt).toBeGreaterThan(postCommitAt)
  })

  test('fresh, replay and claimed pre-drive share durable clarify convergence', () => {
    const autoDispatch = source('services/clarify/autoDispatch.ts')
    const preDrive = source('services/humanGateContinuationEffects.ts')
    const seal = source('services/clarify/seal.ts')
    const replayAt = autoDispatch.indexOf('if (replay !== null)')
    const freshAt = autoDispatch.indexOf('committedOperationId: prepared.operationId')
    const finishAt = autoDispatch.indexOf(
      'export async function finishCommittedClarifyAutoDispatch',
    )

    expect(finishAt).toBeGreaterThan(-1)
    expect(
      autoDispatch.indexOf('await finishCommittedClarifyAutoDispatch({', replayAt),
    ).toBeGreaterThan(replayAt)
    expect(freshAt).toBeGreaterThan(replayAt)
    expect(
      autoDispatch.indexOf('await finishCommittedClarifyAutoDispatch({', freshAt),
    ).toBeGreaterThan(freshAt)
    expect(autoDispatch).not.toContain('dispatch: EMPTY_DISPATCH,')
    expect(preDrive).toContain('await finishCommittedClarifyAutoDispatch({')
    expect(preDrive).toContain("state: 'pending'")
    expect(preDrive).toContain(
      'eq(taskExecutionIntents.claimedEpoch, context.execution.token.epoch)',
    )
    expect(seal).toContain('freezeAnswerAttributions({')
    expect(seal).toContain('setNodeClarifyDirectiveTx(')
    expect(seal.indexOf('freezeAnswerAttributions({')).toBeLessThan(
      seal.indexOf('await args.afterCommit?.()'),
    )
    expect(seal.indexOf('setNodeClarifyDirectiveTx(')).toBeLessThan(
      seal.indexOf('await args.afterCommit?.()'),
    )
  })

  test('covered collaboration writers have no legacy direct broadcaster', () => {
    for (const path of [
      'services/review.ts',
      'services/clarify/service.ts',
      'services/clarify/seal.ts',
      'services/clarifyDecision.ts',
      'services/taskQuestionDispatch.ts',
    ]) {
      const value = source(path)
      expect(value).not.toContain("from '@/ws/broadcaster'")
      expect(value).not.toContain('taskBroadcaster.broadcast')
    }
  })

  test('daemon composes one continuous owner and maintenance no longer schedules boot recovery', () => {
    const start = source('cli/start.ts')
    const catalog = source('platform/background/maintenanceCatalog.ts')
    const service = source('platform/background/maintenanceService.ts')
    expect(start).toContain('createHumanGateContinuationWorkerDefinition')
    expect(start).toContain('composeHumanGateContinuationDriver')
    expect(start).not.toContain('wakeHumanGateContinuation')
    expect(start).not.toContain('onHumanGateContinuations')
    expect(catalog).not.toContain("key: 'humanGateRecovery'")
    expect(service).not.toContain('onHumanGateContinuations')
  })

  test('continuation drive composition does not create a task service initialization cycle', () => {
    const taskService = source('services/task.ts')
    const taskExecutionComposition = source('modules/task-execution/composition/humanGate.ts')
    expect(taskService).toContain('export function composeHumanGateContinuationDriver')
    expect(taskExecutionComposition).not.toContain("from '@/services/task'")
    expect(taskExecutionComposition).not.toContain('wakeHumanGateContinuation')
  })

  test('task lifecycle legacy outbox publisher and duplicate WS publisher remain extinct', () => {
    expect(
      existsSync(
        resolve(
          import.meta.dir,
          '../src/modules/task-execution/infrastructure/sqliteTaskLifecycleEventPublisher.ts',
        ),
      ),
    ).toBe(false)
    expect(
      existsSync(
        resolve(
          import.meta.dir,
          '../src/modules/task-execution/infrastructure/webSocketTaskStatusPublisher.ts',
        ),
      ),
    ).toBe(false)
    expect(source('cli/start.ts')).not.toContain('registerTerminalTaskHook')
  })
})

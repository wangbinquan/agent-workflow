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

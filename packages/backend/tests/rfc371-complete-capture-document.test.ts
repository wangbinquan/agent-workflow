// RFC-371: compact display summaries must never stand in for the full retained native proof.
import { expect, test } from 'bun:test'
import { ObservationCaptureCommitSchema } from '@agent-workflow/shared'
import { observationUsageCaptures } from '@/db/schema'
import {
  commitUsageCapture,
  readUsageCapturePage,
} from '@/modules/run-observability/infrastructure/usageCapturePersistence'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 complete capture documents', (harness) => {
  test('all 101 baseline steps and resolution rows survive a compact summary and true EOF', async () => {
    const before = {
      usage: { input: '1', cacheRead: '2', cacheWrite: '3', output: '4' },
      model: { provider: 'original', id: 'native-model' },
    }
    const evidence = ObservationCaptureCommitSchema.parse({
      invocationId: 'original-invocation',
      taskId: 'original-task',
      capture: {
        contract: 'opencode-child-steps-v1',
        nativeSource: 'original-native',
        rootSessionId: 'original-root',
        state: 'complete',
        baseline: { kind: 'resume', fingerprint: 'original-baseline' },
        snapshotFingerprint: 'original-final',
        observedAt: 1790985600000,
        scannedSessions: 1,
        scannedSteps: 101,
        issues: [],
        priorRevisions: [],
        baselineSteps: Array.from({ length: 101 }, (_, n) => ({
          stepId: 'step-' + n,
          sessionId: 'original-root',
          parentSessionId: null,
          ancestors: [],
          before,
          after: before,
          afterObserved: true,
          scopeChanged: false,
        })),
      },
    })
    const resolutions = evidence.capture.baselineSteps!.map((step) => ({
      stepId: step.stepId,
      sessionId: step.sessionId,
      status: 'resolved' as const,
      invocationId: 'original-invocation',
      reason: null,
      previous: before,
      current: before,
    }))
    await commitUsageCapture(
      harness.db,
      'original-source',
      'original-cursor',
      evidence,
      resolutions,
    )
    const stored = await harness.db
      .select({
        summary: observationUsageCaptures.summary,
        document: observationUsageCaptures.document,
      })
      .from(observationUsageCaptures)
      .get()
    expect(JSON.parse(stored!.summary).evidence.capture).not.toHaveProperty('baselineSteps')
    expect(JSON.parse(stored!.summary).resolutions).toHaveLength(100)
    expect(JSON.parse(stored!.document).resolutions).toHaveLength(101)
    const page = await readUsageCapturePage(harness.db, 'original-task', { limit: 1 })
    expect(page.nextCursor).toBeNull()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.capture).toEqual(evidence.capture)
    expect(page.items[0]?.resolutions).toEqual(resolutions)
  })
})

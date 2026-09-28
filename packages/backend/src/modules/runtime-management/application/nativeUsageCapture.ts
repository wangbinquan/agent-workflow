import {
  ObservationCapturedUsageSchema,
  type ObservationCapturedUsage,
  type ObservationMeasurement,
  type ObservationNativeCapture,
  type ObservationNativeBaselineStep,
} from '@agent-workflow/shared'
import type {
  NativeUsageCapture,
  NativeUsageCaptureIdentity,
  NativeUsageSnapshot,
  NativeUsageStep,
} from './ports/nativeUsageCapture'

const evidence = (step: NativeUsageStep) => ({ usage: step.usage, model: step.model })
// The native part primary key is global. Moving it to another session is a revision, not new usage.
const stepKey = (step: NativeUsageStep) => step.id
const stepFingerprint = (step: NativeUsageStep) =>
  JSON.stringify([step.sessionId, step.parentSessionId, step.ancestors, evidence(step)])
/** Resume baselines are frozen before spawn; prior steps never become new invocation usage. */
export function createNativeUsageCapture(
  input: NativeUsageCaptureIdentity & {
    readonly nativeSource: string
    readonly read: (root: string) => NativeUsageSnapshot
  },
): NativeUsageCapture {
  let begun = false,
    baseline: NativeUsageSnapshot | undefined,
    final: ObservationCapturedUsage[] | undefined
  let revision = 0
  const nextRevision = input.nextRevision ?? (() => ++revision)
  return {
    contract: 'opencode-child-steps-v1',
    nativeSource: input.nativeSource,
    includesRecord(recordId) {
      if (!input.resumeSessionId) return true
      return (
        Boolean(baseline?.fingerprint) &&
        !baseline!.steps.some((row) => 'opencode:step:' + row.id === recordId)
      )
    },
    begin() {
      if (begun) return
      begun = true
      if (input.resumeSessionId) baseline = input.read(input.resumeSessionId)
    },
    finish(rootSessionId, observedAt, processIssues = []) {
      if (final) return final
      const issues = new Set<string>(processIssues),
        measurements: ObservationMeasurement[] = [],
        priorRevisions: ObservationNativeCapture['priorRevisions'] = [],
        baselineSteps: ObservationNativeBaselineStep[] = []
      if (!begun) issues.add('native-baseline-not-started')
      if (input.resumeSessionId && !baseline?.fingerprint) issues.add('native-baseline-unavailable')
      if (input.resumeSessionId && rootSessionId !== input.resumeSessionId)
        issues.add('native-root-changed')
      const snapshot = rootSessionId ? input.read(rootSessionId) : undefined
      if (!snapshot) issues.add('native-root-unavailable')
      // Current numeric/model completeness comes from the ledger, not sticky historical text.
      for (const issue of snapshot?.issues ?? [])
        if (
          ![
            'native-model-unavailable',
            'native-token-bucket-unknown',
            'native-time-unavailable',
          ].includes(issue)
        )
          issues.add(issue)
      const prior = new Map(baseline?.steps.map((row) => [stepKey(row), row]) ?? []),
        current = new Map(snapshot?.steps.map((row) => [stepKey(row), row]) ?? [])
      const canAttribute =
        begun &&
        (!input.resumeSessionId ||
          (baseline?.fingerprint !== null &&
            baseline !== undefined &&
            rootSessionId === input.resumeSessionId))
      if (canAttribute) {
        for (const [key, before] of prior) {
          const after = current.get(key)
          const scopeChanged =
            after !== undefined &&
            JSON.stringify([before.sessionId, before.parentSessionId, before.ancestors]) !==
              JSON.stringify([after.sessionId, after.parentSessionId, after.ancestors])
          baselineSteps.push({
            stepId: before.id,
            sessionId: before.sessionId,
            parentSessionId: before.parentSessionId,
            ancestors: [...before.ancestors],
            before: evidence(before),
            after: after ? evidence(after) : null,
            afterObserved: after !== undefined || snapshot?.fingerprint != null,
            scopeChanged,
          })
          if (
            (!after && snapshot?.fingerprint) ||
            (after && stepFingerprint(before) !== stepFingerprint(after))
          ) {
            issues.add('native-prior-revision-gap')
            if (priorRevisions.length < 100)
              priorRevisions.push({
                sessionId: before.sessionId,
                stepId: before.id,
                before: evidence(before),
                after: after ? evidence(after) : null,
              })
            else issues.add('native-prior-revision-budget')
          }
        }
        for (const [key, row] of current) {
          if (prior.has(key)) continue
          measurements.push({
            schemaVersion: 1,
            invocationId: input.invocationId,
            taskId: input.taskId,
            nodeRunId: input.nodeRunId,
            agentId: input.agentId,
            recordId: 'opencode:step:' + row.id,
            revision: nextRevision(),
            occurredAt: row.occurredAt,
            observedAt,
            model: row.model,
            adapterVersion: 'opencode-native-child/1.15.5@1',
            reporting: 'delta',
            inclusion: 'self',
            coverage: Object.values(row.usage).every((n) => n !== null) ? 'complete' : 'partial',
            validity: 'valid',
            basis: { kind: 'invocation' },
            usage: row.usage,
            scope: {
              root: rootSessionId!,
              session: row.sessionId,
              parentSession: row.parentSessionId,
              ancestors: [...row.ancestors],
              turn: input.invocationId,
              turnIndex: 0,
              level: 'request',
            },
          })
        }
      }
      const capture: ObservationNativeCapture = {
        contract: 'opencode-child-steps-v1',
        nativeSource: input.nativeSource,
        rootSessionId,
        state: issues.size ? 'partial' : 'complete',
        baseline: {
          kind: input.resumeSessionId ? 'resume' : 'fresh',
          fingerprint: baseline?.fingerprint ?? null,
        },
        snapshotFingerprint: snapshot?.fingerprint ?? null,
        observedAt,
        scannedSessions: snapshot?.sessions ?? 0,
        scannedSteps: snapshot?.steps.length ?? 0,
        issues: [...issues],
        priorRevisions,
        baselineSteps,
      }
      const frames: ObservationCapturedUsage[] = []
      for (let start = 0; start < measurements.length; start += 500)
        frames.push({
          invocationId: input.invocationId,
          measurements: measurements.slice(start, start + 500),
          diagnostics: [],
        })
      // This last frame follows every numeric frame in one owner append transaction. Projection
      // cannot see completion until the ordered source cursor has passed all preceding numbers.
      frames.push({
        invocationId: input.invocationId,
        measurements: [],
        diagnostics: [...issues],
        capture,
      })
      final = frames.map((frame) => ObservationCapturedUsageSchema.parse(frame))
      return final
    },
  }
}

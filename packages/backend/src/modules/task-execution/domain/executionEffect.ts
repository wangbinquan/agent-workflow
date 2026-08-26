// RFC-328 — logical effects, per-send attempts and multi-resource fences.

import { createHash } from 'node:crypto'
import { canonicalJson, type LineageSlot } from './executionIntent'

export const TASK_EXECUTION_EFFECT_KINDS = [
  'workspace-prepare',
  'workspace-rollback',
  'isolation-create',
  'isolation-merge',
  'repository',
  'process',
  'workspace-cleanup',
  'code-host-mutation',
  'outbound-mutation',
] as const
export type TaskExecutionEffectKind = (typeof TASK_EXECUTION_EFFECT_KINDS)[number]

export const TASK_EXECUTION_EFFECT_STATES = [
  'open',
  'succeeded',
  'failed',
  'outcome-unknown',
] as const
export type TaskExecutionEffectState = (typeof TASK_EXECUTION_EFFECT_STATES)[number]

export const TASK_EXECUTION_ATTEMPT_STATES = [
  'prepared',
  'acting',
  'succeeded',
  'failed-not-applied',
  'retry-authorized',
  'recovery-required',
  'outcome-unknown',
] as const
export type TaskExecutionAttemptState = (typeof TASK_EXECUTION_ATTEMPT_STATES)[number]

export const APPLICATION_EVIDENCE = ['applied', 'definitely-not-applied', 'ambiguous'] as const
export type ApplicationEvidence = (typeof APPLICATION_EVIDENCE)[number]

export const RETRY_AUTHORITIES = ['none', 'probe', 'convergent', 'transport-policy'] as const
export type RetryAuthority = (typeof RETRY_AUTHORITIES)[number]

export interface AttemptEvidence {
  readonly attemptNo: number
  readonly state: TaskExecutionAttemptState
  readonly applicationEvidence: ApplicationEvidence
}

export interface AggregatedEffectOutcome {
  readonly state: Extract<TaskExecutionEffectState, 'succeeded' | 'failed' | 'outcome-unknown'>
  readonly priorAmbiguityCount: number
  readonly appliedAttemptNo: number | null
}

export function operationFamilyKey(input: {
  executionLineageId: string
  slotPath: readonly LineageSlot[]
  effectKind: TaskExecutionEffectKind
  stableActionOrdinal: string
}): string {
  if (
    input.executionLineageId.length === 0 ||
    input.slotPath.length === 0 ||
    input.stableActionOrdinal.length === 0
  ) {
    throw new Error('invalid-operation-family-input')
  }
  return createHash('sha256')
    .update(
      canonicalJson({
        lineage: input.executionLineageId,
        path: input.slotPath,
        kind: input.effectKind,
        ordinal: input.stableActionOrdinal,
      }),
    )
    .digest('hex')
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function canonicalResourceKeySet(keys: readonly string[]): readonly string[] {
  if (keys.length === 0) throw new Error('effect requires at least one resource fence')
  const normalized = keys.map((key) => key.trim())
  if (normalized.some((key) => key.length === 0)) throw new Error('empty-resource-fence-key')
  const unique = [...new Set(normalized)].sort()
  if (unique.length !== normalized.length) throw new Error('duplicate-resource-fence-key')
  return Object.freeze(unique)
}

export function nextAttemptNo(attempts: readonly AttemptEvidence[]): number {
  const numbers = attempts.map((attempt) => attempt.attemptNo).sort((a, b) => a - b)
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) throw new Error('non-monotonic-effect-attempts')
  }
  return numbers.length + 1
}

export function canCreateNextAttempt(input: {
  previous: AttemptEvidence
  retryAuthority: RetryAuthority
}): boolean {
  if (input.retryAuthority === 'none') return false
  if (input.previous.state === 'failed-not-applied') {
    return input.retryAuthority === 'probe'
  }
  if (input.previous.state === 'retry-authorized') {
    return (
      input.retryAuthority === 'probe' ||
      input.retryAuthority === 'convergent' ||
      input.retryAuthority === 'transport-policy'
    )
  }
  return false
}

export function aggregateEffectOutcome(
  attempts: readonly AttemptEvidence[],
): AggregatedEffectOutcome {
  if (attempts.length === 0) throw new Error('cannot settle an effect without attempts')
  const sorted = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo)
  nextAttemptNo(sorted)
  const ambiguous = sorted.filter((attempt) => attempt.applicationEvidence === 'ambiguous')
  const applied = sorted.filter((attempt) => attempt.applicationEvidence === 'applied')
  if (applied.length > 0) {
    const winner = applied[applied.length - 1]!
    return {
      state: 'succeeded',
      priorAmbiguityCount: ambiguous.filter((attempt) => attempt.attemptNo < winner.attemptNo)
        .length,
      appliedAttemptNo: winner.attemptNo,
    }
  }
  if (ambiguous.length > 0) {
    return {
      state: 'outcome-unknown',
      priorAmbiguityCount: ambiguous.length,
      appliedAttemptNo: null,
    }
  }
  if (
    sorted.every(
      (attempt) =>
        attempt.applicationEvidence === 'definitely-not-applied' &&
        (attempt.state === 'failed-not-applied' || attempt.state === 'retry-authorized'),
    )
  ) {
    return { state: 'failed', priorAmbiguityCount: 0, appliedAttemptNo: null }
  }
  throw new Error('effect-attempts-not-terminal')
}

export function assertAttemptTransition(
  from: TaskExecutionAttemptState,
  to: TaskExecutionAttemptState,
): void {
  const allowed: Readonly<Record<TaskExecutionAttemptState, readonly TaskExecutionAttemptState[]>> =
    {
      prepared: ['acting', 'failed-not-applied'],
      acting: [
        'succeeded',
        'failed-not-applied',
        'retry-authorized',
        'recovery-required',
        'outcome-unknown',
      ],
      'recovery-required': [
        'succeeded',
        'failed-not-applied',
        'retry-authorized',
        'outcome-unknown',
      ],
      succeeded: [],
      'failed-not-applied': [],
      'retry-authorized': [],
      'outcome-unknown': [],
    }
  if (!allowed[from].includes(to))
    throw new Error(`illegal-effect-attempt-transition:${from}->${to}`)
}

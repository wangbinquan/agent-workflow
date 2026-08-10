import type { IntentTurnDto } from '@agent-workflow/shared'
import type { TFunction } from 'i18next'

const MISSING_ENVELOPE_REASONS = [
  'output-cap-hit',
  'no-assistant-text',
  'terminal-without-envelope',
  'assistant-stopped-without-envelope',
  'runtime-shape-unknown',
] as const
type MissingEnvelopeReason = (typeof MISSING_ENVELOPE_REASONS)[number]

interface OutputEvidence {
  observedAssistantTextBytes: number
  retainedAssistantTextBytes: number
  unparsedStdoutSeen: boolean
  lastNormalizedEventKind: string | null
  lastRuntimeEventType: string | null
  terminalResult: 'success' | 'error' | 'not-observed'
}

export interface IntentFailureDiagnostic {
  title: string
  suggestion: string
  evidence: readonly string[]
  scratchNotice: string | null
}

export function formatIntentDiagnosticBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${trimDecimal(bytes / 1024)} KiB`
  return `${trimDecimal(bytes / (1024 * 1024))} MiB`
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

export function intentFailureDiagnostic(
  turn: IntentTurnDto,
  t: TFunction,
): IntentFailureDiagnostic {
  const code = typeof turn.content.code === 'string' ? turn.content.code : 'intent-error'
  const reasonKey = isMissingEnvelopeReason(turn.content.reason)
    ? turn.content.reason
    : 'runtime-shape-unknown'
  const isMissingEnvelope = code === 'intent-envelope-missing'

  const meta = readRunMeta(turn.runMeta)
  const output = meta.outputEvidence
  const evidence: string[] = []
  if (output !== undefined) {
    evidence.push(
      t('intent.failureDiagnostic.observedRetained', {
        observed: formatIntentDiagnosticBytes(output.observedAssistantTextBytes),
        retained: formatIntentDiagnosticBytes(output.retainedAssistantTextBytes),
      }),
    )
    evidence.push(
      t('intent.failureDiagnostic.lastEvent', {
        kind: output.lastNormalizedEventKind ?? t('intent.failureDiagnostic.notObserved'),
        type: output.lastRuntimeEventType ?? t('intent.failureDiagnostic.notObserved'),
      }),
    )
    evidence.push(
      t('intent.failureDiagnostic.terminalResult', {
        result: t(`intent.failureDiagnostic.terminal.${output.terminalResult}`),
      }),
    )
    if (output.unparsedStdoutSeen) {
      evidence.push(t('intent.failureDiagnostic.unparsedStdout'))
    }
  }

  const retentionHours = meta.scratchRetentionHours
  const scratchNotice = turn.scratchRetained
    ? retentionHours === undefined
      ? t('intent.failureDiagnostic.scratchRetainedUnknown')
      : t('intent.failureDiagnostic.scratchRetained', { hours: retentionHours })
    : null

  return {
    title: isMissingEnvelope ? t(`intent.failureDiagnostic.reason.${reasonKey}.title`) : code,
    suggestion: isMissingEnvelope
      ? t(`intent.failureDiagnostic.reason.${reasonKey}.suggestion`)
      : t('intent.failureDiagnostic.genericSuggestion'),
    evidence,
    scratchNotice,
  }
}

function isMissingEnvelopeReason(value: unknown): value is MissingEnvelopeReason {
  return MISSING_ENVELOPE_REASONS.some((candidate) => candidate === value)
}

function readRunMeta(value: unknown): {
  outputEvidence?: OutputEvidence
  scratchRetentionHours?: number
} {
  if (!isRecord(value)) return {}
  const outputEvidence = readOutputEvidence(value.outputEvidence)
  const retention = value.scratchRetentionHours
  const scratchRetentionHours =
    typeof retention === 'number' &&
    Number.isInteger(retention) &&
    retention > 0 &&
    retention <= 24 * 14
      ? retention
      : undefined
  return {
    ...(outputEvidence === null ? {} : { outputEvidence }),
    ...(scratchRetentionHours === undefined ? {} : { scratchRetentionHours }),
  }
}

function readOutputEvidence(value: unknown): OutputEvidence | null {
  if (!isRecord(value)) return null
  const observed = safeByteCount(value.observedAssistantTextBytes)
  const retained = safeByteCount(value.retainedAssistantTextBytes)
  const kind = safeNullableLabel(value.lastNormalizedEventKind, /^[A-Za-z0-9._-]{1,64}$/)
  const runtimeType = safeNullableLabel(value.lastRuntimeEventType, /^[A-Za-z0-9._-]{1,64}$/)
  if (
    typeof value.assistantTextSeen !== 'boolean' ||
    observed === null ||
    retained === null ||
    typeof value.eventTextCapHit !== 'boolean' ||
    typeof value.unparsedStdoutSeen !== 'boolean' ||
    kind === undefined ||
    runtimeType === undefined ||
    (value.terminalResult !== 'success' &&
      value.terminalResult !== 'error' &&
      value.terminalResult !== 'not-observed')
  ) {
    return null
  }
  return {
    observedAssistantTextBytes: observed,
    retainedAssistantTextBytes: retained,
    unparsedStdoutSeen: value.unparsedStdoutSeen,
    lastNormalizedEventKind: kind,
    lastRuntimeEventType: runtimeType,
    terminalResult: value.terminalResult,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeByteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safeNullableLabel(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

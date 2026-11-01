// RFC-398 §2: pure session and approval policy.
import type { InstallationFacts, EpochInstallationState } from './classification'
import type { MigrationPlanDocument } from './documents'

export const AUTO_UPGRADE_RECORD_KINDS = [
  'intent',
  'rfc349-finalized',
  'provisioned',
  'plan-evaluated',
  'approved',
  'refused',
  'verify-failed',
  'rolled-back',
  'completed',
  'failed',
] as const
export type AutoUpgradeRecordKind = (typeof AUTO_UPGRADE_RECORD_KINDS)[number]
export interface AutoUpgradeRecord {
  readonly version: 1
  readonly operationId: string
  readonly sequence: number
  readonly kind: AutoUpgradeRecordKind
  readonly at: number
  readonly data: Readonly<Record<string, unknown>>
}
export interface AutoUpgradeSession {
  readonly operationId: string
  readonly sessionSequence: number
  readonly records: readonly AutoUpgradeRecord[]
  readonly unfinished: boolean
  readonly verificationFailed: boolean
  readonly outcome: 'completed' | 'failed' | null
}
/** Decisions are append-only; the migration journal remains the phase authority. */
export function foldAutoUpgradeSession(records: readonly AutoUpgradeRecord[]): AutoUpgradeSession {
  const intent = records[0]
  if (!intent || intent.kind !== 'intent' || !Number.isSafeInteger(intent.data.sessionSequence))
    throw new Error('auto-upgrade-intent-missing')
  let outcome: AutoUpgradeSession['outcome'] = null
  for (const [index, record] of records.entries()) {
    if (
      record.version !== 1 ||
      record.sequence !== index + 1 ||
      record.operationId !== intent.operationId ||
      !AUTO_UPGRADE_RECORD_KINDS.includes(record.kind) ||
      (index > 0 && record.kind === 'intent') ||
      outcome !== null
    )
      throw new Error('auto-upgrade-record-sequence-invalid')
    if (record.kind === 'completed' || record.kind === 'failed') outcome = record.kind
  }
  const verificationFailed = records.some((r) => r.kind === 'verify-failed')
  if (verificationFailed && outcome === 'completed')
    throw new Error('auto-upgrade-rollback-committed')
  return {
    operationId: intent.operationId,
    sessionSequence: Number(intent.data.sessionSequence),
    records,
    unfinished: outcome === null,
    verificationFailed,
    outcome,
  }
}
export const AUTO_UPGRADE_RETRY_GUIDANCE =
  'Automatic verification failed. The retained source is available to the old binary. Repair the reported problem, then run agent-workflow db migration auto --retry.'

export type AutoUpgradeTrigger = {
  readonly kind: 'start' | 'resume' | 'refuse' | 'noop'
  readonly reason: string
  readonly operationId?: string
  readonly guidance?: string
}
export function autoUpgradeTrigger(input: {
  readonly facts: InstallationFacts
  readonly installation: EpochInstallationState
  readonly standalone: boolean
  readonly enabled: boolean
  readonly retry?: boolean
}): AutoUpgradeTrigger {
  if (!input.standalone || !input.enabled) return { kind: 'noop', reason: 'manual-mode' }
  const sessions = input.facts.autoUpgradeSessions ?? []
  const latest = sessions.at(-1)
  const pending = [...sessions].reverse().find((s) => s.unfinished)
  const operation = input.facts.operation
  if (
    operation &&
    !['completed', 'rolled-back', 'abandoned'].includes(operation.payload.status) &&
    !sessions.some((s) => s.operationId === operation.payload.operationId)
  )
    return {
      kind: 'refuse',
      reason: 'manual-operation-active',
      guidance: `Continue the manual operation: agent-workflow db migration status ${operation.payload.operationId}`,
    }
  if (pending)
    return { kind: 'resume', reason: 'unfinished-session', operationId: pending.operationId }
  if (latest?.verificationFailed && latest.outcome === 'failed' && !input.retry)
    return {
      kind: 'refuse',
      reason: 'verification-failed',
      operationId: latest.operationId,
      guidance: `${AUTO_UPGRADE_RETRY_GUIDANCE}\n${JSON.stringify([...latest.records].reverse().find((r) => r.kind === 'verify-failed')?.data)}`,
    }
  if (input.installation.kind === 'epoch1')
    return { kind: 'start', reason: input.retry ? 'explicit-retry' : 'epoch1' }
  const installation = input.installation
  if (
    installation.kind === 'switch-recovery-required' &&
    installation.reason === 'activation-unreconciled' &&
    sessions.some((s) => s.operationId === installation.operation.payload.operationId)
  )
    return {
      kind: 'resume',
      reason: 'activation-unreconciled',
      operationId: installation.operation.payload.operationId,
    }
  return { kind: 'noop', reason: input.installation.kind }
}

export function evaluateAutoUpgradePlan(
  plan: Pick<MigrationPlanDocument, 'payload' | 'approvalDigest'>,
) {
  return plan.payload.blocks.length
    ? {
        kind: 'refuse' as const,
        reasons: plan.payload.blocks,
        restrictions: plan.payload.restrictions,
      }
    : {
        kind: 'approve' as const,
        digest: plan.approvalDigest,
        restrictions: plan.payload.restrictions,
      }
}

/** Both thrown EpochSwitchError and persisted/returned failure views use this table. */
export function classifyAutoUpgradeRun(
  value: unknown,
): 'awaiting-approval' | 'new-run' | 'activated' | 'error' {
  if (!value || typeof value !== 'object') return 'error'
  const v = value as {
    status?: string
    phase?: string
    category?: string
    code?: string
    detailCode?: string
    failure?: unknown
  }
  if (
    v.status === 'awaiting-approval' ||
    v.category === 'approval-required' ||
    v.code === 'v3-approval-required'
  )
    return 'awaiting-approval'
  if (v.failure && classifyAutoUpgradeRun(v.failure) === 'new-run') return 'new-run'
  if (
    v.category === 'source-changed' ||
    v.code === 'v3-source-changed' ||
    v.detailCode === 'v3-source-changed' ||
    (v.code ?? v.detailCode)?.endsWith('-new-run-required')
  )
    return 'new-run'
  if (v.phase === 'activated' && v.status !== 'failed') return 'activated'
  return 'error'
}
export interface AutoUpgradeAcceptanceEvidence {
  readonly runId: string
  readonly published: boolean
  readonly name: string
  readonly health: {
    readonly passed: boolean
    readonly catalogAdmitted: boolean
    readonly probes: readonly { readonly passed: boolean }[]
  }
}
export function autoUpgradeRollbackCommitment(input: {
  readonly session: AutoUpgradeSession
  readonly runId: string | null
  readonly failure: { readonly category: string; readonly detailCode: string } | null
  readonly artifacts: readonly AutoUpgradeAcceptanceEvidence[]
}): string | null {
  if (input.session.verificationFailed) return 'verify-failed'
  if (
    input.failure?.detailCode === 'v3-acceptance-failed' &&
    input.failure.category === 'health-failed'
  )
    return 'journal-acceptance-failed'
  if (
    input.artifacts.some(
      (a) =>
        a.published &&
        a.runId === input.runId &&
        /^acceptance-health-\d+\.json$/.test(a.name) &&
        (!a.health.passed || !a.health.catalogAdmitted || a.health.probes.some((p) => !p.passed)),
    )
  )
    return 'published-negative-acceptance'
  return null
}

export interface AutoUpgradeConclusion {
  readonly mode: 'auto'
  readonly outcome: 'done' | 'noop' | 'refused' | 'failed' | 'error'
  readonly exitCode: 0 | 1 | 3
  readonly operationId: string | null
  readonly guidance: readonly string[]
  readonly receipt?: Readonly<Record<string, unknown>>
}

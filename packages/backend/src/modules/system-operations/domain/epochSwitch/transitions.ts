import { digestSchemaContract as valueDigest } from '@/platform/persistence/schema/canonical'
import {
  createEpochSwitchJournal,
  EPOCH_SWITCH_PHASES,
  EpochSwitchError,
  type EpochSwitchJournal,
  type EpochSwitchJournalPayload,
  type EpochSwitchPhase,
} from './model'

export function phaseIndex(phase: EpochSwitchPhase): number {
  return EPOCH_SWITCH_PHASES.indexOf(phase)
}

export function rollbackEligibility(journal: EpochSwitchJournal): {
  allowed: boolean
  reason: string | null
} {
  const p = journal.payload
  if (p.phase === 'completed' || p.firstLiveWriteAt !== null)
    return { allowed: false, reason: 'reverse-migration-required' }
  if (p.status === 'rolled-back') return { allowed: false, reason: 'already-rolled-back' }
  if (p.status === 'abandoned') return { allowed: false, reason: 'operation-abandoned' }
  return { allowed: true, reason: null }
}

export function assertJournalSuccessor(
  current: EpochSwitchJournal,
  next: EpochSwitchJournal,
): void {
  const a = current.payload
  const b = next.payload
  const sameOwner = b.owner.id === a.owner.id && b.owner.fence === a.owner.fence
  const takeover = b.owner.id !== a.owner.id && b.owner.fence === a.owner.fence + 1
  if (
    a.operationId !== b.operationId ||
    b.revision !== a.revision + 1 ||
    b.previousDigest !== current.digest ||
    (!sameOwner && !takeover) ||
    b.createdAt !== a.createdAt ||
    b.kind !== a.kind ||
    b.deployment !== a.deployment ||
    b.role !== a.role ||
    b.updatedAt < a.updatedAt
  )
    throw new EpochSwitchError('v3-journal-stale-revision-or-owner', { category: 'owner-conflict' })
  if (valueDigest(b) !== next.digest)
    throw new EpochSwitchError('v3-journal-digest-mismatch', { category: 'journal-corrupt' })
}

type Patch = Partial<
  Omit<
    EpochSwitchJournalPayload,
    'version' | 'operationId' | 'revision' | 'previousDigest' | 'createdAt'
  >
>

export function reviseEpochSwitch(
  current: EpochSwitchJournal,
  patch: Patch,
  now: number,
): EpochSwitchJournal {
  const from = current.payload
  const to = patch.phase ?? from.phase
  if (to !== from.phase && phaseIndex(to) !== phaseIndex(from.phase) + 1)
    throw new EpochSwitchError(`v3-illegal-transition:${from.phase}:${to}`)
  if (['completed', 'rolled-back', 'abandoned'].includes(from.status) && to !== from.phase)
    throw new EpochSwitchError('v3-operation-terminal')
  if (to === 'backed-up' && from.phase !== to) assertApproved(current)
  if (to === 'completed' && from.phase !== to && from.phase !== 'verified')
    throw new EpochSwitchError('v3-completion-requires-verified')
  const next = createEpochSwitchJournal({
    ...from,
    ...patch,
    revision: from.revision + 1,
    previousDigest: current.digest,
    updatedAt: Math.max(now, from.updatedAt),
  })
  assertJournalSuccessor(current, next)
  return next
}

export function assertApproved(journal: EpochSwitchJournal): void {
  const plan = journal.payload.plan
  if (!plan || plan.approvedDigest !== plan.approvalDigest)
    throw new EpochSwitchError('v3-approval-required', { category: 'approval-required' })
}

export function takeOverEpochSwitch(
  current: EpochSwitchJournal,
  ownerId: string,
  now: number,
): EpochSwitchJournal {
  return reviseEpochSwitch(
    current,
    {
      owner: {
        id: ownerId,
        fence: current.payload.owner.fence + Number(ownerId !== current.payload.owner.id),
        leaseExpiresAt: now + 60_000,
      },
    },
    now,
  )
}

export function epochRunIdentity(operationId: string, ordinal: number) {
  const suffix = valueDigest({ operationId, ordinal }).slice(7, 39)
  return { runId: `emr_${suffix}`, generationId: `dbg_${suffix}` }
}

/** Only the operation lock holder may start another attempt; old receipts remain intact. */
export function newEpochRun(current: EpochSwitchJournal, now: number): EpochSwitchJournal {
  if (
    phaseIndex(current.payload.phase) >= phaseIndex('activation-prepared') ||
    ['completed', 'rolled-back', 'abandoned'].includes(current.payload.status)
  )
    throw new EpochSwitchError('v3-new-run-after-activation-preparation')
  const ordinal = (current.payload.run?.ordinal ?? 0) + 1
  const identity = epochRunIdentity(current.payload.operationId, ordinal)
  const location = current.payload.target.location
  const next = createEpochSwitchJournal({
    ...current.payload,
    revision: current.payload.revision + 1,
    previousDigest: current.digest,
    phase: 'discovered',
    status: 'running',
    plan: null,
    backup: null,
    frozen: null,
    activation: null,
    failure: null,
    run: {
      runId: identity.runId,
      ordinal,
      bindingDigest: null,
      summaryDigest: null,
      validationDigest: null,
      receiptExportDigest: null,
    },
    target: {
      ...current.payload.target,
      generationId: identity.generationId,
      location:
        location?.kind === 'sqlite-file'
          ? { kind: 'sqlite-file', relativePath: `databases/${identity.generationId}/db.sqlite` }
          : location,
    },
    updatedAt: Math.max(now, current.payload.updatedAt),
  })
  assertJournalSuccessor(current, next)
  return next
}

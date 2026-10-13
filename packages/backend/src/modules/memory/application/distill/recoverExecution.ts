import { canonicalJson, DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import { z } from 'zod'
import type { SystemAgentRunFamily } from '@/modules/task-execution/public/participants'
import type { MemoryDistillExecutionRecord } from '../ports/distillExecutionJournal'
import type { MemoryDistillWorkStore } from '../ports/distillWorkStore'
import type { MemoryDistillJobRecord } from '../ports/distillReadStore'
import {
  parseDistillerCandidates,
  validateAndPersistCandidate,
  rowToDistillJob,
  DEFAULT_TIMEOUT_MS,
  mapSystemAgentFailure,
  describeProtocolFailure,
  DistillerProtocolError,
} from './memoryDistiller'
import { DISTILL_MAX_ATTEMPTS, DISTILL_BACKOFF_BASE_MS } from '../../domain/distillSchedulingPolicy'
import { originalProtocolRounds } from './originalProtocolRounds'

const ids = z.array(z.string().min(1)).min(1)
const outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deferred'), ids }).strict(),
  z
    .object({
      kind: z.literal('done'),
      ids,
      finishedAt: z.number().finite(),
      candidatesCreated: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('failed'),
      ids,
      attempts: z.number().int().positive(),
      error: z.string(),
      now: z.number().finite(),
      retryAt: z.number().finite().nullable(),
    })
    .strict(),
])
export type OriginalMemoryDistillOutcome = z.infer<typeof outcome>
export type MemoryDistillRecoveryResult =
  | { readonly kind: 'settled' }
  | { readonly kind: 'unproven' }
  | { readonly kind: 'continuation'; readonly records: readonly MemoryDistillExecutionRecord[] }

function sameOriginal(actual: MemoryDistillJobRecord, original: MemoryDistillJobRecord): boolean {
  return (
    actual.id === original.id &&
    actual.sourceKind === original.sourceKind &&
    actual.sourceEventId === original.sourceEventId &&
    actual.taskId === original.taskId &&
    actual.createdAt === original.createdAt &&
    actual.debounceKey === original.debounceKey &&
    actual.scopeResolvedJson === original.scopeResolvedJson
  )
}
function matchesOutcome(
  actual: MemoryDistillJobRecord,
  original: MemoryDistillJobRecord,
  value: OriginalMemoryDistillOutcome,
): boolean {
  if (value.kind === 'deferred')
    return (
      (actual.status === 'pending' || actual.status === 'canceled') &&
      actual.startedAt === null &&
      actual.attempts === original.attempts
    )
  if (value.kind === 'done')
    return (
      actual.status === 'done' &&
      actual.finishedAt === value.finishedAt &&
      actual.attempts === original.attempts
    )
  return (
    actual.attempts === value.attempts &&
    actual.lastError === value.error &&
    (value.retryAt === null
      ? actual.status === 'failed' && actual.finishedAt === value.now
      : (actual.status === 'pending' || actual.status === 'canceled') &&
        actual.nextRunAt === value.retryAt &&
        actual.startedAt === null)
  )
}

/** Reconcile original facts only. Protocol continuation is returned for a
 * new active owner; recovery never launches a model from a standby API call. */
export async function recoverOriginalMemoryExecution(input: {
  readonly store: MemoryDistillWorkStore
  readonly systemAgents: SystemAgentRunFamily
  readonly records: readonly MemoryDistillExecutionRecord[]
  readonly now: () => number
  readonly allowPhysicalRecovery?: boolean
}): Promise<MemoryDistillRecoveryResult> {
  const records = [...input.records].sort((a, b) => a.roundIndex - b.roundIndex)
  const first = records[0]
  if (!first) return { kind: 'unproven' }
  if (
    records.some(
      (row) =>
        row.jobId !== first.jobId ||
        row.attemptIndex !== first.attemptIndex ||
        row.envelopeNonce !== first.envelopeNonce ||
        canonicalJson(row.original) !== canonicalJson(first.original) ||
        canonicalJson(row.scope) !== canonicalJson(first.scope),
    )
  )
    return { kind: 'unproven' }
  const { store, systemAgents } = input
  const journal = store.executionJournal
  const bundle = first.original
  const originalIds = bundle.map((row) => row.id)
  const loadOriginal = async (value?: OriginalMemoryDistillOutcome) => {
    const actual = await store.loadJobs(originalIds)
    const byId = new Map(actual.map((row) => [row.id, row]))
    if (
      actual.length !== bundle.length ||
      bundle.some((original) => {
        const row = byId.get(original.id)
        return (
          !row ||
          !sameOriginal(row, original) ||
          !(
            (value !== undefined && matchesOutcome(row, original, value)) ||
            (row.status === 'running' &&
              row.attempts === original.attempts &&
              row.startedAt === original.startedAt)
          )
        )
      })
    )
      throw new Error('memory-distill-original-recovery-job-mismatch')
    return actual
  }
  let proposed: OriginalMemoryDistillOutcome | undefined
  const settlements = [
    ...new Set(
      records.map((row) => row.settlement).filter((value): value is string => value !== null),
    ),
  ]
  if (settlements.length > 1) return { kind: 'unproven' }
  if (settlements[0] !== undefined) proposed = outcome.parse(JSON.parse(settlements[0]))
  if (
    proposed &&
    canonicalJson([...proposed.ids].sort()) !== canonicalJson([...originalIds].sort())
  )
    return { kind: 'unproven' }
  await loadOriginal(proposed)

  for (const [index, row] of records.entries()) {
    if (
      row.state === 'closed' ||
      row.state === 'reaped' ||
      (row.terminal !== null && row.terminal.status !== 'unreaped')
    )
      continue
    if (input.allowPhysicalRecovery !== true) return { kind: 'unproven' }
    if (row.receipt.recoveryRef === null) return { kind: 'unproven' }
    const physical = await systemAgents.recovery.recoverReference({
      executionRef: row.receipt.executionRef,
      recoveryRef: row.receipt.recoveryRef,
    })
    if (physical.executionRef !== row.receipt.executionRef || physical.state !== 'reaped')
      return { kind: 'unproven' }
    await journal.reaped(row.receipt)
    records[index] = { ...row, state: 'reaped' }
  }
  const rounds = originalProtocolRounds(records)
  if (rounds === null) return { kind: 'unproven' }
  const last = rounds.at(-1) ?? first
  if (!proposed && rounds.length === 0 && records.every((row) => row.roundIndex === 0))
    proposed = { kind: 'deferred', ids: originalIds }

  if (!proposed && last.terminal?.status === 'ok') {
    const parsed = parseDistillerCandidates(last.terminal.eventText, last.envelopeNonce)
    if (
      !parsed.ok &&
      rounds.some((row) => row.terminal?.capturedSessionId !== undefined) &&
      last.roundIndex < DEFAULT_PROTOCOL_RETRY_BUDGET
    ) {
      const scope = systemAgents.workspaces.capture(first.scope)
      for (const row of [...records].reverse()) {
        const originalMaterial = await systemAgents.retainedContents.inspect({
          retainedRef: row.receipt.retainedRef,
          scope,
        })
        if (originalMaterial.available) return { kind: 'continuation', records }
      }
      return { kind: 'unproven' }
    }
    if (parsed.ok) {
      const head = bundle.find((row) => row.id === first.jobId)
      if (!head) return { kind: 'unproven' }
      const job = rowToDistillJob(head)
      let created = 0
      const rejections: string[] = []
      for (const [index, candidate] of parsed.candidates.entries()) {
        const persisted = await validateAndPersistCandidate(
          store,
          candidate,
          job,
          (reason) => {
            rejections.push(reason)
          },
          { executionRef: last.receipt.executionRef, preparedAt: last.preparedAt, index },
        )
        if (persisted) created += 1
      }
      if (parsed.candidates.length > 0 && created === 0) {
        const attempts = first.attemptIndex + 1,
          at = input.now()
        proposed = {
          kind: 'failed',
          ids: originalIds,
          attempts,
          error: `distiller emitted ${parsed.candidates.length} candidate(s) but none passed validation: ${rejections[0] ?? 'unknown reason'}`,
          now: at,
          retryAt:
            attempts >= DISTILL_MAX_ATTEMPTS
              ? null
              : at + DISTILL_BACKOFF_BASE_MS * Math.pow(2, attempts - 1),
        }
      } else
        proposed = {
          kind: 'done',
          ids: originalIds,
          candidatesCreated: created,
          finishedAt: input.now(),
        }
    }
  }
  if (!proposed) {
    const attempts = first.attemptIndex + 1,
      at = input.now()
    let error = 'original distillation execution retired without a confirmed business result'
    if (last.terminal?.status === 'ok') {
      const parsed = parseDistillerCandidates(last.terminal.eventText, last.envelopeNonce)
      if (!parsed.ok)
        error = new DistillerProtocolError(
          parsed.code,
          last.roundIndex + 1,
          describeProtocolFailure(parsed, last.terminal.outputEvidence),
        ).message
    } else if (last.terminal !== null)
      error = mapSystemAgentFailure(last.terminal, last.timeoutMs ?? DEFAULT_TIMEOUT_MS).message
    proposed = {
      kind: 'failed',
      ids: originalIds,
      attempts,
      error: error.slice(0, 2000),
      now: at,
      retryAt:
        attempts >= DISTILL_MAX_ATTEMPTS
          ? null
          : at + DISTILL_BACKOFF_BASE_MS * Math.pow(2, attempts - 1),
    }
  }

  // Retained spawn failures preserve the original native diagnostic policy.
  if (last.terminal?.status !== 'spawn-failed') {
    const scope = systemAgents.workspaces.capture(last.scope)
    const released = await systemAgents.retainedContents.release({
      retainedRef: last.receipt.retainedRef,
      scope,
    })
    if (!released.removed) return { kind: 'unproven' }
  }
  const serialized = canonicalJson(proposed)
  const receipts = records.map((row) => row.receipt)
  await journal.settlement({ receipts, settlement: serialized })
  await loadOriginal(proposed)
  if (proposed.kind === 'deferred') {
    const startedAt = bundle[0]?.startedAt
    if (
      startedAt === null ||
      startedAt === undefined ||
      !(await store.deferUnissued({ original: bundle, startedAt, allowPreparedPrompt: true }))
    )
      return { kind: 'unproven' }
  } else if (proposed.kind === 'done')
    await store.markDone(originalIds, proposed.finishedAt, bundle)
  else
    await store.markFailed({
      ids: originalIds,
      attempts: proposed.attempts,
      error: proposed.error,
      now: proposed.now,
      retryAt: proposed.retryAt,
      original: bundle,
    })
  const final = await store.loadJobs(originalIds)
  if (
    final.length !== bundle.length ||
    bundle.some((original) => {
      const row = final.find((candidate) => candidate.id === original.id)
      return !row || !sameOriginal(row, original) || !matchesOutcome(row, original, proposed!)
    })
  )
    return { kind: 'unproven' }
  await journal.close({ receipts, settlement: serialized })
  return { kind: 'settled' }
}

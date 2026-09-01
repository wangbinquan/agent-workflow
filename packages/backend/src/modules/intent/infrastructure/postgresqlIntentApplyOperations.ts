import { formatChangesetIssues, parseIntentChangeset } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { ZodError } from 'zod'

import type { Actor } from '@/auth/actor'
import type {
  IntentApplyInput,
  IntentApplyOperations,
  IntentApplyReceipt,
} from '@/modules/intent/application/ports/intentApplyOperations'
import {
  intentApplyJournal,
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
} from '@/db/schema'
import type {
  PostgresqlIntentApplyArtifact,
  PostgresqlIntentApplyResourceSession,
} from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { VersionedIntentResourceChangesetPlan } from '@/modules/resource-catalog/public/types'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import type { ApplyIntentFaults } from './sqliteIntentApplyOperations'
import type { IntentJournalArtifact } from '@/services/intent/journalArtifacts'
import {
  applyCommitMounts,
  createHandleAllocator,
  handleWatermarkOf,
  lineageRootOf,
  mergeHandleWatermarks,
  parseHandleWatermark,
  type IntentContextManifest,
  type IntentManifestEntry,
} from '@/services/intent/manifest'
import { resolveIntentBundle, type ResolvedIntentOp } from '@/services/intent/resolveChangeset'
import { sessionManifest } from '@/services/intent/session'

type IntentApplyRecoveryArtifact = PostgresqlIntentApplyArtifact | IntentJournalArtifact

export interface PostgresqlIntentApplyArtifactLifecycle {
  compensate(artifact: IntentApplyRecoveryArtifact): Promise<void>
  /** Returns false when a committed tail remains retryable. */
  rollForward(artifacts: readonly IntentApplyRecoveryArtifact[], log: Logger): Promise<boolean>
}

export interface PostgresqlIntentApplyResourceBinding {
  createSession(input: {
    readonly actor: Actor
    readonly authority: ResourceRequestContext
  }): PostgresqlIntentApplyResourceSession
}

export interface PostgresqlIntentApplyRequest {
  readonly actor: Actor
  readonly authority: ResourceRequestContext
  readonly command: IntentApplyInput
  readonly faults?: ApplyIntentFaults
  readonly log?: Logger
}

export interface PostgresqlIntentApplyOperations extends IntentApplyOperations {
  apply(request: PostgresqlIntentApplyRequest): Promise<IntentApplyReceipt>
  converge(
    log?: Logger,
    options?: { readonly activeJournalIds?: readonly string[] },
  ): Promise<{ failed: number; rolledForward: number }>
  activeJournalIds(): readonly string[]
}

export interface PostgresqlIntentApplyDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly resources: PostgresqlIntentApplyResourceBinding
  readonly artifacts: PostgresqlIntentApplyArtifactLifecycle
  readonly id?: () => string
  readonly now?: () => number
}

const CONVERGE_MIN_AGE_MS = 10 * 60 * 1000

function intentResourcePlanOf(
  operation: ResolvedIntentOp,
  manifestByHandle: ReadonlyMap<string, IntentManifestEntry>,
): VersionedIntentResourceChangesetPlan {
  const payload =
    operation.resourceType === 'plugin' && 'options' in operation.payload
      ? (() => {
          const { options, ...rest } = operation.payload
          return { ...rest, optionsJson: options }
        })()
      : operation.payload
  if (operation.action === 'update') {
    const expectedRevision = operation.manifestEntry?.fence
    if (expectedRevision === undefined || expectedRevision.kind !== operation.resourceType) {
      throw new ConflictError(
        'intent-baseline-stale',
        `${operation.resourceType} fence missing for intent update`,
      )
    }
    return {
      kind: operation.resourceType,
      operationId: operation.opId,
      action: 'update',
      resourceId: operation.resourceId,
      expectedRevision,
      payload,
    } as VersionedIntentResourceChangesetPlan
  }
  const copiedFromResourceId =
    operation.copiedFromHandle === undefined
      ? undefined
      : manifestByHandle.get(operation.copiedFromHandle)?.resourceId
  return {
    kind: operation.resourceType,
    operationId: operation.opId,
    action: 'create',
    resourceId: operation.resourceId,
    fromCopy: operation.fromCopy,
    ...(copiedFromResourceId === undefined ? {} : { copiedFromResourceId }),
    payload,
  } as VersionedIntentResourceChangesetPlan
}

function decodeRecoveryArtifacts(json: string): IntentApplyRecoveryArtifact[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error('intent journal artifacts must be an array')
  return parsed.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('intent journal artifact must be an object')
    }
    const kind = (value as { readonly kind?: unknown }).kind
    if (
      kind !== 'legacy-plugin-install-untracked' &&
      kind !== 'plugin-install' &&
      kind !== 'skill-stage' &&
      kind !== 'skill-version-stage'
    ) {
      throw new Error(`unknown intent journal artifact kind '${String(kind)}'`)
    }
    return value as IntentApplyRecoveryArtifact
  })
}

function replayIntentApplyOutcome(row: typeof intentApplyJournal.$inferSelect): IntentApplyReceipt {
  if (row.state === 'committed' && row.receiptJson !== null) {
    return JSON.parse(row.receiptJson) as IntentApplyReceipt
  }
  if (row.state === 'failed') {
    throw new ConflictError(
      'intent-apply-failed-replay',
      row.error ?? 'this apply attempt failed',
      { journalId: row.id },
    )
  }
  throw new ConflictError(
    'intent-apply-unsettled',
    'a prior apply attempt is unsettled; retry later',
    { journalId: row.id },
  )
}

export function createPostgresqlIntentApplyOperations(
  dependencies: PostgresqlIntentApplyDependencies,
): PostgresqlIntentApplyOperations {
  const nextId = dependencies.id ?? ulid
  const now = dependencies.now ?? Date.now
  const active = new Set<string>()
  const locks = new Map<string, Promise<unknown>>()

  async function withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const prior = locks.get(sessionId) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const chain = prior.then(() => gate)
    locks.set(sessionId, chain)
    await prior.catch(() => {})
    try {
      return await run()
    } finally {
      release()
      if (locks.get(sessionId) === chain) locks.delete(sessionId)
    }
  }

  async function applyUnlocked(request: PostgresqlIntentApplyRequest): Promise<IntentApplyReceipt> {
    const { actor, authority, command: input } = request
    const log = request.log ?? createLogger('intentApply')
    const journalId = nextId()
    const claim = await dependencies.db.transaction(async (transaction) => {
      const session = await transaction
        .select()
        .from(intentSessions)
        .where(eq(intentSessions.id, input.sessionId))
        .get()
      if (session === undefined || session.ownerUserId !== actor.user.id) {
        throw new NotFoundError('intent-session-not-found', 'intent session not found')
      }
      const existing = await transaction
        .select()
        .from(intentApplyJournal)
        .where(
          and(
            eq(intentApplyJournal.sessionId, input.sessionId),
            eq(intentApplyJournal.clientMutationId, input.clientMutationId),
          ),
        )
        .get()
      if (existing !== undefined) return { kind: 'replay' as const, existing, session }
      if (session.status !== 'active') {
        throw new ConflictError('intent-session-archived', 'session is archived')
      }
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is running')
      }
      const draft = await transaction
        .select()
        .from(intentDrafts)
        .where(
          and(
            eq(intentDrafts.sessionId, input.sessionId),
            eq(intentDrafts.revision, input.draftRevision),
          ),
        )
        .get()
      if (draft === undefined) {
        throw new NotFoundError('intent-draft-not-found', 'draft revision not found')
      }
      if (draft.draftHash !== input.draftHash) {
        throw new ConflictError(
          'intent-draft-hash-mismatch',
          'confirmed draft hash does not match',
          { expected: draft.draftHash },
        )
      }
      if (draft.contextRevision !== session.contextRevision) {
        throw new ConflictError(
          'intent-baseline-stale',
          'the session context moved since this draft was generated; rebase and regenerate',
        )
      }
      if (session.currentDraftId !== draft.id) {
        throw new ConflictError(
          'intent-draft-superseded',
          'a newer draft revision exists in this session; review and commit the latest draft',
          { confirmedRevision: draft.revision },
        )
      }
      const resolution = await transaction
        .select({ reason: intentDraftResolutions.reason })
        .from(intentDraftResolutions)
        .where(eq(intentDraftResolutions.draftId, draft.id))
        .get()
      if (resolution !== undefined) {
        throw new ConflictError(
          'intent-draft-superseded',
          `this draft is ${resolution.reason} and can no longer be committed`,
        )
      }
      const recordedAt = now()
      await transaction.insert(intentApplyJournal).values({
        id: journalId,
        sessionId: input.sessionId,
        clientMutationId: input.clientMutationId,
        draftId: draft.id,
        draftHash: draft.draftHash,
        state: 'prepared',
        preparedArtifactsJson: '[]',
        createdAt: recordedAt,
        updatedAt: recordedAt,
      })
      return { kind: 'claimed' as const, session, draft }
    })

    if (claim.kind === 'replay') return replayIntentApplyOutcome(claim.existing)
    active.add(journalId)
    const artifacts: IntentApplyRecoveryArtifact[] = []
    const recordArtifact = async (artifact: PostgresqlIntentApplyArtifact): Promise<void> => {
      const nextArtifacts = [...artifacts, artifact]
      await dependencies.db
        .update(intentApplyJournal)
        .set({ preparedArtifactsJson: JSON.stringify(nextArtifacts), updatedAt: now() })
        .where(eq(intentApplyJournal.id, journalId))
      artifacts.push(artifact)
    }
    const settleFailed = async (error: unknown): Promise<void> => {
      await dependencies.db
        .update(intentApplyJournal)
        .set({
          state: 'failed',
          error:
            error instanceof Error
              ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}`
              : String(error),
          updatedAt: now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
    }
    const keepRetryable = async (
      error: unknown,
      compensationErrors: readonly unknown[],
    ): Promise<void> => {
      const original = error instanceof Error ? error.message : String(error)
      const cleanup = compensationErrors
        .map((item) => (item instanceof Error ? item.message : String(item)))
        .join('; ')
      await dependencies.db
        .update(intentApplyJournal)
        .set({
          error: `retryable after apply error: ${original}; compensation incomplete: ${cleanup}`,
          updatedAt: now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
    }

    let committedReceipt: IntentApplyReceipt | null = null
    const resourceSession = dependencies.resources.createSession({ actor, authority })
    try {
      const manifest = sessionManifest(claim.session)
      const parsedChangeset = parseIntentChangeset(claim.draft.changesetJson)
      if (!parsedChangeset.ok) {
        throw new ValidationError(
          'intent-changeset-invalid',
          `stored draft changeset is invalid: ${parsedChangeset.errors.join('; ')}`,
        )
      }
      const changeset = parsedChangeset.changeset
      const { occupiedNames, copyOnlyTargets } = await resourceSession.preflight(
        manifest,
        changeset,
      )
      const bundle = resolveIntentBundle({
        manifest,
        changeset,
        decisions: input.decisions,
        occupiedNames,
        copyOnlyTargets,
      })
      const pendingIds = new Set(
        bundle.ops
          .filter((operation) => operation.action === 'create')
          .map((operation) => operation.resourceId),
      )
      const pendingAgentNames = new Map(
        bundle.ops
          .filter(
            (operation) => operation.action === 'create' && operation.resourceType === 'agent',
          )
          .map((operation) => [
            operation.resourceId,
            (operation.payload as { readonly name: string }).name,
          ]),
      )
      const manifestByHandle = new Map(
        manifest.map((entry): [string, IntentManifestEntry] => [entry.handle, entry]),
      )
      const plans = bundle.ops.map((operation) => intentResourcePlanOf(operation, manifestByHandle))
      for (const plan of plans) {
        try {
          await resourceSession.prepare(plan, {
            pendingIds,
            pendingAgentNames,
            clientMutationId: input.clientMutationId,
          })
        } catch (error) {
          if (error instanceof ZodError) {
            throw new ValidationError(
              'intent-op-canonical-invalid',
              `${plan.operationId}: ${formatChangesetIssues(error.issues).join('; ')}`,
            )
          }
          throw error
        }
      }
      for (const plan of plans) await resourceSession.prestage(plan, { recordArtifact })
      request.faults?.beforeTx?.()

      const transactionResult = await dependencies.db.transaction(async (transaction) => {
        const cas = await transaction
          .update(intentApplyJournal)
          .set({ state: 'applying', updatedAt: now() })
          .where(
            and(eq(intentApplyJournal.id, journalId), eq(intentApplyJournal.state, 'prepared')),
          )
          .returning({ id: intentApplyJournal.id })
          .get()
        if (cas === undefined) {
          throw new ConflictError('intent-apply-unsettled', 'journal claim lost')
        }
        const sessionNow = await transaction
          .select()
          .from(intentSessions)
          .where(eq(intentSessions.id, input.sessionId))
          .get()
        if (
          sessionNow === undefined ||
          sessionNow.contextRevision !== claim.session.contextRevision ||
          sessionNow.currentDraftId !== claim.draft.id ||
          sessionNow.inFlightTurnId !== null
        ) {
          throw new ConflictError(
            'intent-baseline-stale',
            'the session changed while the apply was staging; rebase and regenerate',
          )
        }

        const bundleCreatedNames = {
          workflow: new Set<string>(),
          workgroup: new Set<string>(),
        }
        for (const plan of plans) {
          if (plan.action !== 'create') continue
          const bucket =
            plan.kind === 'workflow'
              ? bundleCreatedNames.workflow
              : plan.kind === 'workgroup'
                ? bundleCreatedNames.workgroup
                : null
          if (bucket === null) continue
          const name = (plan.payload as { readonly name?: unknown }).name
          if (typeof name === 'string' && name.length > 0) bucket.add(name)
        }
        const attempt = resourceSession.createTransactionAttempt(transaction, {
          bundleCreatedNames,
        })
        const applied: IntentApplyReceipt['applied'] = []
        for (const [index, plan] of plans.entries()) {
          const operation = bundle.ops[index]
          if (operation === undefined || operation.opId !== plan.operationId) {
            throw new Error('intent-resource-plan-order-mismatch')
          }
          await attempt.participant.authorizeAndCommit(authority, plan)
          applied.push({
            opId: operation.opId,
            resourceType: operation.resourceType,
            resourceId: operation.resourceId,
            action: operation.action,
            fromCopy: operation.fromCopy,
            name: (operation.payload as { readonly name: string }).name,
          })
          await transaction.insert(intentProvenance).values({
            resourceType: operation.resourceType,
            resourceId: operation.resourceId,
            commitId: journalId,
            sessionId: input.sessionId,
            createdAt: now(),
          })
        }
        request.faults?.inTxAfterOps?.()

        const preCommitManifest = JSON.parse(
          sessionNow.contextManifestJson,
        ) as IntentContextManifest
        const preCommitByHandle = new Map(
          preCommitManifest.map((entry) => [entry.handle, entry] as const),
        )
        const copySourceHandles: string[] = []
        const lineageOriginByResourceId = new Map<string, string>()
        for (const operation of bundle.ops) {
          const sourceHandle = operation.copiedFromHandle
          if (sourceHandle === undefined) continue
          copySourceHandles.push(sourceHandle)
          const sourceEntry = preCommitByHandle.get(sourceHandle)
          if (sourceEntry !== undefined) {
            lineageOriginByResourceId.set(operation.resourceId, lineageRootOf(sourceEntry))
          }
        }
        const commitSeq = claim.session.commitSeq + 1
        const nextManifest = applyCommitMounts(preCommitManifest, {
          created: bundle.ops
            .filter((operation) => operation.action === 'create')
            .map((operation) => {
              const origin = lineageOriginByResourceId.get(operation.resourceId)
              return {
                resourceType: operation.resourceType,
                resourceId: operation.resourceId,
                ...(origin === undefined ? {} : { copiedFromResourceId: origin }),
              }
            }),
          unmountHandles: copySourceHandles,
        })
        await transaction
          .update(intentSessions)
          .set({
            commitSeq,
            contextRevision: claim.session.contextRevision + 1,
            currentDraftId: null,
            contextManifestJson: JSON.stringify(nextManifest),
            handleWatermarkJson: JSON.stringify(
              mergeHandleWatermarks(
                parseHandleWatermark(claim.session.handleWatermarkJson),
                handleWatermarkOf(createHandleAllocator(nextManifest)),
              ),
            ),
            updatedAt: now(),
          })
          .where(eq(intentSessions.id, input.sessionId))
        const receiptValue: IntentApplyReceipt = { journalId, commitSeq, applied }
        await transaction
          .update(intentApplyJournal)
          .set({
            state: 'committed',
            receiptJson: JSON.stringify(receiptValue),
            updatedAt: now(),
          })
          .where(eq(intentApplyJournal.id, journalId))
        return Object.freeze({ receipt: receiptValue, attempt })
      })
      const { receipt, attempt } = transactionResult
      committedReceipt = receipt
      attempt.commitSucceeded()
      request.faults?.afterTxBeforeRollForward?.()
      await resourceSession.rollForwardCommitted()
      const complete = await dependencies.artifacts.rollForward(artifacts, log)
      if (!complete) {
        await dependencies.db
          .update(intentApplyJournal)
          .set({
            error: 'retryable: committed roll-forward incomplete; inspect intent apply logs',
            updatedAt: now(),
          })
          .where(eq(intentApplyJournal.id, journalId))
      }
      await resourceSession.broadcastCommitted()
      return receipt
    } catch (error) {
      if (committedReceipt !== null) {
        try {
          await resourceSession.abortPrepared({ databaseCommitted: true })
        } catch (abortError) {
          log.warn('intent-resource-roll-forward-recovery-failed', {
            journalId,
            err: abortError instanceof Error ? abortError.message : String(abortError),
          })
        }
        log.warn('intent-roll-forward-crashed', {
          journalId,
          err: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      const compensationErrors: unknown[] = []
      try {
        await resourceSession.abortPrepared({ databaseCommitted: false })
      } catch (compensationError) {
        compensationErrors.push(compensationError)
        log.warn('intent-resource-abort-failed', {
          journalId,
          err:
            compensationError instanceof Error
              ? compensationError.message
              : String(compensationError),
        })
      }
      for (const artifact of [...artifacts].reverse()) {
        try {
          request.faults?.beforeArtifactCompensation?.(artifact as IntentJournalArtifact)
          await dependencies.artifacts.compensate(artifact)
        } catch (compensationError) {
          compensationErrors.push(compensationError)
          log.warn('intent-artifact-compensation-failed', {
            kind: artifact.kind,
            err:
              compensationError instanceof Error
                ? compensationError.message
                : String(compensationError),
          })
        }
      }
      if (compensationErrors.length === 0) await settleFailed(error)
      else await keepRetryable(error, compensationErrors)
      throw error
    } finally {
      active.delete(journalId)
    }
  }

  async function converge(
    log: Logger = createLogger('intentApply'),
    options: { readonly activeJournalIds?: readonly string[] } = {},
  ): Promise<{ failed: number; rolledForward: number }> {
    let failed = 0
    let rolledForward = 0
    const rows = await dependencies.db.select().from(intentApplyJournal)
    const reapBefore = now() - CONVERGE_MIN_AGE_MS
    for (const row of rows) {
      if (row.state === 'failed') continue
      let artifacts: IntentApplyRecoveryArtifact[]
      try {
        artifacts = decodeRecoveryArtifacts(row.preparedArtifactsJson)
      } catch (error) {
        log.warn('intent-journal-artifact-corrupt', {
          journalId: row.id,
          state: row.state,
          err: error instanceof Error ? error.message : String(error),
        })
        await dependencies.db
          .update(intentApplyJournal)
          .set({
            error: `retryable: artifact decode failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
          .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
        continue
      }
      if (row.state === 'prepared' || row.state === 'applying') {
        if (
          active.has(row.id) ||
          options.activeJournalIds?.includes(row.id) === true ||
          row.updatedAt > reapBefore
        ) {
          continue
        }
        const errors: unknown[] = []
        for (const artifact of [...artifacts].reverse()) {
          try {
            await dependencies.artifacts.compensate(artifact)
          } catch (error) {
            errors.push(error)
            log.warn('intent-converge-compensation-failed', {
              journalId: row.id,
              kind: artifact.kind,
              err: error instanceof Error ? error.message : String(error),
            })
          }
        }
        if (errors.length > 0) {
          await dependencies.db
            .update(intentApplyJournal)
            .set({
              error: `retryable: compensation incomplete: ${errors
                .map((error) => (error instanceof Error ? error.message : String(error)))
                .join('; ')}`,
            })
            .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
          continue
        }
        const cas = await dependencies.db
          .update(intentApplyJournal)
          .set({ state: 'failed', error: 'daemon-restart before commit', updatedAt: now() })
          .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
          .returning({ id: intentApplyJournal.id })
          .get()
        if (cas !== undefined) failed += 1
        continue
      }
      const complete = await dependencies.artifacts.rollForward(artifacts, log)
      if (complete) {
        rolledForward += 1
        if (row.error !== null) {
          await dependencies.db
            .update(intentApplyJournal)
            .set({ error: null, updatedAt: now() })
            .where(
              and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')),
            )
        }
      } else {
        await dependencies.db
          .update(intentApplyJournal)
          .set({
            error: 'retryable: committed roll-forward incomplete; inspect intent apply logs',
            updatedAt: now(),
          })
          .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')))
      }
    }
    return { failed, rolledForward }
  }

  return Object.freeze({
    apply(request: PostgresqlIntentApplyRequest) {
      return withSessionLock(request.command.sessionId, () => applyUnlocked(request))
    },
    converge,
    activeJournalIds: () => [...active],
  })
}

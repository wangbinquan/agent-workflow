// RFC-234 §9 (T6) — the intent bundle apply pipeline.
//
// External invariant (AC-4/AC-13): either every resource of the confirmed
// draft lands terminally VISIBLE, or zero do; one clientMutationId takes
// effect at most once (duplicate requests replay the stored receipt).
//
// Phases (design §9.1-§9.5):
//   claim     one tx: draft-hash + context-epoch + no-in-flight checks, then
//             UNIQUE(session, clientMutationId) journal claim ('prepared').
//             A duplicate returns the stored receipt/error with ZERO side
//             effects (design-gate P0-6).
//   preflight resolveIntentBundle (slots/copy/rewiring) + per-type prepare*
//             kernels with same-bundle pending seams. No side effects.
//   prestage  compensable side effects, each RECORDED IN THE JOURNAL BEFORE it
//             runs (design-gate P0-5): plugin installs, skill stages.
//   big tx    journal CAS prepared→applying, then every commit kernel in topo
//             order (same-connection uncommitted visibility makes
//             assertRefsUsableInTx exact for bundle-internal refs), fences
//             re-verified inside the kernels, provenance rows, session epoch
//             close, journal 'committed' + receipt.
//   forward   idempotent post-commit publishes: skill finishOperation,
//             created/updated broadcasts.
//   converge  boot/hourly: prepared/applying → compensate artifacts → failed;
//             committed → replay roll-forward (convergeIntentApplyJournal).
//
// v1 op-coverage boundary (recorded in plan.md): creates for all six types +
// updates for agent/mcp/workflow/workgroup. skill/plugin UPDATE ops are
// rejected as `intent-op-unsupported` until the follow-stretch lands the
// op-lock + staged-version roll-forward path.

import { and, eq } from 'drizzle-orm'
import { formatChangesetIssues } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { intentResourcePlanOf } from '../application/intentResourcePlan'
import { decodeStoredChangeset } from '../domain/storedChangeset'
import { INTENT_APPLY_DIAGNOSTICS } from '../application/journalConvergence'
import {
  requireCommittableDraft,
  assertIntentDraftUnresolved,
  assertIntentSessionClaimable,
  assertIntentSessionReady,
} from '../domain/applyClaim'
import { createSessionApplyLock } from '../application/sessionApplyLock'
import {
  appliedEntryOf,
  assertIntentApplyBaselineFresh,
  bundleCreatedNamesOf,
  intentApplyCommitMutationOf,
  requireOpForPlan,
} from '../application/applyCommitPlan'
import { intentApplyReplayOutcomeOf } from '../application/applyReplay'
import {
  intentApplyJournal,
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
} from '@/db/schema'
import { ConflictError, ValidationError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import { ulid } from 'ulid'
import { ZodError } from 'zod'
import type {
  IntentApplyResourceParticipantInTx,
  ResourceRequestContext,
} from '@/modules/resource-catalog/public/participants'
import type { VersionedIntentResourceChangesetPlan } from '@/modules/resource-catalog/public/types'
import {
  type IntentContextManifest,
  type IntentManifestEntry,
} from '@/modules/intent/application/manifest'
import {
  resolveIntentBundle,
  type IntentDecision,
  type ResolvedIntentOp,
} from '@/modules/intent/application/resolveChangeset'
import { sessionManifest } from '@/modules/intent/application/session'
import {
  decodeIntentJournalArtifacts,
  encodeIntentJournalArtifacts,
  type IntentJournalArtifact,
  type IntentJournalArtifactV1,
} from '@/modules/intent/domain/journalArtifacts'
import type { SqliteIntentApplyArtifactLifecycle } from './sqliteIntentApplyArtifactLifecycle'

export interface IntentApplyReceipt {
  journalId: string
  commitSeq: number
  applied: Array<{
    opId: string
    resourceType: string
    resourceId: string
    action: 'create' | 'update'
    fromCopy: boolean
    name: string
  }>
}

export interface ApplyIntentFaults {
  afterPluginInstall?: () => void
  afterSkillStage?: () => void
  beforeTx?: () => void
  inTxAfterOps?: () => void
  afterTxBeforeRollForward?: () => void
  /** Test-only seam for proving that partial cleanup never terminalizes a journal. */
  beforeArtifactCompensation?: (artifact: IntentJournalArtifact) => void
}

export interface ApplyIntentDeps {
  db: DbClient
  appHome: string
  actor: Actor
  authority: ResourceRequestContext
  resourceApply: IntentApplyResourceBinding
  /** Required provider-owned filesystem/skill recovery mechanics. */
  artifacts: SqliteIntentApplyArtifactLifecycle
  /** Plugin installer seam (tests point specs at local fixtures). */
  pluginInstallOpts?: {
    readonly pluginsDir?: string
    readonly npmBin?: string
    readonly timeoutMs?: number
  }
  faults?: ApplyIntentFaults
  log?: Logger
}

export interface IntentApplyResourceSession {
  preflight(
    manifest: IntentContextManifest,
    changeset: {
      readonly ops: ReadonlyArray<{
        readonly action: string
        readonly resourceType: string
        readonly target?: string
      }>
    },
  ): Promise<{
    readonly occupiedNames: ReadonlyMap<ResolvedIntentOp['resourceType'], ReadonlySet<string>>
    readonly copyOnlyTargets: ReadonlyMap<string, string>
  }>
  prepare(
    plan: VersionedIntentResourceChangesetPlan,
    context: {
      readonly pendingIds: ReadonlySet<string>
      readonly pendingAgentNames: ReadonlyMap<string, string>
      readonly clientMutationId: string
    },
  ): Promise<void>
  prestage(
    plan: VersionedIntentResourceChangesetPlan,
    context: { readonly recordArtifact: (artifact: IntentJournalArtifactV1) => void },
  ): Promise<void>
  participantInTransaction(
    tx: DbTxSync,
    context: {
      readonly bundleCreatedNames: {
        readonly workflow: ReadonlySet<string>
        readonly workgroup: ReadonlySet<string>
      }
    },
  ): IntentApplyResourceParticipantInTx
  broadcastCommitted(): void
}

export interface IntentApplyResourceBinding {
  createSession(options: {
    readonly db: DbClient
    readonly appHome: string
    readonly actor: Actor
    readonly authority: ResourceRequestContext
    readonly pluginInstallOpts?: {
      readonly pluginsDir?: string
      readonly npmBin?: string
      readonly timeoutMs?: number
    }
    readonly afterPluginInstall?: () => void
    readonly afterSkillStage?: () => void
  }): IntentApplyResourceSession
}

export interface ApplyIntentInput {
  sessionId: string
  clientMutationId: string
  draftRevision: number
  draftHash: string
  decisions: IntentDecision[]
}

/**
 * Per-session in-process serialization (single-daemon platform).
 * RFC-355 T3：算法搬进 `application/sessionApplyLock`，这里只持有本 provider 的那个实例
 * ——两个 provider 本来就是两个独立的 Map，合并的是算法不是状态。
 */
const applyLock = createSessionApplyLock()

export function __intentApplyLockCountForTests(): number {
  return applyLock.size()
}

export async function __withSessionApplyLockForTests<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return applyLock.run(sessionId, fn)
}

export async function applyIntentChangeset(
  deps: ApplyIntentDeps,
  input: ApplyIntentInput,
): Promise<IntentApplyReceipt> {
  return applyLock.run(input.sessionId, () => applyInner(deps, input))
}

async function applyInner(
  deps: ApplyIntentDeps,
  input: ApplyIntentInput,
): Promise<IntentApplyReceipt> {
  const log = deps.log ?? createLogger('intentApply')
  const { db, actor } = deps
  const journalId = ulid()

  // ── claim (design §9.1) ──
  const claim = dbTxSync(db, (tx) => {
    const session = tx
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, input.sessionId))
      .get()
    assertIntentSessionClaimable(session, actor.user.id)
    const existing = tx
      .select()
      .from(intentApplyJournal)
      .where(
        and(
          eq(intentApplyJournal.sessionId, input.sessionId),
          eq(intentApplyJournal.clientMutationId, input.clientMutationId),
        ),
      )
      .get()
    if (existing !== undefined) {
      return { kind: 'replay' as const, existing, session }
    }
    assertIntentSessionReady(session)
    const draft = tx
      .select()
      .from(intentDrafts)
      .where(
        and(
          eq(intentDrafts.sessionId, input.sessionId),
          eq(intentDrafts.revision, input.draftRevision),
        ),
      )
      .get()
    const committable = requireCommittableDraft({
      draft,
      session,
      confirmedDraftHash: input.draftHash,
    })
    const resolution = tx
      .select({ reason: intentDraftResolutions.reason })
      .from(intentDraftResolutions)
      .where(eq(intentDraftResolutions.draftId, committable.id))
      .get()
    assertIntentDraftUnresolved(resolution?.reason)
    const now = Date.now()
    tx.insert(intentApplyJournal)
      .values({
        id: journalId,
        sessionId: input.sessionId,
        clientMutationId: input.clientMutationId,
        draftId: committable.id,
        draftHash: committable.draftHash,
        state: 'prepared',
        preparedArtifactsJson: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return { kind: 'claimed' as const, session, draft: committable }
  })

  if (claim.kind === 'replay') return intentApplyReplayOutcomeOf(claim.existing)

  // P2-1: the whole claim→settle window is registered so the converger can
  // never mistake this process's own live apply for a crashed one.
  ACTIVE_APPLY_JOURNALS.add(journalId)

  const artifacts: IntentJournalArtifactV1[] = []
  const recordArtifact = (artifact: IntentJournalArtifactV1): void => {
    artifacts.push(artifact)
    dbTxSync(db, (tx) => {
      tx.update(intentApplyJournal)
        .set({
          preparedArtifactsJson: encodeIntentJournalArtifacts(artifacts),
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
        .run()
    })
  }
  const settleFailed = (error: unknown): void => {
    dbTxSync(db, (tx) => {
      tx.update(intentApplyJournal)
        .set({
          state: 'failed',
          error:
            error instanceof Error
              ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}`
              : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
        .run()
    })
  }
  const keepRetryable = (error: unknown, compensationErrors: readonly unknown[]): void => {
    const original = error instanceof Error ? error.message : String(error)
    const cleanup = compensationErrors
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .join('; ')
    dbTxSync(db, (tx) => {
      tx.update(intentApplyJournal)
        .set({
          error: `retryable after apply error: ${original}; compensation incomplete: ${cleanup}`,
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
        .run()
    })
  }

  let committedReceipt: IntentApplyReceipt | null = null
  try {
    const resourceSession = deps.resourceApply.createSession({
      db,
      appHome: deps.appHome,
      actor,
      authority: deps.authority,
      ...(deps.pluginInstallOpts === undefined
        ? {}
        : { pluginInstallOpts: deps.pluginInstallOpts }),
      ...(deps.faults?.afterPluginInstall === undefined
        ? {}
        : { afterPluginInstall: deps.faults.afterPluginInstall }),
      ...(deps.faults?.afterSkillStage === undefined
        ? {}
        : { afterSkillStage: deps.faults.afterSkillStage }),
    })

    // ── preflight (design §9.2/§9.3) ──
    const manifest = sessionManifest(claim.session)
    const changeset = decodeStoredChangeset(claim.draft.changesetJson)
    const { occupiedNames, copyOnlyTargets } = await resourceSession.preflight(manifest, changeset)
    const bundle = resolveIntentBundle({
      manifest,
      changeset,
      decisions: input.decisions,
      occupiedNames,
      copyOnlyTargets,
    })
    const pendingIds = new Set(
      bundle.ops.filter((op) => op.action === 'create').map((op) => op.resourceId),
    )
    const pendingAgentNames = new Map(
      bundle.ops
        .filter((op) => op.action === 'create' && op.resourceType === 'agent')
        .map((op) => [op.resourceId, (op.payload as { readonly name: string }).name]),
    )
    const manifestByHandle = new Map(
      manifest.map((entry): [string, IntentManifestEntry] => [entry.handle, entry]),
    )
    const plans = bundle.ops.map((op) => intentResourcePlanOf(op, manifestByHandle))

    for (const plan of plans) {
      try {
        await resourceSession.prepare(plan, {
          pendingIds,
          pendingAgentNames,
          clientMutationId: input.clientMutationId,
        })
      } catch (error) {
        // Canonical resource schemas stay an op-addressed 422 at the Intent boundary.
        if (error instanceof ZodError) {
          throw new ValidationError(
            'intent-op-canonical-invalid',
            `${plan.operationId}: ${formatChangesetIssues(error.issues).join('; ')}`,
          )
        }
        throw error
      }
    }

    // ── prestage (design §9.4 ①②; record-then-act) ──
    for (const plan of plans) {
      await resourceSession.prestage(plan, { recordArtifact })
    }

    deps.faults?.beforeTx?.()

    // ── the big transaction (design §9.4 ③) ──
    const applied: IntentApplyReceipt['applied'] = []
    const receipt = dbTxSync(db, (tx) => {
      const cas = tx
        .update(intentApplyJournal)
        .set({ state: 'applying', updatedAt: Date.now() })
        .where(and(eq(intentApplyJournal.id, journalId), eq(intentApplyJournal.state, 'prepared')))
        .run()
      if ((cas as unknown as { changes?: number }).changes !== 1) {
        throw new ConflictError('intent-apply-unsettled', 'journal claim lost')
      }

      const sessionRow = tx
        .select()
        .from(intentSessions)
        .where(eq(intentSessions.id, input.sessionId))
        .get()
      const baseline = {
        claimSession: claim.session,
        claimDraftId: claim.draft.id,
        sessionNow: sessionRow,
      }
      assertIntentApplyBaselineFresh(baseline)
      const sessionNow = baseline.sessionNow
      const bundleCreatedNames = bundleCreatedNamesOf(plans)

      const resourceParticipant = resourceSession.participantInTransaction(tx, {
        bundleCreatedNames,
      })
      for (const [index, plan] of plans.entries()) {
        const op = requireOpForPlan(bundle.ops[index], plan)
        resourceParticipant.authorizeAndCommit(deps.authority, plan)
        applied.push(appliedEntryOf(op))
        tx.insert(intentProvenance)
          .values({
            resourceType: op.resourceType,
            resourceId: op.resourceId,
            commitId: journalId,
            sessionId: input.sessionId,
            createdAt: Date.now(),
          })
          .run()
      }

      deps.faults?.inTxAfterOps?.()

      const mutation = intentApplyCommitMutationOf({
        claimSession: claim.session,
        preCommitManifestJson: sessionNow.contextManifestJson,
        ops: bundle.ops,
      })
      const commitSeq = mutation.commitSeq
      tx.update(intentSessions)
        .set({
          commitSeq: mutation.commitSeq,
          contextRevision: mutation.contextRevision,
          currentDraftId: null,
          contextManifestJson: mutation.contextManifestJson,
          handleWatermarkJson: mutation.handleWatermarkJson,
          updatedAt: Date.now(),
        })
        .where(eq(intentSessions.id, input.sessionId))
        .run()
      const receiptValue: IntentApplyReceipt = { journalId, commitSeq, applied }
      tx.update(intentApplyJournal)
        .set({
          state: 'committed',
          receiptJson: JSON.stringify(receiptValue),
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
        .run()
      return receiptValue
    })
    committedReceipt = receipt

    // ── roll-forward (design §9.5; idempotent) ──
    deps.faults?.afterTxBeforeRollForward?.()
    await deps.artifacts.rollForward(artifacts, log)
    resourceSession.broadcastCommitted()
    return receipt
  } catch (error) {
    if (committedReceipt !== null) {
      // The transaction is durable — the bundle IS applied. A post-commit
      // throw (roll-forward/broadcast) must never compensate or overwrite the
      // committed journal state; convergence replays the idempotent tail.
      log.warn('intent-roll-forward-crashed', {
        journalId,
        err: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    // ── compensation: the durable artifact list is the oracle ──
    // A plugin installer may create its generation and throw before returning
    // InstallResult, so the success-only in-memory maps are insufficient here.
    const compensationErrors: unknown[] = []
    for (const artifact of [...artifacts].reverse()) {
      try {
        deps.faults?.beforeArtifactCompensation?.(artifact)
        await deps.artifacts.compensate(artifact)
      } catch (err) {
        compensationErrors.push(err)
        log.warn(INTENT_APPLY_DIAGNOSTICS.artifactCompensationFailed, {
          kind: artifact.kind,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (compensationErrors.length === 0) settleFailed(error)
    else {
      // A non-terminal row truthfully records that cleanup is incomplete and
      // lets boot/hourly convergence retry. Marking it failed would make the
      // converger skip the residue forever.
      keepRetryable(error, compensationErrors)
      log.warn(INTENT_APPLY_DIAGNOSTICS.applyLeftRetryable, {
        journalId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  } finally {
    ACTIVE_APPLY_JOURNALS.delete(journalId)
  }
}

/** Boot/hourly convergence (design §9.5): sweep unsettled journal rows.
 *  prepared/applying → compensate recorded artifacts, mark failed;
 *  committed → replay the idempotent roll-forward. */
/** P2-1 — journals this PROCESS is actively applying; the converger must
 *  never treat them as crashed. Registered for the whole applyIntentChangeset
 *  window (claim → settle). */
const ACTIVE_APPLY_JOURNALS = new Set<string>()
/** P2-1 — and a floor: never reap a journal younger than this (a slow npm
 *  install crossing the hourly tick is an ACTIVE apply, not a crash). */
const CONVERGE_MIN_AGE_MS = 10 * 60 * 1000

export async function convergeIntentApplyJournal(
  db: DbClient,
  artifactLifecycle: SqliteIntentApplyArtifactLifecycle,
  log: Logger = createLogger('intentApply'),
  options: { activeJournalIds?: readonly string[] } = {},
): Promise<{ failed: number; rolledForward: number }> {
  let failed = 0
  let rolledForward = 0
  const rows = await db.select().from(intentApplyJournal)
  const reapBefore = Date.now() - CONVERGE_MIN_AGE_MS
  for (const row of rows) {
    if (row.state === 'failed') continue
    let artifacts: IntentJournalArtifact[]
    try {
      artifacts = decodeIntentJournalArtifacts(row.preparedArtifactsJson)
    } catch (err) {
      // The journal is the recovery oracle. If it is corrupt or an old lossy
      // skill-version shape, claiming compensation/roll-forward succeeded is
      // worse than leaving the row visible for repair.
      log.warn(INTENT_APPLY_DIAGNOSTICS.journalArtifactCorrupt, {
        journalId: row.id,
        state: row.state,
        err: err instanceof Error ? err.message : String(err),
      })
      if (row.state === 'prepared' || row.state === 'applying' || row.state === 'committed') {
        dbTxSync(db, (tx) => {
          tx.update(intentApplyJournal)
            .set({
              error: `retryable: artifact decode failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            })
            .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
            .run()
        })
      }
      continue
    }
    if (row.state === 'prepared' || row.state === 'applying') {
      // P2-1: an apply this PROCESS is running, or one still fresh enough to
      // be a slow install, is ACTIVE — reaping it would compensate a live
      // transaction's prestage and then fail its journal CAS.
      if (
        ACTIVE_APPLY_JOURNALS.has(row.id) ||
        options.activeJournalIds?.includes(row.id) === true ||
        row.updatedAt > reapBefore
      )
        continue
      const compensationErrors: unknown[] = []
      for (const artifact of [...artifacts].reverse()) {
        try {
          await artifactLifecycle.compensate(artifact)
        } catch (err) {
          compensationErrors.push(err)
          log.warn(INTENT_APPLY_DIAGNOSTICS.convergeCompensationFailed, {
            journalId: row.id,
            kind: artifact.kind,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (compensationErrors.length > 0) {
        dbTxSync(db, (tx) => {
          tx.update(intentApplyJournal)
            .set({
              error: `retryable: compensation incomplete: ${compensationErrors
                .map((item) => (item instanceof Error ? item.message : String(item)))
                .join('; ')}`,
            })
            .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
            .run()
        })
        log.warn(INTENT_APPLY_DIAGNOSTICS.convergeLeftRetryable, { journalId: row.id })
        continue
      }
      const cas = dbTxSync(db, (tx) =>
        tx
          .update(intentApplyJournal)
          .set({ state: 'failed', error: 'daemon-restart before commit', updatedAt: Date.now() })
          .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
          .run(),
      )
      if ((cas as unknown as { changes?: number }).changes === 1) failed += 1
    } else if (row.state === 'committed') {
      const complete = await artifactLifecycle.rollForward(artifacts, log)
      if (complete) {
        rolledForward += 1
        if (row.error !== null) {
          dbTxSync(db, (tx) => {
            tx.update(intentApplyJournal)
              .set({ error: null, updatedAt: Date.now() })
              .where(
                and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')),
              )
              .run()
          })
        }
      } else {
        dbTxSync(db, (tx) => {
          tx.update(intentApplyJournal)
            .set({
              error: 'retryable: committed roll-forward incomplete; inspect intent apply logs',
              updatedAt: Date.now(),
            })
            .where(
              and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')),
            )
            .run()
        })
      }
    }
  }
  return { failed, rolledForward }
}

/** RFC-338: strict process-local advisory snapshot for the maintenance Worker.
 * The persisted age/state CAS remains the deletion fence. */
export function activeIntentApplyJournalIds(): string[] {
  return [...ACTIVE_APPLY_JOURNALS]
}

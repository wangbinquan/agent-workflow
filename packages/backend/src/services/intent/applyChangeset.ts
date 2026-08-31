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
import { formatChangesetIssues, INTENT_RESOURCE_TYPES } from '@agent-workflow/shared'
import { rmSync } from 'node:fs'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  intentApplyJournal,
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
} from '@/db/schema'
import { getAclResourceOwner, listOwnedAclResourceNames } from '@/services/resourceAcl'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import { ulid } from 'ulid'
import { ZodError } from 'zod'
import type {
  IntentApplyResourceParticipantInTx,
  ResourceRequestContext,
} from '@/modules/resource-catalog/public/participants'
import type { VersionedIntentResourceChangesetPlan } from '@/modules/resource-catalog/public/types'
import { legacyIntentApplyResourceDependencies } from './legacyIntentApplyResourceDependencies'
import {
  applyCommitMounts,
  createHandleAllocator,
  handleWatermarkOf,
  lineageRootOf,
  mergeHandleWatermarks,
  parseHandleWatermark,
  type IntentContextManifest,
  type IntentManifestEntry,
} from './manifest'
import { resolveIntentBundle, type IntentDecision, type ResolvedIntentOp } from './resolveChangeset'
import { sessionManifest } from './session'
import {
  decodeIntentJournalArtifacts,
  encodeIntentJournalArtifacts,
  type IntentJournalArtifact,
  type IntentJournalArtifactV1,
} from './journalArtifacts'

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

/**
 * Codex impl-gate P0-1/P2-3 — update targets the actor cannot modify in place:
 *  - foreign or built-in owner (D-round1: 他人/内置仅副本) → copy-only.
 * RFC-271 T14: the skill/plugin "not implemented yet" carve-out is GONE; all six
 * types share the one ownerUserId rule.
 * handle → reason. Shared by the apply preflight (enforced inside
 * resolveIntentBundle) and the session-detail route (drives the commit UI).
 */
export async function copyOnlyTargetsFor(
  db: DbClient,
  actor: Actor,
  manifest: IntentContextManifest,
  changeset: {
    ops: ReadonlyArray<{ action: string; resourceType: string; target?: string }>
  },
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byHandle = new Map(
    manifest.map((entry): [string, IntentManifestEntry] => [entry.handle, entry]),
  )
  for (const op of changeset.ops) {
    if (op.action !== 'update' || op.target === undefined) continue
    // RFC-271 T14（决策 27）：skill / plugin 的「尚不支持原地更新」特例已解除——
    // 它们和其余四类走**同一条** ownerUserId 判据。⚠️ 那条判据本身一字未动：
    // 他人拥有的 / 内置的资源仍然强制 copy，copy 语义（slot 派生 / 重连 /
    // finalName / receipt 的 fromCopy）逐条保持。
    const entry = byHandle.get(op.target)
    if (entry === undefined) continue // unknown handle → draft validation owns it
    const ownerUserId = await getAclResourceOwner(db, entry.resourceType, entry.resourceId)
    if (ownerUserId === undefined) continue // vanished row → fence/stale owns it
    if (ownerUserId !== actor.user.id) {
      out.set(op.target, 'owned by another user or built-in')
    }
  }
  return out
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

/** Per-session in-process serialization (single-daemon platform). */
const applyLocks = new Map<string, Promise<unknown>>()

async function withSessionApplyLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = applyLocks.get(sessionId) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const chain = prior.then(() => gate)
  applyLocks.set(sessionId, chain)
  await prior.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (applyLocks.get(sessionId) === chain) applyLocks.delete(sessionId)
  }
}

export function __intentApplyLockCountForTests(): number {
  return applyLocks.size
}

export { withSessionApplyLock as __withSessionApplyLockForTests }

async function occupiedNamesFor(
  db: DbClient,
  ownerUserId: string,
): Promise<ReadonlyMap<ResolvedIntentOp['resourceType'], ReadonlySet<string>>> {
  const out = new Map<ResolvedIntentOp['resourceType'], Set<string>>()
  // Over the INTENT types, not every ACL table. This map answers "which names
  // does this owner already use, among the types an op could collide with" —
  // walking the capability template tables would add two sets nothing reads
  // and, once they were keys, quietly widen what an intent op may name.
  for (const type of INTENT_RESOURCE_TYPES) {
    const names = await listOwnedAclResourceNames(db, type, ownerUserId)
    out.set(type, new Set(names.map((name) => name.toLowerCase())))
  }
  return out
}

function intentResourcePlanOf(
  op: ResolvedIntentOp,
  manifestByHandle: ReadonlyMap<string, IntentManifestEntry>,
): VersionedIntentResourceChangesetPlan {
  const payload =
    op.resourceType === 'plugin' && 'options' in op.payload
      ? (() => {
          const { options, ...rest } = op.payload
          return { ...rest, optionsJson: options }
        })()
      : op.payload
  if (op.action === 'update') {
    const expectedRevision = op.manifestEntry?.fence
    if (expectedRevision === undefined || expectedRevision.kind !== op.resourceType) {
      throw new ConflictError(
        'intent-baseline-stale',
        `${op.resourceType} fence missing for intent update`,
      )
    }
    return {
      kind: op.resourceType,
      operationId: op.opId,
      action: 'update',
      resourceId: op.resourceId,
      expectedRevision,
      payload,
    } as VersionedIntentResourceChangesetPlan
  }

  const copiedFromResourceId =
    op.copiedFromHandle === undefined
      ? undefined
      : manifestByHandle.get(op.copiedFromHandle)?.resourceId
  return {
    kind: op.resourceType,
    operationId: op.opId,
    action: 'create',
    resourceId: op.resourceId,
    fromCopy: op.fromCopy,
    ...(copiedFromResourceId === undefined ? {} : { copiedFromResourceId }),
    payload,
  } as VersionedIntentResourceChangesetPlan
}

export async function applyIntentChangeset(
  deps: ApplyIntentDeps,
  input: ApplyIntentInput,
): Promise<IntentApplyReceipt> {
  return withSessionApplyLock(input.sessionId, () => applyInner(deps, input))
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
    if (session === undefined || session.ownerUserId !== actor.user.id) {
      throw new NotFoundError('intent-session-not-found', 'intent session not found')
    }
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
    if (session.status !== 'active') {
      throw new ConflictError('intent-session-archived', 'session is archived')
    }
    if (session.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is running')
    }
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
    if (draft === undefined) {
      throw new NotFoundError('intent-draft-not-found', 'draft revision not found')
    }
    if (draft.draftHash !== input.draftHash) {
      throw new ConflictError('intent-draft-hash-mismatch', 'confirmed draft hash does not match', {
        expected: draft.draftHash,
      })
    }
    if (draft.contextRevision !== session.contextRevision) {
      throw new ConflictError(
        'intent-baseline-stale',
        'the session context moved since this draft was generated; rebase and regenerate',
      )
    }
    // Codex impl-gate P1-3: the hash proves WHICH revision was confirmed, not
    // that it is still the CURRENT one — a later turn in the same epoch mints
    // a higher revision without bumping contextRevision. Refuse stale tabs.
    if (session.currentDraftId !== draft.id) {
      throw new ConflictError(
        'intent-draft-superseded',
        'a newer draft revision exists in this session; review and commit the latest draft',
        { confirmedRevision: draft.revision },
      )
    }
    const resolution = tx
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
    const now = Date.now()
    tx.insert(intentApplyJournal)
      .values({
        id: journalId,
        sessionId: input.sessionId,
        clientMutationId: input.clientMutationId,
        draftId: draft.id,
        draftHash: draft.draftHash,
        state: 'prepared',
        preparedArtifactsJson: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return { kind: 'claimed' as const, session, draft }
  })

  if (claim.kind === 'replay') {
    const row = claim.existing
    if (row.state === 'committed' && row.receiptJson !== null) {
      return JSON.parse(row.receiptJson) as IntentApplyReceipt
    }
    if (row.state === 'failed') {
      throw new ConflictError(
        'intent-apply-failed-replay',
        row.error ?? 'this apply attempt failed',
        {
          journalId: row.id,
        },
      )
    }
    // prepared/applying without a live lock holder = a crashed attempt that
    // boot convergence has not yet swept. Refuse rather than guess.
    throw new ConflictError(
      'intent-apply-unsettled',
      'a prior apply attempt is unsettled; retry later',
      {
        journalId: row.id,
      },
    )
  }

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
    const changeset = JSON.parse(claim.draft.changesetJson)
    const occupiedNames = await occupiedNamesFor(db, actor.user.id)
    const copyOnlyTargets = await copyOnlyTargetsFor(db, actor, manifest, changeset)
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

      // Codex impl-gate P1-1: claim-time checks alone leave the prestage
      // window (npm install / skill staging) open to rebase/mount/new drafts.
      // Re-assert the session identity INSIDE the commit transaction so a
      // moved epoch or superseded draft can never land, and the epoch bump
      // below builds on the value we actually verified.
      const sessionNow = tx
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

      // Names this very bundle is about to create, by type. These are read from
      // the resolved plans so finalName overlays have already been applied.
      const bundleCreatedNames = { workflow: new Set<string>(), workgroup: new Set<string>() }
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

      const resourceParticipant = resourceSession.participantInTransaction(tx, {
        bundleCreatedNames,
      })
      for (const [index, plan] of plans.entries()) {
        const op = bundle.ops[index]
        if (op === undefined || op.opId !== plan.operationId) {
          throw new Error('intent-resource-plan-order-mismatch')
        }
        resourceParticipant.authorizeAndCommit(deps.authority, plan)
        applied.push({
          opId: op.opId,
          resourceType: op.resourceType,
          resourceId: op.resourceId,
          action: op.action,
          fromCopy: op.fromCopy,
          name: (op.payload as { readonly name: string }).name,
        })
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

      // RFC-291 面 B — copy bookkeeping, read off the PRE-COMMIT manifest.
      //
      // `sessionNow` is the row this transaction already CAS-verified above, so
      // its manifest is the authoritative baseline for the migration below.
      //
      // The lineage recorded is the ROOT, not the immediate source: copying C1
      // (itself a copy of O) records O. Recording C1 would break "keep only the
      // newest copy" — O→C1→C2 then O→C3 would retire C1 but not C2, leaving
      // two roots (design-gate P1-c).
      const preCommitManifest = JSON.parse(sessionNow.contextManifestJson) as IntentContextManifest
      const preCommitByHandle = new Map(preCommitManifest.map((entry) => [entry.handle, entry]))
      const copySourceHandles: string[] = []
      const lineageOriginByResourceId = new Map<string, string>()
      for (const op of bundle.ops) {
        const sourceHandle = op.copiedFromHandle
        if (sourceHandle === undefined) continue
        copySourceHandles.push(sourceHandle)
        const sourceEntry = preCommitByHandle.get(sourceHandle)
        // Unresolvable handle degrades to "mount the copy, don't chase lineage"
        // rather than failing the commit: the entry is only missing if the
        // session moved under us, which the CAS above already ruled out.
        if (sourceEntry !== undefined) {
          lineageOriginByResourceId.set(op.resourceId, lineageRootOf(sourceEntry))
        }
      }

      const commitSeq = claim.session.commitSeq + 1
      // RFC-291 面 A/B — mount what this commit created, IN THIS TRANSACTION.
      //
      // Doing it afterwards would leave a "resources landed, mounts missing"
      // window, which is exactly the defect this RFC exists to remove: nothing
      // repairs it later, because convergeIntentApplyJournal only rolls the
      // filesystem side forward for `committed` rows (see the bottom of this
      // file) — it never replays the big transaction.
      //
      // `action` here is the NORMALIZED action (resolveChangeset), so a copy
      // already counts as a create; no second predicate needed.
      const nextManifest = applyCommitMounts(preCommitManifest, {
        // Read off the resolved ops, not the receipt: the receipt's resourceType
        // is the wire-level string while these carry the canonical union type.
        created: bundle.ops
          .filter((op) => op.action === 'create')
          .map((op) => {
            const origin = lineageOriginByResourceId.get(op.resourceId)
            return {
              resourceType: op.resourceType,
              resourceId: op.resourceId,
              ...(origin === undefined ? {} : { copiedFromResourceId: origin }),
            }
          }),
        unmountHandles: copySourceHandles,
      })
      // Close the context epoch (design-gate P1-5): the applied draft archives,
      // the current pointer clears, and stale fences force a fresh dump before
      // the next generation can target the new baselines. The mount migration
      // rides the SAME epoch bump — it is part of this commit, not a new one.
      tx.update(intentSessions)
        .set({
          commitSeq,
          contextRevision: claim.session.contextRevision + 1,
          currentDraftId: null,
          contextManifestJson: JSON.stringify(nextManifest),
          // 面 F — creates mint handles here too, so the watermark must move
          // with them or a later epoch could hand the ordinal to another row.
          handleWatermarkJson: JSON.stringify(
            mergeHandleWatermarks(
              parseHandleWatermark(claim.session.handleWatermarkJson),
              handleWatermarkOf(createHandleAllocator(nextManifest)),
            ),
          ),
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
    rollForwardCommitted(
      db,
      deps.appHome,
      {
        skillStages: artifacts.flatMap((artifact) =>
          artifact.kind === 'skill-stage'
            ? [{ skillId: artifact.skillId, opId: artifact.opId }]
            : [],
        ),
        skillVersionStages: artifacts.flatMap((artifact) =>
          artifact.kind === 'skill-version-stage' ? [artifact.staged] : [],
        ),
      },
      log,
    )
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
        compensateIntentArtifact(db, artifact)
      } catch (err) {
        compensationErrors.push(err)
        log.warn('intent-artifact-compensation-failed', {
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
      log.warn('intent-left-retryable', {
        journalId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  } finally {
    ACTIVE_APPLY_JOURNALS.delete(journalId)
  }
}

/** Post-commit publishes. Completed exact operations are skipped; unfinished
 * failures remain observable so convergence can retry them. */
type IntentStagedSkillVersion = Extract<
  IntentJournalArtifactV1,
  { readonly kind: 'skill-version-stage' }
>['staged']

function rollForwardCommitted(
  db: DbClient,
  appHome: string,
  state: {
    skillStages: Array<{ skillId: string; opId: string }>
    skillVersionStages: IntentStagedSkillVersion[]
  },
  log: Logger,
): boolean {
  let complete = true
  // Committed rows remain in the audit ledger and are swept repeatedly. Only
  // an exact still-active operation has an unfinished publish tail; replaying
  // an old completed artifact after a later edit would unmark the healthy new
  // generation and try to publish stale bytes.
  const pendingSkillVersions: IntentStagedSkillVersion[] = []
  for (const staged of state.skillVersionStages) {
    if (staged.noop !== null) continue
    if (staged.opId === null) {
      pendingSkillVersions.push(staged)
      continue
    }
    const op = legacyIntentApplyResourceDependencies.skillOperationState(db, staged.opId)
    if (op?.active === 1 && (op.phase === 'db-committed' || op.phase === 'fs-published')) {
      pendingSkillVersions.push(staged)
      continue
    }
    if (op?.phase !== 'done') {
      complete = false
      log.warn('intent-skill-publish-op-not-replayable', {
        skillId: staged.skillId,
        opId: staged.opId,
        phase: op?.phase ?? 'missing',
      })
    }
  }

  // Unmark every pending skill before publishing any of them; otherwise an
  // earlier item can be re-admitted while a later committed item is stale.
  for (const staged of pendingSkillVersions) {
    legacyIntentApplyResourceDependencies.unmarkSkillBootVerified(staged.skillId)
  }
  for (const staged of pendingSkillVersions) {
    try {
      legacyIntentApplyResourceDependencies.publishStagedSkillVersion(db, { appHome }, staged)
    } catch (err) {
      complete = false
      log.warn('intent-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  for (const stage of state.skillStages) {
    const op = legacyIntentApplyResourceDependencies.skillOperationState(db, stage.opId)
    if (op?.active === 0 && op.phase === 'done') continue
    if (op?.active !== 1 || op.phase !== 'db-committed') {
      complete = false
      log.warn('intent-skill-finish-op-not-replayable', {
        skillId: stage.skillId,
        opId: stage.opId,
        phase: op?.phase ?? 'missing',
      })
      continue
    }
    try {
      dbTxSync(db, (tx) => legacyIntentApplyResourceDependencies.finishOperation(tx, stage.opId))
    } catch (err) {
      complete = false
      log.warn('intent-skill-finish-replayed-or-failed', {
        skillId: stage.skillId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return complete
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
  appHome: string,
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
      log.warn('intent-journal-artifact-corrupt', {
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
          compensateIntentArtifact(db, artifact)
        } catch (err) {
          compensationErrors.push(err)
          log.warn('intent-converge-compensation-failed', {
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
        log.warn('intent-converge-left-retryable', { journalId: row.id })
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
      const complete = rollForwardCommitted(
        db,
        appHome,
        {
          skillStages: artifacts.flatMap((a) =>
            a.kind === 'skill-stage' ? [{ skillId: a.skillId, opId: a.opId }] : [],
          ),
          skillVersionStages: artifacts.flatMap((artifact) =>
            artifact.kind === 'skill-version-stage' ? [artifact.staged] : [],
          ),
        },
        log,
      )
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

function compensateIntentArtifact(db: DbClient, artifact: IntentJournalArtifact): void {
  switch (artifact.kind) {
    case 'legacy-plugin-install-untracked':
      // Historical rows did not record a generation path. Keep their former
      // converger behavior (installer GC owns any residue) without pretending
      // the serialized artifact was the new precise shape.
      return
    case 'plugin-install':
      rmSync(artifact.generationDir, { recursive: true, force: true })
      return
    case 'skill-stage':
      legacyIntentApplyResourceDependencies.compensateManagedSkillStage(db, artifact)
      return
    case 'skill-version-stage': {
      legacyIntentApplyResourceDependencies.abortStagedSkillVersion(db, artifact.staged)
      if (artifact.staged.opId === null) return
      const op = legacyIntentApplyResourceDependencies.skillOperationState(db, artifact.staged.opId)
      // abortStagedSkillVersion intentionally preserves an active op when it
      // cannot prove cleanup. Surface that fact to the journal state machine
      // instead of mistaking its void return for successful compensation.
      if (op === undefined || op.active === 1) {
        throw new Error(
          `skill version compensation remains active for operation ${artifact.staged.opId}`,
        )
      }
      return
    }
  }
}

/** RFC-338: strict process-local advisory snapshot for the maintenance Worker.
 * The persisted age/state CAS remains the deletion fence. */
export function activeIntentApplyJournalIds(): string[] {
  return [...ACTIVE_APPLY_JOURNALS]
}

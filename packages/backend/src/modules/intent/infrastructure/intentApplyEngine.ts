import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'
import {
  intentWorkflowInvalidMessage,
  validateResolvedBundleWorkflowGraphs,
} from '../application/graphValidation'
import type { IntentWorkflowGraphValidationPort } from '../application/ports/intentWorkflowGraphValidation'
import { formatChangesetIssues } from '@agent-workflow/shared'
import { intentResourcePlanOf } from '../application/intentResourcePlan'
import { decodeStoredChangeset } from '../domain/storedChangeset'
import { INTENT_APPLY_DIAGNOSTICS } from '../application/journalConvergence'
import {
  appliedEntryOf,
  assertIntentApplyBaselineFresh,
  bundleCreatedNamesOf,
  intentApplyCommitMutationOf,
  requireOpForPlan,
} from '../application/applyCommitPlan'
import {
  assertIntentDraftUnresolved,
  assertIntentSessionClaimable,
  assertIntentSessionReady,
  requireCommittableDraft,
} from '../domain/applyClaim'
import { createAtomicApplyLock } from '@/platform/atomic-apply/keyedLock'
import { createAtomicApply } from '@/platform/atomic-apply/stateMachine'
import { createIntentApplyJournal } from './intentApplyJournal'
import { intentApplyArtifactCodecs } from './intentApplyArtifactCodec'
import { intentApplyErrors } from './intentApplyErrors'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { ZodError } from 'zod'

import type { Actor } from '@/auth/actor'
import type {
  IntentApplyInput,
  IntentApplyOperations,
  IntentApplyReceipt,
} from '@/modules/intent/application/ports/intentApplyOperations'
import type { IntentApplyResourceSession } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourceParticipants'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ConflictError, ValidationError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
import type { IntentJournalArtifact } from '@/modules/intent/domain/journalArtifacts'
import { type IntentManifestEntry } from '@/modules/intent/application/manifest'
import { resolveIntentBundle } from '@/modules/intent/application/resolveChangeset'
import { sessionManifest } from '@/modules/intent/application/session'

export type IntentApplyRecoveryArtifact = IntentApplyArtifact | IntentJournalArtifact

export interface IntentApplyArtifactLifecycle {
  compensate(artifact: IntentApplyRecoveryArtifact): Promise<void>
  /** Returns false when a committed tail remains retryable. */
  rollForward(artifacts: readonly IntentApplyRecoveryArtifact[], log: Logger): Promise<boolean>
}

export interface IntentApplyResourceBinding {
  createSession(input: {
    readonly actor: Actor
    readonly authority: ResourceRequestContext
    /** RFC-359 —— 预暂存的两个崩溃断点，由本次请求的 `faults` 透传给资源会话。 */
    readonly afterSkillStage?: () => void
    readonly afterPluginInstall?: () => void
  }): IntentApplyResourceSession
}

/**
 * Crash seams used by the apply crash matrix (`rfc234-apply-changeset` P2-2).
 * 每一个都对应一个「盘上 / 库里状态不一致」的真实窗口。
 */
export interface ApplyIntentFaults {
  afterPluginInstall?: () => void
  afterSkillStage?: () => void
  /**
   * RFC-359 W9 —— claim 事务的原子性接缝：在 journal 行**已插入、事务尚未提交**时抛。
   * 这是「四道读判据 + 认领同生共死」唯一可观测的形态（其余判据都在写之前拒绝）。
   */
  inClaimTxAfterJournal?: () => void
  beforeTx?: () => void
  inTxAfterOps?: () => void
  afterTxBeforeRollForward?: () => void
  /** Test-only seam for proving that partial cleanup never terminalizes a journal. */
  beforeArtifactCompensation?: (artifact: IntentJournalArtifact) => void
}

export interface IntentApplyEngineRequest {
  readonly actor: Actor
  readonly authority: ResourceRequestContext
  readonly command: IntentApplyInput
  readonly faults?: ApplyIntentFaults
  readonly log?: Logger
}

export interface IntentApplyEngine extends IntentApplyOperations {
  apply(request: IntentApplyEngineRequest): Promise<IntentApplyReceipt>
  activeJournalIds(): readonly string[]
}

export interface IntentApplyEngineDependencies {
  readonly db: PersistenceDb
  readonly resources: IntentApplyResourceBinding
  readonly artifacts: IntentApplyArtifactLifecycle
  /** RFC-358 §7 —— 提交期图校验。缺省不拦（既有测试装配保持原样）。 */
  readonly graphValidation?: IntentWorkflowGraphValidationPort
  readonly id?: () => string
  readonly now?: () => number
}

const applyLock = createAtomicApplyLock()

export function __intentApplyLockCountForTests(): number {
  return applyLock.size()
}

export async function __withSessionApplyLockForTests<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return applyLock.run(sessionId, fn)
}

export function createIntentApplyEngine(
  dependencies: IntentApplyEngineDependencies,
): IntentApplyEngine {
  const now = dependencies.now ?? Date.now
  const machine = createAtomicApply({
    journal: createIntentApplyJournal(dependencies.db),
    codecs: {
      encode: (artifacts: readonly IntentApplyArtifact[]) =>
        intentApplyArtifactCodecs.encode(artifacts),
    },
    receipt: {
      decode: (json: string) => JSON.parse(json) as IntentApplyReceipt,
      encode: JSON.stringify,
    },
    errors: intentApplyErrors,
    id: dependencies.id ?? ulid,
    now,
  })
  async function applyUnlocked(request: IntentApplyEngineRequest): Promise<IntentApplyReceipt> {
    const { actor, authority, command: input } = request
    const log = request.log ?? createLogger('intentApply')
    const result = await machine.claim({
      key: { sessionId: input.sessionId, clientMutationId: input.clientMutationId },
      async beforeLookup(transaction) {
        const { intentSessions } = tablesOf(transaction)
        const session = await first(
          transaction.select().from(intentSessions).where(eq(intentSessions.id, input.sessionId)),
        )
        assertIntentSessionClaimable(session, actor.user.id)
        return session
      },
      assertReplay(row) {
        if (row.draftHash !== input.draftHash) {
          throw new ConflictError(
            'intent-draft-hash-mismatch',
            'confirmed draft hash does not match',
            { expected: row.draftHash },
          )
        }
      },
      async prepare(transaction, session) {
        const { intentDrafts, intentDraftResolutions } = tablesOf(transaction)
        assertIntentSessionReady(session)
        const draft = await first(
          transaction
            .select()
            .from(intentDrafts)
            .where(
              and(
                eq(intentDrafts.sessionId, input.sessionId),
                eq(intentDrafts.revision, input.draftRevision),
              ),
            ),
        )
        const committable = requireCommittableDraft({
          draft,
          session,
          confirmedDraftHash: input.draftHash,
        })
        const resolution = await first(
          transaction
            .select({ reason: intentDraftResolutions.reason })
            .from(intentDraftResolutions)
            .where(eq(intentDraftResolutions.draftId, committable.id)),
        )
        assertIntentDraftUnresolved(resolution?.reason)

        return {
          insert: {
            sessionId: input.sessionId,
            clientMutationId: input.clientMutationId,
            draftId: committable.id,
            draftHash: committable.draftHash,
          },
          value: { session, draft: committable },
        }
      },
      afterInsert: request.faults?.inClaimTxAfterJournal,
    })
    if (result.kind === 'replay') return result.receipt
    const { journalId, value: claim } = result
    const resourceSession = dependencies.resources.createSession({
      actor,
      authority,
      ...(request.faults?.afterSkillStage === undefined
        ? {}
        : { afterSkillStage: request.faults.afterSkillStage }),
      ...(request.faults?.afterPluginInstall === undefined
        ? {}
        : { afterPluginInstall: request.faults.afterPluginInstall }),
    })
    return machine.execute({
      journalId,
      async prepare(recordArtifact) {
        const manifest = sessionManifest(claim.session)
        const changeset = decodeStoredChangeset(claim.draft.changesetJson)
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
        const plans = bundle.ops.map((operation) =>
          intentResourcePlanOf(operation, manifestByHandle),
        )
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
        // RFC-358 §7（决策 D3）—— 与 SQLite provider 同一份判据、同一个位置：
        // prepare 之后（canonical parse 已跑过）、prestage 之前（尚无任何副作用）。
        if (dependencies.graphValidation !== undefined) {
          const graph = await validateResolvedBundleWorkflowGraphs(
            { graphValidation: dependencies.graphValidation },
            { actor: request.actor, ops: bundle.ops },
          )
          if (graph.errors.length > 0) {
            throw new ValidationError(
              'intent-workflow-invalid',
              intentWorkflowInvalidMessage(graph.errors),
              { issues: graph.errors },
            )
          }
        }

        for (const plan of plans) await resourceSession.prestage(plan, { recordArtifact })
        request.faults?.beforeTx?.()

        return { bundle, plans }
      },
      async commit(transaction, journalId, { bundle, plans }) {
        const { intentSessions, intentProvenance } = tablesOf(transaction)
        const sessionRow = await first(
          transaction.select().from(intentSessions).where(eq(intentSessions.id, input.sessionId)),
        )
        const baseline = {
          claimSession: claim.session,
          claimDraftId: claim.draft.id,
          sessionNow: sessionRow,
        }
        assertIntentApplyBaselineFresh(baseline)
        const sessionNow = baseline.sessionNow
        const bundleCreatedNames = bundleCreatedNamesOf(plans)
        const attempt = resourceSession.createTransactionAttempt(transaction, {
          bundleCreatedNames,
        })
        const applied: IntentApplyReceipt['applied'] = []
        for (const [index, plan] of plans.entries()) {
          const operation = requireOpForPlan(bundle.ops[index], plan)
          await attempt.participant.authorizeAndCommit(authority, plan)
          applied.push(appliedEntryOf(operation))
          await insertOne(transaction, intentProvenance, {
            resourceType: operation.resourceType,
            resourceId: operation.resourceId,
            commitId: journalId,
            sessionId: input.sessionId,
            createdAt: now(),
          })
        }
        request.faults?.inTxAfterOps?.()

        const mutation = intentApplyCommitMutationOf({
          claimSession: claim.session,
          preCommitManifestJson: sessionNow.contextManifestJson,
          ops: bundle.ops,
        })
        const commitSeq = mutation.commitSeq
        await transaction
          .update(intentSessions)
          .set({
            commitSeq: mutation.commitSeq,
            contextRevision: mutation.contextRevision,
            currentDraftId: null,
            contextManifestJson: mutation.contextManifestJson,
            handleWatermarkJson: mutation.handleWatermarkJson,
            updatedAt: now(),
          })
          .where(eq(intentSessions.id, input.sessionId))
        const receiptValue: IntentApplyReceipt = { journalId, commitSeq, applied }

        return { receipt: receiptValue, attempt }
      },
      async afterCommit({ attempt }, artifacts) {
        attempt.commitSucceeded()
        request.faults?.afterTxBeforeRollForward?.()
        await resourceSession.rollForwardCommitted()
        const complete = await dependencies.artifacts.rollForward(artifacts, log)
        await resourceSession.broadcastCommitted()
        return complete
      },
      async committedFailure(error) {
        try {
          await resourceSession.abortPrepared({ databaseCommitted: true })
        } catch (abortError) {
          log.warn(INTENT_APPLY_DIAGNOSTICS.resourceRollForwardRecoveryFailed, {
            journalId,
            err: abortError instanceof Error ? abortError.message : String(abortError),
          })
        }
        log.warn('intent-roll-forward-crashed', {
          journalId,
          err: error instanceof Error ? error.message : String(error),
        })
      },
      async compensate(artifacts) {
        const compensationErrors: unknown[] = []
        try {
          await resourceSession.abortPrepared({ databaseCommitted: false })
        } catch (compensationError) {
          compensationErrors.push(compensationError)
          log.warn(INTENT_APPLY_DIAGNOSTICS.resourceAbortFailed, {
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
            log.warn(INTENT_APPLY_DIAGNOSTICS.artifactCompensationFailed, {
              kind: artifact.kind,
              err:
                compensationError instanceof Error
                  ? compensationError.message
                  : String(compensationError),
            })
          }
        }

        return compensationErrors
      },
      leftRetryable(error) {
        log.warn(INTENT_APPLY_DIAGNOSTICS.applyLeftRetryable, {
          journalId,
          err: error instanceof Error ? error.message : String(error),
        })
      },
    })
  }
  return Object.freeze({
    apply: (request: IntentApplyEngineRequest) =>
      applyLock.run(request.command.sessionId, () => applyUnlocked(request)),
    activeJournalIds: machine.activeJournalIds,
  })
}

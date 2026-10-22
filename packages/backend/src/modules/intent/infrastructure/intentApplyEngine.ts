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
import {
  INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
  INTENT_APPLY_DIAGNOSTICS,
} from '../application/journalConvergence'
import {
  appliedEntryOf,
  assertIntentApplyBaselineFresh,
  bundleCreatedNamesOf,
  intentApplyCommitMutationOf,
  requireOpForPlan,
} from '../application/applyCommitPlan'
import { intentApplyReplayOutcomeOf } from '../application/applyReplay'
import {
  assertIntentDraftUnresolved,
  assertIntentSessionClaimable,
  assertIntentSessionReady,
  requireCommittableDraft,
} from '../domain/applyClaim'
import { createSessionApplyLock } from '../application/sessionApplyLock'
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
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceTx, PersistenceDb } from '@/platform/persistence/persistenceDb'
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

/**
 * RFC-359 W11 —— 两笔大事务已改走中立事务原语（`databaseSessionFor(db).transaction(...)`），
 * 但注入进来的资源会话仍按 provider 命名的事务句柄取参。把中立句柄重新窄化给它**不是强转
 * 谎话**：那个参数类型归根到底是
 * `Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]`，而中立会话在
 * PostgreSQL 上交出的正是驱动 `db.transaction` 回调里的那个句柄本身
 * （`createPostgresqlDatabaseSession` 只把同一个对象标注成 `PersistenceTx`）——
 * 运行期逐字相同。
 *
 * 目标类型从**已经注入的那个会话**上取（而不是另开一条深取 import）：窄化的收件人变了，
 * 这里就跟着变，不会留下一个自说自话的别名。退役条件：资源会话协议改吃 `PersistenceTx`，
 * 两套 apply 引擎合一时随之消失。
 */
type IntentApplyCatalogTransaction = Parameters<
  IntentApplyResourceSession['createTransactionAttempt']
>[0]

function catalogTransaction(transaction: PersistenceTx): IntentApplyCatalogTransaction {
  return transaction as unknown as IntentApplyCatalogTransaction
}

/**
 * Per-session in-process serialization (single-daemon platform).
 *
 * RFC-355 T3：算法在 `application/sessionApplyLock`。
 *
 * RFC-359 —— 这个实例是**模块级**的，不是每次装配一份。两台引擎合一之前，这里曾是
 * `createIntentApplyEngine` 的局部变量，而 SQLite 那台是模块级；生产上各只
 * 装配一次，差别看不见。合一之后装配点变多了（兼容门面 `applyIntentChangeset` 每次调用现装
 * 一台），局部变量意味着**同一个 session 的两笔并发 apply 各自拿到一把自己的锁**——串行保证
 * 当场消失。判据：`rfc343-intent-apply-correctness`。
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

export function createIntentApplyEngine(
  dependencies: IntentApplyEngineDependencies,
): IntentApplyEngine {
  const nextId = dependencies.id ?? ulid
  const now = dependencies.now ?? Date.now
  const active = new Set<string>()

  async function applyUnlocked(request: IntentApplyEngineRequest): Promise<IntentApplyReceipt> {
    const { actor, authority, command: input } = request
    const log = request.log ?? createLogger('intentApply')
    const journalId = nextId()
    const claim = await databaseSessionFor(dependencies.db).transaction(async (transaction) => {
      const { intentSessions, intentApplyJournal, intentDrafts, intentDraftResolutions } =
        tablesOf(transaction)
      const session = await first(
        transaction.select().from(intentSessions).where(eq(intentSessions.id, input.sessionId)),
      )
      assertIntentSessionClaimable(session, actor.user.id)
      const existing = await first(
        transaction
          .select()
          .from(intentApplyJournal)
          .where(
            and(
              eq(intentApplyJournal.sessionId, input.sessionId),
              eq(intentApplyJournal.clientMutationId, input.clientMutationId),
            ),
          ),
      )
      if (existing !== undefined) return { kind: 'replay' as const, existing, session }
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
      const recordedAt = now()
      await insertOne(transaction, intentApplyJournal, {
        id: journalId,
        sessionId: input.sessionId,
        clientMutationId: input.clientMutationId,
        draftId: committable.id,
        draftHash: committable.draftHash,
        state: 'prepared',
        preparedArtifactsJson: '[]',
        createdAt: recordedAt,
        updatedAt: recordedAt,
      })
      // RFC-359 W11 —— 认领事务的原子性接缝（与 SQLite 侧同名同位）：journal 行已插入、
      // 事务尚未提交时抛。这是「四道读判据 + 认领同生共死」唯一可观测的形态。
      request.faults?.inClaimTxAfterJournal?.()
      return { kind: 'claimed' as const, session, draft: committable }
    })

    if (claim.kind === 'replay') return intentApplyReplayOutcomeOf(claim.existing)
    active.add(journalId)
    const artifacts: IntentApplyRecoveryArtifact[] = []
    const recordArtifact = async (artifact: IntentApplyArtifact): Promise<void> => {
      const nextArtifacts = [...artifacts, artifact]
      const { intentApplyJournal } = tablesOf(dependencies.db)
      await dependencies.db
        .update(intentApplyJournal)
        .set({ preparedArtifactsJson: JSON.stringify(nextArtifacts), updatedAt: now() })
        .where(eq(intentApplyJournal.id, journalId))
      artifacts.push(artifact)
    }
    const settleFailed = async (error: unknown): Promise<void> => {
      const { intentApplyJournal } = tablesOf(dependencies.db)
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
      const { intentApplyJournal } = tablesOf(dependencies.db)
      await dependencies.db
        .update(intentApplyJournal)
        .set({
          error: `retryable after apply error: ${original}; compensation incomplete: ${cleanup}`,
          updatedAt: now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
    }

    let committedReceipt: IntentApplyReceipt | null = null
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
    try {
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

      const transactionResult = await databaseSessionFor(dependencies.db).transaction(
        async (transaction) => {
          const { intentApplyJournal, intentSessions, intentProvenance } = tablesOf(transaction)
          const cas = await first(
            transaction
              .update(intentApplyJournal)
              .set({ state: 'applying', updatedAt: now() })
              .where(
                and(eq(intentApplyJournal.id, journalId), eq(intentApplyJournal.state, 'prepared')),
              )
              .returning({ id: intentApplyJournal.id }),
          )
          if (cas === undefined) {
            throw new ConflictError('intent-apply-unsettled', 'journal claim lost')
          }
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
          const attempt = resourceSession.createTransactionAttempt(
            catalogTransaction(transaction),
            {
              bundleCreatedNames,
            },
          )
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
          await transaction
            .update(intentApplyJournal)
            .set({
              state: 'committed',
              receiptJson: JSON.stringify(receiptValue),
              updatedAt: now(),
            })
            .where(eq(intentApplyJournal.id, journalId))
          return Object.freeze({ receipt: receiptValue, attempt })
        },
      )
      const { receipt, attempt } = transactionResult
      committedReceipt = receipt
      attempt.commitSucceeded()
      request.faults?.afterTxBeforeRollForward?.()
      await resourceSession.rollForwardCommitted()
      const complete = await dependencies.artifacts.rollForward(artifacts, log)
      if (!complete) {
        const { intentApplyJournal } = tablesOf(dependencies.db)
        await dependencies.db
          .update(intentApplyJournal)
          .set({
            error: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
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
          log.warn(INTENT_APPLY_DIAGNOSTICS.resourceRollForwardRecoveryFailed, {
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
      if (compensationErrors.length === 0) await settleFailed(error)
      else {
        // RFC-359 W7 抬齐②: a non-terminal row is only half the record — the other
        // half is the word operators grep for. SQLite has always logged this;
        // without it the same failure simply has no name on a PostgreSQL
        // deployment. Same constant, same payload shape, so both greps match.
        await keepRetryable(error, compensationErrors)
        log.warn(INTENT_APPLY_DIAGNOSTICS.applyLeftRetryable, {
          journalId,
          err: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    } finally {
      active.delete(journalId)
    }
  }

  return Object.freeze({
    apply(request: IntentApplyEngineRequest) {
      return applyLock.run(request.command.sessionId, () => applyUnlocked(request))
    },
    activeJournalIds: () => [...active],
  })
}

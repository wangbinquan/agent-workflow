import {
  intentWorkflowInvalidMessage,
  validateResolvedBundleWorkflowGraphs,
} from '../application/graphValidation'
import type { IntentWorkflowGraphValidationPort } from '../application/ports/intentWorkflowGraphValidation'
import { formatChangesetIssues } from '@agent-workflow/shared'
import { intentResourcePlanOf } from '../application/intentResourcePlan'
import { decodeStoredChangeset } from '../domain/storedChangeset'
import { decodeIntentJournalArtifacts } from '../domain/journalArtifacts'
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
import {
  intentApplyJournal,
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
} from '@/db/schema'
import type {
  IntentApplyArtifact,
  IntentApplyResourceSession,
} from '@/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourceParticipants'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { ProviderNeutralDatabase } from '@/db/query'
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
  converge(
    log?: Logger,
    options?: { readonly activeJournalIds?: readonly string[] },
  ): Promise<{ failed: number; rolledForward: number }>
  activeJournalIds(): readonly string[]
}

export interface IntentApplyEngineDependencies {
  readonly db: ProviderNeutralDatabase
  readonly resources: IntentApplyResourceBinding
  readonly artifacts: IntentApplyArtifactLifecycle
  /** RFC-358 §7 —— 提交期图校验。缺省不拦（既有测试装配保持原样）。 */
  readonly graphValidation?: IntentWorkflowGraphValidationPort
  readonly id?: () => string
  readonly now?: () => number
}

const CONVERGE_MIN_AGE_MS = 10 * 60 * 1000

/**
 * RFC-359 W11 —— 两笔大事务已改走中立事务原语（`databaseSessionFor(db).transaction(...)`），
 * 但注入进来的资源会话仍按 provider 命名的事务句柄取参。把中立句柄重新窄化给它**不是强转
 * 谎话**：那个参数类型归根到底是
 * `Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]`，而中立会话在
 * PostgreSQL 上交出的正是驱动 `db.transaction` 回调里的那个句柄本身
 * （`createPostgresqlDatabaseSession` 只把同一个对象标注成 `DatabaseTransaction`）——
 * 运行期逐字相同。
 *
 * 目标类型从**已经注入的那个会话**上取（而不是另开一条深取 import）：窄化的收件人变了，
 * 这里就跟着变，不会留下一个自说自话的别名。退役条件：资源会话协议改吃 `DatabaseTransaction`，
 * 两套 apply 引擎合一时随之消失。
 */
type IntentApplyCatalogTransaction = Parameters<
  IntentApplyResourceSession['createTransactionAttempt']
>[0]

function catalogTransaction(transaction: DatabaseTransaction): IntentApplyCatalogTransaction {
  return transaction as unknown as IntentApplyCatalogTransaction
}

/**
 * RFC-359（plan §5dz）—— 收敛期读回 journal 的恢复凭据。
 *
 * **必须同时认得两种容器**：这台引擎自己写的是裸数组，而**合一之前**由 SQLite 那台
 * intent apply 引擎写下的行是带版本号的信封 `{ version: 1, artifacts: [...] }`
 * （`domain/intentJournalArtifacts.ts` 的 codec）。只认裸数组的话，一台在合一之前起过的
 * SQLite daemon 留下的未结 journal 行会被判成 `intent-journal-artifact-corrupt` 而**永不终态化**
 * ——收敛器每小时看它一次、每次都拒绝，行与半成品一起永久卡住。
 *
 * 同一条道理、同一种处置，资源包那边是 `composeResourcePackageApplyArtifactRecoveryChain`
 * （plan §5dw）；这里因为 codec 本来就在 domain 层，直接回落一次即可。
 * 工件生命周期那一侧早就这么做了（`intentApplyArtifactLifecycle.ts:95`），
 * 收敛这一侧此前漏了。
 */
function decodeRecoveryArtifacts(json: string): IntentApplyRecoveryArtifact[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) {
    return [...decodeIntentJournalArtifacts(json)] as IntentApplyRecoveryArtifact[]
  }
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
      const session = await transaction
        .select()
        .from(intentSessions)
        .where(eq(intentSessions.id, input.sessionId))
        .get()
      assertIntentSessionClaimable(session, actor.user.id)
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
      assertIntentSessionReady(session)
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
      const committable = requireCommittableDraft({
        draft,
        session,
        confirmedDraftHash: input.draftHash,
      })
      const resolution = await transaction
        .select({ reason: intentDraftResolutions.reason })
        .from(intentDraftResolutions)
        .where(eq(intentDraftResolutions.draftId, committable.id))
        .get()
      assertIntentDraftUnresolved(resolution?.reason)
      const recordedAt = now()
      await transaction.insert(intentApplyJournal).values({
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
          const sessionRow = await transaction
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
            await transaction.insert(intentProvenance).values({
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
        log.warn(INTENT_APPLY_DIAGNOSTICS.journalArtifactCorrupt, {
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
            log.warn(INTENT_APPLY_DIAGNOSTICS.convergeCompensationFailed, {
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
            error: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
            updatedAt: now(),
          })
          .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')))
      }
    }
    return { failed, rolledForward }
  }

  return Object.freeze({
    apply(request: IntentApplyEngineRequest) {
      return applyLock.run(request.command.sessionId, () => applyUnlocked(request))
    },
    converge,
    activeJournalIds: () => [...active],
  })
}

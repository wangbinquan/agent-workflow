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
import { affectedRows, databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { formatChangesetIssues } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { intentResourcePlanOf } from '../application/intentResourcePlan'
import {
  intentWorkflowInvalidMessage,
  validateResolvedBundleWorkflowGraphs,
} from '../application/graphValidation'
import type { IntentWorkflowGraphValidationPort } from '../application/ports/intentWorkflowGraphValidation'
import { decodeStoredChangeset } from '../domain/storedChangeset'
import {
  INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
  INTENT_APPLY_DIAGNOSTICS,
} from '../application/journalConvergence'
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

/**
 * RFC-359 W4-D23b —— 意图应用的大事务已改走中立事务原语，但链上还有一批**同步**的 `*InTx` 成员
 * 没迁完。把中立句柄重新窄化给它们**不是强转谎话**：SQLite 会话交出的事务句柄**就是 `DbClient`
 * 本身**（`createSqliteDatabaseSession`），这些成员运行时拿到的对象逐字相同。
 * 退役条件同 bundle apply：那批成员迁完、两套 apply 引擎合一时随之消失。
 *
 * RFC-359 W9 —— 本文件的 9 笔 **journal 事务**（claim / recordArtifact / settleFailed /
 * keepRetryable / 收敛的 5 笔）也迁完了，`dbTxSync` 调用点归零；这条窄化只剩
 * `participantInTransaction` 一个使用者（legacy 资源会话的六条提交臂仍是同步 `*InTx`）。
 * 与此同时大事务体内的裸 `.run()` 也改成了 `await`——它们是 bun:sqlite 独有的同步执行面，
 * 在 PostgreSQL 客户端（drizzle sqlite-proxy，异步）上返回未 await 的 Promise、`changes`
 * 恒为 undefined，于是 CAS 判据静默失真。改完之后本文件的编排层**整体是 provider 中立的**，
 * 只有注入进来的资源会话还锁死在 SQLite 上。行为锁在
 * `tests/rfc359-w9-intent-apply-sync-transaction-cutover.test.ts`（双引擎）。
 */
function syncMembers(tx: DatabaseTransaction): DbTxSync {
  return tx as unknown as DbTxSync
}

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
  /**
   * RFC-358 §7（决策 D3）—— 提交期的图校验。缺省表示不拦（既有测试装配保持原样）；
   * 生产装配必须给，否则 AC-6 这道门形同虚设。
   */
  graphValidation?: IntentWorkflowGraphValidationPort
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
    /**
     * RFC-359 W9 —— I14 record-before-act：这一笔**必须**在副作用（插件安装 / 技能暂存）之前
     * 落库，所以它是 `Promise<void>` 而不是 `void | Promise<void>`——联合里混进 `void`，调用方
     * 漏掉 await 就成了合法写法，连 `no-floating-promises` 都不再报（`docs/dev-gotchas.md`）。
     */
    context: { readonly recordArtifact: (artifact: IntentJournalArtifactV1) => Promise<void> },
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
  // RFC-359 W9：四道读判据 + journal 认领必须同生共死，所以它是**唯一**一笔多语句的
  // journal 事务，改走中立事务原语后仍是一笔。读用 `(await …limit(1))[0]`：中立句柄上
  // `.get()` 的返回类型是 `T | Promise<T>` 的联合，能 await 但读起来像同步面，容易被下一个
  // 人抄成漏 await 的形状（`plan.md` 记着 `sqliteResourcePackageMaintenance.ts` 那个活标本）。
  const claim = await databaseSessionFor(db).transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, input.sessionId))
      .limit(1)
    assertIntentSessionClaimable(session, actor.user.id)
    const [existing] = await tx
      .select()
      .from(intentApplyJournal)
      .where(
        and(
          eq(intentApplyJournal.sessionId, input.sessionId),
          eq(intentApplyJournal.clientMutationId, input.clientMutationId),
        ),
      )
      .limit(1)
    if (existing !== undefined) {
      return { kind: 'replay' as const, existing, session }
    }
    assertIntentSessionReady(session)
    const [draft] = await tx
      .select()
      .from(intentDrafts)
      .where(
        and(
          eq(intentDrafts.sessionId, input.sessionId),
          eq(intentDrafts.revision, input.draftRevision),
        ),
      )
      .limit(1)
    const committable = requireCommittableDraft({
      draft,
      session,
      confirmedDraftHash: input.draftHash,
    })
    const [resolution] = await tx
      .select({ reason: intentDraftResolutions.reason })
      .from(intentDraftResolutions)
      .where(eq(intentDraftResolutions.draftId, committable.id))
      .limit(1)
    assertIntentDraftUnresolved(resolution?.reason)
    const now = Date.now()
    await tx.insert(intentApplyJournal).values({
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
    deps.faults?.inClaimTxAfterJournal?.()
    return { kind: 'claimed' as const, session, draft: committable }
  })

  if (claim.kind === 'replay') return intentApplyReplayOutcomeOf(claim.existing)

  // P2-1: the whole claim→settle window is registered so the converger can
  // never mistake this process's own live apply for a crashed one.
  ACTIVE_APPLY_JOURNALS.add(journalId)

  const artifacts: IntentJournalArtifactV1[] = []
  // RFC-359 W9 —— I14 record-before-act：登记必须**先于**副作用落库，切成异步后调用方
  // 必须 await（生产链上的三处在 `legacyIntentApplyResourceParticipants.ts`，源码层守卫
  // 在本刀的行为锁文件里——漏掉 await 时既有断言全绿，只有那条守卫会红）。
  const recordArtifact = async (artifact: IntentJournalArtifactV1): Promise<void> => {
    artifacts.push(artifact)
    await databaseSessionFor(db).transaction(async (tx) => {
      await tx
        .update(intentApplyJournal)
        .set({
          preparedArtifactsJson: encodeIntentJournalArtifacts(artifacts),
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
    })
  }
  const settleFailed = async (error: unknown): Promise<void> => {
    await databaseSessionFor(db).transaction(async (tx) => {
      await tx
        .update(intentApplyJournal)
        .set({
          state: 'failed',
          error:
            error instanceof Error
              ? `${(error as { code?: string }).code ?? 'error'}: ${error.message}`
              : String(error),
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
    })
  }
  /**
   * RFC-359 W7 抬齐①：提交后的尾巴没做完时的写回。
   *
   * 它是本文件第一笔走**中立事务原语**的 journal 写回（W7 落地时其余 9 笔还是 `dbTxSync`），
   * 理由是 SQLite 同步事务面记的是「只降不升」的高水位账
   * （`tests/architecture/rfc359-sync-transaction-highwater`）——为一条新写回再开一个 SQLite
   * 专属句柄，等于给合一多欠一笔。W9 把其余 9 笔一并迁过来后，这里与它们同形。
   */
  const keepCommittedRollForwardRetryable = async (): Promise<void> => {
    await databaseSessionFor(db).transaction(async (tx) => {
      await tx
        .update(intentApplyJournal)
        .set({
          error: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
    })
  }
  const keepRetryable = async (
    error: unknown,
    compensationErrors: readonly unknown[],
  ): Promise<void> => {
    const original = error instanceof Error ? error.message : String(error)
    const cleanup = compensationErrors
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .join('; ')
    await databaseSessionFor(db).transaction(async (tx) => {
      await tx
        .update(intentApplyJournal)
        .set({
          error: `retryable after apply error: ${original}; compensation incomplete: ${cleanup}`,
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
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

    // ── RFC-358 §7 —— 提交期的图校验（决策 D3，兑现 RFC-234 §9.2 的未落地项）──
    //
    // 位置必须在 `prepare` 循环**之后**：canonical `WorkflowDefinitionSchema.parse`
    // 是在 prepare 里跑的，放它之前会拿到未校验的定义、在 `edge.target.nodeId` 上抛
    // TypeError（500），并把「canonical schema rejection maps to
    // intent-op-canonical-invalid, not 500」那条既有回归推红。
    //
    // 还在 prestage 之前：此刻尚无任何副作用（插件未装、技能未 stage），失败就是干净
    // 的零落库，不需要补偿。
    if (deps.graphValidation !== undefined) {
      const graph = await validateResolvedBundleWorkflowGraphs(
        { graphValidation: deps.graphValidation },
        { actor: deps.actor, ops: bundle.ops },
      )
      if (graph.errors.length > 0) {
        throw new ValidationError(
          'intent-workflow-invalid',
          intentWorkflowInvalidMessage(graph.errors),
          { issues: graph.errors },
        )
      }
    }

    // ── prestage (design §9.4 ①②; record-then-act) ──
    for (const plan of plans) {
      await resourceSession.prestage(plan, { recordArtifact })
    }

    deps.faults?.beforeTx?.()

    // ── the big transaction (design §9.4 ③) ──
    const applied: IntentApplyReceipt['applied'] = []
    const receipt = await databaseSessionFor(db).transaction(async (tx) => {
      // RFC-359 W9：CAS 判据从 bun:sqlite 独有的 `.run().changes` 换成中立的 `affectedRows`
      // （两个引擎都读 `changes`，缺失按 0 计 ⇒ 判据失真时失败得大声）。
      const cas = await tx
        .update(intentApplyJournal)
        .set({ state: 'applying', updatedAt: Date.now() })
        .where(and(eq(intentApplyJournal.id, journalId), eq(intentApplyJournal.state, 'prepared')))
      if (affectedRows(cas) !== 1) {
        throw new ConflictError('intent-apply-unsettled', 'journal claim lost')
      }

      const sessionRow = (
        await tx
          .select()
          .from(intentSessions)
          .where(eq(intentSessions.id, input.sessionId))
          .limit(1)
      )[0]
      const baseline = {
        claimSession: claim.session,
        claimDraftId: claim.draft.id,
        sessionNow: sessionRow,
      }
      assertIntentApplyBaselineFresh(baseline)
      const sessionNow = baseline.sessionNow
      const bundleCreatedNames = bundleCreatedNamesOf(plans)

      // RFC-359 W4-D23b：同 bundle apply——大事务已走中立会话，链上仍是同步面的成员经具名窄化
      // 拿到同一个句柄（SQLite 上就是 DbClient 本身，见 `createSqliteDatabaseSession`）。
      const resourceParticipant = resourceSession.participantInTransaction(syncMembers(tx), {
        bundleCreatedNames,
      })
      for (const [index, plan] of plans.entries()) {
        const op = requireOpForPlan(bundle.ops[index], plan)
        await resourceParticipant.authorizeAndCommit(deps.authority, plan)
        applied.push(appliedEntryOf(op))
        await tx.insert(intentProvenance).values({
          resourceType: op.resourceType,
          resourceId: op.resourceId,
          commitId: journalId,
          sessionId: input.sessionId,
          createdAt: Date.now(),
        })
      }

      deps.faults?.inTxAfterOps?.()

      const mutation = intentApplyCommitMutationOf({
        claimSession: claim.session,
        preCommitManifestJson: sessionNow.contextManifestJson,
        ops: bundle.ops,
      })
      const commitSeq = mutation.commitSeq
      await tx
        .update(intentSessions)
        .set({
          commitSeq: mutation.commitSeq,
          contextRevision: mutation.contextRevision,
          currentDraftId: null,
          contextManifestJson: mutation.contextManifestJson,
          handleWatermarkJson: mutation.handleWatermarkJson,
          updatedAt: Date.now(),
        })
        .where(eq(intentSessions.id, input.sessionId))
      const receiptValue: IntentApplyReceipt = { journalId, commitSeq, applied }
      await tx
        .update(intentApplyJournal)
        .set({
          state: 'committed',
          receiptJson: JSON.stringify(receiptValue),
          updatedAt: Date.now(),
        })
        .where(eq(intentApplyJournal.id, journalId))
      return receiptValue
    })
    committedReceipt = receipt

    // ── roll-forward (design §9.5; idempotent) ──
    // RFC-359 W7 抬齐①: the return value is the ONLY in-band signal that the
    // committed tail is unfinished. Dropping it (the pre-W7 shape here) left a
    // clean-looking row that nobody could tell apart from a fully settled one
    // until the next boot/hourly convergence. Record it now, in the same words
    // convergence uses; the row stays `committed` because the bundle IS applied.
    deps.faults?.afterTxBeforeRollForward?.()
    const complete = await deps.artifacts.rollForward(artifacts, log)
    if (!complete) await keepCommittedRollForwardRetryable()
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
    if (compensationErrors.length === 0) await settleFailed(error)
    else {
      // A non-terminal row truthfully records that cleanup is incomplete and
      // lets boot/hourly convergence retry. Marking it failed would make the
      // converger skip the residue forever.
      await keepRetryable(error, compensationErrors)
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
        await databaseSessionFor(db).transaction(async (tx) => {
          await tx
            .update(intentApplyJournal)
            .set({
              error: `retryable: artifact decode failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            })
            .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
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
        await databaseSessionFor(db).transaction(async (tx) => {
          await tx
            .update(intentApplyJournal)
            .set({
              error: `retryable: compensation incomplete: ${compensationErrors
                .map((item) => (item instanceof Error ? item.message : String(item)))
                .join('; ')}`,
            })
            .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state)))
        })
        log.warn(INTENT_APPLY_DIAGNOSTICS.convergeLeftRetryable, { journalId: row.id })
        continue
      }
      const cas = await databaseSessionFor(db).transaction(
        async (tx) =>
          await tx
            .update(intentApplyJournal)
            .set({ state: 'failed', error: 'daemon-restart before commit', updatedAt: Date.now() })
            .where(and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, row.state))),
      )
      // CAS 的判据是「恰好一行」：`affectedRows` 在两个引擎上都读 `changes`，缺失按 0 计。
      if (affectedRows(cas) === 1) failed += 1
    } else if (row.state === 'committed') {
      const complete = await artifactLifecycle.rollForward(artifacts, log)
      if (complete) {
        rolledForward += 1
        if (row.error !== null) {
          await databaseSessionFor(db).transaction(async (tx) => {
            await tx
              .update(intentApplyJournal)
              .set({ error: null, updatedAt: Date.now() })
              .where(
                and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')),
              )
          })
        }
      } else {
        await databaseSessionFor(db).transaction(async (tx) => {
          await tx
            .update(intentApplyJournal)
            .set({
              error: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
              updatedAt: Date.now(),
            })
            .where(
              and(eq(intentApplyJournal.id, row.id), eq(intentApplyJournal.state, 'committed')),
            )
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

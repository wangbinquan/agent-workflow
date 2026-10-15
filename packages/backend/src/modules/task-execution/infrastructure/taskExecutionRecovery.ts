// RFC-359 W8 —— 后继 daemon 的 effect / owner 恢复：**一份**实现，两个引擎共用。
//
// 合一前是 W5 账本里那对：SQLite 侧 `sqliteTaskExecutionRecovery.ts`（393 行同步流程，经
// `taskExecutionModule.effects` 的 dbTxSync 家族）+ 20 行 Promise 适配器，PostgreSQL 侧
// `postgresqlTaskExecutionRecovery.ts`（674 行原生重写，自带一份私有的 code-host 探针清算）。
// 比值 1.7、两侧体量接近——正是「各自长出同样体量的代码」的形状。逐方法对完只有编排是重复的，
// 差异全在三条，由 `tests/rfc359-w8-task-execution-recovery-conformance.test.ts` 实测照出：
//
//   · 04-pg-code-host-recovery-lock-proof —— PG 的 code-host 清算不校验接管者代际 / 静默证据非空；
//     SQLite 的 `finalize` 反过来不校验独占锁证明本身（候选为空时形同放行）。两侧各取强的一半：
//     `prepare` / `finalize` 入口都 assert 锁证明，清算原子里也照 assert。
//   · 05-pg-code-host-evidence-digest-payload —— 两侧 `codeHostEvidenceDigest` 载荷不同
//     （PG 含 nodeRunId、不含 descriptor / proofCode；SQLite 相反）⇒ 同一次恢复产出不同的
//     takeover 证明摘要。按强侧（SQLite：完整探针判据）统一。
//   · 08-pg-release-recovered-replay-decision-rollback —— 在 `taskOwnershipPersistence.ts` 关闭。
//
// 网络探针留在事务外：候选读 + 探针 + 第二阶段围栏落账，三段式与合一前一致。

import { and, asc, eq, inArray, ne } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionEffectAttempts, taskExecutionEffects, taskExecutionOwners } from '@/db/schema'
import type {
  TaskExecutionRecoveryFinalization,
  TaskExecutionRecoveryPersistence,
} from '../application/recoverTaskExecutions'
import {
  decodeCodeHostRecoveryDescriptor,
  type CodeHostProbeOutcome,
  type CodeHostRecoveryDescriptor,
} from '../domain/codeHostRecovery'
import { sha256Hex } from '../domain/digest'
import { canonicalJson } from '../domain/executionIntent'
import {
  assertExclusiveDaemonLockProof,
  createVerifiedOutcomeUnknownClosure,
  createVerifiedTakeoverProof,
  type OwnershipTuple,
} from '../domain/ownership'
import {
  closeRecoveredOutcomeUnknownAndRelease,
  readUnresolvedEffectIds,
  resolveQuiescedCodeHostMutations,
  resolveQuiescedManagedProcesses,
  type RecoveredCodeHostMutation,
} from './effectQuiescence'
import { DrizzleTaskOwnershipPersistence } from './taskOwnershipPersistence'

type OwnerRow = typeof taskExecutionOwners.$inferSelect

function tuple(row: OwnerRow): OwnershipTuple {
  return {
    taskId: row.taskId,
    ownerId: row.ownerId,
    daemonGeneration: row.daemonGeneration,
    epoch: row.epoch,
  }
}

/** 一条已知结论的探针：落账要用的字段 + 进证据摘要的完整判据。 */
interface ProbedCodeHostMutation {
  readonly resolution: RecoveredCodeHostMutation
  readonly evidence: {
    readonly effectId: string
    readonly attemptId: string
    readonly descriptor: CodeHostRecoveryDescriptor
    readonly outcome: 'applied' | 'definitely-not-applied'
    readonly proofCode: string
    readonly responseStatus: number
  }
}

export class DrizzleTaskExecutionRecoveryPersistence implements TaskExecutionRecoveryPersistence {
  private readonly ownership: DrizzleTaskOwnershipPersistence

  constructor(private readonly db: ProviderNeutralDatabase) {
    this.ownership = new DrizzleTaskOwnershipPersistence(db)
  }

  /**
   * 在后继 daemon 的独占锁后面把旧的 claimed owner 线性化。它跑在进程 / 孤儿探测之前，
   * 所以恢复在检视旧世代时不可能冒出新的执行世代。
   */
  async prepare(input: Parameters<TaskExecutionRecoveryPersistence['prepare']>[0]) {
    assertExclusiveDaemonLockProof(input.lockProof)
    const now = input.now ?? Date.now()
    const oldClaims = await this.db
      .select()
      .from(taskExecutionOwners)
      .where(
        and(
          eq(taskExecutionOwners.state, 'claimed'),
          ne(taskExecutionOwners.daemonGeneration, input.lockProof.daemonGeneration),
        ),
      )
    const revokedTaskIds: string[] = []
    for (const owner of oldClaims) {
      await this.ownership.revokeOldDaemon({
        owner: tuple(owner),
        expectedRevision: owner.revision,
        lockProof: input.lockProof,
        now,
      })
      revokedTaskIds.push(owner.taskId)
    }
    return { revokedTaskIds }
  }

  /**
   * 只在 boot 的进程收割器跑完之后调用。已知世代照常释放给自动 / 手动续跑；含糊的外部动作转成
   * 保留的 requires-actor 决定——自动发送保持为零，既有的手动 Resume / Retry / Sync 命令仍可授权 N+1。
   */
  async finalize(
    input: Parameters<TaskExecutionRecoveryPersistence['finalize']>[0],
  ): Promise<TaskExecutionRecoveryFinalization> {
    assertExclusiveDaemonLockProof(input.lockProof)
    if (input.processEvidence.orphanReaperCompleted !== true) {
      throw new Error('task execution recovery requires a completed orphan-process barrier')
    }
    const now = input.now ?? Date.now()
    const candidates = await this.db
      .select()
      .from(taskExecutionOwners)
      .where(
        and(
          inArray(taskExecutionOwners.state, ['revoked', 'recovery-required']),
          ne(taskExecutionOwners.daemonGeneration, input.lockProof.daemonGeneration),
        ),
      )
    const releasedTaskIds: string[] = []
    const outcomeUnknownTaskIds: string[] = []
    const recoveredProcessEffectIds: string[] = []
    const recoveredCodeHostEffectIds: string[] = []
    const retryAuthorizedCodeHostEffectIds: string[] = []
    for (const owner of candidates) {
      const oldOwner = tuple(owner)
      const preResolutionEffectIds = await readUnresolvedEffectIds(this.db, owner.taskId)
      const processEvidenceDigest = sha256Hex(
        canonicalJson({
          v: 1,
          taskId: owner.taskId,
          oldOwner,
          successorGeneration: input.lockProof.daemonGeneration,
          lockReceiptDigest: input.lockProof.lockReceiptDigest,
          processEvidence: input.processEvidence,
          preResolutionEffectIds,
        }),
      )
      const processResolution = await resolveQuiescedManagedProcesses(this.db, {
        authority: 'successor-daemon',
        owner: oldOwner,
        expectedRevision: owner.revision,
        lockProof: input.lockProof,
        quiescenceEvidenceDigest: processEvidenceDigest,
        now,
      })
      recoveredProcessEffectIds.push(...processResolution.resolvedEffectIds)

      const probed = await this.probeCodeHostCandidates(owner, input.codeHostProbe)
      const codeHostEvidenceDigest = sha256Hex(
        canonicalJson({
          v: 1,
          taskId: owner.taskId,
          processEvidenceDigest,
          probeResults: probed.map((result) => result.evidence),
        }),
      )
      const codeHostResolution = await resolveQuiescedCodeHostMutations(this.db, {
        owner: oldOwner,
        expectedRevision: owner.revision,
        lockProof: input.lockProof,
        quiescenceEvidenceDigest: codeHostEvidenceDigest,
        resolutions: probed.map((result) => result.resolution),
        now,
      })
      recoveredCodeHostEffectIds.push(...codeHostResolution.appliedEffectIds)
      retryAuthorizedCodeHostEffectIds.push(...codeHostResolution.retryAuthorizedEffectIds)

      const unresolvedEffectIds = await readUnresolvedEffectIds(this.db, owner.taskId)
      const evidenceDigest = sha256Hex(
        canonicalJson({
          v: 2,
          taskId: owner.taskId,
          oldOwner,
          successorGeneration: input.lockProof.daemonGeneration,
          lockReceiptDigest: input.lockProof.lockReceiptDigest,
          processEvidenceDigest,
          recoveredProcessEffectIds: processResolution.resolvedEffectIds,
          recoveredCodeHostEffectIds: codeHostResolution.appliedEffectIds,
          retryAuthorizedCodeHostEffectIds: codeHostResolution.retryAuthorizedEffectIds,
          codeHostEvidenceDigest,
          unresolvedEffectIds,
        }),
      )
      if (unresolvedEffectIds.length > 0) {
        await closeRecoveredOutcomeUnknownAndRelease(this.db, {
          owner: oldOwner,
          expectedRevision: owner.revision,
          lockProof: input.lockProof,
          proof: createVerifiedOutcomeUnknownClosure({
            taskId: owner.taskId,
            ownerRevision: owner.revision,
            epoch: owner.epoch,
            quiescenceDigest: evidenceDigest,
            unresolvedEffectIds,
            verifiedAt: now,
          }),
          now,
        })
        outcomeUnknownTaskIds.push(owner.taskId)
        continue
      }
      await this.ownership.releaseRecovered({
        owner: oldOwner,
        expectedRevision: owner.revision,
        proof: createVerifiedTakeoverProof({
          taskId: owner.taskId,
          oldOwnerRevision: owner.revision,
          oldEpoch: owner.epoch,
          evidenceDigest,
          verifiedAt: now,
        }),
        now,
      })
      releasedTaskIds.push(owner.taskId)
    }
    return {
      releasedTaskIds,
      outcomeUnknownTaskIds,
      recoveredProcessEffectIds: [...new Set(recoveredProcessEffectIds)].sort(),
      recoveredCodeHostEffectIds: [...new Set(recoveredCodeHostEffectIds)].sort(),
      retryAuthorizedCodeHostEffectIds: [...new Set(retryAuthorizedCodeHostEffectIds)].sort(),
    }
  }

  /**
   * 探针在事务外跑。没有描述符 / 描述符坏了 / 只能由行为人重放 / 探针抛错或回 unknown 的候选
   * 一律跳过——它们留在未决集合里，由 outcome-unknown 闭合收场。
   *
   * 候选顺序在 JS 里排定：证据摘要依赖顺序，而 SQL 的排序受引擎排序规则影响，两个引擎会算出
   * 不同的摘要。
   */
  private async probeCodeHostCandidates(
    owner: OwnerRow,
    probe: ((descriptor: CodeHostRecoveryDescriptor) => Promise<CodeHostProbeOutcome>) | undefined,
  ): Promise<readonly ProbedCodeHostMutation[]> {
    const candidates = (
      await this.db
        .select({
          effectId: taskExecutionEffects.id,
          attemptId: taskExecutionEffectAttempts.id,
          recoveryDescriptorJson: taskExecutionEffectAttempts.recoveryDescriptorJson,
        })
        .from(taskExecutionEffectAttempts)
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(
          and(
            eq(taskExecutionEffects.taskId, owner.taskId),
            eq(taskExecutionEffects.kind, 'code-host-mutation'),
            eq(taskExecutionEffects.state, 'open'),
            eq(taskExecutionEffectAttempts.epoch, owner.epoch),
            inArray(taskExecutionEffectAttempts.state, ['acting', 'recovery-required']),
          ),
        )
        .orderBy(asc(taskExecutionEffects.id), asc(taskExecutionEffectAttempts.id))
    ).sort(
      (left, right) =>
        left.effectId.localeCompare(right.effectId) ||
        left.attemptId.localeCompare(right.attemptId),
    )
    const probed = await Promise.all(
      candidates.map(async (candidate): Promise<ProbedCodeHostMutation | null> => {
        if (candidate.recoveryDescriptorJson === null || probe === undefined) return null
        let descriptor: CodeHostRecoveryDescriptor
        try {
          descriptor = decodeCodeHostRecoveryDescriptor(candidate.recoveryDescriptorJson)
        } catch {
          return null
        }
        if (descriptor.probe.kind === 'actor-replay') return null
        let outcome: CodeHostProbeOutcome
        try {
          outcome = await probe(descriptor)
        } catch {
          return null
        }
        if (outcome.kind === 'unknown') return null
        return {
          resolution: {
            effectId: candidate.effectId,
            attemptId: candidate.attemptId,
            outcome: outcome.kind,
            receiptJson: JSON.stringify({
              v: 1,
              recovery: 'successor-daemon-code-host-probe',
              proofCode: outcome.proofCode,
              responseStatus: outcome.responseStatus,
            }),
            nodeRunId: descriptor.nodeRunId,
            responseStatus: outcome.responseStatus,
            responseBody: outcome.responseBody,
          },
          evidence: {
            effectId: candidate.effectId,
            attemptId: candidate.attemptId,
            descriptor,
            outcome: outcome.kind,
            proofCode: outcome.proofCode,
            responseStatus: outcome.responseStatus,
          },
        }
      }),
    )
    return probed.filter((result): result is ProbedCodeHostMutation => result !== null)
  }
}

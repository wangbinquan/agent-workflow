// RFC-359 W1-T7b（P0-10）—— 任务驱动释放序列的**一份**实现，两个引擎共用。
//
// 此前 `taskDriverLifecycle.ts`（SQLite）在释放 owner 之前会先清算本 epoch 的 process effect
// （exact-stop 权威）、清不掉的走 outcome-unknown 闭合；`postgresqlTaskDriverLifecycle.ts` 直接
// `releaseAfterStop`，而 PG 的 owner 释放一看到还开着的 effect 就抛 `task-execution-recovery-required`
// ——每个跑过子进程的任务在 PG 上都以 owner 卡死收场。这里把顺序只写一次，两个 lifecycle 都委托：
//
//   registry 校验（token / controller）→ 读 unreaped 证据 → registry.release（第一阶段）→ 停心跳
//   → 读 owner → [released] 清算 managed-process → 仍有未决 effect ? outcome-unknown 闭合 : releaseAfterStop
//              → [unreaped]  markRecoveryRequired
//   → registry.settle（第二阶段：此时才唤醒 awaitStopped / awaitTaskDriverIdle 的等待者）
//   → finalizeWorkspace
//
// 两阶段的原因（2026-09-05 CI 实撞，RFC-092 S-1）：等待者一被唤醒就会去认领，而库里的 owner 行
// 要到上面那几笔事务提交后才不再是 'claimed'。此前 SQLite 的释放几乎全同步、靠微任务先后顺序碰巧
// 赢了这场竞速；序列合一后多了几次 await 就输了。现在库里转移完才 settle，与顺序无关。
//
// 全部持久化动作走 `TaskExecutionPersistence` 的命名端口，provider 只在 bootstrap 选。

import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import { sha256Hex } from '../domain/digest'
import { canonicalJson } from '../domain/executionIntent'
import {
  createVerifiedOutcomeUnknownClosure,
  createVerifiedStopProof,
  ownershipTokenKey,
  type OwnershipToken,
} from '../domain/ownership'
import type { InMemoryTaskRuntimeRegistry, RuntimeStopResult } from './inMemoryTaskRuntimeRegistry'

export interface TaskDriverReleaseDependencies {
  readonly registry: InMemoryTaskRuntimeRegistry
  readonly persistence: Pick<TaskExecutionPersistence, 'ownership' | 'effects'>
  /** 释放 token 对应的心跳定时器；两个 lifecycle 各自持有定时器表。 */
  readonly stopHeartbeat: (tokenKey: string) => void
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
}

export async function releaseTaskDriverAndFinalize(
  deps: TaskDriverReleaseDependencies,
  input: {
    readonly taskId: string
    readonly controller: AbortController
  },
): Promise<void> {
  const { registry, persistence } = deps
  // 先验 process-local 归属，再碰库：过期 / 重复的 driver finally 不得替现任 owner 读写。
  const token = registry.tokenForTask(input.taskId)
  if (token === null || registry.controllerFor(token) !== input.controller) return
  const intentId = registry.intentFor(token)
  if (intentId === null) return
  const unreaped = await persistence.effects.unreapedProcessCode(input.taskId)
  const stopResult = registry.release({
    token,
    controller: input.controller,
    result: unreaped === null ? { kind: 'released' } : { kind: 'unreaped', code: unreaped },
  })
  if (stopResult === null) return

  deps.stopHeartbeat(ownershipTokenKey(token))
  try {
    await transferOwnerRow(persistence, { taskId: input.taskId, token, intentId, stopResult })
  } finally {
    registry.settle(token)
  }
  await deps.finalizeWorkspace(input.taskId)
}

/** 库里的 owner 行转移：清算本 epoch 的 effect，再按停机结果释放或标记待恢复。 */
async function transferOwnerRow(
  persistence: TaskDriverReleaseDependencies['persistence'],
  input: {
    readonly taskId: string
    readonly token: OwnershipToken
    readonly intentId: string
    readonly stopResult: RuntimeStopResult
  },
): Promise<void> {
  const { token, intentId, stopResult } = input
  const owner = await persistence.ownership.read(input.taskId)
  if (owner !== null && owner.epoch === token.epoch) {
    if (stopResult.kind === 'released') {
      const verifiedAt = Date.now()
      const stopProof = createVerifiedStopProof({
        taskId: input.taskId,
        ownerRevision: owner.revision,
        epoch: token.epoch,
        evidenceDigest: stopResult.evidenceDigest,
        verifiedAt,
      })
      await persistence.effects.resolveQuiescedManagedProcesses({
        authority: 'exact-stop',
        token,
        expectedRevision: owner.revision,
        proof: stopProof,
        quiescenceEvidenceDigest: stopResult.evidenceDigest,
        now: verifiedAt,
      })
      const unresolvedEffectIds = await persistence.effects.unresolvedEffectIds(input.taskId)
      if (unresolvedEffectIds.length > 0) {
        const quiescenceDigest = sha256Hex(
          canonicalJson({
            v: 1,
            taskId: input.taskId,
            epoch: token.epoch,
            runtimeStopEvidence: stopResult.evidenceDigest,
            unresolvedEffectIds,
          }),
        )
        await persistence.effects.closeOutcomeUnknownAndRelease({
          token,
          intentId,
          proof: createVerifiedOutcomeUnknownClosure({
            taskId: input.taskId,
            ownerRevision: owner.revision,
            epoch: token.epoch,
            quiescenceDigest,
            unresolvedEffectIds,
            verifiedAt,
          }),
          now: verifiedAt,
        })
      } else {
        await persistence.ownership.releaseAfterStop({
          token,
          intentId,
          proof: stopProof,
          now: verifiedAt,
        })
      }
    } else {
      await persistence.ownership.markRecoveryRequired({
        token,
        expectedRevision: owner.revision,
        code: stopResult.code,
        evidenceDigest: stopResult.evidenceDigest,
        now: Date.now(),
      })
    }
  }
}

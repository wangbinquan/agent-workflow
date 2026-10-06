// RFC-359 W3-T4（P0-3 / P0-4）—— daemon 启动期的任务执行恢复四步：**一份**序列，两个引擎共用。
//
// 此前这四步只写在 `cli/start.ts` 的 SQLite 分支里（撤销旧 daemon 的 owner → 收割孤儿 run →
// 修复 runtime session lease → 用孤儿收割证据清算 effect 并释放 / 闭合 owner），PostgreSQL 分支在
// `servePostgresqlDaemon` 的永不返回 Promise 之后根本到不了：PG 上重启一次 daemon，上一代所有在跑的
// 任务与 node_run 永久停在 running / pending，owner 行永远停在 claimed，此后任何启动 / 继续 / 重试恒
// 409 `task-execution-owner-conflict`（dual-provider-parity-audit-2026-09-04 P0-3）；周期 orphan-reconcile
// 与自动修复同样被这个 ownerless 围栏拒绝（P0-4）。
//
// 每一步都只经 provider 中立端口：`TaskExecutionRecoveryPersistence`（prepare / finalize）、
// `TaskRecoveryOperations`（孤儿快照与 CAS）、`RuntimeSessionLeaseOperations`。provider 只在 bootstrap 选。

import { sha256Hex } from '@/util/hash'
import { runBootExecutionRecovery } from '../application/bootExecutionRecovery'
import type {
  TaskExecutionBootRecoveryInput,
  TaskExecutionBootRecoveryReport,
} from '../application/ports/bootExecutionRecovery'
import { selectLocalBootExecutionRecoveryFactory } from './localBootExecutionRecovery'

export type {
  BootExecutionRecoveryFactory,
  BootRecoveryLogger,
  TaskExecutionBootRecoveryInput,
  TaskExecutionBootRecoveryReport,
} from '../application/ports/bootExecutionRecovery'
import { createExclusiveDaemonLockProof, type ExclusiveDaemonLockProof } from '../domain/ownership'

/** 单实例锁 + 本代 daemon 世代铸成的独占证明——successor 恢复的唯一权威来源。 */
export function createDaemonLockProof(input: {
  readonly lockPath: string
  readonly lockPid: number
  readonly daemonGeneration: string
  readonly now?: number
}): ExclusiveDaemonLockProof {
  return createExclusiveDaemonLockProof({
    daemonGeneration: input.daemonGeneration,
    acquiredAt: input.now ?? Date.now(),
    lockReceiptDigest: sha256Hex(
      `${input.lockPath}\u0000${input.lockPid}\u0000${input.daemonGeneration}`,
    ),
  })
}

/** Bootstrap consumes an opaque acquired host receipt; native PID facts stay in its adapter. */
export function createDaemonRecoveryAuthorityProof(input: {
  readonly daemonGeneration: string
  readonly acquiredAt: number
  readonly receiptDigest: string
}): ExclusiveDaemonLockProof {
  return createExclusiveDaemonLockProof({
    daemonGeneration: input.daemonGeneration,
    acquiredAt: input.acquiredAt,
    lockReceiptDigest: input.receiptDigest,
  })
}

/**
 * 顺序固定：先撤销旧 daemon 的 owner（此后没有任何旧 worker 能再通过 owner 围栏写库），再收割孤儿
 * run（进程级屏障），再修 lease，最后才拿着「孤儿收割已完成」的证据清算 effect 并释放 / 闭合 owner。
 * 必须在 HTTP 与任何自动续跑之前跑完。
 */
export async function runTaskExecutionBootRecovery(
  input: TaskExecutionBootRecoveryInput,
): Promise<TaskExecutionBootRecoveryReport> {
  return runBootExecutionRecovery(
    selectLocalBootExecutionRecoveryFactory(input.recoveryEffects),
    input,
  )
}

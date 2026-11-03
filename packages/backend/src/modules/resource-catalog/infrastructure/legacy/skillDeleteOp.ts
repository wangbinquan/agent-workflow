// RFC-170 §6a — the `delete` structural op (crash-safe managed-skill deletion).
//
// RFC-401 T5/T6：新的删除经 skill 写入场景（`skillAtomicApply.ts`）；这里只剩旧记录的启动恢复（兼容执行器
// `recoverSkillOperations` 排空旧 operation 时使用）。下面是旧 operation 的形状，恢复据此判定方向。
//
// The old removeSkillRowAndFiles did `rmSync(dir); DELETE row` — a crash between
// them orphans the DB row (points at vanished files). The op makes it recoverable:
//   intent → fs-staged(rename skills/{name} ROOT → .trash/{skillId}-{opId}) →
//   db-committed(DELETE row, same tx) → done(rm trash) .
// The whole ROOT (files/ + versions/) moves so a rollback restores history too.
//
// Recovery (§6a bisection): phase < db-committed → rollback (rename trash back to
// the root — the delete never committed); ≥ db-committed → rollforward (row gone,
// just drop the trash). The restore target (name) rides in precondition_json so
// recovery needs no DB lookup (the row may already be gone on rollforward).
//
// External skills have no managed directory: their deletion is a single-tx DB
// row drop (atomic, no op needed) — handled by the caller, not here.

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SkillOperationRow } from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import type {
  OpRecoveryHandler,
  SkillOpFsOptions,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'
import { decodeSkillOperationIdentity } from './skillIdentityPaths'
import { createFileSkillDeletionContentStore } from '../local/fileSkillDeletionContentStore'

/** §6a recovery for a crashed `delete` op (registered into the boot driver). */
export const deleteRecoveryHandler: OpRecoveryHandler = {
  rollbackFs: async (fsOpts: SkillOpFsOptions, op: SkillOperationRow, db: PersistenceDb) => {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const content =
      fsOpts.deletionContent ?? createFileSkillDeletionContentStore(fsOpts.appHome, db)
    const plan = content.plan({
      ...identity,
      operationId: op.opId,
      recordedBackupRef: op.backupPath,
    })
    await content.rollback(plan, true)
  },
  rollForwardFs: async (fsOpts: SkillOpFsOptions, op: SkillOperationRow, db: PersistenceDb) => {
    const content =
      fsOpts.deletionContent ?? createFileSkillDeletionContentStore(fsOpts.appHome, db)
    const plan = content.plan({
      skillId: op.skillId,
      operationId: op.opId,
      recordedBackupRef: op.backupPath,
    })
    await content.discard(plan)
  },
}

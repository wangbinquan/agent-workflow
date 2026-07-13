// RFC-170 §6a/T7② — boot recovery for a crashed `version-write` op.
//
// Forward (in commitSkillVersion): intent(lock) → fs-staged(build op-scoped
// staged) → fs-versioned(materialize versions/v<target>) → db-committed(bump
// content_version + INSERT skill_versions, same tx) → fs-published(swapInStaged) →
// done. The staged dir + version dir paths ride in the op columns (stagingPath,
// candidatePath) so recovery needs no path recomputation. Recovery:
//   phase < db-committed → rollback: the version was never committed → discard the
//     staged tree + the orphan versions/v<target> (nothing references them).
//   phase ≥ db-committed → rollforward: the version row is durable. There is no FS
//     work here — the driver finishes the op (frees the lock) and the boot-time
//     reconcileSkillLiveFiles() re-syncs live files/ from versions/v{cur} if the
//     publish didn't complete. We just drop any leftover staged dir.

import { rmSync } from 'node:fs'
import type { SkillOperationRow } from '@/services/skillOperations'
import type { OpRecoveryHandler, SkillOpFsOptions } from '@/services/skillOpRecoveryDriver'

export const versionWriteRecoveryHandler: OpRecoveryHandler = {
  rollbackFs: (_fsOpts: SkillOpFsOptions, op: SkillOperationRow) => {
    if (op.stagingPath) rmSync(op.stagingPath, { recursive: true, force: true })
    if (op.candidatePath) rmSync(op.candidatePath, { recursive: true, force: true })
  },
  rollForwardFs: (_fsOpts: SkillOpFsOptions, op: SkillOperationRow) => {
    // Version is committed; live is re-synced by reconcileSkillLiveFiles at boot.
    // Just drop the leftover staged dir (candidate/version dir stays — it's the row's).
    if (op.stagingPath) rmSync(op.stagingPath, { recursive: true, force: true })
  },
}

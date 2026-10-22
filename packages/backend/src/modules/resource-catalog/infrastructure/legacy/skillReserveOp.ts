// RFC-170 §9/§6a — boot recovery for a crashed `reserve` (creation) op.
//
// Forward (in createManagedSkill): intent(insert 'reserving' row + lock) →
// fs-staged(write SKILL.md) → fs-published(commitSkillVersion v1) →
// db-committed(flip to 'ready') → done. The reserving row is invisible to
// getSkill/list until 'ready', so a crash mid-create never surfaces a partial
// skill. Recovery:
//   phase < db-committed → rollback: the create never became visible → drop the
//     reserving row + its files (nothing depended on it).
//   phase ≥ db-committed → rollforward: 'ready' was set → ensure it (idempotent)
//     and finish. The skill is a complete, published skill.

import { tablesOf } from '@/platform/persistence/sessionTables'
import { rmSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { SkillOperationRow } from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import type {
  OpRecoveryHandler,
  SkillOpFsOptions,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'
import {
  decodeSkillOperationIdentity,
  legacySkillRootAbs,
  skillRootAbs,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'

export const reserveRecoveryHandler: OpRecoveryHandler = {
  // phase < db-committed: discard the never-published files.
  rollbackFs: async (fsOpts: SkillOpFsOptions, op: SkillOperationRow) => {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    if (fsOpts.creationContent) {
      await fsOpts.creationContent.discard(fsOpts.creationContent.plan(identity.skillId))
      return
    }
    const root =
      identity.legacyName === undefined
        ? skillRootAbs(fsOpts.appHome, identity.skillId)
        : legacySkillRootAbs(fsOpts.appHome, identity.legacyName)
    rmSync(root, { recursive: true, force: true })
  },
  recoverDb: async (tx: PersistenceTx, op: SkillOperationRow, dir: 'rollback' | 'rollforward') => {
    if (dir === 'rollback') {
      const { skills } = tablesOf(tx)
      // Drop the reserving row (the create never completed).
      await tx.delete(skills).where(eq(skills.id, op.skillId))
    } else {
      const { skills } = tablesOf(tx)
      // 'ready' should already be set in the db-committed tx; make sure of it.
      await tx.update(skills).set({ reservationState: 'ready' }).where(eq(skills.id, op.skillId))
    }
  },
}

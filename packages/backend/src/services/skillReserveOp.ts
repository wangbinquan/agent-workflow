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

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { skills } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { SkillOperationRow } from '@/services/skillOperations'
import type { OpRecoveryHandler, SkillOpFsOptions } from '@/services/skillOpRecoveryDriver'

interface ReservePrecondition {
  name: string
}

export const reserveRecoveryHandler: OpRecoveryHandler = {
  // phase < db-committed: discard the never-published files.
  rollbackFs: (fsOpts: SkillOpFsOptions, op: SkillOperationRow) => {
    if (!op.preconditionJson) return
    const { name } = JSON.parse(op.preconditionJson) as ReservePrecondition
    rmSync(join(fsOpts.appHome, 'skills', name), { recursive: true, force: true })
  },
  recoverDb: (tx: DbTxSync, op: SkillOperationRow, dir: 'rollback' | 'rollforward') => {
    if (dir === 'rollback') {
      // Drop the reserving row (the create never completed).
      tx.delete(skills).where(eq(skills.id, op.skillId)).run()
    } else {
      // 'ready' should already be set in the db-committed tx; make sure of it.
      tx.update(skills).set({ reservationState: 'ready' }).where(eq(skills.id, op.skillId)).run()
    }
  },
}

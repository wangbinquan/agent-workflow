// RFC-170 §6a/T7② — boot recovery for a crashed `version-write` op.
//
// Forward (in commitSkillVersion): intent(lock) → fs-staged(build op-scoped
// staged) → fs-versioned(materialize versions/v<target>) → db-committed(bump
// content_version + INSERT skill_versions, same tx) → fs-published(swapInStaged) →
// done. The staged dir + version dir paths ride in the op columns (stagingPath,
// candidatePath) so recovery needs no path recomputation. Recovery:
//   phase < db-committed → rollback: the version was never committed → discard the
//     staged tree + the orphan versions/v<target> (nothing references them).
//   phase ≥ db-committed → rollforward: the version row is durable. Verify its
//     immutable version snapshot, finish/rebuild the two-rename live publish, and
//     only then remove exact op-scoped residue. The generic boot reconciler cannot
//     own this: it deliberately preserves an existing-but-stale live tree.

import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { skills, skillVersions } from '@/db/schema'
import type { SkillOperationRow } from './skillOperations'
import type { OpRecoveryHandler, SkillOpFsOptions } from './skillOpRecoveryDriver'
import { decodeSkillOperationIdentity } from './skillIdentityPaths'
import type {
  SkillVersionRecoveryContentStore,
  SkillVersionRecoveryPlan,
} from '../../application/skills/versionRecoveryContentStore'
import { createFileSkillVersionRecoveryContentStore } from '../local/fileSkillVersionRecoveryContentStore'

function selectedRecovery(fsOpts: SkillOpFsOptions, op: SkillOperationRow) {
  const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
  if (op.stagingPath === null)
    throw new Error(`version-write ${op.opId} is missing its staging path`)
  if (op.candidatePath === null)
    throw new Error(`version-write ${op.opId} is missing its candidate path`)
  if (op.targetVersion === null)
    throw new Error(
      `version-write ${op.opId} candidate path does not match its identity/phase payload`,
    )
  const content =
    fsOpts.versionRecovery ?? createFileSkillVersionRecoveryContentStore(fsOpts.appHome)
  const plan = content.plan({
    ...identity,
    operationId: op.opId,
    version: op.targetVersion,
    stagingReference: op.stagingPath,
    versionReference: op.candidatePath,
  })
  return { content, plan }
}

export const versionWriteRecoveryHandler: OpRecoveryHandler = {
  rollbackFs: async (fsOpts, op, db) => {
    const { content, plan } = selectedRecovery(fsOpts, op)
    await assertVersionRow(db, content, plan, op, false)
    await content.rollback(plan)
  },
  rollForwardFs: async (fsOpts, op, db) => {
    const { content, plan } = selectedRecovery(fsOpts, op)
    const committed = await assertVersionRow(db, content, plan, op, true)
    await content.rollForward(plan, committed.contentHash)
  },
}

async function assertVersionRow(
  db: ProviderNeutralDatabase,
  content: SkillVersionRecoveryContentStore,
  plan: SkillVersionRecoveryPlan,
  op: SkillOperationRow,
  expected: boolean,
): Promise<{ contentHash: string }> {
  if (op.targetVersion === null) {
    throw new Error(`version-write ${op.opId} has no target version`)
  }
  const row = (
    await db
      .select({
        contentHash: skillVersions.contentHash,
        filesPath: skillVersions.filesPath,
      })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, op.skillId),
          eq(skillVersions.versionIndex, op.targetVersion),
        ),
      )
      .limit(1)
  )[0]
  if ((row !== undefined) !== expected) {
    throw new Error(`version-write ${op.opId} phase disagrees with target version authority`)
  }
  if (row === undefined) return { contentHash: '' }
  const skill = (
    await db
      .select({ contentVersion: skills.contentVersion })
      .from(skills)
      .where(eq(skills.id, op.skillId))
      .limit(1)
  )[0]
  if (skill?.contentVersion !== op.targetVersion) {
    throw new Error(`version-write ${op.opId} target is not the skill's current committed version`)
  }
  if (!content.matchesVersionReference(plan, row.filesPath)) {
    throw new Error(`version-write ${op.opId} target row files_path does not match its candidate`)
  }
  if (row.contentHash === null) {
    throw new Error(`version-write ${op.opId} target version has no content fingerprint`)
  }
  return { contentHash: row.contentHash }
}

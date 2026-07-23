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

import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { relative } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { skills, skillVersions } from '@/db/schema'
import type { SkillOperationRow } from '@/services/skillOperations'
import type { OpRecoveryHandler, SkillOpFsOptions } from '@/services/skillOpRecoveryDriver'
import {
  decodeSkillOperationIdentity,
  realDirectoryChainState,
  rebaseSkillOperationPath,
  skillRootAbs,
} from '@/services/skillIdentityPaths'
import {
  cleanupOpDirs,
  opBackupDir,
  restoreFromBackup,
  swapInStaged,
} from '@/services/skillFsPublish'
import { hashRegularFileTree } from '@/services/skillHash'

export const versionWriteRecoveryHandler: OpRecoveryHandler = {
  rollbackFs: (fsOpts: SkillOpFsOptions, op: SkillOperationRow, db: DbClient) => {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const key = identity.legacyName ?? identity.skillId
    const staging = requireStagingOpPath(fsOpts.appHome, op.stagingPath, key, op)
    const candidate = requireCandidateOpPath(fsOpts.appHome, op.candidatePath, key, op)
    assertVersionRow(db, fsOpts.appHome, key, candidate, op, false)
    const root = skillRootAbs(fsOpts.appHome, key)
    const filesDir = joinFilesRoot(fsOpts.appHome, key)
    assertRealDirectory(root, root, op, 'skill root')
    const candidateExists = assertRealDirectoryIfPresent(root, candidate, op, 'version candidate')
    assertRealDirectoryIfPresent(root, staging.path, op, 'staged tree')
    const backupExists = assertRealDirectoryIfPresent(
      root,
      opBackupDir(filesDir, staging.publishId),
      op,
      'backup tree',
    )
    assertRealDirectoryIfPresent(root, filesDir, op, 'canonical live tree')
    if (backupExists) {
      restoreFromBackup(filesDir, staging.publishId)
    }
    if (!assertRealDirectoryIfPresent(root, filesDir, op, 'canonical live tree')) {
      throw new Error(`version-write ${op.opId} rollback cannot prove a canonical live tree`)
    }
    cleanupOpDirs(filesDir, staging.publishId)
    if (candidateExists) rmSync(candidate, { recursive: true, force: true })
  },
  rollForwardFs: (fsOpts: SkillOpFsOptions, op: SkillOperationRow, db: DbClient) => {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const key = identity.legacyName ?? identity.skillId
    const staging = requireStagingOpPath(fsOpts.appHome, op.stagingPath, key, op)
    const candidate = requireCandidateOpPath(fsOpts.appHome, op.candidatePath, key, op)
    const committed = assertVersionRow(db, fsOpts.appHome, key, candidate, op, true)
    const root = skillRootAbs(fsOpts.appHome, key)
    assertRealDirectory(root, root, op, 'skill root')
    assertRealDirectory(root, candidate, op, 'version candidate')
    const stagingExists = assertRealDirectoryIfPresent(root, staging.path, op, 'staged tree')
    const filesDir = joinFilesRoot(fsOpts.appHome, key)
    const liveExists = assertRealDirectoryIfPresent(root, filesDir, op, 'canonical live tree')
    assertRealDirectoryIfPresent(root, opBackupDir(filesDir, staging.publishId), op, 'backup tree')
    assertTreeFingerprint(root, candidate, committed.contentHash, op, 'version snapshot')

    if (stagingExists) {
      assertTreeFingerprint(root, staging.path, committed.contentHash, op, 'staged tree')
    } else if (!liveExists || hashRegularFileTree(filesDir) !== committed.contentHash) {
      // A crash can land before publish, between files→backup and staged→files,
      // or after an earlier recovery lost its staged directory. The committed,
      // fingerprint-verified version snapshot is the durable source of truth.
      mkdirSync(skillRootAbs(fsOpts.appHome, key), { recursive: true })
      cpSync(candidate, staging.path, { recursive: true })
      assertRealDirectory(root, staging.path, op, 'rebuilt staged tree')
    }

    if (assertRealDirectoryIfPresent(root, staging.path, op, 'staged tree')) {
      swapInStaged(filesDir, staging.publishId)
    }
    assertTreeFingerprint(root, filesDir, committed.contentHash, op, 'canonical live tree')
    cleanupOpDirs(filesDir, staging.publishId)
  },
}

function requireStagingOpPath(
  appHome: string,
  storedPath: string | null,
  key: string,
  op: SkillOperationRow,
): { path: string; publishId: string } {
  if (storedPath === null) {
    throw new Error(`version-write ${op.opId} is missing its staging path`)
  }
  const rebased = rebaseSkillOperationPath(appHome, storedPath, key)
  const rel = relative(skillRootAbs(appHome, key), rebased).replaceAll('\\', '/')
  const match = /^files\.op-([0-9A-HJKMNP-TV-Z]{26})\.staged$/.exec(rel)
  if (match === null) {
    throw new Error(
      `version-write ${op.opId} staging path does not match its identity/phase payload`,
    )
  }
  return { path: rebased, publishId: match[1] as string }
}

function requireCandidateOpPath(
  appHome: string,
  storedPath: string | null,
  key: string,
  op: SkillOperationRow,
): string {
  if (storedPath === null) {
    throw new Error(`version-write ${op.opId} is missing its candidate path`)
  }
  const rebased = rebaseSkillOperationPath(appHome, storedPath, key)
  const rel = relative(skillRootAbs(appHome, key), rebased).replaceAll('\\', '/')
  if (op.targetVersion === null || rel !== `versions/v${op.targetVersion}/files`) {
    throw new Error(
      `version-write ${op.opId} candidate path does not match its identity/phase payload`,
    )
  }
  return rebased
}

function joinFilesRoot(appHome: string, key: string): string {
  return `${skillRootAbs(appHome, key)}/files`
}

function assertVersionRow(
  db: DbClient,
  appHome: string,
  key: string,
  candidate: string,
  op: SkillOperationRow,
  expected: boolean,
): { contentHash: string } {
  if (op.targetVersion === null) {
    throw new Error(`version-write ${op.opId} has no target version`)
  }
  const row = db
    .select({
      contentHash: skillVersions.contentHash,
      filesPath: skillVersions.filesPath,
    })
    .from(skillVersions)
    .where(
      and(eq(skillVersions.skillId, op.skillId), eq(skillVersions.versionIndex, op.targetVersion)),
    )
    .get()
  if ((row !== undefined) !== expected) {
    throw new Error(`version-write ${op.opId} phase disagrees with target version authority`)
  }
  if (row === undefined) return { contentHash: '' }
  const skill = db
    .select({ contentVersion: skills.contentVersion })
    .from(skills)
    .where(eq(skills.id, op.skillId))
    .get()
  if (skill?.contentVersion !== op.targetVersion) {
    throw new Error(`version-write ${op.opId} target is not the skill's current committed version`)
  }
  if (rebaseSkillOperationPath(appHome, row.filesPath, key) !== candidate) {
    throw new Error(`version-write ${op.opId} target row files_path does not match its candidate`)
  }
  if (row.contentHash === null) {
    throw new Error(`version-write ${op.opId} target version has no content fingerprint`)
  }
  return { contentHash: row.contentHash }
}

function assertTreeFingerprint(
  root: string,
  path: string,
  expected: string,
  op: SkillOperationRow,
  label: string,
): void {
  if (
    !assertRealDirectoryIfPresent(root, path, op, label) ||
    hashRegularFileTree(path) !== expected
  ) {
    throw new Error(`version-write ${op.opId} ${label} does not match committed content hash`)
  }
}

function assertRealDirectory(
  root: string,
  path: string,
  op: SkillOperationRow,
  label: string,
): void {
  if (!assertRealDirectoryIfPresent(root, path, op, label)) {
    throw new Error(`version-write ${op.opId} ${label} is missing or not a real directory`)
  }
}

function assertRealDirectoryIfPresent(
  root: string,
  path: string,
  op: SkillOperationRow,
  label: string,
): boolean {
  try {
    return realDirectoryChainState(root, path) === 'real-directory'
  } catch (err) {
    throw new Error(`version-write ${op.opId} ${label} is not a real directory`, { cause: err })
  }
}

import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { relative } from 'node:path'
import type { SkillVersionRecoveryContentStore } from '../../application/skills/versionRecoveryContentStore'
import {
  realDirectoryChainState,
  rebaseSkillOperationPath,
  skillRootAbs,
} from '../legacy/skillIdentityPaths'
import {
  cleanupOpDirs,
  opBackupDir,
  restoreFromBackup,
  swapInStaged,
} from '../legacy/skillFsPublish'
import { hashRegularFileTree } from '../legacy/skillHash'

type RecoveryOperation = { readonly opId: string; readonly targetVersion: number }

/** Original op-scoped rollback and committed snapshot republish effects. */
export function createFileSkillVersionRecoveryContentStore(
  appHome: string,
): SkillVersionRecoveryContentStore {
  return Object.freeze({
    plan(input) {
      const key = input.legacyName ?? input.skillId
      const op = { opId: input.operationId, targetVersion: input.version }
      const staging = requireStagingOpPath(appHome, input.stagingReference, key, op)
      const candidate = requireCandidateOpPath(appHome, input.versionReference, key, op)
      return {
        skillId: input.skillId,
        operationId: input.operationId,
        version: input.version,
        publicationId: staging.publishId,
        rootRef: skillRootAbs(appHome, key),
        liveRef: joinFilesRoot(appHome, key),
        stagingRef: staging.path,
        versionRef: candidate,
      }
    },
    matchesVersionReference(plan, reference) {
      const key = relative(`${appHome}/skills`, plan.rootRef).replaceAll('\\', '/')
      return rebaseSkillOperationPath(appHome, reference, key) === plan.versionRef
    },
    rollback(plan) {
      const op = { opId: plan.operationId, targetVersion: plan.version }
      const root = plan.rootRef
      const filesDir = plan.liveRef
      assertRealDirectory(root, root, op, 'skill root')
      const candidateExists = assertRealDirectoryIfPresent(
        root,
        plan.versionRef,
        op,
        'version candidate',
      )
      assertRealDirectoryIfPresent(root, plan.stagingRef, op, 'staged tree')
      const backupExists = assertRealDirectoryIfPresent(
        root,
        opBackupDir(filesDir, plan.publicationId),
        op,
        'backup tree',
      )
      assertRealDirectoryIfPresent(root, filesDir, op, 'canonical live tree')
      if (backupExists) {
        restoreFromBackup(filesDir, plan.publicationId)
      }
      if (!assertRealDirectoryIfPresent(root, filesDir, op, 'canonical live tree')) {
        throw new Error(`version-write ${op.opId} rollback cannot prove a canonical live tree`)
      }
      cleanupOpDirs(filesDir, plan.publicationId)
      if (candidateExists) rmSync(plan.versionRef, { recursive: true, force: true })
    },
    rollForward(plan, contentHash) {
      const op = { opId: plan.operationId, targetVersion: plan.version }
      const root = plan.rootRef
      assertRealDirectory(root, root, op, 'skill root')
      assertRealDirectory(root, plan.versionRef, op, 'version candidate')
      const stagingExists = assertRealDirectoryIfPresent(root, plan.stagingRef, op, 'staged tree')
      const filesDir = plan.liveRef
      const liveExists = assertRealDirectoryIfPresent(root, filesDir, op, 'canonical live tree')
      assertRealDirectoryIfPresent(
        root,
        opBackupDir(filesDir, plan.publicationId),
        op,
        'backup tree',
      )
      assertTreeFingerprint(root, plan.versionRef, contentHash, op, 'version snapshot')

      if (stagingExists) {
        assertTreeFingerprint(root, plan.stagingRef, contentHash, op, 'staged tree')
      } else if (!liveExists || hashRegularFileTree(filesDir) !== contentHash) {
        // A crash can land before publish, between files→backup and staged→files,
        // or after an earlier recovery lost its staged directory. The committed,
        // fingerprint-verified version snapshot is the durable source of truth.
        mkdirSync(plan.rootRef, { recursive: true })
        cpSync(plan.versionRef, plan.stagingRef, { recursive: true })
        assertRealDirectory(root, plan.stagingRef, op, 'rebuilt staged tree')
      }

      if (assertRealDirectoryIfPresent(root, plan.stagingRef, op, 'staged tree')) {
        swapInStaged(filesDir, plan.publicationId)
      }
      assertTreeFingerprint(root, filesDir, contentHash, op, 'canonical live tree')
      cleanupOpDirs(filesDir, plan.publicationId)
    },
  } satisfies SkillVersionRecoveryContentStore)
}

function requireStagingOpPath(
  appHome: string,
  storedPath: string | null,
  key: string,
  op: RecoveryOperation,
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
  op: RecoveryOperation,
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

function assertTreeFingerprint(
  root: string,
  path: string,
  expected: string,
  op: RecoveryOperation,
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
  op: RecoveryOperation,
  label: string,
): void {
  if (!assertRealDirectoryIfPresent(root, path, op, label)) {
    throw new Error(`version-write ${op.opId} ${label} is missing or not a real directory`)
  }
}

function assertRealDirectoryIfPresent(
  root: string,
  path: string,
  op: RecoveryOperation,
  label: string,
): boolean {
  try {
    return realDirectoryChainState(root, path) === 'real-directory'
  } catch (err) {
    throw new Error(`version-write ${op.opId} ${label} is not a real directory`, { cause: err })
  }
}

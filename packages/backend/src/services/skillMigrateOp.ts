// RFC-223 PR-5 — crash-safe skills/{name} -> skills/{id} migration operation.

import { closeSync, fsyncSync, lstatSync, openSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { skills, skillVersions } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { fingerprintTree } from '@/services/skillHash'
import {
  legacySkillRootAbs,
  skillFilesRel,
  skillRootAbs,
  skillVersionRelPath,
} from '@/services/skillIdentityPaths'
import {
  advancePhase,
  beginOperation,
  finishOperation,
  type SkillOperationRow,
} from '@/services/skillOperations'
import type { OpRecoveryHandler, SkillOpFsOptions } from '@/services/skillOpRecoveryDriver'
import { ValidationError } from '@/util/errors'

export interface SkillIdentityMigrationHooks {
  afterPhase?: (
    phase: 'intent' | 'fs-moved' | 'fs-staged' | 'db-committed' | 'done',
    skillId: string,
  ) => void
}

interface MigratePrecondition {
  skillId: string
  legacyName: string
}

export function migrateSkillIdentityOp(
  db: DbClient,
  fsOpts: SkillOpFsOptions,
  skill: { id: string; name: string },
  hooks: SkillIdentityMigrationHooks = {},
): void {
  const oldRoot = legacySkillRootAbs(fsOpts.appHome, skill.name)
  const newRoot = skillRootAbs(fsOpts.appHome, skill.id)
  const samePath = oldRoot === newRoot || pathsShareEntry(oldRoot, newRoot)
  const fingerprint = requireMigrationRoot(oldRoot, newRoot, 'legacy', null)
  const opId = dbTxSync(db, (tx) =>
    beginOperation(tx, {
      skillId: skill.id,
      kind: 'migrate',
      candidateFingerprint: fingerprint,
      preconditionJson: JSON.stringify({
        skillId: skill.id,
        legacyName: skill.name,
      } satisfies MigratePrecondition),
    }),
  )
  hooks.afterPhase?.('intent', skill.id)

  if (!samePath) renameAndSyncParent(oldRoot, newRoot)
  requireMigrationRoot(oldRoot, newRoot, 'canonical', fingerprint)
  hooks.afterPhase?.('fs-moved', skill.id)
  dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))
  hooks.afterPhase?.('fs-staged', skill.id)

  dbTxSync(db, (tx) => {
    writeCanonicalPaths(tx, skill.id)
    advancePhase(tx, opId, 'db-committed')
  })
  hooks.afterPhase?.('db-committed', skill.id)

  dbTxSync(db, (tx) => finishOperation(tx, opId))
  hooks.afterPhase?.('done', skill.id)
}

export const migrateRecoveryHandler: OpRecoveryHandler = {
  rollbackFs: (fsOpts, op) => {
    const identity = decodeMigratePrecondition(op)
    const oldRoot = legacySkillRootAbs(fsOpts.appHome, identity.legacyName)
    const newRoot = skillRootAbs(fsOpts.appHome, identity.skillId)
    if (oldRoot === newRoot || pathsShareEntry(oldRoot, newRoot)) {
      requireMigrationRoot(oldRoot, newRoot, 'legacy', op.candidateFingerprint)
      return
    }
    const state = rootState(oldRoot, newRoot)
    if (state === 'legacy') {
      requireMigrationRoot(oldRoot, newRoot, 'legacy', op.candidateFingerprint)
      return
    }
    if (state === 'canonical') {
      requireMigrationRoot(oldRoot, newRoot, 'canonical', op.candidateFingerprint)
      renameAndSyncParent(newRoot, oldRoot)
      requireMigrationRoot(oldRoot, newRoot, 'legacy', op.candidateFingerprint)
      return
    }
    throw migrationRootError(state)
  },
  rollForwardFs: (fsOpts, op) => {
    const identity = decodeMigratePrecondition(op)
    const oldRoot = legacySkillRootAbs(fsOpts.appHome, identity.legacyName)
    const newRoot = skillRootAbs(fsOpts.appHome, identity.skillId)
    requireMigrationRoot(oldRoot, newRoot, 'canonical', op.candidateFingerprint)
  },
  recoverDb: (tx, op, dir) => {
    if (dir === 'rollforward') writeCanonicalPaths(tx, op.skillId)
  },
}

function writeCanonicalPaths(tx: DbTxSync, skillId: string): void {
  const rows = tx
    .select({ versionIndex: skillVersions.versionIndex })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .all()
  tx.update(skills)
    .set({ managedPath: skillFilesRel(skillId) })
    .where(eq(skills.id, skillId))
    .run()
  for (const row of rows) {
    tx.update(skillVersions)
      .set({ filesPath: skillVersionRelPath(skillId, row.versionIndex) })
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.versionIndex, row.versionIndex),
        ),
      )
      .run()
  }
}

export function decodeMigratePrecondition(op: SkillOperationRow): MigratePrecondition {
  if (
    op.candidateFingerprint === null ||
    !/^[0-9a-f]{64}$/.test(op.candidateFingerprint)
  ) {
    throw new ValidationError(
      'skill-migration-fingerprint-invalid',
      `migrate operation ${op.opId} has no valid source fingerprint`,
    )
  }
  let parsed: unknown
  try {
    parsed = op.preconditionJson === null ? null : JSON.parse(op.preconditionJson)
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(
      'skill-migration-payload-invalid',
      `migrate operation ${op.opId} has no valid identity payload`,
    )
  }
  const obj = parsed as Record<string, unknown>
  if (
    Object.keys(obj).length !== 2 ||
    typeof obj.skillId !== 'string' ||
    obj.skillId !== op.skillId ||
    typeof obj.legacyName !== 'string' ||
    obj.legacyName.length === 0
  ) {
    throw new ValidationError(
      'skill-migration-payload-invalid',
      `migrate operation ${op.opId} identity does not match skill_id`,
    )
  }
  // The path helpers validate both values as single safe path segments.
  skillRootAbs('/', obj.skillId)
  legacySkillRootAbs('/', obj.legacyName)
  return { skillId: obj.skillId, legacyName: obj.legacyName }
}

type RootState = 'legacy' | 'canonical' | 'both' | 'missing'

function rootState(oldRoot: string, newRoot: string): RootState {
  if (oldRoot === newRoot || pathsShareEntry(oldRoot, newRoot)) {
    return pathEntryExists(oldRoot) ? 'canonical' : 'missing'
  }
  const oldExists = pathEntryExists(oldRoot)
  const newExists = pathEntryExists(newRoot)
  if (oldExists && newExists) return 'both'
  if (oldExists) return 'legacy'
  if (newExists) return 'canonical'
  return 'missing'
}

function requireMigrationRoot(
  oldRoot: string,
  newRoot: string,
  expected: 'legacy' | 'canonical',
  fingerprint: string | null,
): string {
  if (oldRoot === newRoot || pathsShareEntry(oldRoot, newRoot)) {
    if (!pathEntryExists(oldRoot)) throw migrationRootError('missing')
    assertRealDirectory(oldRoot)
    const actual = fingerprintTree(oldRoot)
    if (fingerprint !== null && actual !== fingerprint) {
      throw new ValidationError(
        'skill-migration-fingerprint-mismatch',
        'skill directory changed while its identity migration was in flight',
      )
    }
    return actual
  }
  const state = rootState(oldRoot, newRoot)
  if (state !== expected) throw migrationRootError(state)
  const root = expected === 'legacy' ? oldRoot : newRoot
  assertRealDirectory(root)
  const actual = fingerprintTree(root)
  if (fingerprint !== null && actual !== fingerprint) {
    throw new ValidationError(
      'skill-migration-fingerprint-mismatch',
      'skill directory changed while its identity migration was in flight',
    )
  }
  return actual
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function pathsShareEntry(a: string, b: string): boolean {
  if (a === b) return pathEntryExists(a)
  try {
    const left = lstatSync(a)
    const right = lstatSync(b)
    return left.dev === right.dev && left.ino === right.ino
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function assertRealDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ValidationError(
      'skill-migration-root-invalid',
      `skill migration root is not a real directory: ${path}`,
    )
  }
}

function migrationRootError(state: RootState): ValidationError {
  return new ValidationError(
    state === 'both' ? 'skill-migration-root-collision' : 'skill-migration-root-missing',
    state === 'both'
      ? 'both legacy-name and canonical-id skill directories exist'
      : 'neither the expected legacy-name nor canonical-id skill directory exists',
  )
}

function renameAndSyncParent(from: string, to: string): void {
  renameSync(from, to)
  // The two roots are siblings. Persist the directory entry update before the
  // following phase commit so a power loss cannot leave SQLite claiming
  // fs-staged while the rename only lived in the filesystem cache.
  const parent = dirname(to)
  const fd = openSync(parent, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

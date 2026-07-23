// RFC-170 §6a — the `delete` structural op (crash-safe managed-skill deletion).
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

import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { skills } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  abandonOperation,
  advancePhase,
  beginOperation,
  finishOperation,
} from '@/services/skillOperations'
import type { SkillOperationRow } from '@/services/skillOperations'
import type { OpRecoveryHandler, SkillOpFsOptions } from '@/services/skillOpRecoveryDriver'
import {
  decodeSkillOperationIdentity,
  legacySkillRootAbs,
  rebaseSkillOperationPath,
  skillRootAbs,
} from '@/services/skillIdentityPaths'
import { ConflictError } from '@/util/errors'
function trashPath(appHome: string, skillId: string, opId: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(opId)) {
    throw new Error(`delete operation has invalid op_id: ${opId}`)
  }
  return join(appHome, 'skills', '.trash', `${skillId}-${opId}`)
}

export interface SkillDeleteOpHooks {
  afterPhase?: (phase: 'intent' | 'fs-staged' | 'db-committed', skillId: string) => void
}

export interface SkillDeleteFence {
  skillId: string
  contentVersion: number
  metaRevision: number
  ownerUserId: string | null
  aclRevision: number
}

/**
 * Delete a MANAGED skill through the crash-safe op lifecycle. Locks the skill
 * for the duration (concurrent version-write/replace/etc. → busy 409). The row
 * DELETE and the phase='db-committed' advance share one tx (§6a ③).
 */
export function deleteManagedSkillOp(
  db: DbClient,
  fsOpts: SkillOpFsOptions,
  skill: { id: string },
  hooks: SkillDeleteOpHooks = {},
  expected?: SkillDeleteFence,
): void {
  const root = skillRootAbs(fsOpts.appHome, skill.id)

  // ① intent (+lock) — durably record before any FS side effect.
  const opId = dbTxSync(db, (tx) => {
    if (expected !== undefined) assertDeleteFence(tx, skill.id, expected)
    return beginOperation(tx, {
      skillId: skill.id,
      kind: 'delete',
      preconditionJson: JSON.stringify({ skillId: skill.id }),
    })
  })
  const trash = trashPath(fsOpts.appHome, skill.id, opId)
  hooks.afterPhase?.('intent', skill.id)

  let committed = false
  try {
    // ② fs-staged — move the whole root aside (reversible). Ensure the .trash
    // parent exists so the rename can't ENOENT.
    if (pathEntryExists(root)) {
      mkdirSync(dirname(trash), { recursive: true })
      renameSync(root, trash)
    }
    dbTxSync(db, (tx) =>
      advancePhase(tx, opId, 'fs-staged', {
        backupPath: relative(fsOpts.appHome, trash),
      }),
    )
    hooks.afterPhase?.('fs-staged', skill.id)

    // ③ db-committed — DELETE row + advance phase, one tx.
    dbTxSync(db, (tx) => {
      if (expected !== undefined) assertDeleteFence(tx, skill.id, expected)
      tx.delete(skills).where(eq(skills.id, skill.id)).run()
      advancePhase(tx, opId, 'db-committed')
    })
    committed = true
    hooks.afterPhase?.('db-committed', skill.id)

    // done — drop the trash, release the lock.
    rmSync(trash, { recursive: true, force: true })
    dbTxSync(db, (tx) => finishOperation(tx, opId))
  } catch (err) {
    // Once DELETE + db-committed is durable, NEVER restore the root or retire the
    // evidence. The barrier owns roll-forward and keeps the lock until trash is
    // gone. Only a proven pre-commit rollback may abandon the op.
    if (!committed) {
      try {
        const rootExists = pathEntryExists(root)
        const trashExists = pathEntryExists(trash)
        if (rootExists && trashExists) {
          throw new Error(`delete rollback collision for skill ${skill.id}`)
        }
        if (!rootExists && !trashExists) {
          throw new Error(`delete rollback lost both root and trash for skill ${skill.id}`)
        }
        if (trashExists) renameSync(trash, root)
        dbTxSync(db, (tx) => abandonOperation(tx, opId))
      } catch {
        // Preserve the active op + lock when rollback itself cannot be proven.
      }
    }
    throw err
  }
}

function assertDeleteFence(tx: DbTxSync, skillId: string, expected: SkillDeleteFence): void {
  const live = tx
    .select({
      id: skills.id,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
      ownerUserId: skills.ownerUserId,
      aclRevision: skills.aclRevision,
    })
    .from(skills)
    .where(eq(skills.id, skillId))
    .get()
  if (
    live === undefined ||
    live.id !== expected.skillId ||
    live.contentVersion !== expected.contentVersion ||
    live.metaRevision !== expected.metaRevision ||
    live.ownerUserId !== expected.ownerUserId ||
    live.aclRevision !== expected.aclRevision
  ) {
    throw new ConflictError(
      'skill-version-conflict',
      `skill '${skillId}' changed since this operation started; reload and retry`,
    )
  }
}

/** §6a recovery for a crashed `delete` op (registered into the boot driver). */
export const deleteRecoveryHandler: OpRecoveryHandler = {
  // phase < db-committed: the row still exists; restore the root from trash.
  rollbackFs: (fsOpts: SkillOpFsOptions, op: SkillOperationRow) => {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const root =
      identity.legacyName === undefined
        ? skillRootAbs(fsOpts.appHome, identity.skillId)
        : legacySkillRootAbs(fsOpts.appHome, identity.legacyName)
    const backup = trashPath(fsOpts.appHome, op.skillId, op.opId)
    assertDeleteBackupPath(fsOpts.appHome, op, backup)
    const rootExists = pathEntryExists(root)
    const backupExists = pathEntryExists(backup)
    if (rootExists && backupExists) {
      throw new Error(`delete recovery collision for skill ${op.skillId}`)
    }
    if (!rootExists && !backupExists) {
      throw new Error(`delete recovery lost both root and trash for skill ${op.skillId}`)
    }
    if (backupExists) renameSync(backup, root)
  },
  // phase ≥ db-committed: the row is gone; the root is no longer needed.
  rollForwardFs: (fsOpts: SkillOpFsOptions, op: SkillOperationRow) => {
    const backup = trashPath(fsOpts.appHome, op.skillId, op.opId)
    assertDeleteBackupPath(fsOpts.appHome, op, backup)
    rmSync(backup, { recursive: true, force: true })
  },
}

function assertDeleteBackupPath(appHome: string, op: SkillOperationRow, expected: string): void {
  // intent can legitimately predate the rename/backupPath phase patch.
  if (op.backupPath === null) return
  const rebased = rebaseSkillOperationPath(appHome, op.backupPath, '.trash')
  if (rebased !== expected) {
    throw new Error(`delete operation ${op.opId} backup path does not match its op identity`)
  }
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

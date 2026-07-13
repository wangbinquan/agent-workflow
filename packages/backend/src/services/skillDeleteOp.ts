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

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { skills } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import {
  abandonOperation,
  advancePhase,
  beginOperation,
  finishOperation,
} from '@/services/skillOperations'
import type { SkillOperationRow } from '@/services/skillOperations'
import type { OpRecoveryHandler, SkillOpFsOptions } from '@/services/skillOpRecoveryDriver'

interface DeletePrecondition {
  name: string
}

function skillRootPath(appHome: string, name: string): string {
  return join(appHome, 'skills', name)
}
function trashPath(appHome: string, skillId: string, opId: string): string {
  return join(appHome, 'skills', '.trash', `${skillId}-${opId}`)
}

/**
 * Delete a MANAGED skill through the crash-safe op lifecycle. Locks the skill
 * for the duration (concurrent version-write/replace/etc. → busy 409). The row
 * DELETE and the phase='db-committed' advance share one tx (§6a ③).
 */
export function deleteManagedSkillOp(
  db: DbClient,
  fsOpts: SkillOpFsOptions,
  skill: { id: string; name: string },
): void {
  const root = skillRootPath(fsOpts.appHome, skill.name)

  // ① intent (+lock) — durably record before any FS side effect.
  const opId = dbTxSync(db, (tx) =>
    beginOperation(tx, {
      skillId: skill.id,
      kind: 'delete',
      preconditionJson: JSON.stringify({ name: skill.name } satisfies DeletePrecondition),
    }),
  )
  const trash = trashPath(fsOpts.appHome, skill.id, opId)

  try {
    // ② fs-staged — move the whole root aside (reversible). Ensure the .trash
    // parent exists so the rename can't ENOENT.
    if (existsSync(root)) {
      mkdirSync(dirname(trash), { recursive: true })
      renameSync(root, trash)
    }
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged', { backupPath: trash }))

    // ③ db-committed — DELETE row + advance phase, one tx.
    dbTxSync(db, (tx) => {
      tx.delete(skills).where(eq(skills.id, skill.id)).run()
      advancePhase(tx, opId, 'db-committed')
    })

    // done — drop the trash, release the lock.
    rmSync(trash, { recursive: true, force: true })
    dbTxSync(db, (tx) => finishOperation(tx, opId))
  } catch (err) {
    // Synchronous failure BEFORE db-committed → roll back: restore the root and
    // retire the op. (A crash — not an in-process throw — is handled by the boot
    // recovery driver via the same handler below.)
    try {
      if (existsSync(trash) && !existsSync(root)) renameSync(trash, root)
    } catch {
      /* leave trash for boot recovery */
    }
    dbTxSync(db, (tx) => abandonOperation(tx, opId))
    throw err
  }
}

/** §6a recovery for a crashed `delete` op (registered into the boot driver). */
export const deleteRecoveryHandler: OpRecoveryHandler = {
  // phase < db-committed: the row still exists; restore the root from trash.
  rollbackFs: (fsOpts: SkillOpFsOptions, op: SkillOperationRow) => {
    if (!op.backupPath || !op.preconditionJson) return
    const { name } = JSON.parse(op.preconditionJson) as DeletePrecondition
    const root = skillRootPath(fsOpts.appHome, name)
    if (existsSync(op.backupPath) && !existsSync(root)) renameSync(op.backupPath, root)
  },
  // phase ≥ db-committed: the row is gone; the root is no longer needed.
  rollForwardFs: (_fsOpts: SkillOpFsOptions, op: SkillOperationRow) => {
    if (op.backupPath) rmSync(op.backupPath, { recursive: true, force: true })
  },
}

// RFC-170 §6a/§13 — op-scoped FS staging + atomic publish primitives.
//
// The canonical live tree is a skill's `.../skills/{id}/files` directory. POSIX
// rename cannot atomically replace a NON-EMPTY directory, so "publish" is a pair
// of same-parent renames (each individually atomic); the window between them is
// disambiguated by the op's `phase` + these op-scoped, collision-free sibling
// names (G4-2): a probed directory's `op_id` in its name proves which op left it,
// killing the "backup exists but whose?" ambiguity.
//
//   staged    : {files}.op-{opId}.staged     (built tree, pre-publish)
//   backup    : {files}.op-{opId}.backup     (previous live, moved aside on swap)
//   candidate  : {files}.op-{opId}.candidate  (immutable capture/decision copy)
//
// swapInStaged = [rename files → backup (if present)] then [rename staged → files].
// A crash between the two leaves `files` absent + backup present → recovery's
// roll-forward re-runs swapInStaged (idempotent) or roll-back calls
// restoreFromBackup. Pure FS (no hashing / DB) so it stays a leaf module and
// callers fingerprint via the existing hashDir.

import { existsSync, renameSync, rmSync } from 'node:fs'

export type OpDirKind = 'staged' | 'backup' | 'candidate'

/** The op-scoped sibling path for a given kind (does not touch the FS). */
export function opScopedDir(filesDir: string, opId: string, kind: OpDirKind): string {
  return `${filesDir}.op-${opId}.${kind}`
}

export const opStagedDir = (filesDir: string, opId: string): string =>
  opScopedDir(filesDir, opId, 'staged')
export const opBackupDir = (filesDir: string, opId: string): string =>
  opScopedDir(filesDir, opId, 'backup')
export const opCandidateDir = (filesDir: string, opId: string): string =>
  opScopedDir(filesDir, opId, 'candidate')

/**
 * Atomically publish the op's staged tree as the canonical `files` dir. Moves any
 * existing live tree aside to the op-scoped backup FIRST (so it is never lost),
 * then renames staged → files. Idempotent-safe for roll-forward:
 *   - already published (staged gone, files present, no backup) → no-op;
 *   - files aside as backup, staged present → completes the second rename;
 *   - both present (crash mid-way is impossible for a single rename, but a prior
 *     partial run) → completes.
 * Returns whether a previous live tree existed (moved to backup, caller cleans it
 * up on `done`). Throws if neither staged nor an already-published files exists.
 */
export function swapInStaged(filesDir: string, opId: string): { hadPrevious: boolean } {
  const staged = opStagedDir(filesDir, opId)
  const backup = opBackupDir(filesDir, opId)
  const stagedExists = existsSync(staged)
  const filesExists = existsSync(filesDir)
  const backupExists = existsSync(backup)

  // Roll-forward idempotency: nothing staged but canonical already in place → the
  // publish already happened; report whether a backup (previous tree) is around.
  if (!stagedExists && filesExists) {
    return { hadPrevious: backupExists }
  }
  if (!stagedExists && !filesExists) {
    // Neither the built tree nor a published result exists — the caller must
    // recover the staged tree first (from candidate/version snapshot).
    throw new Error(`swapInStaged: no staged tree at ${staged} and no canonical ${filesDir}`)
  }

  // staged present → move current live aside (once), then swap staged in.
  let hadPrevious = backupExists
  if (filesExists) {
    // If a backup already exists from a partial prior run, the current `files` is
    // the half-published state; drop it rather than double-backup.
    if (backupExists) rmSync(filesDir, { recursive: true, force: true })
    else {
      renameSync(filesDir, backup)
      hadPrevious = true
    }
  }
  renameSync(staged, filesDir)
  return { hadPrevious }
}

/**
 * Roll-back: restore the previous live tree from the op's backup (undoing a
 * swapInStaged whose op never reached db-committed). Removes any half-published
 * `files` first. No-op if there is no backup.
 */
export function restoreFromBackup(filesDir: string, opId: string): boolean {
  const backup = opBackupDir(filesDir, opId)
  if (!existsSync(backup)) return false
  rmSync(filesDir, { recursive: true, force: true })
  renameSync(backup, filesDir)
  return true
}

/** Remove all op-scoped sibling dirs for this op (post-`done` / rollback cleanup). */
export function cleanupOpDirs(filesDir: string, opId: string): void {
  for (const kind of ['staged', 'backup', 'candidate'] as const) {
    rmSync(opScopedDir(filesDir, opId, kind), { recursive: true, force: true })
  }
}

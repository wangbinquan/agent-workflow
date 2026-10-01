import { closeSync, fsyncSync, lstatSync, openSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SkillIdentityContentStore } from '../../application/skills/identityContentStore'
import { fingerprintTree } from '../legacy/skillHash'
import { legacySkillRootAbs, skillRootAbs } from '../legacy/skillIdentityPaths'
import { ValidationError } from '@/util/errors'

/** Original sibling rename/fingerprint mechanism, shared by forward and recovery. */
export function createFileSkillIdentityContentStore(appHome: string): SkillIdentityContentStore {
  return {
    plan(identity) {
      return {
        ...identity,
        legacyRef: legacySkillRootAbs(appHome, identity.legacyName),
        canonicalRef: skillRootAbs(appHome, identity.skillId),
      }
    },
    captureSource(plan) {
      return requireMigrationRoot(plan.legacyRef, plan.canonicalRef, 'legacy', null)
    },
    move(plan, fingerprint) {
      const oldRoot = plan.legacyRef,
        newRoot = plan.canonicalRef
      if (oldRoot !== newRoot && !pathsShareEntry(oldRoot, newRoot))
        renameAndSyncParent(oldRoot, newRoot)
      requireMigrationRoot(oldRoot, newRoot, 'canonical', fingerprint)
    },
    rollback(plan, fingerprint) {
      const oldRoot = plan.legacyRef,
        newRoot = plan.canonicalRef
      if (oldRoot === newRoot || pathsShareEntry(oldRoot, newRoot)) {
        requireMigrationRoot(oldRoot, newRoot, 'legacy', fingerprint)
        return
      }
      const state = rootState(oldRoot, newRoot)
      if (state === 'legacy') {
        requireMigrationRoot(oldRoot, newRoot, 'legacy', fingerprint)
        return
      }
      if (state === 'canonical') {
        requireMigrationRoot(oldRoot, newRoot, 'canonical', fingerprint)
        renameAndSyncParent(newRoot, oldRoot)
        requireMigrationRoot(oldRoot, newRoot, 'legacy', fingerprint)
        return
      }
      throw migrationRootError(state)
    },
    rollForward(plan, fingerprint) {
      requireMigrationRoot(plan.legacyRef, plan.canonicalRef, 'canonical', fingerprint)
    },
  }
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
  //
  // RFC-254: best-effort — Windows (and some other platforms) reject fsync on a
  // directory fd with EPERM, and openSync of a directory can itself throw there.
  // The rename is atomic regardless, so tolerate a failed parent-dir sync rather
  // than aborting the whole migration (mirrors restore.ts `fsyncDir`). Without
  // this the RFC-223 skill-identity barrier — run on every boot and inside
  // restore's post-swap chain — dies on Windows before any skill can migrate.
  const parent = dirname(to)
  try {
    const fd = openSync(parent, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* best-effort durability — see comment above */
  }
}

// RFC-223 PR-5 — the single boot/restore barrier for skill identity migration.

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { Database } from 'bun:sqlite'
import type { DbClient } from '@/db/client'
import { skills, skillOperationLocks, skillVersions } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import {
  decodeSkillOperationIdentity,
  legacySkillRootAbs,
  realDirectoryChainState,
  rebaseSkillOperationPath,
  skillFilesAbs,
  skillFilesRel,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '@/services/skillIdentityPaths'
import { hashRegularFileTree } from '@/services/skillHash'
import {
  decodeMigratePrecondition,
  migrateSkillIdentityOp,
  type SkillIdentityMigrationHooks,
} from '@/services/skillMigrateOp'
import { SKILL_OP_RECOVERY_REGISTRY } from '@/services/skillOpRegistry'
import { recoverSkillOperations } from '@/services/skillOpRecoveryDriver'
import { recoveryDirection } from '@/services/skillOpRecovery'
import { listActiveOps } from '@/services/skillOperations'
import type { SkillOperationRow, SkillOpPhase } from '@/services/skillOperations'
import { ValidationError } from '@/util/errors'

export interface SkillIdentityMigrationReport {
  recoveredOperations: number
  removedHusks: number
  migratedSkills: number
  verifiedSkills: number
  verifiedVersions: number
}

export function runSkillIdentityMigrationBarrier(
  db: DbClient,
  opts: {
    appHome: string
    hooks?: SkillIdentityMigrationHooks
    /** Test-only fault seam after husk DB deletion, before empty-root cleanup. */
    __beforeHuskFsCleanupForTest?: (skillId: string) => void
  },
): SkillIdentityMigrationReport {
  // This barrier is the filesystem identity boundary, so validate its parents
  // before recovery is allowed to rename anything. A symlinked skills/ or
  // .trash/ would otherwise redirect migrate/delete operations outside appHome.
  ensureSkillFilesystemBoundary(opts.appHome)
  const initialRows = loadIdentityRows(db)
  const initialActive = listActiveOps(db)
  preflightPhysicalOwnershipGraph(db, initialRows, initialActive, opts.appHome)
  assertRecoveryPreconditions(db, initialActive, opts.appHome)

  // Legacy reserve/delete/version-write operations must settle while their
  // name-keyed directories still exist. A missing handler throws and preserves
  // both the active row and lock; it must never degrade into "release and boot".
  const recovered = recoverSkillOperations(
    db,
    { appHome: opts.appHome },
    SKILL_OP_RECOVERY_REGISTRY,
  )
  assertNoActiveOperations(db)
  preflightPhysicalOwnershipGraph(db, loadIdentityRows(db), [], opts.appHome)
  const removedHusks = sweepMissingLegacyHusks(db, opts.appHome, opts.__beforeHuskFsCleanupForTest)

  const rows = loadIdentityRows(db)
  preflightPhysicalOwnershipGraph(db, rows, [], opts.appHome)
  const plans: (typeof rows)[number][] = []

  // Full-graph preflight before the first rename. In particular, a canonical
  // target may currently be another row's legacy-name root (including a 2-cycle).
  // Per-row SELECT order must never decide whether that graph partially mutates.
  for (const row of rows) {
    const oldRoot = legacySkillRootAbs(opts.appHome, row.name)
    const newRoot = skillRootAbs(opts.appHome, row.id)
    const oldIdentity = pathEntryIdentity(oldRoot)
    const newIdentity = pathEntryIdentity(newRoot)
    const oldExists = oldIdentity !== null
    const newExists = newIdentity !== null
    const sameEntry = oldIdentity !== null && newIdentity !== null && oldIdentity === newIdentity
    const dbCanonical =
      row.managedPath === skillFilesRel(row.id) && versionPathsCanonical(db, row.id)

    if (dbCanonical && newExists) {
      // The display name is no longer an ownership path. The graph preflight
      // already proved that any physical legacy alias belongs to a canonical
      // row (and is not an unclaimed residue).
      continue
    }
    if (oldIdentity !== null && !isRealDirectory(oldRoot)) {
      throw new ValidationError(
        'skill-migration-root-invalid',
        `legacy root is not a real directory for skill ${row.id}`,
      )
    }
    if (newIdentity !== null && !isRealDirectory(newRoot)) {
      throw new ValidationError(
        'skill-migration-root-invalid',
        `canonical root is not a real directory for skill ${row.id}`,
      )
    }
    if (oldIdentity !== null && newIdentity !== null && !sameEntry) {
      throw new ValidationError(
        'skill-migration-root-collision',
        `skill ${row.id} has both legacy-name and canonical-id directories`,
      )
    }
    if (!oldExists && !newExists) {
      throw new ValidationError(
        'skill-migration-root-missing',
        `skill ${row.id} has no recoverable filesystem directory`,
      )
    }
    if (newExists && !oldExists && !dbCanonical) {
      throw new ValidationError(
        'skill-migration-untracked-canonical-root',
        `skill ${row.id} has an id directory but non-canonical DB paths`,
      )
    }
    if (!dbCanonical || !newExists) {
      plans.push(row)
    }
  }

  let migratedSkills = 0
  for (const row of plans) {
    migrateSkillIdentityOp(db, { appHome: opts.appHome }, row, opts.hooks)
    migratedSkills++
  }

  const verified = assertSkillIdentityPostcondition(db, opts.appHome)
  return {
    recoveredOperations: recovered.total,
    removedHusks,
    migratedSkills,
    verifiedSkills: verified.skills,
    verifiedVersions: verified.versions,
  }
}

export function assertSkillIdentityPostcondition(
  db: DbClient,
  appHome: string,
): { skills: number; versions: number } {
  assertNoActiveOperations(db)
  const locks = db.select().from(skillOperationLocks).all()
  if (locks.length > 0) {
    throw new ValidationError(
      'skill-migration-operation-lock',
      `${locks.length} skill operation lock(s) remain after recovery`,
    )
  }
  const rows = db.select().from(skills).all()
  preflightPhysicalOwnershipGraph(db, rows, [], appHome)
  let versions = 0
  for (const row of rows) {
    const canonicalRoot = skillRootAbs(appHome, row.id)
    if (!isRealDirectory(canonicalRoot)) {
      throw new ValidationError(
        'skill-migration-postcondition-failed',
        `canonical root is missing or not a real directory for skill ${row.id}`,
      )
    }
    if (row.managedPath !== skillFilesRel(row.id)) {
      throw new ValidationError(
        'skill-migration-postcondition-failed',
        `managed_path is not canonical for skill ${row.id}`,
      )
    }
    const liveFiles = skillFilesAbs(appHome, row.id)
    if (realDirectoryChainState(canonicalRoot, liveFiles) !== 'real-directory') {
      throw new ValidationError(
        'skill-migration-postcondition-failed',
        `managed_path does not point to a real files directory for skill ${row.id}`,
      )
    }
    const versionRows = db
      .select({
        versionIndex: skillVersions.versionIndex,
        filesPath: skillVersions.filesPath,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, row.id))
      .all()
    for (const version of versionRows) {
      versions++
      if (version.filesPath !== skillVersionRelPath(row.id, version.versionIndex)) {
        throw new ValidationError(
          'skill-migration-postcondition-failed',
          `files_path is not canonical for skill ${row.id} v${version.versionIndex}`,
        )
      }
      if (
        realDirectoryChainState(
          canonicalRoot,
          skillVersionAbs(appHome, row.id, version.versionIndex),
        ) !== 'real-directory'
      ) {
        throw new ValidationError(
          'skill-migration-postcondition-failed',
          `version directory missing for skill ${row.id} v${version.versionIndex}`,
        )
      }
    }
  }
  assertNoOperationResidue(appHome)
  const client = (db as unknown as { $client: Database }).$client
  const foreignKeyViolations = client.query("PRAGMA foreign_key_check('skill_versions')").all()
  if (foreignKeyViolations.length > 0) {
    throw new ValidationError(
      'skill-migration-foreign-key-failed',
      `foreign_key_check found ${foreignKeyViolations.length} violation(s)`,
    )
  }
  return { skills: rows.length, versions }
}

function sweepMissingLegacyHusks(
  db: DbClient,
  appHome: string,
  beforeFsCleanup?: (skillId: string) => void,
): number {
  const allRows = db
    .select({ id: skills.id, name: skills.name, managedPath: skills.managedPath })
    .from(skills)
    .all()
  const physicalOwners = new Map<string, Set<string>>()
  for (const row of allRows) {
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const canonicalExists = pathEntryIdentity(canonicalRoot) !== null
    const dbCanonical =
      row.managedPath === skillFilesRel(row.id) && versionPathsCanonical(db, row.id)
    const paths = new Set<string>([canonicalRoot])
    if (!dbCanonical || !canonicalExists) {
      paths.add(legacySkillRootAbs(appHome, row.name))
    }
    for (const path of paths) {
      const identity = pathEntryIdentity(path)
      if (identity === null) continue
      const owners = physicalOwners.get(identity) ?? new Set<string>()
      owners.add(row.id)
      physicalOwners.set(identity, owners)
    }
  }
  const candidates = db
    .select({
      id: skills.id,
      name: skills.name,
    })
    .from(skills)
    .where(
      and(eq(skills.reservationState, 'ready'), eq(skills.versionState, 'legacy-unbackfilled')),
    )
    .all()
    .sort((a, b) => a.id.localeCompare(b.id))
  let removed = 0
  for (const row of candidates) {
    const hasVersion =
      db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, row.id))
        .limit(1)
        .get() !== undefined
    if (hasVersion) continue
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const canonicalExists = pathEntryIdentity(canonicalRoot) !== null
    const rowState = allRows.find((candidate) => candidate.id === row.id)
    const dbCanonical =
      rowState?.managedPath === skillFilesRel(row.id) && versionPathsCanonical(db, row.id)
    // Once the row is canonical and owns its ID root, `name` is display-only.
    // Never sweep a display alias: it may resolve to another skill's canonical
    // inode on a case-insensitive filesystem.
    const roots = new Set<string>(
      dbCanonical && canonicalExists
        ? [canonicalRoot]
        : canonicalExists
          ? [canonicalRoot]
          : [legacySkillRootAbs(appHome, row.name)],
    )
    // Preserve the old ZIP-husk recovery contract: missing or recursively empty
    // roots are disposable, but a symlink, any byte, unreadable subtree, or a
    // path also claimed by another row is evidence and remains fail-closed.
    if (
      [...roots].some((root) => {
        const identity = pathEntryIdentity(root)
        if (identity === null) return false
        const owners = physicalOwners.get(identity)
        return (
          owners === undefined || owners.size !== 1 || !owners.has(row.id) || !dirHasNoContent(root)
        )
      })
    ) {
      continue
    }
    dbTxSync(db, (tx) => tx.delete(skills).where(eq(skills.id, row.id)).run())
    beforeFsCleanup?.(row.id)
    for (const root of roots) {
      if (probePath(root) === 'exists') {
        // Empty roots only (proved immediately above). DB authority is gone
        // first, so a late cleanup error cannot leave a row pointing at no FS.
        rmSync(root, { recursive: true, force: true })
      }
    }
    removed++
  }
  return removed
}

function assertNoOperationResidue(appHome: string): void {
  const skillsRoot = join(appHome, 'skills')
  if (!existsSync(skillsRoot)) return
  const trash = join(skillsRoot, '.trash')
  if (probePath(trash) === 'exists' && !isRealDirectory(trash)) {
    throw new ValidationError(
      'skill-migration-filesystem-boundary',
      'skill delete trash is not a real directory',
    )
  }
  if (existsSync(trash) && readdirSync(trash).length > 0) {
    throw new ValidationError(
      'skill-migration-operation-residue',
      'skill delete trash still contains operation residue',
    )
  }

  const residue = /^files\.op-[0-9A-HJKMNP-TV-Z]{26}\.(?:staged|backup|candidate)$/
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.trash') continue
    const root = join(skillsRoot, entry.name)
    for (const child of readdirSync(root, { withFileTypes: true })) {
      if (residue.test(child.name)) {
        throw new ValidationError(
          'skill-migration-operation-residue',
          `skill operation residue remains at ${join(root, child.name)}`,
        )
      }
    }
  }
}

function ensureSkillFilesystemBoundary(appHome: string): void {
  const skillsRoot = join(appHome, 'skills')
  if (probePath(skillsRoot) === 'missing') {
    mkdirSync(skillsRoot, { recursive: true })
  }
  if (!isRealDirectory(skillsRoot)) {
    throw new ValidationError(
      'skill-migration-filesystem-boundary',
      'skills root is not a real directory',
    )
  }

  const trash = join(skillsRoot, '.trash')
  if (probePath(trash) === 'exists' && !isRealDirectory(trash)) {
    throw new ValidationError(
      'skill-migration-filesystem-boundary',
      'skill delete trash is not a real directory',
    )
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function probePath(path: string): 'exists' | 'missing' {
  try {
    lstatSync(path)
    return 'exists'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw new ValidationError(
      'skill-migration-path-unreadable',
      `cannot prove skill path state at ${path}`,
    )
  }
}

function pathEntryExists(path: string): boolean {
  return probePath(path) === 'exists'
}

function pathEntryIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path)
    return `${stat.dev}:${stat.ino}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ValidationError(
      'skill-migration-path-unreadable',
      `cannot prove skill path identity at ${path}`,
    )
  }
}

function dirHasNoContent(root: string): boolean {
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return false
    if (!dirHasNoContent(join(root, entry.name))) return false
  }
  return true
}

function assertNoActiveOperations(db: DbClient): void {
  const active = listActiveOps(db)
  if (active.length > 0) {
    throw new ValidationError(
      'skill-migration-active-operation',
      `${active.length} skill operation(s) remain incomplete`,
    )
  }
}

function versionPathsCanonical(db: DbClient, skillId: string): boolean {
  return db
    .select({ versionIndex: skillVersions.versionIndex, filesPath: skillVersions.filesPath })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .all()
    .every((row) => row.filesPath === skillVersionRelPath(skillId, row.versionIndex))
}

interface IdentityRow {
  id: string
  name: string
  managedPath: string | null
}

function loadIdentityRows(db: DbClient): IdentityRow[] {
  return db
    .select({ id: skills.id, name: skills.name, managedPath: skills.managedPath })
    .from(skills)
    .all()
    .sort((a, b) => a.id.localeCompare(b.id))
}

function assertRecoveryPreconditions(
  db: DbClient,
  active: SkillOperationRow[],
  appHome: string,
): void {
  const locks = db
    .select({
      lockedSkillId: skillOperationLocks.lockedSkillId,
      opId: skillOperationLocks.opId,
    })
    .from(skillOperationLocks)
    .all()
  for (const op of active) {
    // RFC-178 retired the only two-id structural operation. A non-null
    // next_skill_id on any currently supported kind is therefore not a lock
    // capability to honor; it is malformed durable state that must fail-stop.
    if (op.nextSkillId !== null) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `active ${op.kind} operation ${op.opId} has an unsupported next_skill_id`,
      )
    }
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(op.opId)) {
      throw new ValidationError(
        'skill-migration-operation-id-invalid',
        `active operation has a non-canonical op_id: ${op.opId}`,
      )
    }
    const direction = recoveryDirection(op.kind, op.phase as SkillOpPhase)
    if (direction === 'quarantine' || direction === 'noop') {
      throw new ValidationError(
        'skill-migration-operation-state-invalid',
        `active ${op.kind} operation ${op.opId} has impossible phase ${op.phase}`,
      )
    }
    assertOperationDbAuthority(db, op, direction)
    assertOperationFilesystemAuthority(db, op, direction, appHome)
    const expected = new Set([op.skillId])
    const actual = locks.filter((lock) => lock.opId === op.opId)
    if (
      actual.length !== expected.size ||
      actual.some((lock) => !expected.has(lock.lockedSkillId)) ||
      [...expected].some(
        (skillId) => !locks.some((lock) => lock.lockedSkillId === skillId && lock.opId === op.opId),
      )
    ) {
      throw new ValidationError(
        'skill-migration-operation-lock-invalid',
        `active operation ${op.opId} does not own exactly its declared skill locks`,
      )
    }
  }
}

function assertOperationFilesystemAuthority(
  db: DbClient,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
  appHome: string,
): void {
  if (op.kind === 'reserve' && (op.phase === 'fs-published' || direction === 'rollforward')) {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const key = identity.legacyName ?? identity.skillId
    const root =
      identity.legacyName === undefined
        ? skillRootAbs(appHome, identity.skillId)
        : legacySkillRootAbs(appHome, identity.legacyName)
    const live = join(root, 'files')
    const version = join(root, 'versions', 'v1', 'files')
    const versionRow = db
      .select({
        filesPath: skillVersions.filesPath,
        contentHash: skillVersions.contentHash,
      })
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, op.skillId), eq(skillVersions.versionIndex, 1)))
      .get()
    const expectedPath =
      identity.legacyName === undefined
        ? skillVersionRelPath(op.skillId, 1)
        : `skills/${key}/versions/v1/files`
    if (
      versionRow === undefined ||
      versionRow.filesPath !== expectedPath ||
      versionRow.contentHash === null ||
      realDirectoryChainState(root, live) !== 'real-directory' ||
      realDirectoryChainState(root, version) !== 'real-directory' ||
      !isRegularFile(join(live, 'SKILL.md')) ||
      !isRegularFile(join(version, 'SKILL.md'))
    ) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `reserve operation ${op.opId} has no complete published v1 tree`,
      )
    }
    if (
      hashRegularFileTree(version) !== versionRow.contentHash ||
      hashRegularFileTree(live) !== versionRow.contentHash
    ) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `reserve operation ${op.opId} published v1 does not match DB authority`,
      )
    }
  }

  if (op.kind === 'delete' && direction === 'rollforward') {
    if (op.backupPath === null) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `delete operation ${op.opId} has no committed trash path`,
      )
    }
    const expected = join(appHome, 'skills', '.trash', `${op.skillId}-${op.opId}`)
    const actual = rebaseSkillOperationPath(appHome, op.backupPath, '.trash')
    if (actual !== expected) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `delete operation ${op.opId} trash path does not match its identity`,
      )
    }
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const root =
      identity.legacyName === undefined
        ? skillRootAbs(appHome, identity.skillId)
        : legacySkillRootAbs(appHome, identity.legacyName)
    if (pathEntryExists(root)) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `delete operation ${op.opId} has a committed row deletion but live root remains`,
      )
    }
    if (
      identity.legacyName !== undefined &&
      pathEntryExists(skillRootAbs(appHome, identity.skillId))
    ) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `legacy delete operation ${op.opId} has a committed row deletion but canonical root remains`,
      )
    }
  }
}

function assertOperationDbAuthority(
  db: DbClient,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
): void {
  const row = db
    .select({
      name: skills.name,
      reservationState: skills.reservationState,
      contentVersion: skills.contentVersion,
      managedPath: skills.managedPath,
      versionState: skills.versionState,
    })
    .from(skills)
    .where(eq(skills.id, op.skillId))
    .get()

  if (op.kind === 'delete') {
    if ((direction === 'rollback') !== (row !== undefined)) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `delete operation ${op.opId} disagrees with skills row presence`,
      )
    }
    if (row !== undefined && row.reservationState !== 'ready') {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `delete operation ${op.opId} does not target a ready skill`,
      )
    }
    if (row === undefined) return // committed delete: no row generation remains to bind
  }

  if (row === undefined) {
    throw new ValidationError(
      'skill-migration-operation-authority-invalid',
      `${op.kind} operation ${op.opId} has no matching skills row`,
    )
  }
  if (op.kind !== 'migrate') {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const versionRows = db
      .select({
        versionIndex: skillVersions.versionIndex,
        filesPath: skillVersions.filesPath,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, op.skillId))
      .all()
    const matchesGeneration =
      identity.legacyName === undefined
        ? row.managedPath === skillFilesRel(op.skillId) &&
          versionRows.every(
            (version) =>
              version.filesPath === skillVersionRelPath(op.skillId, version.versionIndex),
          )
        : row.name === identity.legacyName &&
          row.managedPath?.replace(/\/+$/, '') === `skills/${identity.legacyName}/files` &&
          versionRows.every(
            (version) =>
              version.filesPath.replace(/\/+$/, '') ===
              `skills/${identity.legacyName}/versions/v${version.versionIndex}/files`,
          )
    if (!matchesGeneration) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `${op.kind} operation ${op.opId} payload does not match its DB path generation`,
      )
    }
  }
  if (op.kind === 'reserve') {
    const expectedState = direction === 'rollback' ? 'reserving' : 'ready'
    if (row.reservationState !== expectedState) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `reserve operation ${op.opId} disagrees with reservation_state`,
      )
    }
    const reserveVersions = db
      .select({ versionIndex: skillVersions.versionIndex })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, op.skillId))
      .all()
    const hasNoVersion = reserveVersions.length === 0 && row.contentVersion === 0
    const hasExactlyV1 =
      reserveVersions.length === 1 &&
      reserveVersions[0]?.versionIndex === 1 &&
      row.contentVersion === 1
    // commitSkillVersion(skipOp) commits/publishes v1 before the outer reserve
    // advances fs-staged -> fs-published. A crash in that narrow window leaves
    // fs-staged + complete v1 and is still safely rollbackable.
    const validVersionAuthority =
      op.phase === 'intent'
        ? hasNoVersion
        : op.phase === 'fs-staged'
          ? hasNoVersion || hasExactlyV1
          : hasExactlyV1
    if (!validVersionAuthority) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `reserve operation ${op.opId} disagrees with v1 publication authority`,
      )
    }
    if (direction === 'rollforward') {
      const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
      const expectedManagedPath =
        identity.legacyName === undefined
          ? skillFilesRel(op.skillId)
          : `skills/${identity.legacyName}/files`
      if (
        row.versionState !== 'snapshot-authoritative' ||
        row.managedPath?.replace(/\/+$/, '') !== expectedManagedPath
      ) {
        throw new ValidationError(
          'skill-migration-operation-authority-invalid',
          `reserve operation ${op.opId} has incomplete published row authority`,
        )
      }
    }
    return
  }
  if (row.reservationState !== 'ready') {
    throw new ValidationError(
      'skill-migration-operation-authority-invalid',
      `${op.kind} operation ${op.opId} does not target a ready skill`,
    )
  }
  if (op.kind === 'version-write') {
    if (op.targetVersion === null || op.targetVersion < 1) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `version-write operation ${op.opId} has no valid target version`,
      )
    }
    const target = db
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, op.skillId),
          eq(skillVersions.versionIndex, op.targetVersion),
        ),
      )
      .get()
    const versionIndices = db
      .select({ versionIndex: skillVersions.versionIndex })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, op.skillId))
      .all()
      .map((version) => version.versionIndex)
    const maxVersion = versionIndices.reduce((max, version) => Math.max(max, version), 0)
    if (
      direction === 'rollback'
        ? target !== undefined ||
          row.contentVersion !== maxVersion ||
          op.targetVersion !== maxVersion + 1
        : target === undefined ||
          row.contentVersion !== op.targetVersion ||
          op.targetVersion !== maxVersion
    ) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `version-write operation ${op.opId} disagrees with version authority`,
      )
    }
    return
  }
  if (op.kind === 'migrate') {
    const identity = decodeMigratePrecondition(op)
    const canonical =
      row.managedPath === skillFilesRel(op.skillId) && versionPathsCanonical(db, op.skillId)
    const legacyManagedPath = `skills/${identity.legacyName}/files`
    const legacyVersions = db
      .select({
        versionIndex: skillVersions.versionIndex,
        filesPath: skillVersions.filesPath,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, op.skillId))
      .all()
      .every(
        (version) =>
          version.filesPath.replace(/\/+$/, '') ===
          `skills/${identity.legacyName}/versions/v${version.versionIndex}/files`,
      )
    const legacy = row.managedPath?.replace(/\/+$/, '') === legacyManagedPath && legacyVersions
    if (row.name !== identity.legacyName || (direction === 'rollback' ? !legacy : !canonical)) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `migrate operation ${op.opId} disagrees with DB path authority`,
      )
    }
  }
}

interface PhysicalClaim {
  skillId: string
  path: string
  source: string
}

function preflightPhysicalOwnershipGraph(
  db: DbClient,
  rows: Array<{ id: string; name: string; managedPath: string | null }>,
  active: SkillOperationRow[],
  appHome: string,
): void {
  const claims = new Map<string, PhysicalClaim>()
  const rootClaims = new Map<string, PhysicalClaim>()
  const canonicalLogicalClaims = new Map<string, PhysicalClaim>()
  const addPhysicalClaim = (skillId: string, path: string, source: string): void => {
    const identity = pathEntryIdentity(path)
    if (identity === null) return
    if (!isRealDirectory(path)) {
      throw new ValidationError(
        'skill-migration-root-invalid',
        `${source} is not a real directory: ${path}`,
      )
    }
    const prior = claims.get(identity)
    if (prior !== undefined && prior.skillId !== skillId) {
      throw new ValidationError(
        'skill-migration-physical-ownership-collision',
        `${source} for skill ${skillId} shares a filesystem entry with ` +
          `${prior.source} for skill ${prior.skillId}`,
      )
    }
    claims.set(identity, { skillId, path, source })
  }
  const addRootClaim = (skillId: string, path: string, source: string): void => {
    const identity = pathEntryIdentity(path)
    if (identity === null) return
    const prior = rootClaims.get(skillId)
    if (prior !== undefined && pathEntryIdentity(prior.path) !== identity) {
      throw new ValidationError(
        'skill-migration-physical-ownership-collision',
        `${source} and ${prior.source} claim different roots for skill ${skillId}`,
      )
    }
    addPhysicalClaim(skillId, path, source)
    rootClaims.set(skillId, { skillId, path, source })
  }

  // Canonical roots are the only durable row ownership paths. Build them first
  // so a fully-canonical row's display-name alias can be recognized as another
  // row's legitimate canonical entry instead of being misclassified as residue.
  for (const row of rows) {
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const logicalKey = resolve(canonicalRoot)
    const priorLogical = canonicalLogicalClaims.get(logicalKey)
    if (priorLogical !== undefined && priorLogical.skillId !== row.id) {
      throw new ValidationError(
        'skill-migration-physical-ownership-collision',
        `canonical roots for skills ${row.id} and ${priorLogical.skillId} resolve to the same path`,
      )
    }
    canonicalLogicalClaims.set(logicalKey, {
      skillId: row.id,
      path: canonicalRoot,
      source: 'canonical row root',
    })
    addRootClaim(row.id, canonicalRoot, 'canonical row root')
  }

  for (const row of rows) {
    const legacyRoot = legacySkillRootAbs(appHome, row.name)
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const legacyIdentity = pathEntryIdentity(legacyRoot)
    const canonicalIdentity = pathEntryIdentity(canonicalRoot)
    const dbCanonical =
      row.managedPath === skillFilesRel(row.id) && versionPathsCanonical(db, row.id)
    const needsLegacyOwnership = !dbCanonical || canonicalIdentity === null

    if (needsLegacyOwnership) {
      const logicalOwner = canonicalLogicalClaims.get(resolve(legacyRoot))
      if (logicalOwner !== undefined && logicalOwner.skillId !== row.id) {
        throw new ValidationError(
          'skill-migration-physical-ownership-collision',
          `legacy root for skill ${row.id} resolves to canonical root for ` +
            `skill ${logicalOwner.skillId}`,
        )
      }
      addRootClaim(row.id, legacyRoot, 'legacy row root')
    } else if (
      legacyIdentity !== null &&
      legacyIdentity !== canonicalIdentity &&
      !claims.has(legacyIdentity)
    ) {
      throw new ValidationError(
        'skill-migration-unclaimed-legacy-residue',
        `canonical skill ${row.id} has an unclaimed display-name directory`,
      )
    }
  }

  for (const op of active) {
    const identity =
      op.kind === 'migrate'
        ? decodeMigratePrecondition(op)
        : decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const key = identity.legacyName ?? identity.skillId
    const operationRoot =
      identity.legacyName === undefined
        ? skillRootAbs(appHome, identity.skillId)
        : legacySkillRootAbs(appHome, identity.legacyName)
    if (identity.legacyName !== undefined) {
      const logicalOwner = canonicalLogicalClaims.get(resolve(operationRoot))
      if (logicalOwner !== undefined && logicalOwner.skillId !== op.skillId) {
        throw new ValidationError(
          'skill-migration-physical-ownership-collision',
          `active ${op.kind} operation for ${op.skillId} targets canonical root ` +
            `for ${logicalOwner.skillId}`,
        )
      }
    }
    addRootClaim(op.skillId, operationRoot, `active ${op.kind} operation root`)

    if (op.nextSkillId !== null) {
      addPhysicalClaim(
        op.nextSkillId,
        skillRootAbs(appHome, op.nextSkillId),
        `active ${op.kind} next-skill root`,
      )
    }

    for (const [column, storedPath] of [
      ['staging_path', op.stagingPath],
      ['candidate_path', op.candidatePath],
      ['backup_path', op.backupPath],
    ] as const) {
      if (storedPath === null) continue
      const isDeleteTrash = op.kind === 'delete' && column === 'backup_path'
      const chainRoot = isDeleteTrash ? join(appHome, 'skills', '.trash') : operationRoot
      const rebased = rebaseSkillOperationPath(appHome, storedPath, isDeleteTrash ? '.trash' : key)
      const state = realDirectoryChainState(chainRoot, rebased)
      if (state === 'real-directory') {
        addPhysicalClaim(op.skillId, rebased, `active ${op.kind} ${column}`)
      }
    }
  }
}

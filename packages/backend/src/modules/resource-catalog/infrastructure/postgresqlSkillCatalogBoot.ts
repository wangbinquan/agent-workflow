import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  type Dirent,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { skillOperationLocks, skillOperations, skills, skillVersions } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import type { SkillCatalogBootAdapter } from '../application/skills/skillCatalogBootParticipant'
import {
  activateBootReverify,
  isBootReverifyActive,
  markSkillBootVerified,
  unmarkSkillBootVerified,
} from './legacy/skillBootVerify'
import {
  cleanupOpDirs,
  opBackupDir,
  restoreFromBackup,
  swapInStaged,
} from './legacy/skillFsPublish'
import { fingerprintTree, hashRegularFileTree } from './legacy/skillHash'
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
} from './legacy/skillIdentityPaths'
import { decodeMigratePrecondition } from './legacy/skillMigrateOp'
import { recoveryDirection } from './legacy/skillOpRecovery'
import type { SkillOperationRow, SkillOpPhase } from './legacy/skillOperations'
import {
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

const log = createLogger('postgresql-skill-catalog-boot')

interface IdentityRow {
  readonly id: string
  readonly name: string
  readonly managedPath: string | null
}

interface ReverifySkill {
  readonly id: string
  readonly name: string
  readonly contentVersion: number
}

type VerifyOutcome = 'verified' | 'quarantined' | 'superseded'

/**
 * Native asynchronous PostgreSQL boot adapter. It owns every database read and
 * write through the PostgreSQL client/transaction while retaining the same
 * crash journal and canonical filesystem authority used by SQLite.
 */
export function createPostgresqlSkillCatalogBootAdapter(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): SkillCatalogBootAdapter {
  return Object.freeze({
    runIdentityMigrationBarrier: () => runIdentityMigrationBarrier(input),
    activateAvailabilityGate: () => activateBootReverify(),
    reconcileLiveFiles: () => reconcileLiveFiles(input),
    backfillLegacyVersions: () => backfillLegacyVersions(input),
    reverifySnapshots: () => reverifySnapshots(input),
  })
}

async function runIdentityMigrationBarrier(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): Promise<{
  readonly recoveredOperations: number
  readonly removedHusks: number
  readonly migratedSkills: number
  readonly verifiedSkills: number
  readonly verifiedVersions: number
}> {
  ensureSkillFilesystemBoundary(input.appHome)
  const recoveredOperations = await recoverActiveOperations(input)
  const initialRows = await loadIdentityRows(input.db)
  await assertPhysicalOwnershipGraph(input.db, initialRows, input.appHome)
  const removedHusks = await sweepMissingLegacyHusks(input)
  const rows = await loadIdentityRows(input.db)
  await assertPhysicalOwnershipGraph(input.db, rows, input.appHome)

  const plans: IdentityRow[] = []
  for (const row of rows) {
    const oldRoot = legacySkillRootAbs(input.appHome, row.name)
    const newRoot = skillRootAbs(input.appHome, row.id)
    const oldIdentity = pathEntryIdentity(oldRoot)
    const newIdentity = pathEntryIdentity(newRoot)
    const sameEntry = oldIdentity !== null && oldIdentity === newIdentity
    const canonical = await versionPathsCanonical(input.db, row)

    if (canonical && newIdentity !== null) continue
    if (oldIdentity !== null && !isRealDirectory(oldRoot)) {
      throw migrationError(
        'root-invalid',
        `legacy root is not a real directory for skill ${row.id}`,
      )
    }
    if (newIdentity !== null && !isRealDirectory(newRoot)) {
      throw migrationError(
        'root-invalid',
        `canonical root is not a real directory for skill ${row.id}`,
      )
    }
    if (oldIdentity !== null && newIdentity !== null && !sameEntry) {
      throw migrationError(
        'root-collision',
        `skill ${row.id} has both legacy-name and canonical-id directories`,
      )
    }
    if (oldIdentity === null && newIdentity === null) {
      throw migrationError(
        'root-missing',
        `skill ${row.id} has no recoverable filesystem directory`,
      )
    }
    if (newIdentity !== null && oldIdentity === null && !canonical) {
      throw migrationError(
        'untracked-canonical-root',
        `skill ${row.id} has an id directory but non-canonical database paths`,
      )
    }
    plans.push(row)
  }

  for (const row of plans) await migrateIdentity(input, row)
  const verified = await assertIdentityPostcondition(input)
  return Object.freeze({
    recoveredOperations,
    removedHusks,
    migratedSkills: plans.length,
    verifiedSkills: verified.skills,
    verifiedVersions: verified.versions,
  })
}

async function recoverActiveOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): Promise<number> {
  const active = await input.db
    .select()
    .from(skillOperations)
    .where(eq(skillOperations.active, 1))
    .orderBy(skillOperations.opId)
    .all()
  const locks = await input.db
    .select({ lockedSkillId: skillOperationLocks.lockedSkillId, opId: skillOperationLocks.opId })
    .from(skillOperationLocks)
    .all()

  for (const op of active) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(op.opId)) {
      throw migrationError(
        'operation-id-invalid',
        `active operation has a non-canonical op_id: ${op.opId}`,
      )
    }
    const ownedLocks = locks.filter((lock) => lock.opId === op.opId)
    if (ownedLocks.length !== 1 || ownedLocks[0]?.lockedSkillId !== op.skillId) {
      throw migrationError(
        'operation-lock-invalid',
        `active operation ${op.opId} does not own exactly its declared skill lock`,
      )
    }
    const phase = parseSkillOpPhase(op.phase)
    const direction = phase === null ? 'quarantine' : recoveryDirection(op.kind, phase)
    if (direction === 'quarantine') {
      await retireOperation(input.db, op, 'quarantine')
      continue
    }
    if (direction === 'noop') {
      await retireOperation(input.db, op, 'rollback')
      continue
    }
    await assertOperationDatabaseAuthority(input.db, op, direction)

    if (op.kind === 'reserve') recoverReserveFilesystem(input.appHome, op, direction)
    else if (op.kind === 'delete') recoverDeleteFilesystem(input.appHome, op, direction)
    else if (op.kind === 'migrate') recoverMigrateFilesystem(input.appHome, op, direction)
    else if (op.kind === 'version-write') {
      await recoverVersionWriteFilesystem(input, op, direction)
    } else {
      throw migrationError(
        'operation-state-invalid',
        `active operation ${op.opId} has unsupported kind ${String(op.kind)}`,
      )
    }
    await retireOperation(input.db, op, direction)
  }

  const stillActive = await input.db
    .select({ opId: skillOperations.opId })
    .from(skillOperations)
    .where(eq(skillOperations.active, 1))
    .all()
  const activeIds = new Set(stillActive.map((row) => row.opId))
  const remainingLocks = await input.db.select().from(skillOperationLocks).all()
  const orphaned = remainingLocks.filter((lock) => !activeIds.has(lock.opId))
  if (orphaned.length > 0) {
    await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
      for (const lock of orphaned) {
        await transaction
          .delete(skillOperationLocks)
          .where(eq(skillOperationLocks.lockedSkillId, lock.lockedSkillId))
          .run()
      }
    })
  }
  return active.length
}

async function assertOperationDatabaseAuthority(
  db: PostgresqlDatabaseClient,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
): Promise<void> {
  const row = await db
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
  const versions = await db
    .select({ versionIndex: skillVersions.versionIndex, filesPath: skillVersions.filesPath })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, op.skillId))
    .all()

  if (op.kind === 'delete') {
    if ((direction === 'rollback') !== (row !== undefined)) {
      throw migrationError(
        'operation-authority-invalid',
        `delete operation ${op.opId} disagrees with skills row presence`,
      )
    }
    if (row !== undefined && row.reservationState !== 'ready') {
      throw migrationError(
        'operation-authority-invalid',
        `delete operation ${op.opId} does not target a ready skill`,
      )
    }
    return
  }
  if (row === undefined) {
    throw migrationError(
      'operation-authority-invalid',
      `${op.kind} operation ${op.opId} has no matching skills row`,
    )
  }

  if (op.kind === 'reserve') {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const managedPath =
      identity.legacyName === undefined
        ? skillFilesRel(op.skillId)
        : `skills/${identity.legacyName}/files`
    const hasNoVersion = versions.length === 0 && row.contentVersion === 0
    const hasV1 =
      versions.length === 1 &&
      versions[0]?.versionIndex === 1 &&
      row.contentVersion === 1 &&
      versions[0].filesPath.replace(/\/+$/, '') ===
        (identity.legacyName === undefined
          ? skillVersionRelPath(op.skillId, 1)
          : `skills/${identity.legacyName}/versions/v1/files`)
    const validVersionAuthority =
      op.phase === 'intent'
        ? hasNoVersion
        : op.phase === 'fs-staged'
          ? hasNoVersion || hasV1
          : hasV1
    if (
      row.reservationState !== (direction === 'rollback' ? 'reserving' : 'ready') ||
      !validVersionAuthority ||
      (direction === 'rollforward' &&
        (row.versionState !== 'snapshot-authoritative' ||
          row.managedPath?.replace(/\/+$/, '') !== managedPath))
    ) {
      throw migrationError(
        'operation-authority-invalid',
        `reserve operation ${op.opId} disagrees with its published generation`,
      )
    }
    return
  }

  if (row.reservationState !== 'ready') {
    throw migrationError(
      'operation-authority-invalid',
      `${op.kind} operation ${op.opId} does not target a ready skill`,
    )
  }
  if (op.kind === 'version-write') {
    if (op.targetVersion === null || op.targetVersion < 1) {
      throw migrationError(
        'operation-authority-invalid',
        `version-write operation ${op.opId} has no target generation`,
      )
    }
    const maxVersion = versions.reduce(
      (maximum, version) => Math.max(maximum, version.versionIndex),
      0,
    )
    const targetExists = versions.some((version) => version.versionIndex === op.targetVersion)
    const valid =
      direction === 'rollback'
        ? !targetExists && row.contentVersion === maxVersion && op.targetVersion === maxVersion + 1
        : targetExists && row.contentVersion === op.targetVersion && op.targetVersion === maxVersion
    if (!valid) {
      throw migrationError(
        'operation-authority-invalid',
        `version-write operation ${op.opId} disagrees with version authority`,
      )
    }
    return
  }

  const identity = decodeMigratePrecondition(op)
  const canonical =
    row.managedPath === skillFilesRel(op.skillId) &&
    versions.every(
      (version) => version.filesPath === skillVersionRelPath(op.skillId, version.versionIndex),
    )
  const legacy =
    row.name === identity.legacyName &&
    row.managedPath?.replace(/\/+$/, '') === `skills/${identity.legacyName}/files` &&
    versions.every(
      (version) =>
        version.filesPath.replace(/\/+$/, '') ===
        `skills/${identity.legacyName}/versions/v${version.versionIndex}/files`,
    )
  if (direction === 'rollback' ? !legacy || canonical : !canonical || legacy) {
    throw migrationError(
      'operation-authority-invalid',
      `migrate operation ${op.opId} disagrees with identity authority`,
    )
  }
}

function recoverReserveFilesystem(
  appHome: string,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
): void {
  if (direction === 'rollforward') return
  const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
  const root =
    identity.legacyName === undefined
      ? skillRootAbs(appHome, identity.skillId)
      : legacySkillRootAbs(appHome, identity.legacyName)
  rmSync(root, { recursive: true, force: true })
}

function recoverDeleteFilesystem(
  appHome: string,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
): void {
  const backup = join(appHome, 'skills', '.trash', `${op.skillId}-${op.opId}`)
  if (op.backupPath !== null) {
    const actual = rebaseSkillOperationPath(appHome, op.backupPath, '.trash')
    if (actual !== backup) {
      throw migrationError(
        'operation-authority-invalid',
        `delete operation ${op.opId} backup path does not match its identity`,
      )
    }
  }
  if (direction === 'rollforward') {
    rmSync(backup, { recursive: true, force: true })
    return
  }
  const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
  const root =
    identity.legacyName === undefined
      ? skillRootAbs(appHome, identity.skillId)
      : legacySkillRootAbs(appHome, identity.legacyName)
  const rootExists = pathEntryIdentity(root) !== null
  const backupExists = pathEntryIdentity(backup) !== null
  if (rootExists === backupExists) {
    throw migrationError(
      'operation-authority-invalid',
      `delete recovery cannot prove one authoritative tree for skill ${op.skillId}`,
    )
  }
  if (backupExists) renameAndSyncParent(backup, root)
}

function recoverMigrateFilesystem(
  appHome: string,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
): void {
  const identity = decodeMigratePrecondition(op)
  const oldRoot = legacySkillRootAbs(appHome, identity.legacyName)
  const newRoot = skillRootAbs(appHome, identity.skillId)
  const oldIdentity = pathEntryIdentity(oldRoot)
  const newIdentity = pathEntryIdentity(newRoot)
  const sameEntry = oldIdentity !== null && oldIdentity === newIdentity
  const expected = direction === 'rollback' ? oldRoot : newRoot
  const other = direction === 'rollback' ? newRoot : oldRoot

  if (!sameEntry && pathEntryIdentity(expected) === null && pathEntryIdentity(other) !== null) {
    renameAndSyncParent(other, expected)
  }
  if (!isRealDirectory(expected) || (!sameEntry && pathEntryIdentity(other) !== null)) {
    throw migrationError(
      'operation-authority-invalid',
      `migrate operation ${op.opId} has an ambiguous filesystem authority`,
    )
  }
  if (op.candidateFingerprint === null || fingerprintTree(expected) !== op.candidateFingerprint) {
    throw migrationError(
      'fingerprint-mismatch',
      `migrate operation ${op.opId} root changed while recovery was in flight`,
    )
  }
}

async function retireOperation(
  db: PostgresqlDatabaseClient,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward' | 'quarantine',
): Promise<void> {
  await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
    if (direction === 'quarantine') {
      await transaction
        .update(skills)
        .set({ versionState: 'quarantined' })
        .where(eq(skills.id, op.skillId))
        .run()
    } else if (op.kind === 'reserve') {
      if (direction === 'rollback') {
        await transaction.delete(skills).where(eq(skills.id, op.skillId)).run()
      } else {
        await transaction
          .update(skills)
          .set({ reservationState: 'ready' })
          .where(eq(skills.id, op.skillId))
          .run()
      }
    } else if (op.kind === 'migrate' && direction === 'rollforward') {
      await writeCanonicalPaths(transaction, op.skillId)
    }
    await transaction
      .update(skillOperations)
      .set(direction === 'rollforward' ? { phase: 'done', active: 0 } : { active: 0 })
      .where(eq(skillOperations.opId, op.opId))
      .run()
    await transaction.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, op.opId)).run()
  })
}

async function recoverVersionWriteFilesystem(
  input: { readonly db: PostgresqlDatabaseClient; readonly appHome: string },
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
): Promise<void> {
  const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
  const key = identity.legacyName ?? identity.skillId
  const root = skillRootAbs(input.appHome, key)
  const filesDir = join(root, 'files')
  const staging = requireVersionOperationPath(input.appHome, op.stagingPath, key, op, 'staged')
  const candidate = requireVersionOperationPath(
    input.appHome,
    op.candidatePath,
    key,
    op,
    'candidate',
  )
  if (op.targetVersion === null || op.targetVersion < 1) {
    throw migrationError(
      'operation-authority-invalid',
      `version-write ${op.opId} has no valid target version`,
    )
  }
  const row = await input.db
    .select({ contentHash: skillVersions.contentHash, filesPath: skillVersions.filesPath })
    .from(skillVersions)
    .where(
      and(eq(skillVersions.skillId, op.skillId), eq(skillVersions.versionIndex, op.targetVersion)),
    )
    .get()
  const currentSkill = await input.db
    .select({ contentVersion: skills.contentVersion })
    .from(skills)
    .where(eq(skills.id, op.skillId))
    .get()

  if (direction === 'rollback') {
    if (row !== undefined) {
      throw migrationError(
        'operation-authority-invalid',
        `version-write ${op.opId} rollback has a committed version row`,
      )
    }
    if (isRealDirectory(opBackupDir(filesDir, staging.publishId))) {
      restoreFromBackup(filesDir, staging.publishId)
    }
    if (!isRealDirectory(filesDir)) {
      throw migrationError(
        'operation-authority-invalid',
        `version-write ${op.opId} rollback cannot prove a live tree`,
      )
    }
    cleanupOpDirs(filesDir, staging.publishId)
    rmSync(candidate.path, { recursive: true, force: true })
    return
  }

  if (
    row === undefined ||
    row.contentHash === null ||
    currentSkill?.contentVersion !== op.targetVersion ||
    rebaseSkillOperationPath(input.appHome, row.filesPath, key) !== candidate.path
  ) {
    throw migrationError(
      'operation-authority-invalid',
      `version-write ${op.opId} has no canonical committed version authority`,
    )
  }
  requireTreeHash(root, candidate.path, row.contentHash, op, 'version snapshot')
  if (isRealDirectory(staging.path)) {
    requireTreeHash(root, staging.path, row.contentHash, op, 'staged tree')
  } else if (!isRealDirectory(filesDir) || hashRegularFileTree(filesDir) !== row.contentHash) {
    mkdirSync(root, { recursive: true })
    cpSync(candidate.path, staging.path, { recursive: true })
  }
  if (isRealDirectory(staging.path)) swapInStaged(filesDir, staging.publishId)
  requireTreeHash(root, filesDir, row.contentHash, op, 'canonical live tree')
  cleanupOpDirs(filesDir, staging.publishId)
}

function requireVersionOperationPath(
  appHome: string,
  storedPath: string | null,
  key: string,
  op: SkillOperationRow,
  kind: 'staged' | 'candidate',
): { readonly path: string; readonly publishId: string } {
  if (storedPath === null) {
    throw migrationError(
      'operation-authority-invalid',
      `version-write ${op.opId} is missing its ${kind} path`,
    )
  }
  const path = rebaseSkillOperationPath(appHome, storedPath, key)
  const rel = relative(skillRootAbs(appHome, key), path).replaceAll('\\', '/')
  const pattern =
    kind === 'staged'
      ? /^files\.op-([0-9A-HJKMNP-TV-Z]{26})\.staged$/
      : new RegExp(`^versions/v${op.targetVersion ?? 0}/files$`)
  const match = pattern.exec(rel)
  if (match === null) {
    throw migrationError(
      'operation-authority-invalid',
      `version-write ${op.opId} ${kind} path does not match its identity`,
    )
  }
  const publishId = kind === 'staged' ? match[1] : op.opId
  if (publishId === undefined || (kind === 'staged' && publishId !== op.opId)) {
    throw migrationError(
      'operation-authority-invalid',
      `version-write ${op.opId} staged path has a foreign operation id`,
    )
  }
  return { path, publishId }
}

function requireTreeHash(
  root: string,
  path: string,
  expectedHash: string,
  op: SkillOperationRow,
  label: string,
): void {
  if (
    realDirectoryChainState(root, path) !== 'real-directory' ||
    hashRegularFileTree(path) !== expectedHash
  ) {
    throw migrationError(
      'operation-authority-invalid',
      `version-write ${op.opId} ${label} does not match committed content`,
    )
  }
}

async function loadIdentityRows(db: PostgresqlDatabaseClient): Promise<readonly IdentityRow[]> {
  return await db
    .select({ id: skills.id, name: skills.name, managedPath: skills.managedPath })
    .from(skills)
    .orderBy(skills.id)
    .all()
}

async function versionPathsCanonical(
  db: PostgresqlDatabaseClient,
  row: IdentityRow,
): Promise<boolean> {
  if (row.managedPath !== skillFilesRel(row.id)) return false
  const versions = await db
    .select({ versionIndex: skillVersions.versionIndex, filesPath: skillVersions.filesPath })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, row.id))
    .all()
  return versions.every(
    (version) => version.filesPath === skillVersionRelPath(row.id, version.versionIndex),
  )
}

async function assertPhysicalOwnershipGraph(
  db: PostgresqlDatabaseClient,
  rows: readonly IdentityRow[],
  appHome: string,
): Promise<void> {
  const canonicalLogicalOwners = new Map<string, string>()
  const physicalOwners = new Map<string, string>()
  const canonicalState = new Map<string, boolean>()

  const claim = (skillId: string, path: string, source: string): void => {
    const identity = pathEntryIdentity(path)
    if (identity === null) return
    const prior = physicalOwners.get(identity)
    if (prior !== undefined && prior !== skillId) {
      throw migrationError(
        'physical-ownership-collision',
        `${source} for skill ${skillId} aliases storage owned by skill ${prior}`,
      )
    }
    physicalOwners.set(identity, skillId)
  }

  for (const row of rows) {
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const logical = resolve(canonicalRoot)
    const prior = canonicalLogicalOwners.get(logical)
    if (prior !== undefined && prior !== row.id) {
      throw migrationError(
        'physical-ownership-collision',
        `canonical roots for skills ${row.id} and ${prior} resolve to the same path`,
      )
    }
    canonicalLogicalOwners.set(logical, row.id)
    canonicalState.set(row.id, await versionPathsCanonical(db, row))
    claim(row.id, canonicalRoot, 'canonical root')
  }

  for (const row of rows) {
    const legacyRoot = legacySkillRootAbs(appHome, row.name)
    const canonicalRoot = skillRootAbs(appHome, row.id)
    const canonicalIdentity = pathEntryIdentity(canonicalRoot)
    const legacyIdentity = pathEntryIdentity(legacyRoot)
    const needsLegacy = canonicalState.get(row.id) !== true || canonicalIdentity === null
    if (needsLegacy) {
      const logicalOwner = canonicalLogicalOwners.get(resolve(legacyRoot))
      if (logicalOwner !== undefined && logicalOwner !== row.id) {
        throw migrationError(
          'physical-ownership-collision',
          `legacy root for skill ${row.id} resolves to canonical root for skill ${logicalOwner}`,
        )
      }
      claim(row.id, legacyRoot, 'legacy root')
    } else if (
      legacyIdentity !== null &&
      legacyIdentity !== canonicalIdentity &&
      !physicalOwners.has(legacyIdentity)
    ) {
      throw migrationError(
        'unclaimed-legacy-residue',
        `canonical skill ${row.id} has an unclaimed display-name directory`,
      )
    }
  }
}

async function sweepMissingLegacyHusks(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): Promise<number> {
  const candidates = await input.db
    .select({ id: skills.id, name: skills.name, managedPath: skills.managedPath })
    .from(skills)
    .where(
      and(eq(skills.reservationState, 'ready'), eq(skills.versionState, 'legacy-unbackfilled')),
    )
    .orderBy(skills.id)
    .all()
  let removed = 0
  for (const row of candidates) {
    const hasVersion =
      (await input.db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, row.id))
        .limit(1)
        .get()) !== undefined
    if (hasVersion) continue
    const canonicalRoot = skillRootAbs(input.appHome, row.id)
    const legacyRoot = legacySkillRootAbs(input.appHome, row.name)
    const canonical = await versionPathsCanonical(input.db, row)
    const roots =
      canonical && pathEntryIdentity(canonicalRoot) !== null
        ? [canonicalRoot]
        : pathEntryIdentity(canonicalRoot) !== null
          ? [canonicalRoot]
          : [legacyRoot]
    if (roots.some((root) => !dirHasNoContent(root))) continue
    const deleted = await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
      const fresh = await transaction
        .select({ versionState: skills.versionState, reservationState: skills.reservationState })
        .from(skills)
        .where(eq(skills.id, row.id))
        .get()
      const version = await transaction
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, row.id))
        .limit(1)
        .get()
      if (
        fresh?.versionState !== 'legacy-unbackfilled' ||
        fresh.reservationState !== 'ready' ||
        version !== undefined
      ) {
        return false
      }
      await transaction.delete(skills).where(eq(skills.id, row.id)).run()
      return true
    })
    if (!deleted) continue
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    removed++
  }
  return removed
}

async function migrateIdentity(
  input: { readonly db: PostgresqlDatabaseClient; readonly appHome: string },
  row: IdentityRow,
): Promise<void> {
  const oldRoot = legacySkillRootAbs(input.appHome, row.name)
  const newRoot = skillRootAbs(input.appHome, row.id)
  const oldIdentity = pathEntryIdentity(oldRoot)
  const newIdentity = pathEntryIdentity(newRoot)
  const sameEntry = oldRoot === newRoot || (oldIdentity !== null && oldIdentity === newIdentity)
  const fingerprint = fingerprintTree(oldIdentity === null ? newRoot : oldRoot)
  const opId = ulid()

  await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
    await transaction.insert(skillOperationLocks).values({ lockedSkillId: row.id, opId }).run()
    await transaction
      .insert(skillOperations)
      .values({
        opId,
        skillId: row.id,
        kind: 'migrate',
        phase: 'intent',
        active: 1,
        candidateFingerprint: fingerprint,
        preconditionJson: JSON.stringify({ skillId: row.id, legacyName: row.name }),
      })
      .run()
  })

  if (!sameEntry) renameAndSyncParent(oldRoot, newRoot)
  if (!isRealDirectory(newRoot) || fingerprintTree(newRoot) !== fingerprint) {
    throw migrationError(
      'fingerprint-mismatch',
      `skill ${row.id} changed while identity migration was in flight`,
    )
  }
  await input.db
    .update(skillOperations)
    .set({ phase: 'fs-staged' })
    .where(and(eq(skillOperations.opId, opId), eq(skillOperations.active, 1)))
    .run()
  await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
    await writeCanonicalPaths(transaction, row.id)
    await transaction
      .update(skillOperations)
      .set({ phase: 'db-committed' })
      .where(and(eq(skillOperations.opId, opId), eq(skillOperations.active, 1)))
      .run()
  })
  await runPostgresqlResourceCatalogTransaction(input.db, async (transaction) => {
    await transaction
      .update(skillOperations)
      .set({ phase: 'done', active: 0 })
      .where(eq(skillOperations.opId, opId))
      .run()
    await transaction.delete(skillOperationLocks).where(eq(skillOperationLocks.opId, opId)).run()
  })
}

async function writeCanonicalPaths(
  transaction: PostgresqlResourceCatalogTransaction,
  skillId: string,
): Promise<void> {
  const versions = await transaction
    .select({ versionIndex: skillVersions.versionIndex })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .all()
  await transaction
    .update(skills)
    .set({ managedPath: skillFilesRel(skillId) })
    .where(eq(skills.id, skillId))
    .run()
  for (const version of versions) {
    await transaction
      .update(skillVersions)
      .set({ filesPath: skillVersionRelPath(skillId, version.versionIndex) })
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.versionIndex, version.versionIndex),
        ),
      )
      .run()
  }
}

async function assertIdentityPostcondition(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): Promise<{ readonly skills: number; readonly versions: number }> {
  const active = await input.db
    .select({ opId: skillOperations.opId })
    .from(skillOperations)
    .where(eq(skillOperations.active, 1))
    .all()
  const locks = await input.db.select().from(skillOperationLocks).all()
  if (active.length > 0 || locks.length > 0) {
    throw migrationError(
      'active-operation',
      `${active.length} active operation(s) and ${locks.length} lock(s) remain after recovery`,
    )
  }
  const rows = await loadIdentityRows(input.db)
  await assertPhysicalOwnershipGraph(input.db, rows, input.appHome)
  let versions = 0
  for (const row of rows) {
    const root = skillRootAbs(input.appHome, row.id)
    if (
      !isRealDirectory(root) ||
      row.managedPath !== skillFilesRel(row.id) ||
      realDirectoryChainState(root, skillFilesAbs(input.appHome, row.id)) !== 'real-directory'
    ) {
      throw migrationError(
        'postcondition-failed',
        `skill ${row.id} does not own one canonical live filesystem root`,
      )
    }
    const versionRows = await input.db
      .select({ versionIndex: skillVersions.versionIndex, filesPath: skillVersions.filesPath })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, row.id))
      .all()
    for (const version of versionRows) {
      versions++
      const path = skillVersionAbs(input.appHome, row.id, version.versionIndex)
      if (
        version.filesPath !== skillVersionRelPath(row.id, version.versionIndex) ||
        realDirectoryChainState(root, path) !== 'real-directory'
      ) {
        throw migrationError(
          'postcondition-failed',
          `skill ${row.id} v${version.versionIndex} is not canonical`,
        )
      }
    }
  }
  assertNoOperationResidue(input.appHome)
  return { skills: rows.length, versions }
}

async function reconcileLiveFiles(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): Promise<void> {
  const rows = await input.db
    .select({ id: skills.id, contentVersion: skills.contentVersion })
    .from(skills)
    .orderBy(skills.id)
    .all()
  for (const row of rows) {
    try {
      const filesDir = skillFilesAbs(input.appHome, row.id)
      const main = join(filesDir, 'SKILL.md')
      let currentVersion = row.contentVersion
      const existingVersion = await input.db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, row.id))
        .limit(1)
        .get()
      if (existingVersion === undefined && existsSync(main)) {
        const versionDir = skillVersionAbs(input.appHome, row.id, 1)
        rmSync(versionDir, { recursive: true, force: true })
        mkdirSync(dirname(versionDir), { recursive: true })
        cpSync(filesDir, versionDir, { recursive: true })
        const contentHash = hashRegularFileTree(versionDir)
        const now = Date.now()
        const committed = await runPostgresqlResourceCatalogTransaction(
          input.db,
          async (transaction) => {
            const version = await transaction
              .select({ id: skillVersions.id })
              .from(skillVersions)
              .where(eq(skillVersions.skillId, row.id))
              .limit(1)
              .get()
            if (version !== undefined) return false
            await transaction
              .update(skills)
              .set({
                contentVersion: 1,
                versionState: 'snapshot-authoritative',
                updatedAt: now,
              })
              .where(eq(skills.id, row.id))
              .run()
            await transaction
              .insert(skillVersions)
              .values({
                id: ulid(),
                skillId: row.id,
                versionIndex: 1,
                filesPath: skillVersionRelPath(row.id, 1),
                source: 'initial',
                summary: null,
                fusionId: null,
                restoredFromVersion: null,
                authorUserId: '__system__',
                contentHash,
                createdAt: now,
              })
              .run()
            return true
          },
        )
        if (committed) {
          currentVersion = 1
          markSkillBootVerified(row.id)
        }
      }
      if (existsSync(main)) continue
      const versionDir = skillVersionAbs(input.appHome, row.id, currentVersion)
      if (!isRealDirectory(versionDir)) continue
      rmSync(filesDir, { recursive: true, force: true })
      mkdirSync(dirname(filesDir), { recursive: true })
      cpSync(versionDir, filesDir, { recursive: true })
    } catch {
      // Match the existing per-skill best-effort startup reconciler.
    }
  }
}

async function backfillLegacyVersions(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): Promise<{ readonly backfilled: number; readonly husksRemoved: number }> {
  const rows = await input.db
    .select({
      id: skills.id,
      name: skills.name,
      reservationState: skills.reservationState,
      versionState: skills.versionState,
    })
    .from(skills)
    .where(
      and(eq(skills.versionState, 'legacy-unbackfilled'), eq(skills.reservationState, 'ready')),
    )
    .orderBy(skills.id)
    .all()
  let backfilled = 0
  let husksRemoved = 0

  for (const row of rows) {
    try {
      const filesDir = skillFilesAbs(input.appHome, row.id)
      const main = join(filesDir, 'SKILL.md')
      const versionRows = await input.db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, row.id))
        .all()
      if (existsSync(main)) {
        if (versionRows.length > 0) continue
        const versionDir = skillVersionAbs(input.appHome, row.id, 1)
        rmSync(versionDir, { recursive: true, force: true })
        mkdirSync(dirname(versionDir), { recursive: true })
        cpSync(filesDir, versionDir, { recursive: true })
        const contentHash = hashRegularFileTree(versionDir)
        const now = Date.now()
        const committed = await runPostgresqlResourceCatalogTransaction(
          input.db,
          async (transaction) => {
            const fresh = await transaction
              .select({
                reservationState: skills.reservationState,
                versionState: skills.versionState,
              })
              .from(skills)
              .where(eq(skills.id, row.id))
              .get()
            const existingVersion = await transaction
              .select({ id: skillVersions.id })
              .from(skillVersions)
              .where(eq(skillVersions.skillId, row.id))
              .limit(1)
              .get()
            if (
              fresh?.reservationState !== 'ready' ||
              fresh.versionState !== 'legacy-unbackfilled' ||
              existingVersion !== undefined
            ) {
              return false
            }
            await transaction
              .update(skills)
              .set({
                contentVersion: 1,
                versionState: 'snapshot-authoritative',
                updatedAt: now,
              })
              .where(eq(skills.id, row.id))
              .run()
            await transaction
              .insert(skillVersions)
              .values({
                id: ulid(),
                skillId: row.id,
                versionIndex: 1,
                filesPath: skillVersionRelPath(row.id, 1),
                source: 'initial',
                summary: null,
                fusionId: null,
                restoredFromVersion: null,
                authorUserId: '__system__',
                contentHash,
                createdAt: now,
              })
              .run()
            return true
          },
        )
        if (committed) {
          markSkillBootVerified(row.id)
          backfilled++
        }
        continue
      }
      if (versionRows.length > 0) {
        log.warn('legacy-state skill has versions but no live SKILL.md; leaving for repair', {
          skillId: row.id,
          name: row.name,
        })
        continue
      }
      const root = skillRootAbs(input.appHome, row.id)
      if (!dirHasNoContent(root)) {
        log.warn('legacy skill has no SKILL.md but its root is not empty; leaving for repair', {
          skillId: row.id,
          name: row.name,
        })
        continue
      }
      const deleted = await runPostgresqlResourceCatalogTransaction(
        input.db,
        async (transaction) => {
          const fresh = await transaction
            .select({
              reservationState: skills.reservationState,
              versionState: skills.versionState,
            })
            .from(skills)
            .where(eq(skills.id, row.id))
            .get()
          const existingVersion = await transaction
            .select({ id: skillVersions.id })
            .from(skillVersions)
            .where(eq(skillVersions.skillId, row.id))
            .limit(1)
            .get()
          if (
            fresh?.reservationState !== 'ready' ||
            fresh.versionState !== 'legacy-unbackfilled' ||
            existingVersion !== undefined
          ) {
            return false
          }
          await transaction.delete(skills).where(eq(skills.id, row.id)).run()
          return true
        },
      )
      if (deleted) {
        rmSync(root, { recursive: true, force: true })
        husksRemoved++
      }
    } catch (error) {
      log.warn('legacy skill version backfill failed', {
        skillId: row.id,
        name: row.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return Object.freeze({ backfilled, husksRemoved })
}

async function reverifySnapshots(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): Promise<{ readonly verified: number; readonly quarantined: number }> {
  if (!isBootReverifyActive()) activateBootReverify()
  const rows = await input.db
    .select({
      id: skills.id,
      name: skills.name,
      contentVersion: skills.contentVersion,
      versionState: skills.versionState,
      reservationState: skills.reservationState,
    })
    .from(skills)
    .where(
      inArray(skills.versionState, [
        'snapshot-authoritative',
        'snapshot-unverified',
        'quarantined',
      ]),
    )
    .orderBy(skills.id)
    .all()
  let verified = 0
  let quarantined = 0
  for (const row of rows) {
    if (row.versionState === 'quarantined' && row.reservationState !== 'ready') {
      quarantined++
      continue
    }
    const outcome = await verifySnapshot(input, row)
    if (outcome === 'verified') verified++
    else if (outcome === 'quarantined') quarantined++
  }
  log.info('boot snapshot reverify complete', { verified, quarantined, scanned: rows.length })
  return Object.freeze({ verified, quarantined })
}

async function verifySnapshot(
  input: { readonly db: PostgresqlDatabaseClient; readonly appHome: string },
  skill: ReverifySkill,
): Promise<VerifyOutcome> {
  let inspected = skill
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await inspectSnapshot(input, inspected)
    const finalized = await runPostgresqlResourceCatalogTransaction(
      input.db,
      async (transaction) => {
        const current = await transaction
          .select({
            contentVersion: skills.contentVersion,
            reservationState: skills.reservationState,
          })
          .from(skills)
          .where(eq(skills.id, inspected.id))
          .get()
        if (
          current === undefined ||
          current.contentVersion !== inspected.contentVersion ||
          current.reservationState !== 'ready'
        ) {
          return false
        }
        await transaction
          .update(skills)
          .set({ versionState: result.ok ? 'snapshot-authoritative' : 'quarantined' })
          .where(
            and(eq(skills.id, inspected.id), eq(skills.contentVersion, inspected.contentVersion)),
          )
          .run()
        return true
      },
    )
    if (finalized) {
      if (result.ok) {
        markSkillBootVerified(inspected.id)
        return 'verified'
      }
      unmarkSkillBootVerified(inspected.id)
      log.warn('managed skill snapshot quarantined this boot', {
        skillId: inspected.id,
        name: inspected.name,
        reason: result.reason,
      })
      return 'quarantined'
    }
    const fresh = await input.db
      .select({ id: skills.id, name: skills.name, contentVersion: skills.contentVersion })
      .from(skills)
      .where(eq(skills.id, inspected.id))
      .get()
    if (fresh === undefined) return 'superseded'
    inspected = fresh
  }
  log.warn('managed skill snapshot verification deferred after generation churn', {
    skillId: inspected.id,
  })
  return 'superseded'
}

async function inspectSnapshot(
  input: { readonly db: PostgresqlDatabaseClient; readonly appHome: string },
  skill: ReverifySkill,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const reject = (reason: string): { readonly ok: false; readonly reason: string } => ({
    ok: false,
    reason,
  })
  try {
    const root = skillRootAbs(input.appHome, skill.id)
    const versions = await input.db
      .select({
        versionIndex: skillVersions.versionIndex,
        filesPath: skillVersions.filesPath,
        contentHash: skillVersions.contentHash,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skill.id))
      .all()
    const current = versions.find((version) => version.versionIndex === skill.contentVersion)
    if (current === undefined || current.contentHash === null) {
      return reject('no current version row / hash')
    }
    const indices = versions.map((version) => version.versionIndex).sort((a, b) => a - b)
    if (
      indices.length !== skill.contentVersion ||
      indices.some((version, offset) => version !== offset + 1)
    ) {
      return reject('version history is not the complete 1..contentVersion sequence')
    }
    for (const version of versions) {
      if (version.filesPath !== skillVersionRelPath(skill.id, version.versionIndex)) {
        return reject(`version ${version.versionIndex} path is not canonical`)
      }
      if (version.contentHash === null) {
        return reject(`version ${version.versionIndex} has no content hash`)
      }
      const dir = skillVersionAbs(input.appHome, skill.id, version.versionIndex)
      if (
        realDirectoryChainState(root, dir) !== 'real-directory' ||
        !isRegularFile(join(dir, 'SKILL.md'))
      ) {
        return reject(`version ${version.versionIndex} directory/SKILL.md is missing`)
      }
      if (hashRegularFileTree(dir) !== version.contentHash) {
        return reject(`version ${version.versionIndex} hash mismatch (tampered/corrupt)`)
      }
    }
    const live = skillFilesAbs(input.appHome, skill.id)
    if (realDirectoryChainState(root, live) !== 'real-directory') {
      return reject('canonical live files directory missing')
    }
    if (hashRegularFileTree(live) !== current.contentHash) {
      return reject('canonical live tree differs from current committed version')
    }
    return { ok: true }
  } catch (error) {
    return reject(
      `snapshot verification I/O failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function ensureSkillFilesystemBoundary(appHome: string): void {
  const root = join(appHome, 'skills')
  if (pathEntryIdentity(root) === null) mkdirSync(root, { recursive: true })
  if (!isRealDirectory(root)) {
    throw migrationError('filesystem-boundary', 'skills root is not a real directory')
  }
  const trash = join(root, '.trash')
  if (pathEntryIdentity(trash) !== null && !isRealDirectory(trash)) {
    throw migrationError('filesystem-boundary', 'skill delete trash is not a real directory')
  }
}

function assertNoOperationResidue(appHome: string): void {
  const root = join(appHome, 'skills')
  if (!existsSync(root)) return
  const trash = join(root, '.trash')
  if (existsSync(trash) && readdirSync(trash).length > 0) {
    throw migrationError('operation-residue', 'skill delete trash contains operation residue')
  }
  const residue = /^files\.op-[0-9A-HJKMNP-TV-Z]{26}\.(?:staged|backup|candidate)$/
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.trash') continue
    const skillRoot = join(root, entry.name)
    for (const child of readdirSync(skillRoot, { withFileTypes: true })) {
      if (residue.test(child.name)) {
        throw migrationError(
          'operation-residue',
          `skill operation residue remains at ${join(skillRoot, child.name)}`,
        )
      }
    }
  }
}

function pathEntryIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path)
    return `${stat.dev}:${stat.ino}`
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null
    throw migrationError('path-unreadable', `cannot prove skill path identity at ${path}`)
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false
    throw error
  }
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false
    throw error
  }
}

function dirHasNoContent(root: string): boolean {
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  } catch (error) {
    return errnoCode(error) === 'ENOENT'
  }
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return errnoCode(error) === 'ENOENT'
  }
  return entries.every((entry) => entry.isDirectory() && dirHasNoContent(join(root, entry.name)))
}

function renameAndSyncParent(from: string, to: string): void {
  renameSync(from, to)
  for (const parent of new Set([dirname(from), dirname(to)])) {
    const fd = openSync(parent, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

function migrationError(suffix: string, message: string): ValidationError {
  return new ValidationError(`skill-migration-${suffix}`, message)
}

function parseSkillOpPhase(value: string): SkillOpPhase | null {
  switch (value) {
    case 'intent':
    case 'fs-staged':
    case 'fs-captured':
    case 'fs-versioned':
    case 'fs-published':
    case 'db-committed':
    case 'done':
      return value
    default:
      return null
  }
}

function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

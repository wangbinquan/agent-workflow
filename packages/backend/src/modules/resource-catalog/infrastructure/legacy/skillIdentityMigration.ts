// RFC-223 PR-5 — the single boot/restore barrier for skill identity migration.

import { and, eq, isNull } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { skills, skillOperationLocks, skillVersions } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  decodeSkillOperationIdentity,
  skillFilesRel,
  skillVersionRelPath,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import type {
  SkillIdentityInspector,
  SkillIdentityInventoryRow,
} from '../../application/skills/identityInspector'
import { createFileSkillIdentityInspector } from '../local/fileSkillIdentityInspector'
import {
  decodeMigratePrecondition,
  migrateSkillIdentityOp,
  type SkillIdentityMigrationHooks,
} from '@/modules/resource-catalog/infrastructure/legacy/skillMigrateOp'
import { SKILL_OP_RECOVERY_REGISTRY } from '@/modules/resource-catalog/infrastructure/legacy/skillOpRegistry'
import {
  recoverSkillOperations,
  type SkillOpFsOptions,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'
import { recoveryDirection } from '@/modules/resource-catalog/infrastructure/legacy/skillOpRecovery'
import { listActiveOps } from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import type {
  SkillOperationRow,
  SkillOpPhase,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { ValidationError } from '@/util/errors'

export interface SkillIdentityMigrationReport {
  recoveredOperations: number
  removedHusks: number
  migratedSkills: number
  verifiedSkills: number
  verifiedVersions: number
}

export async function runSkillIdentityMigrationBarrier(
  db: ProviderNeutralDatabase,
  opts: SkillOpFsOptions & {
    hooks?: SkillIdentityMigrationHooks
    /** Test-only fault seam after husk DB deletion, before empty-root cleanup. */
    __beforeHuskFsCleanupForTest?: (skillId: string) => void
  },
): Promise<SkillIdentityMigrationReport> {
  const inspector = opts.identityInspector ?? createFileSkillIdentityInspector(opts.appHome)
  await inspector.prepare()
  const initialRows = await loadIdentityRows(db)
  const initialActive = await listActiveOps(db)
  await preflightPhysicalOwnershipGraph(db, initialRows, initialActive, inspector)
  await assertRecoveryPreconditions(db, initialActive, inspector)

  // Legacy reserve/delete/version-write operations must settle while their
  // name-keyed directories still exist. A missing handler throws and preserves
  // both the active row and lock; it must never degrade into "release and boot".
  const recovered = await recoverSkillOperations(db, opts, SKILL_OP_RECOVERY_REGISTRY)
  await assertNoActiveOperations(db)
  await preflightPhysicalOwnershipGraph(db, await loadIdentityRows(db), [], inspector)
  const removedHusks = await sweepMissingLegacyHusks(
    db,
    inspector,
    opts.__beforeHuskFsCleanupForTest,
  )

  const rows = await loadIdentityRows(db)
  await preflightPhysicalOwnershipGraph(db, rows, [], inspector)
  const plans: (typeof rows)[number][] = []

  // Full-graph preflight before the first rename. In particular, a canonical
  // target may currently be another row's legacy-name root (including a 2-cycle).
  // Per-row SELECT order must never decide whether that graph partially mutates.
  for (const row of rows) {
    if (await inspector.needsMigration(await identityInventoryRow(db, row))) plans.push(row)
  }

  let migratedSkills = 0
  for (const row of plans) {
    await migrateSkillIdentityOp(db, opts, row, opts.hooks)
    migratedSkills++
  }

  const verified = await assertSkillIdentityPostcondition(db, opts.appHome, inspector)
  return {
    recoveredOperations: recovered.total,
    removedHusks,
    migratedSkills,
    verifiedSkills: verified.skills,
    verifiedVersions: verified.versions,
  }
}

export async function assertSkillIdentityPostcondition(
  db: ProviderNeutralDatabase,
  appHome: string,
  inspector: SkillIdentityInspector = createFileSkillIdentityInspector(appHome),
): Promise<{ skills: number; versions: number }> {
  await assertNoActiveOperations(db)
  const locks = await db.select().from(skillOperationLocks)
  if (locks.length > 0) {
    throw new ValidationError(
      'skill-migration-operation-lock',
      `${locks.length} skill operation lock(s) remain after recovery`,
    )
  }
  const rows = await db.select().from(skills)
  await preflightPhysicalOwnershipGraph(db, rows, [], inspector)
  let versions = 0
  for (const row of rows) {
    await inspector.assertCanonicalRoot(row.id)
    if (row.managedPath !== skillFilesRel(row.id)) {
      throw new ValidationError(
        'skill-migration-postcondition-failed',
        `managed_path is not canonical for skill ${row.id}`,
      )
    }
    await inspector.assertCanonicalLive(row.id)
    const versionRows = await db
      .select({
        versionIndex: skillVersions.versionIndex,
        filesPath: skillVersions.filesPath,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, row.id))
    for (const version of versionRows) {
      versions++
      if (version.filesPath !== skillVersionRelPath(row.id, version.versionIndex)) {
        throw new ValidationError(
          'skill-migration-postcondition-failed',
          `files_path is not canonical for skill ${row.id} v${version.versionIndex}`,
        )
      }
      await inspector.assertCanonicalVersion(row.id, version.versionIndex)
    }
  }
  await inspector.assertNoResidue()
  // RFC-359 W4-D23c —— 这一条此前是 `PRAGMA foreign_key_check('skill_versions')`，只有 SQLite 有；
  // PostgreSQL 那份原生重写**整条略过**了引用完整性复核。合一时按「两种数据库都要能用、且都要是好的那份」
  // 处理：把判据改写成两个引擎都能跑的孤儿行查询——语义与 PRAGMA 对 `skill_versions` 的检查一致
  // （版本行指向了不存在的技能），PG 侧因此**补齐**了此前缺失的这道屏障。
  const orphanVersions = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .leftJoin(skills, eq(skillVersions.skillId, skills.id))
    .where(isNull(skills.id))
    .limit(1)
  if (orphanVersions.length > 0) {
    throw new ValidationError(
      'skill-migration-foreign-key-failed',
      'skill_versions contains row(s) referencing a missing skill',
    )
  }
  return { skills: rows.length, versions }
}

async function sweepMissingLegacyHusks(
  db: ProviderNeutralDatabase,
  inspector: SkillIdentityInspector,
  beforeFsCleanup?: (skillId: string) => void,
): Promise<number> {
  const allRows = await loadIdentityRows(db)
  const inventory = await loadIdentityInventory(db, allRows)
  const sweep = await inspector.prepareHuskSweep(inventory)
  const candidates = (
    await db
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .where(
        and(eq(skills.reservationState, 'ready'), eq(skills.versionState, 'legacy-unbackfilled')),
      )
  ).sort((a, b) => a.id.localeCompare(b.id))
  let removed = 0
  for (const row of candidates) {
    const hasVersion =
      (
        await db
          .select({ id: skillVersions.id })
          .from(skillVersions)
          .where(eq(skillVersions.skillId, row.id))
          .limit(1)
      )[0] !== undefined
    if (hasVersion) continue
    const plan = await sweep.plan(row)
    if (plan === null) continue
    await databaseSessionFor(db).transaction(
      async (tx) => await tx.delete(skills).where(eq(skills.id, row.id)),
    )
    beforeFsCleanup?.(row.id)
    await sweep.discard(plan)
    removed++
  }
  return removed
}

async function assertNoActiveOperations(db: ProviderNeutralDatabase): Promise<void> {
  const active = await listActiveOps(db)
  if (active.length > 0) {
    throw new ValidationError(
      'skill-migration-active-operation',
      `${active.length} skill operation(s) remain incomplete`,
    )
  }
}

async function versionPathsCanonical(
  db: ProviderNeutralDatabase,
  skillId: string,
): Promise<boolean> {
  return (
    await db
      .select({ versionIndex: skillVersions.versionIndex, filesPath: skillVersions.filesPath })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
  ).every((row) => row.filesPath === skillVersionRelPath(skillId, row.versionIndex))
}

interface IdentityRow {
  id: string
  name: string
  managedPath: string | null
}

async function loadIdentityRows(db: ProviderNeutralDatabase): Promise<IdentityRow[]> {
  return (
    await db
      .select({ id: skills.id, name: skills.name, managedPath: skills.managedPath })
      .from(skills)
  ).sort((a, b) => a.id.localeCompare(b.id))
}

async function assertRecoveryPreconditions(
  db: ProviderNeutralDatabase,
  active: SkillOperationRow[],
  inspector: SkillIdentityInspector,
): Promise<void> {
  const locks = await db
    .select({
      lockedSkillId: skillOperationLocks.lockedSkillId,
      opId: skillOperationLocks.opId,
    })
    .from(skillOperationLocks)
  for (const op of active) {
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
    await assertOperationDbAuthority(db, op, direction)
    await assertOperationContentAuthority(db, op, direction, inspector)
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

async function assertOperationContentAuthority(
  db: ProviderNeutralDatabase,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
  inspector: SkillIdentityInspector,
): Promise<void> {
  if (op.kind === 'reserve' && (op.phase === 'fs-published' || direction === 'rollforward')) {
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    const versionRow = (
      await db
        .select({ filesPath: skillVersions.filesPath, contentHash: skillVersions.contentHash })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, op.skillId), eq(skillVersions.versionIndex, 1)))
        .limit(1)
    )[0]
    const expectedPath =
      identity.legacyName === undefined
        ? skillVersionRelPath(op.skillId, 1)
        : `skills/${identity.legacyName}/versions/v1/files`
    if (
      versionRow === undefined ||
      versionRow.filesPath !== expectedPath ||
      versionRow.contentHash === null
    ) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `reserve operation ${op.opId} has no complete published v1 tree`,
      )
    }
    await inspector.assertPublishedReserve({
      ...identity,
      operationId: op.opId,
      contentHash: versionRow.contentHash,
    })
  }
  if (op.kind === 'delete' && direction === 'rollforward') {
    if (op.backupPath === null) {
      throw new ValidationError(
        'skill-migration-operation-authority-invalid',
        `delete operation ${op.opId} has no committed trash path`,
      )
    }
    const identity = decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    await inspector.assertCommittedDelete({
      ...identity,
      operationId: op.opId,
      backupReference: op.backupPath,
    })
  }
}

async function assertOperationDbAuthority(
  db: ProviderNeutralDatabase,
  op: SkillOperationRow,
  direction: 'rollback' | 'rollforward',
): Promise<void> {
  const row = (
    await db
      .select({
        name: skills.name,
        reservationState: skills.reservationState,
        contentVersion: skills.contentVersion,
        managedPath: skills.managedPath,
        versionState: skills.versionState,
      })
      .from(skills)
      .where(eq(skills.id, op.skillId))
      .limit(1)
  )[0]

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
    const versionRows = await db
      .select({
        versionIndex: skillVersions.versionIndex,
        filesPath: skillVersions.filesPath,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, op.skillId))
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
    const reserveVersions = await db
      .select({ versionIndex: skillVersions.versionIndex })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, op.skillId))
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
    const target = (
      await db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, op.skillId),
            eq(skillVersions.versionIndex, op.targetVersion),
          ),
        )
        .limit(1)
    )[0]
    const versionIndices = (
      await db
        .select({ versionIndex: skillVersions.versionIndex })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, op.skillId))
    ).map((version) => version.versionIndex)
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
      row.managedPath === skillFilesRel(op.skillId) && (await versionPathsCanonical(db, op.skillId))
    const legacyManagedPath = `skills/${identity.legacyName}/files`
    const legacyVersions = (
      await db
        .select({
          versionIndex: skillVersions.versionIndex,
          filesPath: skillVersions.filesPath,
        })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, op.skillId))
    ).every(
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

async function identityInventoryRow(
  db: ProviderNeutralDatabase,
  row: IdentityRow,
): Promise<SkillIdentityInventoryRow> {
  return {
    id: row.id,
    name: row.name,
    canonicalMetadata:
      row.managedPath === skillFilesRel(row.id) && (await versionPathsCanonical(db, row.id)),
  }
}

async function loadIdentityInventory(
  db: ProviderNeutralDatabase,
  rows: readonly IdentityRow[],
): Promise<SkillIdentityInventoryRow[]> {
  const result: SkillIdentityInventoryRow[] = []
  for (const row of rows) result.push(await identityInventoryRow(db, row))
  return result
}

async function preflightPhysicalOwnershipGraph(
  db: ProviderNeutralDatabase,
  rows: readonly IdentityRow[],
  active: readonly SkillOperationRow[],
  inspector: SkillIdentityInspector,
): Promise<void> {
  const inventory = await loadIdentityInventory(db, rows)
  const operations = active.map((op) => {
    const identity =
      op.kind === 'migrate'
        ? decodeMigratePrecondition(op)
        : decodeSkillOperationIdentity(op.preconditionJson, op.skillId)
    return {
      ...identity,
      opId: op.opId,
      kind: op.kind,
      stagingPath: op.stagingPath,
      candidatePath: op.candidatePath,
      backupPath: op.backupPath,
    }
  })
  await inspector.assertOwnership(inventory, operations)
}

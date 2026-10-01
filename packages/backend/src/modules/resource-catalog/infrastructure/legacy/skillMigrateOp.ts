// RFC-223 PR-5 — crash-safe skills/{name} -> skills/{id} migration operation.

import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { skills, skillVersions } from '@/db/schema'
import { createFileSkillIdentityContentStore } from '../local/fileSkillIdentityContentStore'
import {
  legacySkillRootAbs,
  skillFilesRel,
  skillRootAbs,
  skillVersionRelPath,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import {
  advancePhase,
  beginOperation,
  finishOperation,
  type SkillOperationRow,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import type {
  OpRecoveryHandler,
  SkillOpFsOptions,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'
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

export async function migrateSkillIdentityOp(
  db: ProviderNeutralDatabase,
  fsOpts: SkillOpFsOptions,
  skill: { id: string; name: string },
  hooks: SkillIdentityMigrationHooks = {},
): Promise<void> {
  const session = databaseSessionFor(db)
  const content = fsOpts.identityContent ?? createFileSkillIdentityContentStore(fsOpts.appHome)
  const plan = content.plan({ skillId: skill.id, legacyName: skill.name })
  const fingerprint = await content.captureSource(plan)
  const opId = await session.transaction(
    async (tx) =>
      await beginOperation(tx, {
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

  await content.move(plan, fingerprint)
  hooks.afterPhase?.('fs-moved', skill.id)
  await session.transaction(async (tx) => await advancePhase(tx, opId, 'fs-staged'))
  hooks.afterPhase?.('fs-staged', skill.id)

  await session.transaction(async (tx) => {
    await writeCanonicalPaths(tx, skill.id)
    await advancePhase(tx, opId, 'db-committed')
  })
  hooks.afterPhase?.('db-committed', skill.id)

  await session.transaction(async (tx) => await finishOperation(tx, opId))
  hooks.afterPhase?.('done', skill.id)
}

export const migrateRecoveryHandler: OpRecoveryHandler = {
  rollbackFs: async (fsOpts, op) => {
    const identity = decodeMigratePrecondition(op)
    const content = fsOpts.identityContent ?? createFileSkillIdentityContentStore(fsOpts.appHome)
    await content.rollback(content.plan(identity), op.candidateFingerprint!)
  },
  rollForwardFs: async (fsOpts, op) => {
    const identity = decodeMigratePrecondition(op)
    const content = fsOpts.identityContent ?? createFileSkillIdentityContentStore(fsOpts.appHome)
    await content.rollForward(content.plan(identity), op.candidateFingerprint!)
  },
  recoverDb: async (tx, op, dir) => {
    if (dir === 'rollforward') await writeCanonicalPaths(tx, op.skillId)
  },
}

async function writeCanonicalPaths(tx: DatabaseTransaction, skillId: string): Promise<void> {
  const rows = await tx
    .select({ versionIndex: skillVersions.versionIndex })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
  await tx
    .update(skills)
    .set({ managedPath: skillFilesRel(skillId) })
    .where(eq(skills.id, skillId))
  for (const row of rows) {
    await tx
      .update(skillVersions)
      .set({ filesPath: skillVersionRelPath(skillId, row.versionIndex) })
      .where(
        and(eq(skillVersions.skillId, skillId), eq(skillVersions.versionIndex, row.versionIndex)),
      )
  }
}

export function decodeMigratePrecondition(op: SkillOperationRow): MigratePrecondition {
  if (op.candidateFingerprint === null || !/^[0-9a-f]{64}$/.test(op.candidateFingerprint)) {
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

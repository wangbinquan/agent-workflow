import { and, desc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { developmentBundleRefs } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  RequirementBundleRefPersistence,
  RequirementBundleRefPurpose,
  RequirementBundleRefRecord,
} from '../application/ports/requirementBundleRefStore'

function purposeOf(value: string): RequirementBundleRefPurpose {
  switch (value) {
    case 'direct-submission':
    case 'requirement-bundle':
    case 'requirement-manifest':
    case 'question-set':
    case 'answer-set':
      return value
    default:
      throw new Error(`unknown development bundle-ref purpose: ${value}`)
  }
}

function retentionStateOf(value: string): RequirementBundleRefRecord['retentionState'] {
  switch (value) {
    case 'active':
    case 'expired':
      return value
    default:
      throw new Error(`unknown development bundle-ref retention state: ${value}`)
  }
}

function recordOf(row: typeof developmentBundleRefs.$inferSelect): RequirementBundleRefRecord {
  return {
    id: row.id,
    missionId: row.missionId,
    purpose: purposeOf(row.purpose),
    evidenceRef: row.evidenceRef,
    manifestDigest: row.manifestDigest,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    retentionState: retentionStateOf(row.retentionState),
    createdAt: row.createdAt,
  }
}

function valuesOf(record: RequirementBundleRefRecord): typeof developmentBundleRefs.$inferInsert {
  return { ...record }
}

export function createSqliteRequirementBundleRefPersistence(
  db: DbClient,
): RequirementBundleRefPersistence {
  return {
    async insert(record) {
      db.insert(developmentBundleRefs).values(valuesOf(record)).run()
    },
    async get(id) {
      const row = db
        .select()
        .from(developmentBundleRefs)
        .where(eq(developmentBundleRefs.id, id))
        .get()
      return row === undefined ? null : recordOf(row)
    },
    async latest(missionId, purpose) {
      const row = db
        .select()
        .from(developmentBundleRefs)
        .where(
          and(
            eq(developmentBundleRefs.missionId, missionId),
            eq(developmentBundleRefs.purpose, purpose),
          ),
        )
        .orderBy(desc(developmentBundleRefs.createdAt), desc(developmentBundleRefs.id))
        .limit(1)
        .get()
      return row === undefined ? null : recordOf(row)
    },
    async findManifest(missionId, manifestDigest) {
      const row = db
        .select()
        .from(developmentBundleRefs)
        .where(
          and(
            eq(developmentBundleRefs.missionId, missionId),
            eq(developmentBundleRefs.purpose, 'requirement-manifest'),
            eq(developmentBundleRefs.manifestDigest, manifestDigest),
          ),
        )
        .orderBy(desc(developmentBundleRefs.createdAt), desc(developmentBundleRefs.id))
        .limit(1)
        .get()
      return row === undefined ? null : recordOf(row)
    },
    async copyLatestRequirements(input) {
      return dbTxSync(db, (tx) => {
        let copied = 0
        for (const copy of input.copies) {
          const row = tx
            .select()
            .from(developmentBundleRefs)
            .where(
              and(
                eq(developmentBundleRefs.missionId, input.fromMissionId),
                eq(developmentBundleRefs.purpose, copy.purpose),
              ),
            )
            .orderBy(desc(developmentBundleRefs.createdAt), desc(developmentBundleRefs.id))
            .limit(1)
            .get()
          if (row === undefined) continue
          tx.insert(developmentBundleRefs)
            .values({
              ...row,
              id: copy.id,
              missionId: input.toMissionId,
              createdAt: input.createdAt,
            })
            .run()
          copied += 1
        }
        return copied
      })
    },
  }
}

export function createPostgresqlRequirementBundleRefPersistence(
  db: PostgresqlDatabaseClient,
): RequirementBundleRefPersistence {
  return {
    async insert(record) {
      await db.insert(developmentBundleRefs).values(valuesOf(record)).run()
    },
    async get(id) {
      const row = await db
        .select()
        .from(developmentBundleRefs)
        .where(eq(developmentBundleRefs.id, id))
        .get()
      return row === undefined ? null : recordOf(row)
    },
    async latest(missionId, purpose) {
      const row = await db
        .select()
        .from(developmentBundleRefs)
        .where(
          and(
            eq(developmentBundleRefs.missionId, missionId),
            eq(developmentBundleRefs.purpose, purpose),
          ),
        )
        .orderBy(desc(developmentBundleRefs.createdAt), desc(developmentBundleRefs.id))
        .limit(1)
        .get()
      return row === undefined ? null : recordOf(row)
    },
    async findManifest(missionId, manifestDigest) {
      const row = await db
        .select()
        .from(developmentBundleRefs)
        .where(
          and(
            eq(developmentBundleRefs.missionId, missionId),
            eq(developmentBundleRefs.purpose, 'requirement-manifest'),
            eq(developmentBundleRefs.manifestDigest, manifestDigest),
          ),
        )
        .orderBy(desc(developmentBundleRefs.createdAt), desc(developmentBundleRefs.id))
        .limit(1)
        .get()
      return row === undefined ? null : recordOf(row)
    },
    async copyLatestRequirements(input) {
      return await db.transaction(async (tx) => {
        let copied = 0
        for (const copy of input.copies) {
          const row = await tx
            .select()
            .from(developmentBundleRefs)
            .where(
              and(
                eq(developmentBundleRefs.missionId, input.fromMissionId),
                eq(developmentBundleRefs.purpose, copy.purpose),
              ),
            )
            .orderBy(desc(developmentBundleRefs.createdAt), desc(developmentBundleRefs.id))
            .limit(1)
            .get()
          if (row === undefined) continue
          await tx
            .insert(developmentBundleRefs)
            .values({
              ...row,
              id: copy.id,
              missionId: input.toMissionId,
              createdAt: input.createdAt,
            })
            .run()
          copied += 1
        }
        return copied
      })
    },
  }
}

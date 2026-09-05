// RFC-359 W4-D12 —— requirement bundle 指针行的持久化：一份实现，两个 provider 共用。

import { and, desc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { developmentBundleRefs } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
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

function latestOf(missionId: string, purpose: RequirementBundleRefPurpose) {
  return {
    where: and(
      eq(developmentBundleRefs.missionId, missionId),
      eq(developmentBundleRefs.purpose, purpose),
    ),
    order: [desc(developmentBundleRefs.createdAt), desc(developmentBundleRefs.id)] as const,
  }
}

export function createRequirementBundleRefPersistence(
  db: ProviderNeutralDatabase,
): RequirementBundleRefPersistence {
  const session = databaseSessionFor(db)
  return {
    async insert(record) {
      await db.insert(developmentBundleRefs).values(valuesOf(record))
    },
    async get(id) {
      const row = (
        await db
          .select()
          .from(developmentBundleRefs)
          .where(eq(developmentBundleRefs.id, id))
          .limit(1)
      )[0]
      return row === undefined ? null : recordOf(row)
    },
    async latest(missionId, purpose) {
      const query = latestOf(missionId, purpose)
      const row = (
        await db
          .select()
          .from(developmentBundleRefs)
          .where(query.where)
          .orderBy(...query.order)
          .limit(1)
      )[0]
      return row === undefined ? null : recordOf(row)
    },
    async findManifest(missionId, manifestDigest) {
      const row = (
        await db
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
      )[0]
      return row === undefined ? null : recordOf(row)
    },
    async copyLatestRequirements(input) {
      // 逐 purpose 取源 mission 的最新指针复制到目标 mission；整组在一笔事务里，读写同一快照。
      return await session.transaction(async (tx) => {
        let copied = 0
        for (const copy of input.copies) {
          const query = latestOf(input.fromMissionId, copy.purpose)
          const row = (
            await tx
              .select()
              .from(developmentBundleRefs)
              .where(query.where)
              .orderBy(...query.order)
              .limit(1)
          )[0]
          if (row === undefined) continue
          await tx.insert(developmentBundleRefs).values({
            ...row,
            id: copy.id,
            missionId: input.toMissionId,
            createdAt: input.createdAt,
          })
          copied += 1
        }
        return copied
      })
    },
  }
}

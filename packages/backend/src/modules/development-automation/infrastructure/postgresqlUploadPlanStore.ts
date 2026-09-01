import { asc, eq } from 'drizzle-orm'

import {
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { UploadPlanRead } from './sqliteUploadPlanStore'

function contentPolicyOf(value: string): 'preserve-upload' | 'agent-editable' {
  if (value === 'preserve-upload' || value === 'agent-editable') return value
  throw new Error(`invalid upload content policy: ${value}`)
}

function fileModeOf(value: string): 'regular' | 'executable' {
  if (value === 'regular' || value === 'executable') return value
  throw new Error(`invalid upload target file mode: ${value}`)
}

function dispositionOf(kind: string): 'create' | 'replace' | 'already-present' {
  if (kind === 'absent') return 'create'
  if (kind === 'exact-file') return 'replace'
  return 'already-present'
}

export async function readPostgresqlUploadPlan(
  db: PostgresqlDatabaseClient,
  planId: string,
): Promise<UploadPlanRead | null> {
  const plan = await db
    .select({
      planDigest: developmentRepositoryUploadPlans.planDigest,
      baselineSha: developmentRepositoryUploadPlans.baselineSha,
    })
    .from(developmentRepositoryUploadPlans)
    .where(eq(developmentRepositoryUploadPlans.id, planId))
    .limit(1)
    .get()
  if (plan === undefined) return null
  const rows = await db
    .select()
    .from(developmentRepositoryUploadPlanEntries)
    .where(eq(developmentRepositoryUploadPlanEntries.planId, planId))
    .orderBy(asc(developmentRepositoryUploadPlanEntries.ordinal))
    .all()
  return {
    planDigest: plan.planDigest,
    baselineSha: plan.baselineSha,
    entries: rows.map((row) => ({
      ordinal: row.ordinal,
      fileId: row.fileId,
      targetPath: row.repositoryTargetPath,
      contentPolicy: contentPolicyOf(row.contentPolicy),
      fileMode: fileModeOf(row.targetFileMode),
      disposition: dispositionOf(row.expectedTargetKind),
      uploadSha256: row.uploadSha256,
    })),
  }
}

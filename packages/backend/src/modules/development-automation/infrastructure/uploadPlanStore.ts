// RFC-310 PR-3 T36a —— RepositoryUploadPlan 落库（launch 事务内调用）。RFC-359 W4-B5：一份实现，两个 provider 共用。
//
// plan 一经写入不可修改（design §5.4）；本模块只有 insert 与只读 read，
// 没有 update。PR-4：read 供 attempt 编排定位 seed 目录（seedsRoot 下按
// planDigest 命名——mission 行存的 uploadPlacementRef 是 seedTreeDigest，
// 不是目录名）与 validator/candidate 的上传合同对拍。

import { asc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
} from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { PersistUploadPlanInput } from '../application/uploadPlan'

/** 在调用方的事务里落 plan + 有序 entries（launch 事务的一部分）。 */
export async function insertUploadPlan(
  tx: DatabaseTransaction | ProviderNeutralDatabase,
  input: PersistUploadPlanInput,
): Promise<void> {
  await tx.insert(developmentRepositoryUploadPlans).values({
    id: input.planId,
    missionId: input.missionId,
    missionRevision: input.missionRevision,
    repositoryId: input.repositoryId,
    baselineSnapshotRef: input.baselineSnapshotRef,
    baselineSha: input.baselineSha,
    planDigest: input.planDigest,
    createdAt: input.createdAt,
  })
  if (input.entries.length === 0) return
  await tx.insert(developmentRepositoryUploadPlanEntries).values(
    input.entries.map((entry) => ({
      planId: input.planId,
      ordinal: entry.ordinal,
      fileId: entry.fileId,
      uploadBlobRef: entry.uploadBlobRef,
      uploadSha256: entry.uploadSha256,
      repositoryTargetPath: entry.repositoryTargetPath,
      contentPolicy: entry.contentPolicy,
      targetFileMode: entry.targetFileMode,
      expectedTargetKind: entry.expectedTarget.kind,
      expectedTargetSha256:
        entry.expectedTarget.kind === 'absent' ? null : entry.expectedTarget.sha256,
      expectedTargetFileMode:
        entry.expectedTarget.kind === 'absent' ? null : entry.expectedTarget.fileMode,
    })),
  )
}

export interface UploadPlanRead {
  readonly planDigest: string
  readonly baselineSha: string
  readonly entries: readonly {
    readonly ordinal: number
    readonly fileId: string
    readonly targetPath: string
    readonly contentPolicy: 'preserve-upload' | 'agent-editable'
    readonly fileMode: 'regular' | 'executable'
    readonly disposition: 'create' | 'replace' | 'already-present'
    readonly uploadSha256: string
  }[]
}

function contentPolicyOf(value: string): 'preserve-upload' | 'agent-editable' {
  if (value === 'preserve-upload' || value === 'agent-editable') return value
  throw new Error(`invalid upload content policy: ${value}`)
}

function fileModeOf(value: string): 'regular' | 'executable' {
  if (value === 'regular' || value === 'executable') return value
  throw new Error(`invalid upload target file mode: ${value}`)
}

/** expectedTarget.kind → lineage disposition（resolveUploadPlanEntries 的判定投影）。 */
function dispositionOf(kind: string): 'create' | 'replace' | 'already-present' {
  if (kind === 'absent') return 'create'
  if (kind === 'exact-file') return 'replace'
  return 'already-present'
}

export async function readUploadPlan(
  db: ProviderNeutralDatabase,
  planId: string,
): Promise<UploadPlanRead | null> {
  const plan = (
    await db
      .select({
        planDigest: developmentRepositoryUploadPlans.planDigest,
        baselineSha: developmentRepositoryUploadPlans.baselineSha,
      })
      .from(developmentRepositoryUploadPlans)
      .where(eq(developmentRepositoryUploadPlans.id, planId))
      .limit(1)
  )[0]
  if (plan === undefined) return null
  const rows = await db
    .select()
    .from(developmentRepositoryUploadPlanEntries)
    .where(eq(developmentRepositoryUploadPlanEntries.planId, planId))
    .orderBy(asc(developmentRepositoryUploadPlanEntries.ordinal))
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

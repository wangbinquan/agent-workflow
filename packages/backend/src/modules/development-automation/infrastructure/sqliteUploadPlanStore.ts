// RFC-310 PR-3 T36a —— RepositoryUploadPlan 落库（launch 事务内调用）。
//
// plan 一经写入不可修改（design §5.4）；本模块只有 insert 与只读 read，
// 没有 update。PR-4：read 供 attempt 编排定位 seed 目录（seedsRoot 下按
// planDigest 命名——mission 行存的 uploadPlacementRef 是 seedTreeDigest，
// 不是目录名）与 validator/candidate 的上传合同对拍。

import { asc, eq } from 'drizzle-orm'

import {
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
} from '@/db/schema'
import type { DbClient } from '@/db/client'
import type { PersistUploadPlanInput } from '../application/uploadPlan'

export function insertUploadPlan(db: DbClient, input: PersistUploadPlanInput): void {
  db.insert(developmentRepositoryUploadPlans)
    .values({
      id: input.planId,
      missionId: input.missionId,
      missionRevision: input.missionRevision,
      repositoryId: input.repositoryId,
      baselineSnapshotRef: input.baselineSnapshotRef,
      baselineSha: input.baselineSha,
      planDigest: input.planDigest,
      createdAt: input.createdAt,
    })
    .run()
  for (const entry of input.entries) {
    db.insert(developmentRepositoryUploadPlanEntries)
      .values({
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
      })
      .run()
  }
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

/** expectedTarget.kind → lineage disposition（resolveUploadPlanEntries 的判定投影）。 */
function dispositionOf(kind: string): 'create' | 'replace' | 'already-present' {
  if (kind === 'absent') return 'create'
  if (kind === 'exact-file') return 'replace'
  return 'already-present'
}

export function readUploadPlan(db: DbClient, planId: string): UploadPlanRead | null {
  const plan = db
    .select({
      planDigest: developmentRepositoryUploadPlans.planDigest,
      baselineSha: developmentRepositoryUploadPlans.baselineSha,
    })
    .from(developmentRepositoryUploadPlans)
    .where(eq(developmentRepositoryUploadPlans.id, planId))
    .get()
  if (plan === undefined) return null
  const entries = db
    .select()
    .from(developmentRepositoryUploadPlanEntries)
    .where(eq(developmentRepositoryUploadPlanEntries.planId, planId))
    .orderBy(asc(developmentRepositoryUploadPlanEntries.ordinal))
    .all()
    .map((row) => ({
      ordinal: row.ordinal,
      fileId: row.fileId,
      targetPath: row.repositoryTargetPath,
      contentPolicy: row.contentPolicy as 'preserve-upload' | 'agent-editable',
      fileMode: row.targetFileMode as 'regular' | 'executable',
      disposition: dispositionOf(row.expectedTargetKind),
      uploadSha256: row.uploadSha256,
    }))
  return { planDigest: plan.planDigest, baselineSha: plan.baselineSha, entries }
}

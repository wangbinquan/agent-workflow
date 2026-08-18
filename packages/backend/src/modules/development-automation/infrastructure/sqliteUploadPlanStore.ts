// RFC-310 PR-3 T36a —— RepositoryUploadPlan 落库（launch 事务内调用）。
//
// plan 一经写入不可修改（design §5.4）；本模块只有 insert，没有 update。

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

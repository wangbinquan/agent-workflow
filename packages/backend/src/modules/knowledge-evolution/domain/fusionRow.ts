// RFC-353 T4（RFC-294 W4-E3）—— 持久化行 → 对外 `Fusion` 视图的纯映射。
//
// 从 `services/fusion.ts` 逐字平移。JSON 列的容错解析（坏 JSON 一律降级成空集 / null）
// 是既有行为，**不在本刀收紧**——收紧它会让存量脏数据从「少显示几条」变成「整个融合打不开」。

import type { Fusion, FusionSkipped, FusionStatus } from '@agent-workflow/shared'

/** 坏 JSON / 非数组 / 非字符串项一律丢弃，绝不抛——这是列表页的取数路径。 */
export function jsonArray(s: string | null): string[] {
  if (s === null) return []
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function rowToFusion(row: FusionPersistenceRecord): Fusion {
  let skipped: FusionSkipped[] | null = null
  if (row.skippedJson !== null) {
    try {
      const v = JSON.parse(row.skippedJson) as unknown
      if (Array.isArray(v)) skipped = v as FusionSkipped[]
    } catch {
      skipped = null
    }
  }
  return {
    id: row.id,
    skillId: row.skillId,
    skillName: row.skillName,
    baseSkillVersion: row.baseSkillVersion,
    memoryIds: jsonArray(row.memoryIdsJson),
    intent: row.intent,
    status: row.status as FusionStatus,
    iteration: row.iteration,
    currentTaskId: row.currentTaskId,
    proposedDiff: row.proposedDiff,
    incorporatedMemoryIds:
      row.incorporatedMemoryIdsJson === null ? null : jsonArray(row.incorporatedMemoryIdsJson),
    skipped,
    changelog: row.changelog,
    appliedSkillVersion: row.appliedSkillVersion,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    error: row.error,
  }
}

// RFC-552 (RFC-294 S9): moved from `public/types` (no other module read it); the stored fusion row this file maps.
export interface FusionPersistenceRecord {
  readonly id: string
  readonly skillId: string
  readonly skillName: string
  readonly baseSkillVersion: number
  readonly preconditionToken: string | null
  readonly memoryIdsJson: string
  readonly intent: string
  readonly status: FusionStatus
  readonly iteration: number
  readonly currentTaskId: string | null
  readonly proposedWorktreePath: string | null
  readonly proposedDiff: string | null
  readonly incorporatedMemoryIdsJson: string | null
  readonly skippedJson: string | null
  readonly changelog: string | null
  readonly appliedSkillVersion: number | null
  readonly ownerUserId: string
  readonly createdAt: number
  readonly decidedByUserId: string | null
  readonly decidedAt: number | null
  readonly decisionReason: string | null
  readonly error: string | null
}

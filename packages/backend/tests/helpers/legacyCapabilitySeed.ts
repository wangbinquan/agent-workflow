// RFC-310 PR-10 T105 —— legacy code-capability 的**测试种子**。
//
// 生产写面（enable/bulk-enable 命令、trigger 同步、delivery chain 写点）随
// writer 一并删除；两张表仍在（历史 matrix 与投递链是 T103「查询仍可追溯」的
// 数据源）。读面测试需要行才能断言，于是种子搬到测试侧：这里直接写表，绝不
// 让生产代码保留一个没有调用者的写入口。
//
// readiness 是**读时派生**（codeMatrixQuery），所以种子只落存量列的形状，不
// 复刻已删 upsert 里的派生逻辑。

import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { codeTriggerDeliveries, repoCapabilityConfig } from '@/db/schema'

export async function seedCapabilityCell(
  db: DbClient,
  input: {
    readonly repoId: string
    readonly capability: string
    readonly templateId: string | null
    readonly enabled: boolean
    readonly triggerConfig?: Readonly<Record<string, unknown>>
    readonly readiness?: 'ready' | 'misconfigured' | 'disabled'
    readonly readinessIssues?: readonly unknown[]
    readonly dependencyRevision?: number
    readonly now?: number
  },
): Promise<void> {
  const now = input.now ?? Date.now()
  const values = {
    id: ulid(),
    repoId: input.repoId,
    capability: input.capability,
    templateId: input.templateId,
    enabled: input.enabled,
    triggerConfigJson: JSON.stringify(input.triggerConfig ?? {}),
    readiness: input.readiness ?? (input.enabled ? 'ready' : 'disabled'),
    readinessIssuesJson: JSON.stringify(input.readinessIssues ?? []),
    dependencyRevision: input.dependencyRevision ?? 1,
    lastValidatedAt: now,
    createdAt: now,
    updatedAt: now,
  }
  await db
    .insert(repoCapabilityConfig)
    .values(values)
    .onConflictDoUpdate({
      target: [repoCapabilityConfig.repoId, repoCapabilityConfig.capability],
      set: {
        templateId: values.templateId,
        enabled: values.enabled,
        triggerConfigJson: values.triggerConfigJson,
        readiness: values.readiness,
        readinessIssuesJson: values.readinessIssuesJson,
        dependencyRevision: values.dependencyRevision,
        lastValidatedAt: now,
        updatedAt: now,
      },
    })
}

export async function seedDelivery(
  db: DbClient,
  input: {
    readonly correlationId: string
    readonly codeHostEndpointId?: string | null
    readonly stableProjectId?: string | null
    readonly anchorKind?: string | null
    readonly anchorId?: string | null
    readonly step: string
    readonly outcome: string
    readonly reason?: string | null
    readonly capability?: string | null
    readonly roundId?: string | null
    readonly isProbe?: boolean
    readonly now?: number
  },
): Promise<string> {
  const id = ulid()
  const now = input.now ?? Date.now()
  await db.insert(codeTriggerDeliveries).values({
    id,
    correlationId: input.correlationId,
    codeHostEndpointId: input.codeHostEndpointId ?? null,
    stableProjectId: input.stableProjectId ?? null,
    anchorKind: input.anchorKind ?? null,
    anchorId: input.anchorId ?? null,
    capability: input.capability ?? null,
    step: input.step,
    outcome: input.outcome,
    reason: input.reason ?? null,
    roundId: input.roundId ?? null,
    isProbe: input.isProbe ?? false,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

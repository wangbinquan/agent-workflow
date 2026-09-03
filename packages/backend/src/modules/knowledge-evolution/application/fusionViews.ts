// RFC-353 T8（RFC-294 W4-E3）—— 融合的**可见性收口**：列表 / 待办计数 / 详情共用一条判据。
//
// 归位理由：这三件事此前都在 `routes/fusions.ts` 的 handler 里手写，路由因而不只是
// decode-call-map，还自持了「谁看得见什么」的业务判断（RFC-294 对 inbound 层的要求是
// 只做解码、调用与映射）。搬到 application 之后，路由只剩「把 viewer 解出来交进去」。

import type { Fusion } from '@agent-workflow/shared'

import { canViewFusion, visibleFusions, type FusionViewer } from '../domain/fusionVisibility'
import {
  awaitingApprovalFusionOwners,
  getFusion,
  listFusionSummaries,
  type FusionDeps,
} from './fusionOrchestration'
import type { FusionStatus } from '@agent-workflow/shared'

export type { FusionViewer }

export async function listVisibleFusionSummaries(
  deps: FusionDeps,
  viewer: FusionViewer,
  filter: { skillId?: string; status?: FusionStatus } = {},
): Promise<Fusion[]> {
  return visibleFusions(viewer, await listFusionSummaries(deps, filter))
}

export async function countVisibleAwaitingApprovalFusions(
  deps: FusionDeps,
  viewer: FusionViewer,
): Promise<number> {
  return visibleFusions(viewer, await awaitingApprovalFusionOwners(deps)).length
}

/**
 * 详情：**不可见与不存在同形**（RFC-099 的存在性隔离）——返回 null，由调用方统一
 * 抛同一个 404。判据与列表过滤共用 `canViewFusion`，不可能出现「列表里有、详情 404」。
 */
export async function getVisibleFusion(
  deps: FusionDeps,
  viewer: FusionViewer,
  id: string,
): Promise<Fusion | null> {
  const fusion = await getFusion(deps, id)
  if (fusion === null || !canViewFusion(viewer, fusion.ownerUserId)) return null
  return fusion
}

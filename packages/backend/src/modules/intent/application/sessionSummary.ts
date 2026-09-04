// RFC-355 T8（RFC-294 W4-E4a）—— 会话行 → `IntentSessionSummary` 的投影。
//
// 三个出口（创建 / 列表 / 详情）此前各自在 `routes/intentSessions.ts` 里调同一个
// 路由私有的 `sessionSummary`，其中列表那条还内联着一份「行字段 → journey 入参」的
// 展开。投影是 application 的活，不是投递细节；收到这里之后三个出口共用一份。
//
// **出参形状一字未改**（RFC-355 design §6 的 wire 面冻结）。

import type { IntentJourneySnapshot, IntentSessionSummary } from '@agent-workflow/shared'
import { projectIntentJourney } from '../domain/journey'
import type { IntentSessionRow } from './session'

export function intentSessionSummaryOf(
  row: IntentSessionRow & { currentDraftRevision?: number | null },
  opts: {
    includeOwner: boolean
    journey: IntentJourneySnapshot
    currentDraftRevision?: number | null
  },
): IntentSessionSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    contextRevision: row.contextRevision,
    turnSeq: row.turnSeq,
    commitSeq: row.commitSeq,
    inFlight: row.inFlightTurnId !== null,
    currentDraftRevision: opts.currentDraftRevision ?? row.currentDraftRevision ?? null,
    journey: opts.journey,
    ...(opts.includeOwner ? { ownerUserId: row.ownerUserId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 列表行自带的扁平字段 → journey 入参。只有列表这一条路径有这些字段。 */
export function intentSessionListJourneyOf(row: {
  status: IntentSessionRow['status']
  contextRevision: number
  commitSeq: number
  inFlightTurnId: string | null
  latestAgentTurnKind: IntentJourneySnapshot extends never ? never : string | null
  currentDraftId: string | null
  currentDraftContextRevision: number | null
  currentDraftValidationErrors: readonly string[]
  latestCommit: { draftId: string; state: string } | null
}): IntentJourneySnapshot {
  return projectIntentJourney({
    status: row.status,
    contextRevision: row.contextRevision,
    commitSeq: row.commitSeq,
    inFlight: row.inFlightTurnId !== null,
    ...(row.latestAgentTurnKind === null
      ? {}
      : { latestAgentTurnKind: row.latestAgentTurnKind as never }),
    currentDraft:
      row.currentDraftId === null || row.currentDraftContextRevision === null
        ? null
        : {
            id: row.currentDraftId,
            contextRevision: row.currentDraftContextRevision,
            validationErrors: row.currentDraftValidationErrors,
          },
    ...(row.latestCommit === null ? {} : { latestCommit: row.latestCommit as never }),
  })
}

/** 刚创建、首轮已在跑的会话：journey 的取值是常量。 */
export function newIntentSessionJourney(session: {
  status: IntentSessionRow['status']
  contextRevision: number
  commitSeq: number
}): IntentJourneySnapshot {
  return projectIntentJourney({
    status: session.status,
    contextRevision: session.contextRevision,
    commitSeq: session.commitSeq,
    inFlight: true,
    latestAgentTurnKind: 'running',
    currentDraft: null,
  })
}

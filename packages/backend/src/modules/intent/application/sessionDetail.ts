// RFC-355 T8（RFC-294 W4-E4a）—— 会话详情的投影编排。
//
// 这 ~180 行此前整段内联在 `routes/intentSessions.ts` 的 GET `/api/intent-sessions/:id`
// handler 里：加载轮次 / 提交 / 草稿 / 工作集 / 已挂载项 / 可见资源，再算出草稿生命周期、
// 挂载建议、composer 与 retry 来源。全是 application 的活；路由收成 decode-call-map 之后
// 只负责解出 actor + sessionId、调这一个函数、把结果 `c.json` 出去。
//
// 两处纯判据进了 domain：`intentDraftLifecycleOf`（草稿三档）与 `intentMountSuggestionsOf`
// （该不该出建议、候选是哪些）。其余步骤是编排，留在这里。
//
// **出参形状一字未改**：`IntentSessionDetail` 的每个字段与迁位前逐字相同（RFC-355 design §6
// 的 wire 面冻结），契约注册表与 e2e 双锁。

import {
  IntentApplyReceiptSchema,
  IntentDraftDtoSchema,
  IntentMountRequestsSchema,
  parseIntentChangeset,
  type IntentDraftDto,
  type IntentSessionDetail,
  type IntentTurnDto,
} from '@agent-workflow/shared'
import { z } from 'zod'
import type { Actor } from '@/auth/actor'
import type { IntentPersistence } from '@/modules/intent/application/ports/intentPersistence'
import { intentDraftLifecycleOf } from '../domain/draftLifecycle'
import { intentMountSuggestionsOf } from '../domain/mountSuggestions'
import { projectIntentJourney } from '../domain/journey'
import { deriveIntentSlots } from './resolveChangeset'
import { getIntentSessionForActor, listIntentTurns, sessionManifest } from './session'
import { intentSessionSummaryOf } from './sessionSummary'
import { projectIntentTurnExecution } from './turnSession'
import { getLatestIntentWorkingSetChange, projectIntentWorkingSetChange } from './workingSet'
import { listVisibleIntentResources, type IntentResourceCatalogBinding } from './resourceCatalog'

/** Zod-validated JSON-record parse——不 `as`-cast（RFC-054 W1-7）。 */
const JsonRecordSchema = z.record(z.string(), z.unknown())
function parseJsonRecord(text: string): Record<string, unknown> {
  return JsonRecordSchema.parse(JSON.parse(text))
}

export async function projectIntentSessionDetail(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  catalog: IntentResourceCatalogBinding,
): Promise<IntentSessionDetail> {
  const session = await getIntentSessionForActor(persistence, actor, sessionId)
  const turns = await listIntentTurns(persistence, session.id)
  const turnDtos: IntentTurnDto[] = turns.map((t) => ({
    id: t.id,
    seq: t.seq,
    role: t.role,
    kind: t.kind,
    content: parseJsonRecord(t.contentJson),
    contextRevision: t.contextRevision,
    runMeta: t.runMetaJson === null ? null : parseJsonRecord(t.runMetaJson),
    scratchRetained: t.scratchRetained,
    execution: projectIntentTurnExecution(t),
    createdAt: t.createdAt,
  }))
  const detailArtifacts = await persistence.loadSessionDetailArtifacts(session.id)
  const commits = detailArtifacts.commits
    .map((row) => ({
      journalId: row.id,
      draftId: row.draftId,
      state: row.state,
      receipt:
        row.receiptJson === null
          ? null
          : IntentApplyReceiptSchema.parse(JSON.parse(row.receiptJson)),
      error: row.error,
      createdAt: row.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt || b.journalId.localeCompare(a.journalId))
  const workingSetRow = await getLatestIntentWorkingSetChange(persistence, session.id)
  const draftRows = detailArtifacts.drafts
  const resolutionRows = detailArtifacts.resolutions
  const resolutionByDraft = new Map(
    resolutionRows.map((resolution) => [resolution.draftId, resolution.reason]),
  )
  const committedSeqByDraft = new Map<string, number>()
  for (const commit of commits) {
    if (commit.state === 'committed' && commit.receipt !== null) {
      committedSeqByDraft.set(commit.draftId, commit.receipt.commitSeq)
    }
  }
  const drafts: IntentDraftDto[] = draftRows
    .map((draft): IntentDraftDto => {
      const parsedChangeset = parseIntentChangeset(draft.changesetJson)
      const slots = parsedChangeset.ok
        ? deriveIntentSlots(sessionManifest(session), parsedChangeset.changeset).slots
        : []
      const commitSeq = committedSeqByDraft.get(draft.id) ?? null
      const lifecycle = intentDraftLifecycleOf({
        isCurrent: session.currentDraftId === draft.id,
        commitSeq,
        resolution: resolutionByDraft.get(draft.id),
      })
      return {
        id: draft.id,
        revision: draft.revision,
        changeset: JSON.parse(draft.changesetJson),
        validation: IntentDraftDtoSchema.shape.validation.parse(JSON.parse(draft.validationJson)),
        slots,
        draftHash: draft.draftHash,
        contextRevision: draft.contextRevision,
        stale: draft.contextRevision !== session.contextRevision,
        lifecycle,
        activity:
          lifecycle === 'current' && session.inFlightTurnId !== null ? 'generating' : 'idle',
        commitSeq,
        createdAt: draft.createdAt,
      }
    })
    .sort((a, b) => b.revision - a.revision || b.id.localeCompare(a.id))
  const currentDraft = drafts.find((draft) => draft.lifecycle === 'current') ?? null
  const visibleResources = await listVisibleIntentResources(catalog)
  const visibleByKey = new Map(
    visibleResources.map((resource) => [
      `${resource.resourceType}:${resource.resourceId}`,
      resource,
    ]),
  )
  const mounts = sessionManifest(session)
    .filter((entry) => entry.root)
    .map((entry) => ({
      handle: entry.handle,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      displayName: visibleByKey.get(`${entry.resourceType}:${entry.resourceId}`)?.name ?? null,
      detail: entry.detail,
    }))
  const latestAgentTurn = [...turnDtos].reverse().find((turn) => turn.role === 'agent')
  const hasLaterApproval =
    latestAgentTurn === undefined
      ? false
      : turnDtos.some((turn) => turn.kind === 'mount-approval' && turn.seq > latestAgentTurn.seq)
  const parsedMountRequests =
    latestAgentTurn === undefined
      ? null
      : IntentMountRequestsSchema.safeParse(latestAgentTurn.content.mountRequests)
  const mountSuggestions = intentMountSuggestionsOf({
    latestAgentTurn:
      latestAgentTurn === undefined
        ? undefined
        : {
            id: latestAgentTurn.id,
            seq: latestAgentTurn.seq,
            kind: latestAgentTurn.kind,
            contextRevision: latestAgentTurn.contextRevision,
            mountRequests:
              parsedMountRequests !== null && parsedMountRequests.success
                ? parsedMountRequests.data
                : null,
          },
    hasLaterApproval,
    sessionContextRevision: session.contextRevision,
    mounted: mounts,
    visibleResources,
  })
  const journey = projectIntentJourney({
    status: session.status,
    contextRevision: session.contextRevision,
    commitSeq: session.commitSeq,
    inFlight: session.inFlightTurnId !== null,
    ...(latestAgentTurn === undefined ? {} : { latestAgentTurnKind: latestAgentTurn.kind }),
    currentDraft:
      currentDraft === null
        ? null
        : {
            id: currentDraft.id,
            contextRevision: currentDraft.contextRevision,
            validationErrors: currentDraft.validation.errors,
          },
    ...(commits[0] === undefined
      ? {}
      : { latestCommit: { draftId: commits[0].draftId, state: commits[0].state } }),
    workingSetChange: workingSetRow === null ? null : { state: workingSetRow.state },
  })
  const detail: IntentSessionDetail = {
    session: {
      ...intentSessionSummaryOf(session, {
        includeOwner: session.ownerUserId !== actor.user.id,
        journey,
        currentDraftRevision: currentDraft?.revision ?? null,
      }),
    },
    mounts,
    workingSetChange: workingSetRow === null ? null : projectIntentWorkingSetChange(workingSetRow),
    mountSuggestions,
    turns: turnDtos,
    currentDraft,
    drafts,
    composerSource:
      currentDraft !== null
        ? { kind: 'current-draft', draftId: currentDraft.id, revision: currentDraft.revision }
        : session.commitSeq > 0
          ? { kind: 'latest-checkpoint', commitSeq: session.commitSeq }
          : { kind: 'conversation' },
    retrySource:
      latestAgentTurn?.kind === 'error' && session.inFlightTurnId === null
        ? { turnId: latestAgentTurn.id, turnSeq: latestAgentTurn.seq }
        : null,
    commits,
  }
  return detail
}

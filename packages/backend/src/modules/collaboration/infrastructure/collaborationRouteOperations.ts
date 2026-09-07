// RFC-359 W7 —— 协作路由持久化面（`CollaborationRoutePersistenceOperations`）：
// **一份实现，两个 provider 共用**。
//
// 合一前这里是一对适配器：`sqliteCollaborationRouteOperations.ts`（116 行纯转发，逐方法打到
// `legacySqlite*` 的实现上）与 `postgresqlCollaborationRouteOperations.ts`（2269 行把同一批
// 语义用原生 drizzle 重写了一遍）。20 个方法一一对应、**没有能力缺口**，但重写就是漂移的前提
// ——2026-09-07 的双引擎对拍当场照出两处真实分叉：
//
//   · `reviews.setSelection` 与 `clarify.saveDraft` 在 PG 那份里跑在裸 `db.transaction`
//     （`serializable()` 帮手）上，因此**不可重入**：在外层显式事务里调用它们会另开一条连接、
//     独立提交，外层回滚**带不走**它的写（实测：SQLite 回滚后 'unselected' / 无草稿，
//     PG 回滚后 'accepted' / 草稿仍在）。SQLite 侧走 `databaseSessionFor` 则两边都正确。
//
// 正典是被转发的那批实现——`legacySqliteReview.ts` / `legacySqliteTaskQuestions.ts` /
// `legacySqliteClarifyRounds.ts` / `legacySqliteClarify/seal.ts`。它们的写事务已经全部跑在
// `databaseSessionFor(db).transaction` 上（RFC-359 W1-T2a/b/c 把同一批文件里的决定 / 派发 /
// 快速澄清三条命令链路合一时就是这么做的，PostgreSQL daemon 今天就在用它们），本刀只补上
// 剩下的四处 `dbTxSync`（reassign ×3、saveDraft ×1）。
//（那些文件名的 `legacySqlite` 前缀早已名不副实，改名会牵动别的守卫，留给后续刀口。）

import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  CollaborationClarifyDraftEventPublisher,
  CollaborationRoutePersistenceOperations,
} from '../application/ports/collaborationRouteOperations'

// 决定 / 评审域的实现经 `services/humanGateComposition` 绕回 collaboration 的 composition
// barrel，静态 import 会形成值环——与合一前的 SQLite 工厂同样保留惰性 import。
const loadReviewOperations = () => import('./legacySqliteReview')
const loadQuestionOperations = () => import('./legacySqliteTaskQuestions')
const loadClarifyOperations = () => import('./legacySqliteClarifyRounds')
const loadClarifySeal = () => import('./legacySqliteClarify/seal')

export interface CreateCollaborationRouteOperationsInput {
  readonly db: ProviderNeutralDatabase
  /** 草稿提交后的实时投影：装配点注入，持久化实现不直接够全局广播器。 */
  readonly clarifyDraftEvents: CollaborationClarifyDraftEventPublisher
}

export function createCollaborationRouteOperations(
  input: CreateCollaborationRouteOperationsInput,
): CollaborationRoutePersistenceOperations {
  const db = input.db
  const reviews: CollaborationRoutePersistenceOperations['reviews'] = Object.freeze({
    list: async (filter) => await (await loadReviewOperations()).listReviewSummaries(db, filter),
    countPending: async (actor) =>
      await (await loadReviewOperations()).countPendingReviews(db, actor),
    detail: async (request) =>
      await (await loadReviewOperations()).getReviewDetail(db, request.appHome, request.nodeRunId),
    listVersions: async (nodeRunId) =>
      await (await loadReviewOperations()).listDocVersionsForReview(db, nodeRunId),
    versionDetail: async (request) =>
      await (
        await loadReviewOperations()
      ).getDocVersionDetail(db, request.appHome, request.nodeRunId, request.versionId),
    listRounds: async (request) =>
      await (await loadReviewOperations()).listReviewRounds(db, request.appHome, request.nodeRunId),
    setSelection: async (request) =>
      await (await loadReviewOperations()).setDocumentSelection({ db, ...request }),
    addComment: async (request) =>
      await (
        await loadReviewOperations()
      ).addReviewComment({
        db,
        appHome: request.appHome,
        nodeRunId: request.nodeRunId,
        commentText: request.commentText,
        author: request.author,
        authorRole: request.authorRole,
        ...(request.anchor === undefined ? {} : { anchor: request.anchor }),
        ...(request.anchorRequest === undefined ? {} : { anchorRequest: request.anchorRequest }),
        ...(request.docVersionId === undefined ? {} : { docVersionId: request.docVersionId }),
      }),
    updateComment: async (request) =>
      await (
        await loadReviewOperations()
      ).updateReviewCommentText(
        db,
        request.nodeRunId,
        request.commentId,
        request.commentText,
        request.authority,
      ),
    deleteComment: async (request) =>
      await (
        await loadReviewOperations()
      ).deleteReviewComment(db, request.nodeRunId, request.commentId, request.authority),
  })
  const questions: CollaborationRoutePersistenceOperations['questions'] = Object.freeze({
    list: async (request) =>
      await (
        await loadQuestionOperations()
      ).listTaskQuestions(db, request.taskId, {
        ...(request.sourceNodeId === undefined ? {} : { sourceNodeId: request.sourceNodeId }),
        ...(request.phase === undefined ? {} : { phase: request.phase }),
      }),
    createManual: async (request) =>
      await (
        await loadQuestionOperations()
      ).createManualTaskQuestion(
        db,
        request.taskId,
        {
          title: request.title,
          body: request.body,
          targetNodeId: request.targetNodeId,
        },
        request.actor,
      ),
    confirm: async (request) =>
      await (
        await loadQuestionOperations()
      ).confirmTaskQuestion(db, request.entryId, request.actor),
    reassign: async (request) =>
      await (
        await loadQuestionOperations()
      ).reassignTaskQuestion(db, request.entryId, request.targetNodeId, request.actor),
    stage: async (request) =>
      await (
        await loadQuestionOperations()
      ).stageTaskQuestion(db, request.entryId, request.staged, request.actor),
  })
  const clarify: CollaborationRoutePersistenceOperations['clarify'] = Object.freeze({
    list: async (request) =>
      await (await loadClarifyOperations()).listClarifyRoundSummaries(db, request),
    countPending: async (actor) =>
      await (await loadClarifyOperations()).countAwaitingClarifyRounds(db, actor),
    detail: async (intermediaryNodeRunId) =>
      await (await loadClarifyOperations()).getClarifyRoundDetail(db, intermediaryNodeRunId),
    seal: async (request) =>
      await (
        await loadClarifySeal()
      ).sealRoundQuestions({
        db,
        originNodeRunId: request.originNodeRunId,
        answers: [...request.answers],
        ...(request.sealedBy === undefined ? {} : { sealedBy: request.sealedBy }),
        ...(request.sealedByRole === undefined ? {} : { sealedByRole: request.sealedByRole }),
        ...(request.directive === undefined ? {} : { directive: request.directive }),
        ...(request.autoStage === undefined ? {} : { autoStage: request.autoStage }),
        ...(request.allowResealFor === undefined ? {} : { allowResealFor: request.allowResealFor }),
      }),
    saveDraft: async (request) =>
      await (
        await loadClarifyOperations()
      ).saveClarifyDraft({ db, draftEvents: input.clarifyDraftEvents, ...request }),
  })
  return Object.freeze({ reviews, questions, clarify })
}

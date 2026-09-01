import type { DbClient } from '@/db/client'
import type { CollaborationRoutePersistenceOperations } from '../application/ports/collaborationRouteOperations'

// The legacy SQLite implementations still consume the temporary
// humanGateComposition facade, which imports Collaboration composition. Lazy
// loading keeps this provider adapter out of that initialization cycle.
const loadReviewOperations = () => import('./legacySqliteReview')
const loadQuestionOperations = () => import('./legacySqliteTaskQuestions')
const loadClarifyOperations = () => import('./legacySqliteClarifyRounds')
const loadClarifySeal = () => import('./legacySqliteClarify/seal')

export function createSqliteCollaborationRouteOperations(
  db: DbClient,
): CollaborationRoutePersistenceOperations {
  const reviews: CollaborationRoutePersistenceOperations['reviews'] = Object.freeze({
    list: async (input) => await (await loadReviewOperations()).listReviewSummaries(db, input),
    countPending: async (actor) =>
      await (await loadReviewOperations()).countPendingReviews(db, actor),
    detail: async (input) =>
      await (await loadReviewOperations()).getReviewDetail(db, input.appHome, input.nodeRunId),
    listVersions: async (nodeRunId) =>
      await (await loadReviewOperations()).listDocVersionsForReview(db, nodeRunId),
    versionDetail: async (input) =>
      await (
        await loadReviewOperations()
      ).getDocVersionDetail(db, input.appHome, input.nodeRunId, input.versionId),
    listRounds: async (input) =>
      await (await loadReviewOperations()).listReviewRounds(db, input.appHome, input.nodeRunId),
    setSelection: async (input) =>
      await (await loadReviewOperations()).setDocumentSelection({ db, ...input }),
    addComment: async (input) =>
      await (
        await loadReviewOperations()
      ).addReviewComment({
        db,
        appHome: input.appHome,
        nodeRunId: input.nodeRunId,
        commentText: input.commentText,
        author: input.author,
        authorRole: input.authorRole,
        ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
        ...(input.anchorRequest === undefined ? {} : { anchorRequest: input.anchorRequest }),
        ...(input.docVersionId === undefined ? {} : { docVersionId: input.docVersionId }),
      }),
    updateComment: async (input) =>
      await (
        await loadReviewOperations()
      ).updateReviewCommentText(
        db,
        input.nodeRunId,
        input.commentId,
        input.commentText,
        input.authority,
      ),
    deleteComment: async (input) =>
      await (
        await loadReviewOperations()
      ).deleteReviewComment(db, input.nodeRunId, input.commentId, input.authority),
  })
  const questions: CollaborationRoutePersistenceOperations['questions'] = Object.freeze({
    list: async (input) =>
      await (
        await loadQuestionOperations()
      ).listTaskQuestions(db, input.taskId, {
        ...(input.sourceNodeId === undefined ? {} : { sourceNodeId: input.sourceNodeId }),
        ...(input.phase === undefined ? {} : { phase: input.phase }),
      }),
    createManual: async (input) =>
      await (
        await loadQuestionOperations()
      ).createManualTaskQuestion(
        db,
        input.taskId,
        {
          title: input.title,
          body: input.body,
          targetNodeId: input.targetNodeId,
        },
        input.actor,
      ),
    confirm: async (input) =>
      await (await loadQuestionOperations()).confirmTaskQuestion(db, input.entryId, input.actor),
    reassign: async (input) =>
      await (
        await loadQuestionOperations()
      ).reassignTaskQuestion(db, input.entryId, input.targetNodeId, input.actor),
    stage: async (input) =>
      await (
        await loadQuestionOperations()
      ).stageTaskQuestion(db, input.entryId, input.staged, input.actor),
  })
  const clarify: CollaborationRoutePersistenceOperations['clarify'] = Object.freeze({
    list: async (input) =>
      await (await loadClarifyOperations()).listClarifyRoundSummaries(db, input),
    countPending: async (actor) =>
      await (await loadClarifyOperations()).countAwaitingClarifyRounds(db, actor),
    detail: async (intermediaryNodeRunId) =>
      await (await loadClarifyOperations()).getClarifyRoundDetail(db, intermediaryNodeRunId),
    seal: async (input) =>
      await (
        await loadClarifySeal()
      ).sealRoundQuestions({
        db,
        originNodeRunId: input.originNodeRunId,
        answers: [...input.answers],
        ...(input.sealedBy === undefined ? {} : { sealedBy: input.sealedBy }),
        ...(input.sealedByRole === undefined ? {} : { sealedByRole: input.sealedByRole }),
        ...(input.directive === undefined ? {} : { directive: input.directive }),
        ...(input.autoStage === undefined ? {} : { autoStage: input.autoStage }),
        ...(input.allowResealFor === undefined ? {} : { allowResealFor: input.allowResealFor }),
      }),
    saveDraft: async (input) =>
      await (await loadClarifyOperations()).saveClarifyDraft({ db, ...input }),
  })
  return Object.freeze({ reviews, questions, clarify })
}

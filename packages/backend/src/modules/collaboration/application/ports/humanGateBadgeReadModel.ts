// RFC-483 —— the human-gate badge read model (RFC-294 S9, D14). The review and clarify badges are single SQL statements
// (RFC-359 AC-11, pinned on both engines by rfc359-w56 / rfc359-w57) owned by collaboration's infrastructure, which composes
// task-execution's task scope conditions handed over at assembly. This port carries only DTOs.

/** Whose gates a badge counts: every task's, or those of the tasks the user owns or collaborates on. */
export type HumanGateBadgeViewer =
  | { readonly kind: 'all-tasks' }
  | { readonly kind: 'task-member'; readonly userId: string }

export interface HumanGateBadgeReadModel {
  /** Review versions awaiting a decision; a task member also sees the review nodes they are assigned to. */
  countPendingReviews(viewer: HumanGateBadgeViewer): Promise<number>
  /** Clarify rounds awaiting a human answer, archived rounds included. */
  countAwaitingClarifyRounds(viewer: HumanGateBadgeViewer): Promise<number>
}

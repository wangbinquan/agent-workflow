/** 任务删除场景：在调用方事务内保留完整受众快照，并清理无 FK 的反馈。 */
export interface TaskDeletionCollaborationParticipant {
  members(
    taskIds: readonly string[],
  ): Promise<readonly { readonly taskId: string; readonly userId: string }[]>
  deleteFeedback(taskIds: readonly string[]): Promise<void>
}

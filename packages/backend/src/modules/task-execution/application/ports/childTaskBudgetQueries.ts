export interface ChildTaskBudgetQueries {
  listCountedChildTaskIds(): Promise<readonly string[]>
  isChildTask(taskId: string): Promise<boolean>
  parentTaskId(taskId: string): Promise<string | null>
}

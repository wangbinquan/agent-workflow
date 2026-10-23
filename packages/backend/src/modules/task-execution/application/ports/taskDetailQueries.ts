import type { Task } from '@agent-workflow/shared'
import type { TaskDefinitionOrigin } from '../../domain/taskSubject'

/** 兼容 API 的 Task 投影；原始表行与仓库镜像解码留在 owner 内。 */
export interface TaskDetailQueries {
  read(
    taskId: string,
  ): Promise<{ readonly task: Task; readonly definitionOrigin: TaskDefinitionOrigin } | null>
}

import type { TaskStatus } from '@agent-workflow/shared'
import type { TaskWorkgroupConfig } from '../../domain/taskWorkgroupConfig'

/** 人工门所需的生命周期字段；不含 Task 的存储/启动/仓库镜像列，也不含冻结定义。 */
export interface TaskGateContext {
  readonly id: string
  readonly name: string
  readonly status: TaskStatus
  readonly ownerUserId: string | null
  readonly lifecycleEventRevision: number
  readonly sourceTerminationFence: 'closed' | 'merged' | null
  readonly workflowId: string
  readonly worktreePath: string
}

/**
 * 另带冻结定义原文。只给真正要解析定义的调用方：收件箱等列表读取用不带定义的
 * {@link TaskGateContext}，保持 RFC-311 L1-3 的窄投影（不随轮询拉整份定义）。
 */
export interface TaskGateDefinitionContext extends TaskGateContext {
  readonly workflowSnapshot: string
}

export interface TaskDispatchContext extends TaskGateDefinitionContext {
  readonly workgroupId: string | null
  readonly codeRoundId: string | null
  readonly sourceAgentName: string | null
  readonly workgroupConfig: TaskWorkgroupConfig | null
}

export interface TaskGateQueries {
  listContexts(taskIds: readonly string[]): Promise<TaskGateContext[]>
  listDefinitionContexts(taskIds: readonly string[]): Promise<TaskGateDefinitionContext[]>
  listDispatchContexts(taskIds: readonly string[]): Promise<TaskDispatchContext[]>
}

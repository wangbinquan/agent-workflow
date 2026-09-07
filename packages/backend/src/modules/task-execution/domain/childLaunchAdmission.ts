// RFC-359 W8-A —— 子任务启动的**父任务准入门**，两个引擎共用的唯一一份判定。
//
// 这道门此前只长在 PostgreSQL 的子任务铸造机里（`assertParentAdmission`）：SQLite 走的是
// `services/task.ts#startTaskImpl` 那台通用启动引擎，它只检查「父在不在 / 父还 running 吗 /
// source-termination 围栏」，剩下五条一条都没有。于是同一次调用在两个引擎上给出**不同的准入
// 判定**——错配的 parent node_run、被别的子任务占走的预留、跳级的调用深度、非 owner 的发起者，
// 在 PostgreSQL 上 409，在 SQLite 上照样把子任务铸出来。判据缺口账本把它记作
// `12-sqlite-child-launch-parent-admission`。
//
// 这里是纯判定：不认识 drizzle / 事务 / 错误类，只吃两条已读出来的行快照 + 本次请求的四个事实，
// 吐一个 `{code, message}`。两侧各自在**自己的铸行事务内**读行、调它、把 issue 翻成本地的
// ConflictError —— 判定只有一份，谁也不能单方面加一道或少一道。
// （`domain/taskLaunchOrigin.ts` 的 `taskLaunchAdmissionIssue` 是同一形状的先例。）

import { sourceTerminationRevivalError, type SourceTerminationFence } from './sourceTermination'

/** 铸子任务时读到的父任务行快照（只取准入判定要用的列）。 */
export interface ChildLaunchParentSnapshot {
  readonly id: string
  readonly status: string
  readonly ownerUserId: string | null
  readonly invocationDepth: number
  readonly sourceTerminationFence: SourceTerminationFence | null
}

/** 发起本次调用的那条父 node_run 的行快照。 */
export interface ChildLaunchParentRunSnapshot {
  readonly taskId: string
  readonly status: string
  readonly childTaskId: string | null
}

/** 本次子任务启动请求里参与准入判定的事实。 */
export interface ChildLaunchAdmissionRequest {
  /** 父 node_run 的 id —— 只用于诊断文案。 */
  readonly parentNodeRunId: string
  /** 即将铸出的子任务 id（= 继承工作区租约的 taskId）。 */
  readonly childTaskId: string
  /** 请求声明的子任务调用深度。 */
  readonly invocationDepth: number
  /** 发起这次子启动的 actor id。 */
  readonly launchActorUserId: string
}

export interface ChildLaunchAdmissionIssue {
  readonly code:
    | 'parent-task-not-running'
    | 'task-source-terminal-closed'
    | 'task-source-terminal-merged'
    | 'parent-node-run-task-mismatch'
    | 'parent-node-run-not-running'
    | 'child-task-reservation-mismatch'
    | 'child-invocation-depth-mismatch'
    | 'child-launch-actor-mismatch'
  readonly message: string
}

/**
 * 父任务准入判定。返回 `null` = 放行；否则返回第一条不通过的门。
 *
 * **顺序是判据的一部分**：多条同时不成立时，两个引擎必须报同一个 code，所以这里的先后
 * 顺序即两侧的先后顺序，调用方不得重排或跳过其中任何一条。
 */
export function childLaunchAdmissionIssue(
  parent: ChildLaunchParentSnapshot,
  parentRun: ChildLaunchParentRunSnapshot,
  request: ChildLaunchAdmissionRequest,
): ChildLaunchAdmissionIssue | null {
  if (parent.status !== 'running') {
    return {
      code: 'parent-task-not-running',
      message: `parent task '${parent.id}' is '${parent.status}'; refusing to mint child '${request.childTaskId}'`,
    }
  }
  const fence = sourceTerminationRevivalError(parent.sourceTerminationFence)
  if (fence !== null) return { code: fence, message: fence }
  if (parentRun.taskId !== parent.id) {
    return {
      code: 'parent-node-run-task-mismatch',
      message: `node_run '${request.parentNodeRunId}' does not belong to parent task '${parent.id}'`,
    }
  }
  if (parentRun.status !== 'running') {
    return {
      code: 'parent-node-run-not-running',
      message: `parent node_run '${request.parentNodeRunId}' is '${parentRun.status}'`,
    }
  }
  if (parentRun.childTaskId !== request.childTaskId) {
    return {
      code: 'child-task-reservation-mismatch',
      message: `parent node_run '${request.parentNodeRunId}' reserved a different child task`,
    }
  }
  if (request.invocationDepth !== parent.invocationDepth + 1) {
    return {
      code: 'child-invocation-depth-mismatch',
      message: `child depth ${request.invocationDepth} does not follow parent depth ${parent.invocationDepth}`,
    }
  }
  if (parent.ownerUserId !== null && request.launchActorUserId !== parent.ownerUserId) {
    return {
      code: 'child-launch-actor-mismatch',
      message: `child launch actor does not match parent task '${parent.id}' owner`,
    }
  }
  return null
}

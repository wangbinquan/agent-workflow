// RFC-486 (RFC-294 W4-E1 remainder): the launch participant used by scheduled / webhook / event / child launches.

import {
  StartTaskSchema,
  type StartAgentTask,
  type StartTask,
  type StartWorkgroupTask,
  type Task,
} from '@agent-workflow/shared'
import { resolveTaskUploadLimits } from '../launchConfiguration'
import { type Actor } from '@/auth/actor'
import { assertWorkflowLaunchInputs } from '@/modules/resource-catalog/public/queries'
import { ConflictError, ValidationError } from '@/util/errors'
import type { TaskExecutionResourceAuthority } from '../ports/taskExecutionResourceSnapshots'
import { collectUploadInputDefs, DEFAULT_UPLOAD_LIMITS } from '../../domain/uploads'
import type { ExecutionInvoker, TaskRouteMultipartFilePart } from '../../public/commands'

import type { TaskLaunchGuard } from '../ports/taskLaunchGuard'
import { createRootTaskLaunchKernel } from './rootTaskLaunch'
import {
  createAgentRouteLaunch,
  createWorkgroupRouteLaunch,
  type AgentRouteLaunchDependencies,
  type WorkgroupRouteLaunchDependencies,
} from './taskLaunchArms'

/**
 * 启动参与者（定时 / webhook / 子任务那条路）真正需要的：两条臂的并集，**不含**
 * `resourceAuthorityFor`——它收的是请求上带来的 `resources`。
 */
export interface TaskExecutionLaunchParticipantDependencies
  extends AgentRouteLaunchDependencies, WorkgroupRouteLaunchDependencies {}

export type TaskExecutionLaunchTarget =
  | { readonly kind: 'workflow'; readonly refId: string; readonly payload: StartTask }
  | {
      readonly kind: 'agent'
      readonly refId: string
      readonly payload: StartAgentTask & { readonly agentId?: string }
    }
  | {
      readonly kind: 'workgroup'
      readonly refId: string
      readonly payload: StartWorkgroupTask & { readonly workgroupId?: string }
    }

export interface TaskExecutionLaunchParticipant {
  launch(
    input: Readonly<{
      actor: Actor
      target: TaskExecutionLaunchTarget
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: TaskLaunchGuard
      /**
       * RFC-359 AC-1（plan §5hn 批次二 ⑥）—— multipart 启动交进来的**已解析文件分片**。
       *
       * 只交 `parts`：上传声明与体积上限都从参与者手上**已经有的**东西派生
       * （`collectUploadInputDefs(冻结快照.inputs)` 与 `fileUploadLimits()`）。
       * 路由不必为了算这两样而把工作流再读一遍——那正是合并前两条 multipart 路各自
       * 重复做过的事。
       */
      uploads?: Readonly<{ parts: readonly TaskRouteMultipartFilePart[] }>
      /**
       * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）：调用方**显式**要求延后仓库准备。
       * 定时 / webhook 由参与者按 invoker 自己判定（`triggerDefersRepositoryPreparation`），
       * 这一格留给知道自己不是 multipart 的那条 JSON 路由。
       */
      deferRepoPreparation?: boolean
    }>,
  ): Promise<Task>
}

/**
 * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）—— 哪些入口要**延后仓库准备**。
 *
 * G7 原话是「定时任务与 webhook 触发同一套语义」：这两条背后没有等 HTTP 响应的用户，
 * 而 G7 的另一半收益（**准备失败要留下记录**）恰恰是它们最需要的——不开的话，一次拉不动
 * 远端的定时触发压根不铸任务行，用户在任务列表里什么都看不到，也没有可重试的对象
 *（`services/scheduleLaunch.ts` 原文，AC-11 的重试作用面为空）。
 *
 * 直启路由（`type:'user'`）不在此列：G7 明列「代理 / 工作组启动保持同步语义」，
 * 而 JSON `POST /api/tasks` 那条由**路由自己**声明（它知道自己是不是 multipart）。
 */
function triggerDefersRepositoryPreparation(invoker: ExecutionInvoker): boolean {
  return invoker.type === 'scheduled' || invoker.type === 'webhook' || invoker.type === 'event'
}

export function createTaskExecutionLaunchParticipant(
  dependencies: TaskExecutionLaunchParticipantDependencies,
): TaskExecutionLaunchParticipant {
  const launchRoot = createRootTaskLaunchKernel(dependencies).launch
  const arms = Object.freeze({
    launchAgent: createAgentRouteLaunch(dependencies),
    launchWorkgroup: createWorkgroupRouteLaunch(dependencies),
  })
  return Object.freeze({
    async launch(input: Parameters<TaskExecutionLaunchParticipant['launch']>[0]) {
      const deferRepoPreparation =
        input.deferRepoPreparation === true || triggerDefersRepositoryPreparation(input.invoker)
      switch (input.target.kind) {
        case 'workflow': {
          if (input.target.payload.workflowId !== input.target.refId) {
            throw new ValidationError(
              'execution-ref-mismatch',
              `workflow ref '${input.target.refId}' does not match payload '${input.target.payload.workflowId}'`,
            )
          }
          const snapshots = await input.resources.resources.loadAuthorized(input.resources, [
            { kind: 'workflow-launch', workflowId: input.target.refId },
          ])
          const snapshot = snapshots[0]
          if (snapshots.length !== 1 || snapshot?.kind !== 'workflow-launch') {
            throw new Error('task-execution-workflow-snapshot-invalid')
          }
          if (
            input.target.payload.expectedWorkflowVersion !== undefined &&
            snapshot.workflow.version !== input.target.payload.expectedWorkflowVersion
          ) {
            throw new ConflictError(
              'workflow-version-mismatch',
              `workflow '${input.target.refId}' changed during launch (expected v${input.target.payload.expectedWorkflowVersion}, now v${snapshot.workflow.version})`,
              {
                expectedVersion: input.target.payload.expectedWorkflowVersion,
                currentVersion: snapshot.workflow.version,
              },
            )
          }
          // RFC-359 AC-1（plan §5hn 批次二 ④）：**带上候选上下文**——不带它，
          // `loadWorkflowValidationContext` 不填 `callWorkflows` / `currentWorkflow`，
          // call-node 规则就不在这道门上判，引用悬空要等到冻结调用闭包时才被另一个组件
          // 以 `workflow-call-ref-missing` 拒掉（而且不带 `issues[]`，编辑器指不到出错节点）。
          const validation = await dependencies.agent.resources.validateHostWorkflow(
            snapshot.workflow.definition,
            {
              definition: snapshot.workflow.definition,
              currentWorkflow: { id: snapshot.workflow.id, name: snapshot.workflow.name },
            },
          )
          const errors = validation.issues.filter(
            (issue) => (issue.severity ?? 'error') === 'error',
          )
          if (!validation.ok && errors.length > 0) {
            throw new ValidationError(
              'workflow-invalid',
              `workflow '${snapshot.workflow.id}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'})`,
              { issues: validation.issues },
            )
          }
          const parsed = StartTaskSchema.safeParse(input.target.payload)
          if (!parsed.success) {
            throw new ValidationError('task-invalid', 'invalid task payload', {
              issues: parsed.error.issues,
            })
          }
          // RFC-359 AC-1（plan §5hn 批次二 ④，**修 627290a94 推的红**）：启动输入契约
          //（缺必填 / 未声明键 / picker 类型不匹配 → 422）。此前只有 `startTask` 那一侧做
          // （`services/task.ts` 的同名调用，条件是「非 agent/workgroup/code-round/数字员工
          // 合成宿主」——那几类各有自己的宿主契约，在各自的启动服务里验）。
          // 内核这一侧一直没有，于是 **PostgreSQL 从来没执行过这条契约**；
          // SQLite 的 JSON 路由改走内核之后当场照出来（e2e `workflow-matrix` 的
          // 「missing required」期望 422，实际放行）。
          // 这一格放在**工作流臂**而不是内核：内核也服务合成宿主，那几类不适用本契约。
          //
          // RFC-359 AC-1（plan §5hn 批次二 ⑥）：带上传时**忽略 upload 键**——那几个键的值
          // 是服务端写完文件后才回填的仓内路径，此刻本来就还是空串。SQLite 的 multipart 路
          // （`services/multipartTaskStart.ts`）一直是这个口径。
          assertWorkflowLaunchInputs(
            snapshot.workflow.definition.inputs,
            parsed.data.inputs,
            input.uploads === undefined ? {} : { ignoreUploadInputs: true },
          )
          return await launchRoot({
            actor: input.actor,
            resourceAuthority: input.resources,
            invoker: input.invoker,
            ...(input.guard === undefined ? {} : { guard: input.guard }),
            ...(deferRepoPreparation ? { deferRepoPreparation: true } : {}),
            ...(input.uploads === undefined
              ? {}
              : {
                  uploads: {
                    parts: input.uploads.parts,
                    // 上传声明取自**冻结快照**——与落库的那一份同源，路由读到的另一份不算数。
                    definitions: collectUploadInputDefs(snapshot.workflow.definition.inputs),
                    limits:
                      dependencies.launchConfiguration === undefined
                        ? dependencies.fileUploadLimits()
                        : await resolveTaskUploadLimits(
                            dependencies.launchConfiguration,
                            DEFAULT_UPLOAD_LIMITS,
                          ),
                  },
                }),
            task: parsed.data,
            subject: {
              subject: { kind: 'workflow', sourceId: snapshot.workflow.id },
              workflowName: snapshot.workflow.name,
              workflowVersion: snapshot.workflow.version,
              workflowSnapshot: snapshot.workflow.definition,
              // 工作流启动面按定义拿不到内置工作流——冻结资源快照那一步就
              // `assertNotBuiltin` 挡住了（`taskExecutionResourceSnapshots.ts:142`）。
              builtin: false,
            },
          })
        }
        case 'agent': {
          if (
            input.target.payload.agentId !== undefined &&
            input.target.payload.agentId !== input.target.refId
          ) {
            throw new ValidationError(
              'execution-ref-mismatch',
              `agent ref '${input.target.refId}' does not match payload '${input.target.payload.agentId}'`,
            )
          }
          return await arms.launchAgent({
            actor: input.actor,
            command: { agentId: input.target.refId, payload: input.target.payload },
            invoker: input.invoker,
            resources: input.resources,
            ...(input.guard === undefined ? {} : { guard: input.guard }),
            ...(deferRepoPreparation ? { deferRepoPreparation: true } : {}),
          })
        }
        case 'workgroup': {
          const payloadWorkgroupId = input.target.payload.workgroupId
          if (typeof payloadWorkgroupId === 'string' && payloadWorkgroupId !== input.target.refId) {
            throw new ValidationError(
              'execution-ref-mismatch',
              `workgroup ref '${input.target.refId}' does not match payload '${payloadWorkgroupId}'`,
            )
          }
          return await arms.launchWorkgroup({
            actor: input.actor,
            command: { workgroupId: input.target.refId, payload: input.target.payload },
            invoker: input.invoker,
            resources: input.resources,
            ...(input.guard === undefined ? {} : { guard: input.guard }),
            ...(deferRepoPreparation ? { deferRepoPreparation: true } : {}),
          })
        }
        default: {
          const exhaustive: never = input.target
          throw new Error(`unsupported task launch target: ${String(exhaustive)}`)
        }
      }
    },
  })
}

// RFC-486 (RFC-294 W4-E1 remainder): the single-agent and workgroup launch arms, both ending in the root launch kernel.

import {
  TaskStartOptionsSchema,
  WorkflowDefinitionSchema,
  applySpaceFields,
  initialDwState,
  migrateWorkflowDefinitionToLatest,
  workgroupLaunchReadiness,
  type Agent,
  type Task,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { type Actor } from '@/auth/actor'
import {
  AGENT_HOST_INPUT_KEY,
  buildAgentHostSnapshot,
  validateAgentLaunchShape,
} from '../../domain/agentHostWorkflow'
import {
  acquireAgentLaunch,
  releaseAgentLaunch,
  type AgentLaunchResourceIntegrityParticipant,
} from '@/modules/resource-catalog/public/participants'
import { buildDynamicWorkflowGenerateSnapshot } from '../../domain/dynamicWorkflowOrchestrator'
import { assertNotBuiltin } from '@/modules/resource-catalog/public/types'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import type { AgentLaunchResourceOperations } from '../ports/agentLaunchResourceOperations'
import type { TaskExecutionResourceAuthority } from '../ports/taskExecutionResourceSnapshots'
import { collectUploadInputDefs } from '../../domain/uploads'
import type {
  AgentRouteTaskLaunchOperations,
  ExecutionInvoker,
  WorkgroupRouteTaskLaunchOperations,
} from '../../public/commands'

import type { UploadLimits } from '../../domain/uploads'
import {
  buildWorkgroupHostSnapshot,
  buildWorkgroupRuntimeConfig,
  resolveWorkgroupCollaborators,
} from '../../domain/workgroupRuntimeConfig'
import type { TaskLaunchGuard } from '../ports/taskLaunchGuard'
import type { WorkgroupRouteLaunchResources } from '../ports/taskRouteLaunch'
import { createRootTaskLaunchKernel, type RootTaskLaunchDependencies } from './rootTaskLaunch'

/**
 * RFC-359 AC-1（plan §5hn 批次一）—— **单代理**启动臂真正需要的那些依赖。
 *
 * 从 `TaskRouteLaunchDependencies` 里拆出来，是为了让 SQLite 那一侧能接同一份
 * 实现而**不必编造一份用不到的 workgroup 资源面**：agent 臂的函数体只碰
 * `agent.resources` / `agent.integrity` 与根内核，工作组那格它一次都没读过。
 * 让类型说真话，比让调用方塞个占位对象好。
 *
 * RFC-359 AC-1（plan §5hn 批次二 ①②，同一条判据的第二次应用）：`resourceAuthorityFor`
 * 也从这里挪走了——它只被**路由包装**读（`createTaskRouteLaunchOperations` 的
 * 两个 `launch(actor, command)`），臂与启动参与者收的都是请求上带来的 `resources`。
 * 留着它的代价不是多一行：定时 / webhook 拿到的是**委派** actor，而典型实现是
 * `authorityForLegacyProjection(actor)`——非直连 actor 会当场抛。让一个用不到的必填项
 * 逼调用方去编一个「反正不会被调用」的实现，正是这一轮在消灭的形状。
 */
export interface AgentRouteLaunchDependencies extends RootTaskLaunchDependencies {
  /** RFC-486: the file-config upload limits, used when no launch configuration is wired. */
  readonly fileUploadLimits: () => UploadLimits
  readonly agent: Readonly<{
    resources: AgentLaunchResourceOperations
    integrity: AgentLaunchResourceIntegrityParticipant
  }>
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ③）—— **工作组**启动臂真正需要的那些依赖。
 * 同 `AgentRouteLaunchDependencies` 的理由：让 SQLite 那一侧能接同一份实现，
 * 而不必编造一份用不到的 agent 资源面。
 */
export interface WorkgroupRouteLaunchDependencies extends RootTaskLaunchDependencies {
  /** RFC-486: the file-config upload limits, used when no launch configuration is wired. */
  readonly fileUploadLimits: () => UploadLimits
  readonly workgroup: WorkgroupRouteLaunchResources
}

function frozenAgentSnapshot(agent: Agent, allowClarify: boolean): WorkflowDefinition {
  const snapshot = buildAgentHostSnapshot(agent, allowClarify)
  try {
    return migrateWorkflowDefinitionToLatest(WorkflowDefinitionSchema.parse(snapshot))
  } catch (error) {
    throw new ValidationError('workflow-invalid', 'synthesized agent host snapshot is invalid', {
      issues: error instanceof Error ? [{ message: error.message }] : [],
    })
  }
}

export type AgentLaunchCommand = Parameters<AgentRouteTaskLaunchOperations['launch']>[1]
export type WorkgroupLaunchCommand = Parameters<WorkgroupRouteTaskLaunchOperations['launch']>[1]

export interface TaskLaunchArms {
  launchAgent(
    input: Readonly<{
      actor: Actor
      command: AgentLaunchCommand
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: TaskLaunchGuard
      /** RFC-287 G7：定时 / webhook 触发与手动启动同一套语义，直启路由不开。 */
      deferRepoPreparation?: boolean
    }>,
  ): Promise<Task>
  launchWorkgroup(
    input: Readonly<{
      actor: Actor
      command: WorkgroupLaunchCommand
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: TaskLaunchGuard
      /** RFC-287 G7：同上。 */
      deferRepoPreparation?: boolean
    }>,
  ): Promise<Task>
}

/**
 * RFC-359 AC-1（plan §5hn 批次一）—— 单代理启动的**唯一**编排。
 *
 * 两个引擎共用这一份：路由层本来就打同一个 `AgentRouteTaskLaunchOperations` 端口，
 * 差别整个在端口背后（SQLite 曾转 `startExecution` → `startAgentTask` → `startTask`）。
 * 现在两侧都转到这里，终端统一为根启动内核。
 */
export function createAgentRouteLaunch(
  dependencies: AgentRouteLaunchDependencies,
): (input: Parameters<TaskLaunchArms['launchAgent']>[0]) => Promise<Task> {
  const launchRoot = createRootTaskLaunchKernel(dependencies).launch
  return async function launchAgent(
    input: Parameters<TaskLaunchArms['launchAgent']>[0],
  ): Promise<Task> {
    const { actor, command } = input
    const agent = await dependencies.agent.resources.loadVisibleAgent(actor, command.agentId)
    if (agent === null) throw new NotFoundError('agent-not-found', 'agent not found')
    assertNotBuiltin('agent', agent)
    if (
      command.payload.expectedAgentId !== undefined &&
      agent.id !== command.payload.expectedAgentId
    ) {
      throw new ConflictError(
        'agent-id-mismatch',
        `agent '${agent.name}' is not the expected agent`,
      )
    }

    acquireAgentLaunch(agent.id)
    try {
      const recheck = await dependencies.agent.resources.loadVisibleAgent(actor, agent.id)
      if (recheck === null) {
        throw new ConflictError(
          'agent-id-mismatch',
          `agent '${agent.name}' was deleted during launch`,
        )
      }
      await dependencies.agent.integrity.assertUsable({ rootAgentIds: [recheck.id] })
      const form = validateAgentLaunchShape(recheck.inputs, command.payload, {
        multipart: command.uploads !== undefined,
      })
      const snapshot = frozenAgentSnapshot(recheck, command.payload.allowClarify)
      const validation = await dependencies.agent.resources.validateHostWorkflow(snapshot)
      const errors = validation.issues.filter((issue) => (issue.severity ?? 'error') === 'error')
      if (!validation.ok && errors.length > 0) {
        throw new ValidationError(
          'workflow-invalid',
          `agent '${recheck.name}' cannot launch (${errors.length} error${errors.length === 1 ? '' : 's'} in its host snapshot)`,
          { issues: validation.issues },
        )
      }

      const taskInputs: Record<string, string> = {}
      if (form === null) {
        taskInputs[AGENT_HOST_INPUT_KEY] = command.payload.description ?? ''
      } else {
        const definitions = new Map(form.inputs.map((definition) => [definition.key, definition]))
        for (const [key, value] of Object.entries(command.payload.inputs ?? {})) {
          const definition = definitions.get(key)
          if (
            definition !== undefined &&
            definition.kind !== 'upload' &&
            typeof value === 'string'
          ) {
            taskInputs[key] = value
          }
        }
      }
      const candidate = applySpaceFields(
        {
          name: command.payload.name,
          inputs: taskInputs,
          ...(command.payload.collaboratorUserIds !== undefined &&
          command.payload.collaboratorUserIds.length > 0
            ? { collaboratorUserIds: command.payload.collaboratorUserIds }
            : {}),
          ...(command.payload.workingBranch === undefined
            ? {}
            : { workingBranch: command.payload.workingBranch }),
          ...(command.payload.autoCommitPush === undefined
            ? {}
            : { autoCommitPush: command.payload.autoCommitPush }),
          ...(command.payload.maxDurationMs === undefined
            ? {}
            : { maxDurationMs: command.payload.maxDurationMs }),
          ...(command.payload.maxTotalTokens === undefined
            ? {}
            : { maxTotalTokens: command.payload.maxTotalTokens }),
        },
        command.payload,
      )
      const parsed = TaskStartOptionsSchema.safeParse(candidate)
      if (!parsed.success) {
        throw new ValidationError('agent-launch-invalid', 'invalid agent launch payload', {
          issues: parsed.error.issues,
        })
      }
      return await launchRoot({
        actor,
        resourceAuthority: input.resources,
        invoker: input.invoker,
        ...(input.guard === undefined ? {} : { guard: input.guard }),
        ...(input.deferRepoPreparation === true ? { deferRepoPreparation: true } : {}),
        task: parsed.data,
        subject: {
          subject: { kind: 'agent', sourceId: recheck.id, sourceName: recheck.name },
          // 合成的单代理宿主：写时冻结规范排版（plan §5hn）。
          builtin: true,
          workflowVersion: 1,
          workflowSnapshot: snapshot,
        },
        ...(command.uploads === undefined
          ? {}
          : {
              uploads: {
                parts: command.uploads.parts,
                definitions: collectUploadInputDefs(form?.inputs ?? []),
                limits: command.uploads.limits,
              },
            }),
      })
    } finally {
      releaseAgentLaunch(agent.id)
    }
  }
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ③）—— 工作组启动的**唯一**编排。
 *
 * 与 agent 臂同形：路由层本来就打同一个 `WorkgroupRouteTaskLaunchOperations` 端口，
 * 差别整个在端口背后（SQLite 曾转 `startWorkgroupTask`——470 行、直接读库）。
 * 现在两侧都转到这里，终端统一为根启动内核。
 */
export function createWorkgroupRouteLaunch(
  dependencies: WorkgroupRouteLaunchDependencies,
): (input: Parameters<TaskLaunchArms['launchWorkgroup']>[0]) => Promise<Task> {
  const launchRoot = createRootTaskLaunchKernel(dependencies).launch
  return async function launchWorkgroup(
    input: Parameters<TaskLaunchArms['launchWorkgroup']>[0],
  ): Promise<Task> {
    const { actor, command } = input
    const group = await dependencies.workgroup.loadVisible(actor, command.workgroupId)
    if (group === null) throw new NotFoundError('workgroup-not-found', 'workgroup not found')
    if (
      command.payload.expectedWorkgroupId !== undefined &&
      group.id !== command.payload.expectedWorkgroupId
    ) {
      throw new ConflictError(
        'workgroup-id-mismatch',
        `workgroup '${group.name}' is not the expected resource`,
      )
    }
    if (
      command.payload.expectedWorkgroupVersion !== undefined &&
      group.version !== command.payload.expectedWorkgroupVersion
    ) {
      throw staleConflictError(
        'workgroup',
        `workgroup '${group.name}' changed during launch (expected v${command.payload.expectedWorkgroupVersion}, now v${group.version})`,
        {
          expectedVersion: command.payload.expectedWorkgroupVersion,
          currentVersion: group.version,
        },
      )
    }
    const readiness = workgroupLaunchReadiness(group)
    if (!readiness.ready) {
      throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', {
        reasons: readiness.reasons,
      })
    }
    const agentMembers = group.members.filter((member) => member.memberType === 'agent')
    const memberAgentIds = agentMembers.flatMap((member) =>
      typeof member.agentId === 'string' && member.agentId.length > 0 ? [member.agentId] : [],
    )
    const existingIds = new Set(
      await dependencies.workgroup.loadExistingAgentIds([...new Set(memberAgentIds)]),
    )
    const missingAgentNames = [
      ...new Set(
        agentMembers
          .filter(
            (member) => typeof member.agentId !== 'string' || !existingIds.has(member.agentId),
          )
          .map((member) => member.agentName ?? '(unnamed)'),
      ),
    ]
    if (missingAgentNames.length > 0) {
      throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', {
        reasons: ['agent-missing'],
        missingAgentNames,
      })
    }
    await dependencies.workgroup.integrity.assertUsable({ rootAgentIds: memberAgentIds })

    const config = buildWorkgroupRuntimeConfig(group, command.payload.goal)
    const dynamic = group.mode === 'dynamic_workflow'
    const snapshot = dynamic
      ? WorkflowDefinitionSchema.parse(buildDynamicWorkflowGenerateSnapshot())
      : buildWorkgroupHostSnapshot(config)
    const collaboratorUserIds = resolveWorkgroupCollaborators(
      command.payload.collaboratorUserIds,
      group,
    )
    const candidate = applySpaceFields(
      {
        name: command.payload.name,
        inputs: {},
        ...(collaboratorUserIds.length === 0 ? {} : { collaboratorUserIds }),
        ...(command.payload.workingBranch === undefined
          ? {}
          : { workingBranch: command.payload.workingBranch }),
        ...(command.payload.autoCommitPush === undefined
          ? {}
          : { autoCommitPush: command.payload.autoCommitPush }),
        ...(command.payload.maxDurationMs === undefined
          ? {}
          : { maxDurationMs: command.payload.maxDurationMs }),
        ...(command.payload.maxTotalTokens === undefined
          ? {}
          : { maxTotalTokens: command.payload.maxTotalTokens }),
      },
      command.payload,
    )
    const parsed = TaskStartOptionsSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new ValidationError('workgroup-launch-invalid', 'invalid workgroup launch payload', {
        issues: parsed.error.issues,
      })
    }
    return await launchRoot({
      actor,
      resourceAuthority: input.resources,
      invoker: input.invoker,
      ...(input.guard === undefined ? {} : { guard: input.guard }),
      ...(input.deferRepoPreparation === true ? { deferRepoPreparation: true } : {}),
      task: parsed.data,
      subject: {
        subject: { kind: 'workgroup', sourceId: group.id },
        // 合成的工作组宿主：写时冻结规范排版（plan §5hn）。
        builtin: true,
        workflowVersion: 1,
        workflowSnapshot: snapshot,
        workgroup: {
          id: group.id,
          name: group.name,
          goal: command.payload.goal,
          config,
          dynamicState: dynamic ? initialDwState() : null,
        },
      },
    })
  }
}

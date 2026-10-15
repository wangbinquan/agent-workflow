import { createHash } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
  AgentInvocationProtocol,
} from '@/modules/runtime-management/public/participants'
import {
  createHostedUsageMeter,
  hostedEventRecord,
  readHostedEvent,
} from '@/modules/task-execution/infrastructure/crewstation/runtimeEvents'
import { getRuntimeDriver } from '@/services/runtime'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import type { AgentExecutionParticipants } from '../application/ports/agentExecutionBinding'
import type { TaskAgentExecutionParticipantInput } from '../application/ports/taskAgentMaterial'
import type { AgentInvocationPreparation } from '../application/ports/agentInvocationPreparation'
import { createProcessEffectAttemptObserver } from '../application/processEffectObserver'
import {
  createHostedProcessEffectProjection,
  type HostedProcessReceipt,
} from '../infrastructure/crewstation/processEffectProjection'
import {
  HostedExecutionUnknownError,
  type HostedExecution,
  type HostedExecutionSink,
} from '../infrastructure/crewstation/execution'

export interface HostedAgentProfile {
  readonly protocol: 'opencode' | 'claude-code'
  readonly model: string | null
  readonly agentProfileId: string
}

const participants = new WeakMap<object, TaskAgentExecutionParticipantInput>()
export function bindHostedAgentExecutionParticipants(input: TaskAgentExecutionParticipantInput) {
  const taskEffect = Object.freeze({}) as NonNullable<AgentExecutionParticipants['taskEffect']>
  participants.set(taskEffect, input)
  return { taskEffect }
}

export function createHostedAgentInvocationPreparation(input: {
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly api: CrewStationBusinessExecution
  readonly executions: HostedExecution
  readonly taskId: string
  readonly businessTaskId: string
  readonly cwd: string
  readonly workspace: AgentMaterialWorkspace
  readonly profiles: readonly HostedAgentProfile[]
  readonly skillFiles: (
    skill: NonNullable<AgentMaterialIntent['injection']['skills']>[number],
  ) => Promise<readonly { path: string; content: string }[]>
}): AgentInvocationPreparation {
  return {
    workspace: input.workspace,
    async compile(intent) {
      const executionId = `agent:${input.taskId}:${intent.nodeRunId}`
      const existing = await input.executions.find(executionId)
      if (existing !== null && existing.request.kind !== 'agent')
        throw new Error('hosted-agent-binding-kind-mismatch')
      const blocked: string[] = []
      if (intent.injection.mcps.some((mcp) => mcp.enabled)) blocked.push('MCP')
      if (intent.injection.plugins?.some((plugin) => plugin.declaration.enabled))
        blocked.push('plugins')
      if ((intent.injection.dependents?.length ?? 0) > 0) blocked.push('subagents')
      if (Object.keys(intent.injection.agent?.permission ?? {}).length > 0)
        blocked.push('agent permissions')
      if (Object.keys(intent.injection.agent?.frontmatterExtra ?? {}).length > 0)
        blocked.push('Agent frontmatter')
      if ((intent.extraArgs?.length ?? 0) > 0) blocked.push('runtime arguments')
      const profile = intent.injection.profile
      if (
        profile !== undefined &&
        Object.entries(profile).some(
          ([key, value]) =>
            key !== 'model' &&
            !(key === 'isSandbox' && value === false) &&
            !(Array.isArray(value) && value.length === 0) &&
            value != null,
        )
      )
        blocked.push('model options')
      if (existing === null && blocked.length > 0)
        throw new Error(
          `hosted-capability-unavailable: ${blocked.join(', ')} require CrewStation native configuration materials (RFC-370 M2)`,
        )
      const selected = input.profiles.find(
        (candidate) =>
          candidate.protocol === intent.protocol && candidate.model === (profile?.model || null),
      )
      if (existing === null && selected === undefined)
        throw new Error(
          `hosted-runtime-profile-unmapped: ${intent.protocol}/${profile?.model || 'default'}`,
        )
      const skills: Array<{ path: string; content: string }> = []
      if (existing === null)
        for (const skill of intent.injection.skills ?? [])
          skills.push(...(await input.skillFiles(skill)))
      const material = {
        systemPrompt: [intent.systemPrompt, intent.injectedMemoryBlock]
          .filter(Boolean)
          .join('\n\n'),
        skills,
      }
      if (existing === null && Buffer.byteLength(JSON.stringify(material)) > 1024 * 1024)
        throw new Error('hosted-material-exceeds-platform-limit')
      const digest = createHash('sha256').update(JSON.stringify(material)).digest('hex')
      const uploaded =
        existing?.request.kind === 'agent' && existing.request.materialId !== undefined
          ? { materialId: existing.request.materialId }
          : await input.api.createMaterial(input.businessTaskId, {
              ...material,
              requestKey: `aw-material:${digest}`,
              fence: input.fence.current(),
            })
      const declared = {
        ...emptyDeclaredManifest(),
        skills: [...new Set((intent.injection.skills ?? []).map((skill) => skill.name))],
        skippedDisabledMcps: intent.injection.mcps
          .filter((mcp) => !mcp.enabled)
          .map((mcp) => mcp.name),
        unobservable: ['mcpServers', 'skills', 'subagents', 'plugins', 'tools'],
      }
      const native = getRuntimeDriver(intent.protocol)
      const protocol: AgentInvocationProtocol = {
        kind: intent.protocol,
        capabilities: {
          ...native.capabilities,
          startupObservation: 'none',
          observationRequiresFreshRun: false,
        },
        parseEvent(line) {
          const event = readHostedEvent(JSON.parse(line))
          return event === null ? null : hostedEventRecord(event).event
        },
        usageMeter: () => createHostedUsageMeter(),
      }
      return {
        materialRef: uploaded.materialId,
        declared,
        evidenceCapabilities: {
          usageMeter: true,
          sessionCapture: false,
          inventory: false,
          finalEvents: false,
          liveCapture: false,
          sessionSinkCapture: false,
        },
        bind() {
          let executed = false
          return {
            materialRef: uploaded.materialId,
            declared,
            protocol,
            workspace: input.workspace,
            evidence: { captureSessions: async () => undefined },
            lifecycle: {},
            async execute(request, sink) {
              if (executed) throw new Error('agent-invocation-execution-already-bound')
              executed = true
              const startedAt = Date.now()
              const frozen =
                existing?.request.kind === 'agent'
                  ? existing.request
                  : {
                      kind: 'agent' as const,
                      name: intent.agentName,
                      agentProfileId: selected!.agentProfileId,
                      cwd: input.cwd,
                      prompt: intent.prompt,
                      materialId: uploaded.materialId,
                      ...(intent.resumeSessionId
                        ? { resumeSessionId: intent.resumeSessionId }
                        : {}),
                    }
              const task =
                request.task?.participants.taskEffect === undefined
                  ? undefined
                  : participants.get(request.task.participants.taskEffect)
              if (request.task !== undefined && task === undefined)
                throw new Error('hosted-agent-execution-participant-unavailable')
              const projection = createHostedProcessEffectProjection<{
                outcome: string
                exitCode: number | null
              }>({
                db: input.db,
                fence: input.fence,
                request: frozen,
                ...(task === undefined || task.readOnlyWorkspace()
                  ? {}
                  : { writerWorkspace: intent.workspace.reference }),
              })
              const effect =
                task === undefined
                  ? undefined
                  : createProcessEffectAttemptObserver({
                      persistence: task.persistence,
                      taskId: input.taskId,
                      nodeRunId: intent.nodeRunId,
                      processKind: 'agent',
                      projection,
                      resourceKeys: (description) => description.resourceKeys,
                    })
              await effect?.beforeSpawn()
              await request.beforeStart?.()
              try {
                const executionIntent = {
                  executionId,
                  taskId: input.taskId,
                  nodeRunId: intent.nodeRunId,
                  businessTaskId: input.businessTaskId,
                  requestKey: `aw-agent:${createHash('sha256').update(executionId).digest('hex')}`,
                  request: frozen,
                  ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
                }
                const executionSink: HostedExecutionSink = {
                  async started(binding) {
                    const receipt: HostedProcessReceipt = {
                      executionId,
                      businessTaskId: binding.businessTaskId,
                      subtaskId: binding.subtaskId!,
                      attempt: binding.attempt!,
                    }
                    await effect?.recordSpawnReceipt(receipt)
                  },
                  async event(event) {
                    if (event.type === 'output') {
                      if (event.data.stream === 'stderr') await sink.diagnostic(event.data.text)
                      return
                    }
                    const record = hostedEventRecord(event)
                    await sink.record({
                      ...record,
                      sourceKey: `${executionId}:${event.cursor}`,
                      ...(event.type === 'result' && event.data.exitCode !== 0
                        ? { terminalError: event.data.reason }
                        : {}),
                    })
                  },
                  async checkpoint() {
                    await sink.checkpoint('records')
                    await sink.checkpoint('diagnostics')
                  },
                }
                const outcome =
                  existing === null
                    ? await input.executions.run(executionIntent, executionSink, request.signal)
                    : await input.executions.adopt(executionId, executionSink, request.signal)
                const result = outcome.timedOut
                  ? 'timeout'
                  : /cancel/i.test(outcome.result.reason)
                    ? 'aborted'
                    : outcome.result.exitCode === 0
                      ? 'ok'
                      : 'nonzero-exit'
                return {
                  result,
                  exitCode: outcome.result.exitCode,
                  stderrTail: outcome.result.stderr,
                  durationMs: Date.now() - startedAt,
                  drainTimedOut: outcome.result.truncated,
                  unreapedMessage: () =>
                    'hosted execution outcome is unknown; reconcile its platform receipt',
                  reportUnreaped: () => undefined,
                  async settle() {
                    await effect?.settle({ outcome: result, exitCode: outcome.result.exitCode })
                    await outcome.settle()
                  },
                }
              } catch (error) {
                if (!(error instanceof HostedExecutionUnknownError)) throw error
                return {
                  result: 'unreaped',
                  exitCode: null,
                  stderrTail: '',
                  durationMs: Date.now() - startedAt,
                  pumpError: error.message,
                  unreapedMessage: () => error.message,
                  reportUnreaped: ({ log }) =>
                    log.warn('hosted-execution-reconciliation-required', {
                      executionId,
                      reason: error.message,
                    }),
                  settle: async () => {
                    await effect?.settle({ outcome: 'unreaped', exitCode: null })
                  },
                }
              }
            },
          }
        },
      }
    },
  }
}

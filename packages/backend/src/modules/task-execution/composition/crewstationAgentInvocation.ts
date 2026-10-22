import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  CreateBusinessMaterial,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import type { BusinessMaterialFile } from '@/platform/crewstation/nativeMaterial'
import type {
  HostedMaterialFiles,
  HostedMaterialSourceFile,
} from '../infrastructure/crewstation/materialObjectUploads'
import {
  compileHostedNativeMaterial,
  type HostedNativeMaterialContent,
} from '../infrastructure/crewstation/nativeMaterial'
import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
  AgentInvocationProtocol,
} from '@/modules/runtime-management/public/participants'
import {
  createHostedTokenDeltas,
  createHostedUsageMeter,
  hostedEventRecord,
  readHostedEvent,
} from '@/modules/task-execution/infrastructure/crewstation/runtimeEvents'
import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import { getRuntimeDriver } from '@/services/runtime'
import { declareSkills, emptyDeclaredManifest } from '@/services/execution/agentInjection'
import {
  freezeHostedAgentContext,
  hostedAgentNodeContext,
} from '../infrastructure/crewstation/agentContext'
import type { AgentExecutionParticipants } from '../application/ports/agentExecutionBinding'
import type { TaskAgentExecutionParticipantInput } from '../application/ports/taskAgentMaterial'
import type { AgentInvocationPreparation } from '../application/ports/agentInvocationPreparation'
import { createProcessEffectAttemptObserver } from '../application/processEffectObserver'
import {
  createHostedProcessEffectProjection,
  type HostedProcessReceipt,
} from '../infrastructure/crewstation/processEffectProjection'
import {
  HostedExecutionDetachedError,
  HostedExecutionUnknownError,
  untilDaemonShutdown,
  type HostedExecution,
  type HostedExecutionSink,
} from '../infrastructure/crewstation/execution'
import { sha256Hex } from '@/util/hash'

export interface HostedAgentProfile {
  readonly protocol: 'opencode' | 'claude-code'
  readonly model: string | null
  readonly agentProfileId: string
}

/** The opaque task participant is interpreted only by the execution owner
 * that issued it; one registry per hosted task-run composition. */
export interface HostedAgentParticipants {
  bind(input: TaskAgentExecutionParticipantInput): {
    readonly taskEffect: NonNullable<AgentExecutionParticipants['taskEffect']>
  }
  resolve(token: object): TaskAgentExecutionParticipantInput | undefined
}

export function createHostedAgentParticipants(): HostedAgentParticipants {
  const issued = new WeakMap<object, TaskAgentExecutionParticipantInput>()
  return {
    bind(input) {
      const taskEffect = Object.freeze({}) as NonNullable<AgentExecutionParticipants['taskEffect']>
      issued.set(taskEffect, input)
      return { taskEffect }
    },
    resolve: (token) => issued.get(token),
  }
}

export function createHostedAgentInvocationPreparation(
  input: HostedNativeMaterialContent & {
    readonly materialEnvironment?: (intent: AgentMaterialIntent) => CreateBusinessMaterial['env']
    readonly db: PersistenceDb
    readonly fence: CrewStationMutationFence
    readonly api: CrewStationBusinessExecution
    readonly executions: HostedExecution
    readonly participants?: HostedAgentParticipants
    readonly taskId: string
    readonly businessTaskId: string
    readonly cwd: string
    readonly workspace: AgentMaterialWorkspace
    readonly profiles: readonly HostedAgentProfile[]
    readonly materialFiles?: HostedMaterialFiles
    readonly materialObjectsAvailable?: (agentProfileId: string) => Promise<boolean>
    readonly nativeConfigAvailable?: (agentProfileId: string) => Promise<boolean>
    readonly nativeModelMappingAvailable?: (agentProfileId: string) => Promise<boolean>
    readonly startupInventoryAvailable?: (agentProfileId: string) => Promise<boolean>
    readonly beforeStart?: () => Promise<void>
    readonly acknowledgeStarted?: (receipt: HostedProcessReceipt) => Promise<void>
    readonly skillFiles: (
      skill: NonNullable<AgentMaterialIntent['injection']['skills']>[number],
    ) => Promise<readonly HostedMaterialSourceFile[]>
  },
): AgentInvocationPreparation {
  return {
    workspace: input.workspace,
    async compile(intent) {
      const executionId = `agent:${input.taskId}:${intent.nodeRunId}`
      const existing = await input.executions.find(executionId)
      if (existing !== null && existing.request.kind !== 'agent')
        throw new Error('hosted-agent-binding-kind-mismatch')
      const originalContext = existing?.agentContext
      if (originalContext && originalContext.protocol !== intent.protocol)
        throw new Error('hosted-agent-context-runtime-mismatch')
      const profile = intent.injection.profile
      const selected = input.profiles.find(
        (candidate) =>
          candidate.protocol === intent.protocol && candidate.model === (profile?.model || null),
      )
      if (existing === null && selected === undefined)
        throw new Error(
          `hosted-runtime-profile-unmapped: ${intent.protocol}/${profile?.model || 'default'}`,
        )
      const startupInventoryAvailable =
        existing !== null
          ? (originalContext?.startupInventory ?? false)
          : ((await input.startupInventoryAvailable?.(selected!.agentProfileId)) ?? false)
      const nativeAvailable =
        existing === null && selected !== undefined
          ? ((await input.nativeConfigAvailable?.(selected.agentProfileId)) ?? false)
          : false
      if (existing === null && !nativeAvailable) {
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
        if (blocked.length > 0)
          throw new Error(
            `hosted-capability-unavailable: ${blocked.join(', ')} require CrewStation native configuration materials (RFC-370 M2)`,
          )
      }
      // A frozen execution never reads today's skills, plugins, MCP or profile
      // capabilities, even if its original material was profile-only.
      const nativeMaterial =
        existing === null && nativeAvailable
          ? await compileHostedNativeMaterial(intent, {
              ...input,
              async dependentAgentProfile(model, name) {
                const dependent = input.profiles.find(
                  (candidate) =>
                    candidate.protocol === intent.protocol && candidate.model === model,
                )
                if (!dependent)
                  throw new Error(
                    `hosted-runtime-profile-unmapped: ${intent.protocol}/${model} (${name})`,
                  )
                for (const id of new Set([selected!.agentProfileId, dependent.agentProfileId]))
                  if (!(await input.nativeModelMappingAvailable?.(id)))
                    throw new Error(
                      `hosted-capability-unavailable: nativeModelMappingVersion for ${name} (${id})`,
                    )
                return dependent.agentProfileId
              },
            })
          : undefined
      const sourceFiles: HostedMaterialSourceFile[] = []
      if (existing === null)
        for (const skill of intent.injection.skills ?? [])
          sourceFiles.push(...(await input.skillFiles(skill)))
      const stageObjects =
        sourceFiles.some((file) => 'bytes' in file) &&
        input.materialFiles !== undefined &&
        selected !== undefined &&
        ((await input.materialObjectsAvailable?.(selected.agentProfileId)) ?? false)
      const skills: readonly BusinessMaterialFile[] = stageObjects
        ? await input.materialFiles!.stage({
            executionId,
            taskId: input.taskId,
            businessTaskId: input.businessTaskId,
            files: sourceFiles,
          })
        : sourceFiles.map((file) => {
            if (!('bytes' in file)) return file
            try {
              return {
                path: file.path,
                content: new TextDecoder('utf-8', { fatal: true }).decode(file.bytes),
                ...(file.mode === undefined ? {} : { mode: file.mode }),
              }
            } catch {
              throw new Error(
                'hosted-capability-unavailable: binary skills require materialObjectsVersion',
              )
            }
          })
      const materialEnvironment =
        existing === null ? input.materialEnvironment?.(intent) : undefined
      const material = {
        ...(materialEnvironment === undefined ? {} : { env: materialEnvironment }),
        ...(nativeMaterial === undefined
          ? {
              systemPrompt: [intent.systemPrompt, intent.injectedMemoryBlock]
                .filter(Boolean)
                .join('\n\n'),
            }
          : { nativeConfig: nativeMaterial.nativeConfig }),
        skills,
      }
      if (existing === null && Buffer.byteLength(JSON.stringify(material)) > 1024 * 1024)
        throw new Error('hosted-material-exceeds-platform-limit')
      const digest = sha256Hex(JSON.stringify(material))
      const uploaded =
        existing?.request.kind === 'agent'
          ? { materialId: existing.request.materialId }
          : await input.api.createMaterial(input.businessTaskId, {
              ...material,
              requestKey: `aw-material:${digest}`,
              fence: input.fence.current(),
            })
      if (stageObjects && uploaded.materialId !== undefined)
        await input.materialFiles!.published(executionId, uploaded.materialId)
      const materialRef = uploaded.materialId ?? `hosted-execution:${executionId}`
      const requestedDeclaration = {
        ...(nativeMaterial?.declared ?? {
          ...emptyDeclaredManifest(),
          skills: [...new Set(declareSkills(intent.injection.skills ?? []))],
          skippedDisabledMcps: intent.injection.mcps
            .filter((mcp) => !mcp.enabled)
            .map((mcp) => mcp.name),
        }),
        unobservable: startupInventoryAvailable
          ? ['plugins']
          : ['mcpServers', 'skills', 'subagents', 'plugins', 'tools'],
      }
      const agentContext =
        originalContext ??
        freezeHostedAgentContext({
          version: 1,
          protocol: intent.protocol,
          startupInventory: startupInventoryAvailable,
          declared:
            existing === null
              ? requestedDeclaration
              : {
                  ...emptyDeclaredManifest(),
                  unsupported: ['hosted-declaration-not-recorded'],
                  unobservable: ['mcpServers', 'skills', 'subagents', 'plugins', 'tools'],
                },
        })
      const declared = agentContext.declared
      const observedProtocol =
        existing !== null && originalContext === undefined ? undefined : agentContext.protocol
      const native = getRuntimeDriver(intent.protocol)
      const protocol: AgentInvocationProtocol = {
        kind: intent.protocol,
        capabilities: {
          ...native.capabilities,
          startupObservation: startupInventoryAvailable ? 'init-event' : 'none',
          observationRequiresFreshRun: false,
        },
        parseEvent(line) {
          const event = readHostedEvent(JSON.parse(line))
          return event === null ? null : hostedEventRecord(event, observedProtocol).event
        },
        usageMeter: () => createHostedUsageMeter(),
      }
      return {
        materialRef,
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
            materialRef,
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
                      ...(startupInventoryAvailable ? { startupInventoryVersion: 1 as const } : {}),
                      ...(uploaded.materialId === undefined
                        ? {}
                        : { materialId: uploaded.materialId }),
                      ...(intent.resumeSessionId
                        ? { resumeSessionId: intent.resumeSessionId }
                        : {}),
                    }
              const task =
                request.task?.participants.taskEffect === undefined
                  ? undefined
                  : input.participants?.resolve(request.task.participants.taskEffect)
              if (request.task !== undefined && task === undefined)
                throw new Error('hosted-agent-execution-participant-unavailable')
              const node =
                existing === null && task !== undefined
                  ? await task.nodeExecution().read(intent.nodeRunId)
                  : null
              if (
                existing === null &&
                task !== undefined &&
                (node === null || node.taskId !== input.taskId || node.id !== intent.nodeRunId)
              )
                throw new Error('hosted-agent-context-node-mismatch')
              const frozenContext =
                node === null
                  ? agentContext
                  : freezeHostedAgentContext({
                      ...agentContext,
                      node: hostedAgentNodeContext(node),
                    })
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
              await input.beforeStart?.()
              // A rejected start acknowledgement stops the remote run exactly
              // as a local owner aborts its child (system owners fence on it).
              const control = new AbortController()
              const forward = () => control.abort(request.signal?.reason)
              request.signal?.addEventListener('abort', forward, { once: true })
              if (request.signal?.aborted) forward()
              let acknowledgeError: unknown
              let truncated = false
              const tokenDeltas = createHostedTokenDeltas()
              const executionIntent = {
                executionId,
                taskId: input.taskId,
                nodeRunId: intent.nodeRunId,
                businessTaskId: input.businessTaskId,
                requestKey: `aw-agent:${sha256Hex(executionId)}`,
                request: frozen,
                agentContext: frozenContext,
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
                  try {
                    await input.acknowledgeStarted?.(receipt)
                  } catch (error) {
                    acknowledgeError = error
                    if (request.acknowledgeStart === true) control.abort('acknowledge-failed')
                    else throw error
                  }
                },
                async event(event) {
                  if (event.type === 'gap') {
                    truncated = true
                    return
                  }
                  if (event.type === 'output') {
                    if (event.data.stream === 'stderr')
                      await sink.diagnostic(event.data.text, `${executionId}:${event.cursor}`)
                    return
                  }
                  const record = hostedEventRecord(event, observedProtocol)
                  const tokens =
                    event.type === 'usage' ? tokenDeltas(JSON.parse(record.raw)) : undefined
                  if (event.type === 'result' && event.data.truncated) truncated = true
                  await sink.record({
                    ...record,
                    ...(tokens === undefined ? {} : { event: { ...record.event, tokens } }),
                    sourceKey: `${executionId}:${event.cursor}`,
                    observation: {
                      runtimeEventType: `crewstation.${event.type}`,
                      terminalResult:
                        event.type === 'result'
                          ? event.data.exitCode === 0
                            ? 'success'
                            : 'error'
                          : null,
                    },
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
              const finish = async (
                result: 'ok' | 'nonzero-exit' | 'timeout' | 'aborted',
                exitCode: number | null,
                stderrTail: string,
                settleBinding: () => Promise<void>,
                pumpError?: string,
              ) => {
                if (truncated) await sink.truncated?.()
                return {
                  result,
                  exitCode,
                  stderrTail,
                  durationMs: Date.now() - startedAt,
                  ...(pumpError === undefined ? {} : { pumpError }),
                  ...(acknowledgeError === undefined ? {} : { acknowledgeError }),
                  unreapedMessage: () =>
                    'hosted execution outcome is unknown; reconcile its platform receipt',
                  reportUnreaped: () => undefined,
                  async settle() {
                    await effect?.settle({ outcome: result, exitCode })
                    await settleBinding()
                  },
                }
              }
              try {
                const outcome =
                  existing === null
                    ? await input.executions.run(executionIntent, executionSink, control.signal)
                    : await input.executions.adopt(executionId, executionSink, control.signal)
                const result = outcome.timedOut
                  ? 'timeout'
                  : outcome.cancelled || acknowledgeError !== undefined
                    ? 'aborted'
                    : outcome.result.exitCode === 0
                      ? 'ok'
                      : 'nonzero-exit'
                return await finish(result, outcome.result.exitCode, outcome.result.stderr, () =>
                  outcome.settle(),
                )
              } catch (error) {
                if (error instanceof HostedExecutionDetachedError) {
                  // A user cancel before any receipt: the settler resubmits
                  // with the same requestKey and cancels what it finds, so the
                  // run's writer hold is released now. A shutdown or a lost
                  // authority keeps the remote run for the next owner; its
                  // effect stays open for boot recovery to hand off.
                  const userCancel =
                    request.signal?.aborted === true &&
                    request.signal.reason !== DAEMON_SHUTDOWN_ABORT_REASON
                  if (!userCancel) await untilDaemonShutdown(request.signal)
                  return {
                    result: 'aborted' as const,
                    exitCode: null,
                    stderrTail: '',
                    durationMs: Date.now() - startedAt,
                    unreapedMessage: () => error.message,
                    reportUnreaped: () => undefined,
                    settle: async () => {
                      if (userCancel) await effect?.settle({ outcome: 'aborted', exitCode: null })
                    },
                  }
                }
                if (!(error instanceof HostedExecutionUnknownError)) throw error
                // The binding was settled with a synthetic failure; the node
                // fails with the reason and can be retried normally.
                return await finish(
                  'nonzero-exit',
                  null,
                  error.message,
                  async () => undefined,
                  error.message,
                )
              } finally {
                request.signal?.removeEventListener('abort', forward)
              }
            },
          }
        },
      }
    },
  }
}

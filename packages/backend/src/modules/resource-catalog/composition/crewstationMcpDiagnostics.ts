import { createCrewStationMcpDiagnosticRunner } from '@/modules/task-execution/composition/crewstationMcpDiagnosticRunner'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import type { HostedRuntimeCapabilities } from '@/modules/runtime-management/public/types'
import { verifyStartup } from '@/services/execution/startupVerification'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { ValidationError } from '@/util/errors'
import { MCP_RUNTIME_TESTS_CHANNEL, mcpRuntimeTestsBroadcaster } from '@/ws/broadcaster'
import {
  AGENT_NAME,
  SYSTEM_PROMPT,
  MCP_RUNTIME_TEST_EVENT_BYTES,
  stableJson,
} from '../domain/mcps/runtimeDiagnostics'
import type {
  McpDiagnosticsEffects,
  ResolvedTestRuntime,
} from '../application/mcps/runtimeDiagnosticsEffects'
import { bindMcpDiagnosticsRuntime, createMcpDiagnosticsApplication } from './mcpDiagnostics'
import {
  composeLocalMcpDiagnostics,
  type LocalMcpDiagnosticsCompositionInput,
} from './localMcpDiagnostics'
import { composeMcpRuntimeTestProvider } from './mcpRuntimeTestPersistence'

type HostedInput = Parameters<typeof createCrewStationMcpDiagnosticRunner>[0] & {
  readonly capabilities: () => Promise<HostedRuntimeCapabilities>
  readonly locate: (reference: string) => { readonly taskId: string; readonly path: string }
}

/** Resource Catalog retains admission, ACL, turn/session leases and UI events;
 * only its selected execution and workspace effects differ. */
export function createCrewStationMcpDiagnostics(
  input: HostedInput,
): typeof composeLocalMcpDiagnostics {
  return (options) => {
    if (options.runFn !== undefined) return composeLocalMcpDiagnostics(options)
    const selected = {
      ...options,
      ...composeMcpRuntimeTestProvider(input.db, (tx) =>
        input.fence.assertHeld(tx, input.fence.current()),
      ),
    }
    const effects = createCrewStationMcpDiagnosticsEffects(input, selected)
    const runtime = bindMcpDiagnosticsRuntime(
      createMcpDiagnosticsApplication({ ...selected, effects, maintainOnRead: false }),
      options,
    )
    // Configuration/ACL changes may be accepted by a standby service slot.
    // Their durable invalidation is drained by the active background owner.
    const reconcileDurableIntents = async () => {
      try {
        input.fence.current()
      } catch {
        return
      }
      await runtime.reconcileDurableIntents()
    }
    return Object.freeze({
      ...runtime,
      reconcileDurableIntents,
      reconciliation: Object.freeze({ reconcileDurableIntents }),
    })
  }
}

export function createCrewStationMcpDiagnosticsEffects(
  input: HostedInput,
  options: Pick<
    LocalMcpDiagnosticsCompositionInput,
    'configuration' | 'loadRuntime' | 'isRuntimeEligible' | 'now' | 'observe'
  > & {
    readonly persistence: Pick<
      LocalMcpDiagnosticsCompositionInput['persistence'],
      'recordSpawn' | 'recoverQuarantined'
    >
  },
): McpDiagnosticsEffects {
  const runner = createCrewStationMcpDiagnosticRunner({
    ...input,
    startupInventoryAvailable:
      input.startupInventoryAvailable ??
      (async (id) =>
        (await input.capabilities()).agentProfiles.some(
          (profile) =>
            profile.agentProfileId === id && profile.capabilities.startupInventoryVersion === 1,
        )),
  })
  const starts = new WeakMap<
    object,
    { sessionId: string; turnId: string; acknowledge: () => Promise<void> }
  >()
  const targets = new WeakMap<object, string>()
  const now = options.now ?? Date.now
  const sessionForReference = (reference: string) => {
    const owner = input.locate(reference).taskId
    if (!owner.startsWith('mcp-test:')) throw new Error('mcp-test-cleanup-path-unsafe')
    const id = owner.slice('mcp-test:'.length)
    if (reference !== runner.workspaceReference(id)) throw new Error('mcp-test-cleanup-path-unsafe')
    return id
  }
  return {
    now,
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay)
      return { cancel: () => clearTimeout(timer), unref: () => timer.unref() }
    },
    setInterval(callback, delay) {
      const timer = setInterval(callback, delay)
      return { cancel: () => clearInterval(timer), unref: () => timer.unref() }
    },
    workspaceReference: runner.workspaceReference,
    async workspaceExists(reference) {
      try {
        const owner = input.locate(reference).taskId
        if (!owner.startsWith('mcp-test:')) return false
        const id = owner.slice('mcp-test:'.length)
        return reference === runner.workspaceReference(id) && (await runner.workspaceExists(id))
      } catch {
        return false
      }
    },
    async cleanupWorkspace(candidate) {
      if (candidate.cleanupState === 'quarantined')
        return { cleanupState: 'quarantined', cleanupErrorCode: candidate.cleanupErrorCode }
      let sessionId: string
      try {
        sessionId = sessionForReference(candidate.scratchRoot)
      } catch {
        return { cleanupState: 'quarantined', cleanupErrorCode: 'mcp-test-cleanup-path-unsafe' }
      }
      try {
        return (await runner.cleanup(sessionId))
          ? { cleanupState: 'complete', cleanupErrorCode: null }
          : {
              cleanupState: 'pending',
              cleanupErrorCode: 'mcp-test-cleanup-awaits-platform-release',
            }
      } catch {
        return { cleanupState: 'pending', cleanupErrorCode: 'mcp-test-cleanup-failed' }
      }
    },
    // The runtime creates its native identity; the authoritative sink claims
    // that exact identity before accepting subsequent events or continuation.
    createNativeSessionId: () => null,
    // CrewStation resumes the native session of every supported protocol.
    supportsSession: () => true,
    async resolveRuntime(name): Promise<ResolvedTestRuntime> {
      const selected = name ?? (await options.configuration.read()).defaultRuntime ?? 'opencode'
      const row = await options.loadRuntime(selected)
      if (row === null)
        throw new ValidationError(
          'mcp-test-runtime-not-found',
          `runtime '${selected}' is not registered`,
        )
      if (!row.enabled)
        throw new ValidationError('mcp-test-runtime-disabled', `runtime '${selected}' is disabled`)
      const profile = input.profiles.find(
        (p) => p.protocol === row.protocol && p.model === (row.model || null),
      )
      const capabilities = await input.capabilities()
      const tested = capabilities.agentProfiles.find(
        (p) => p.agentProfileId === profile?.agentProfileId,
      )
      if (
        !profile ||
        !tested?.capabilities.events ||
        !tested.capabilities.mcp ||
        tested.capabilities.startupInventoryVersion !== 1 ||
        !options.isRuntimeEligible(row)
      )
        throw new ValidationError(
          'mcp-test-runtime-unsupported',
          `runtime '${selected}' has no tested CrewStation MCP profile`,
        )
      const label = `cs-agent:${row.protocol}`
      if (row.binaryPath !== null && row.binaryPath !== label)
        throw new ValidationError(
          'mcp-test-runtime-unsupported',
          'runtime binary is managed by CrewStation',
        )
      const configDir = DEFAULT_CONFIG_DIR_PROFILE[row.protocol]
      if (
        (row.configDirEnv !== null && row.configDirEnv !== configDir.env) ||
        (row.configDirName !== null && row.configDirName !== configDir.name)
      )
        throw new ValidationError(
          'mcp-test-runtime-unsupported',
          'runtime configuration directories are managed by CrewStation',
        )
      const snapshotJson = stableJson({
        runtime: row,
        profile,
        tested,
        releaseId: capabilities.releaseId,
        mcpTestProfileCodec: 'mcp-test-v1',
      })
      const reference = Object.freeze({})
      targets.set(reference, snapshotJson)
      return {
        row,
        label,
        snapshotJson,
        target: { kind: 'mcp-diagnostic-runtime-target', reference },
      }
    },
    currentMcpHash: async (mcp) => mcpOperationConfigHashOf(mcp),
    hasExecution: runner.hasExecution,
    async reapTurn(turn) {
      try {
        return (await runner.settled(turn)) ? 'not-alive' : 'kill-failed'
      } catch {
        return 'kill-failed'
      }
    },
    async recoverReapedTurn({ session, turn, readNow }) {
      if (!(await runner.settled(turn))) return false
      return options.persistence.recoverQuarantined({
        sessionId: session.id,
        turnId: turn.id,
        expectedPid: null,
        expectedSpawnedAt: turn.spawnedAt,
        now: readNow(),
      })
    },
    captureTurnStart({ session, turn, readNow }) {
      const reference = Object.freeze({})
      starts.set(reference, {
        sessionId: session.id,
        turnId: turn.id,
        acknowledge: async () => {
          const time = readNow()
          const admitted = await options.persistence.recordSpawn({
            sessionId: session.id,
            turnId: turn.id,
            pid: null,
            spawnedAt: time,
            spawnBinaryPath: null,
            fenceAt: time,
          })
          if (!admitted) throw new Error('mcp-test-start-canceled-before-events')
        },
      })
      return { kind: 'mcp-diagnostic-turn-start', reference }
    },
    broadcast(sessionId, snapshot) {
      mcpRuntimeTestsBroadcaster.broadcast(
        MCP_RUNTIME_TESTS_CHANNEL,
        {
          type: 'mcp-runtime-test.updated',
          sessionId,
          sessionVersion: snapshot.sessionVersion,
          inFlightTurnId: snapshot.inFlightTurnId,
          turnStatus: snapshot.turnStatus,
          eventCursor: snapshot.eventCursor,
          captureState: snapshot.captureState,
        },
        { kind: 'mcp-runtime-test-owner', ownerUserId: snapshot.ownerUserId },
      )
    },
    async runTurn({
      session,
      turn,
      mcp,
      runtime,
      signal,
      sink,
      timeoutMs,
      assertSpawnAllowed,
      turnStart,
    }) {
      const start = starts.get(turnStart.reference)
      if (
        !start ||
        start.sessionId !== session.id ||
        start.turnId !== turn.id ||
        runtime.row.protocol !== session.runtimeProtocol ||
        targets.get(runtime.target.reference) !== runtime.snapshotJson
      )
        throw new Error('mcp-test-hosted-binding-not-owned')
      const profile = {
        model: runtime.row.model,
        variant: runtime.row.variant,
        temperature: runtime.row.temperature,
        steps: runtime.row.steps,
        maxSteps: runtime.row.maxSteps,
        isSandbox: runtime.row.isSandbox,
      }
      const result = await runner.run({
        sessionId: session.id,
        turnId: turn.id,
        intent: {
          protocol: session.runtimeProtocol,
          injection: { mcps: [mcp], profile },
          prompt: turn.promptText,
          agentName: AGENT_NAME,
          systemPrompt: SYSTEM_PROMPT,
          resolvedProfiles: [[AGENT_NAME, profile]],
          freshAgentRun: true,
          ...(turn.seq > 1 && session.runtimeSessionId
            ? { resumeSessionId: session.runtimeSessionId }
            : {}),
        },
        policy: {
          feature: 'mcp-runtime-test',
          abortSignal: signal,
          eventSink: sink,
          nativeIdentityAuthoritative: true,
          ...(turn.seq > 1 && session.runtimeSessionId
            ? { resumeSessionId: session.runtimeSessionId }
            : {}),
        },
        timeoutMs,
        maxEventTextBytes: MCP_RUNTIME_TEST_EVENT_BYTES,
        beforeStart: assertSpawnAllowed,
        acknowledgeStarted: start.acknowledge,
        ...(options.observe
          ? {
              observe: options.observe({
                session,
                turn,
                runtime,
                callId: `aw-hosted-mcp:${session.id}:${turn.id}`,
              }),
            }
          : {}),
      })
      return {
        ...result,
        async verifyAfterCapture() {
          if (result.status !== 'ok') return undefined
          if (!result.declared) throw new Error('mcp-test-hosted-declaration-missing')
          return verifyStartup(
            result.declared,
            result.startupObservation ?? {
              state: 'unavailable',
              reason: 'hosted-inventory-not-reported',
            },
          )
        },
      }
    },
    failedResult(_session, _aborted, durationMs) {
      // A thrown callback may follow a durable remote start. The reconciler
      // must inspect that receipt before releasing leases or workspace bytes.
      return {
        status: 'unreaped',
        exitCode: null,
        stderrTail: 'hosted MCP diagnostic requires execution reconciliation',
        durationMs: Math.max(0, durationMs),
        verifyAfterCapture: async () => undefined,
      }
    },
  }
}

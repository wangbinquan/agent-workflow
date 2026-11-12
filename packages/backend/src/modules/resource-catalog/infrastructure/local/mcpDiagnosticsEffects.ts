import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Config } from '@agent-workflow/shared'
import {
  killStaleRunProcessTree as productionKillStaleRunProcessTree,
  type StaleRunKillOutcome,
} from '@/util/process'
import { ValidationError } from '@/util/errors'
import { MCP_RUNTIME_TESTS_CHANNEL, mcpRuntimeTestsBroadcaster } from '@/ws/broadcaster'
import {
  AGENT_NAME,
  SYSTEM_PROMPT,
  MCP_RUNTIME_TEST_EVENT_BYTES,
  stableJson,
} from '../../domain/mcps/runtimeDiagnostics'
import type {
  McpDiagnosticsEffects,
  McpDiagnosticRuntime,
  ResolvedTestRuntime,
  McpDiagnosticRuntimeTarget,
  McpDiagnosticTurnStart,
} from '../../application/mcps/runtimeDiagnosticsEffects'
import type {
  McpRuntimeTestSessionRecord as SessionRow,
  McpRuntimeTestTurnRecord,
  McpRuntimeTestPersistence,
} from '../../application/mcps/runtimeTestPersistence'
import type {
  LocalMcpDiagnosticExecution,
  LocalMcpDiagnosticSpawnReceipt,
} from '../../application/ports/localMcpDiagnosticExecution'
import type { McpDiagnosticObservation } from '../../application/ports/mcpDiagnosticExecution'

/**
 * RFC-488: the local MCP diagnostic family keeps Resource Catalog's own work here — leases and pid receipts, reaping,
 * the workspace layout and cleanup, UI events and timers. The runtime-specific work (driver session support, native
 * session ids, the executable, one turn's run and its startup verification) goes through the injected
 * `LocalMcpDiagnosticExecution`, which Task Execution implements and bootstrap binds.
 */
export interface McpDiagnosticsEffectDependencies {
  readonly observe?: (input: {
    readonly session: SessionRow
    readonly turn: McpRuntimeTestTurnRecord
    readonly runtime: ResolvedTestRuntime
    readonly callId?: string
  }) => McpDiagnosticObservation | undefined
  readonly configuration: {
    read():
      | Pick<Config, 'defaultRuntime' | 'opencodePath' | 'claudeCodePath'>
      | Promise<Pick<Config, 'defaultRuntime' | 'opencodePath' | 'claudeCodePath'>>
  }
  readonly appHome: string
  readonly loadRuntime: (name: string) => Promise<McpDiagnosticRuntime | null>
  readonly isRuntimeEligible: (runtime: McpDiagnosticRuntime) => boolean
  /** The runtime-specific work, bound by bootstrap (Task Execution's local runner, with its test fixture if any). */
  readonly execution: LocalMcpDiagnosticExecution
  readonly now?: () => number
  readonly killStaleRunProcessTree?: (
    run: { pid: number | null; startedAt: number | null; spawnBinaryPath?: string | null },
    opts?: { now?: number; termWaitMs?: number },
  ) => Promise<StaleRunKillOutcome>
}
export interface LocalResolvedTestRuntime extends ResolvedTestRuntime {
  /** Native-only compatibility projection; ordinary callers use target/label. */
  readonly binary: string
}
export interface LocalMcpDiagnosticsEffects extends McpDiagnosticsEffects {
  resolveRuntime(name: string | null): Promise<LocalResolvedTestRuntime>
}
export interface LocalMcpDiagnosticExecutionOwnership {
  readonly persistence: Pick<McpRuntimeTestPersistence, 'recordSpawn' | 'recoverQuarantined'>
  readonly applicationReceiver: () => unknown
}
export function createLocalMcpDiagnosticsEffects(
  deps: McpDiagnosticsEffectDependencies,
  ownership: LocalMcpDiagnosticExecutionOwnership,
): LocalMcpDiagnosticsEffects {
  const binaries = new WeakMap<object, string>()
  const starts = new WeakMap<object, (receipt: LocalMcpDiagnosticSpawnReceipt) => Promise<void>>()
  function captureTarget(binary: string): McpDiagnosticRuntimeTarget {
    const reference = Object.freeze({})
    binaries.set(reference, binary)
    return Object.freeze({ kind: 'mcp-diagnostic-runtime-target', reference })
  }
  function binaryFor(target: McpDiagnosticRuntimeTarget): string {
    const binary = binaries.get(target.reference)
    if (binary === undefined) throw new Error('mcp-test-runtime-target-not-owned')
    return binary
  }
  function startFor(start: McpDiagnosticTurnStart) {
    const callback = starts.get(start.reference)
    if (callback === undefined) throw new Error('mcp-test-turn-start-not-owned')
    return callback
  }
  return {
    now: (() => {
      const now = deps.now ?? Date.now
      return () => now.call(ownership.applicationReceiver())
    })(),
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay)
      return { cancel: () => clearTimeout(timer), unref: () => timer.unref() }
    },
    setInterval(callback, delay) {
      const timer = setInterval(callback, delay)
      return { cancel: () => clearInterval(timer), unref: () => timer.unref() }
    },
    workspaceReference: (id) => join(deps.appHome, 'mcp-runtime-tests', id),
    workspaceExists: (reference) => existsSync(reference),
    supportsSession: (protocol) => deps.execution.supportsSession(protocol),
    createNativeSessionId: (runtime) => deps.execution.createNativeSessionId(runtime.row.protocol),
    reapTurn: (() => {
      const reap = deps.killStaleRunProcessTree ?? productionKillStaleRunProcessTree
      return (turn: McpRuntimeTestTurnRecord, readNow: () => number) =>
        reap.call(
          ownership.applicationReceiver(),
          { pid: turn.pid, startedAt: turn.startedAt, spawnBinaryPath: turn.spawnBinaryPath },
          { now: readNow() },
        )
    })(),
    hasExecution: (turn) => turn.pid !== null,
    recoverReapedTurn: ({ session, turn, readNow }) =>
      ownership.persistence.recoverQuarantined({
        sessionId: session.id,
        turnId: turn.id,
        expectedPid: turn.pid!,
        now: readNow(),
      }),
    captureTurnStart(input) {
      const reference = Object.freeze({})
      starts.set(reference, async (receipt) => {
        const spawnedFenceAt = input.readNow()
        const admittedForPrompt = await ownership.persistence.recordSpawn({
          sessionId: input.session.id,
          turnId: input.turn.id,
          pid: receipt.pid,
          spawnedAt: receipt.spawnedAt,
          spawnBinaryPath: receipt.spawnBinaryPath,
          fenceAt: spawnedFenceAt,
        })
        if (!admittedForPrompt) throw new Error('mcp-test-spawn-canceled-before-prompt')
      })
      return Object.freeze({ kind: 'mcp-diagnostic-turn-start', reference })
    },
    async resolveRuntime(name): Promise<LocalResolvedTestRuntime> {
      const config = await deps.configuration.read()
      const selected = name ?? config.defaultRuntime ?? 'opencode'
      const row = await deps.loadRuntime(selected)
      if (row === null) {
        throw new ValidationError(
          'mcp-test-runtime-not-found',
          `runtime '${selected}' is not registered`,
        )
      }
      if (!row.enabled) {
        throw new ValidationError('mcp-test-runtime-disabled', `runtime '${selected}' is disabled`)
      }
      if (!deps.execution.supportsSession(row.protocol) || !deps.isRuntimeEligible(row)) {
        throw new ValidationError(
          'mcp-test-runtime-unsupported',
          `runtime '${selected}' does not support mcp-test-v1`,
        )
      }
      const binary = deps.execution.executable(row.protocol, row.binaryPath, config)
      if (binary === undefined || binary === '') {
        throw new ValidationError(
          'mcp-test-runtime-unsupported',
          `runtime '${selected}' has no executable`,
        )
      }
      const snapshot = {
        runtimeRowId: row.id,
        name: row.name,
        protocol: row.protocol,
        resolvedBinaryPath: binary,
        model: row.model,
        variant: row.variant,
        temperature: row.temperature,
        steps: row.steps,
        maxSteps: row.maxSteps,
        isSandbox: row.isSandbox,
        configDirEnv: row.configDirEnv,
        configDirName: row.configDirName,
        probeFence: row.probeFence,
        mcpTestProfileCodec: 'mcp-test-v1',
      }
      const snapshotJson = stableJson(snapshot)
      return { row, binary, snapshotJson, target: captureTarget(binary), label: binary }
    },
    async currentMcpHash(mcp) {
      const { mcpOperationConfigHashOf } = await import('../../domain/mcpOperationRevision')
      return mcpOperationConfigHashOf(mcp)
    },
    cleanupWorkspace(row) {
      const alreadyQuarantined = row.cleanupState === 'quarantined'

      const base = resolve(join(deps.appHome, 'mcp-runtime-tests'))
      const target = resolve(row.scratchRoot)
      const safe = dirname(target) === base && target !== base
      let cleanupState: SessionRow['cleanupState'] = alreadyQuarantined ? 'quarantined' : 'complete'
      let cleanupErrorCode: string | null = alreadyQuarantined ? row.cleanupErrorCode : null
      if (alreadyQuarantined) {
        // A known or possibly-live child may still own the directory. Retain it
        // and block replacement/deletion until explicit recovery proves reaping.
      } else if (!safe) {
        cleanupState = 'quarantined'
        cleanupErrorCode = 'mcp-test-cleanup-path-unsafe'
      } else {
        try {
          rmSync(target, { recursive: true, force: true })
        } catch {
          cleanupState = 'pending'
          cleanupErrorCode = 'mcp-test-cleanup-failed'
        }
      }
      return { cleanupState, cleanupErrorCode }
    },
    broadcast(sessionId, session) {
      mcpRuntimeTestsBroadcaster.broadcast(
        MCP_RUNTIME_TESTS_CHANNEL,
        {
          type: 'mcp-runtime-test.updated',
          sessionId,
          sessionVersion: session.sessionVersion,
          inFlightTurnId: session.inFlightTurnId,
          turnStatus: session.turnStatus,
          eventCursor: session.eventCursor,
          captureState: session.captureState,
        },
        {
          kind: 'mcp-runtime-test-owner',
          ownerUserId: session.ownerUserId,
        },
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
      return await deps.execution.run({
        feature: 'mcp-runtime-test',
        protocol: session.runtimeProtocol,
        agentName: AGENT_NAME,
        systemPrompt: SYSTEM_PROMPT,
        prompt: turn.promptText,
        scratch: {
          parent: join(deps.appHome, 'mcp-runtime-tests'),
          name: session.id,
          root: session.scratchRoot,
        },
        turn: { id: turn.id, seq: turn.seq },
        mcp,
        binary: binaryFor(runtime.target),
        runtime: {
          protocol: runtime.row.protocol,
          model: runtime.row.model,
          variant: runtime.row.variant,
          temperature: runtime.row.temperature,
          steps: runtime.row.steps,
          maxSteps: runtime.row.maxSteps,
          isSandbox: runtime.row.isSandbox,
          configDirEnv: runtime.row.configDirEnv,
          configDirName: runtime.row.configDirName,
        },
        nativeSessionId: session.runtimeSessionId,
        // Observation and session resume ride together, as before (the runner leaves both out of fixture runs).
        ...(deps.observe === undefined
          ? {}
          : {
              observe: deps.observe({ session, turn, runtime }),
              ...(turn.seq > 1 && session.runtimeSessionId !== null
                ? { resumeSessionId: session.runtimeSessionId }
                : {}),
            }),
        timeoutMs,
        maxEventTextBytes: MCP_RUNTIME_TEST_EVENT_BYTES,
        maxRawFrameBytes: 2 * 1024 * 1024,
        signal,
        sink,
        beforeSpawn: assertSpawnAllowed,
        onSpawned: startFor(turnStart),
      })
    },
    failedResult(_session, aborted, durationMs) {
      return {
        status: aborted ? 'aborted' : 'spawn-failed',
        exitCode: null,
        stderrTail: 'runtime test attempt failed before completion',
        durationMs: Math.max(0, durationMs),
        verifyAfterCapture: async () => undefined,
      }
    },
  }
}

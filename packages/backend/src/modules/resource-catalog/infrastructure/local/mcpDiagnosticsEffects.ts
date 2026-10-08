import { existsSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_CONFIG_DIR_PROFILE,
  type Config,
  type StartupVerificationResult,
} from '@agent-workflow/shared'
import { getRuntimeDriver } from '@/services/runtime'
import type { AgentSpawnContext, AgentSpawnPlan, SpawnPlan } from '@/services/runtime/types'
import {
  runSystemAgent,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '@/services/systemAgentRun'
import {
  observationForVerification,
  verifyStartup,
  type StartupObservation,
} from '@/services/execution/startupVerification'
import {
  killStaleRunProcessTree as productionKillStaleRunProcessTree,
  type StaleRunKillOutcome,
} from '@/util/process'
import { ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
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
export interface McpDiagnosticsEffectDependencies {
  readonly observe?: (input: {
    readonly session: SessionRow
    readonly turn: McpRuntimeTestTurnRecord
    readonly runtime: ResolvedTestRuntime
  }) => SystemAgentRunOptions['observe']
  readonly configuration: {
    read():
      | Pick<Config, 'defaultRuntime' | 'opencodePath' | 'claudeCodePath'>
      | Promise<Pick<Config, 'defaultRuntime' | 'opencodePath' | 'claudeCodePath'>>
  }
  readonly appHome: string
  readonly loadRuntime: (name: string) => Promise<McpDiagnosticRuntime | null>
  readonly isRuntimeEligible: (runtime: McpDiagnosticRuntime) => boolean
  readonly runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
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
  const runFn = deps.runFn ?? runSystemAgent
  const log = createLogger('mcp-runtime-test')
  const binaries = new WeakMap<object, string>()
  const starts = new WeakMap<object, NonNullable<SystemAgentRunOptions['onSpawned']>>()
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
  async function verifyTurn(
    session: SessionRow,
    turn: McpRuntimeTestTurnRecord,
    result: SystemAgentRunResult,
  ) {
    let verification: StartupVerificationResult | undefined
    if (result.status === 'ok' && deps.runFn === undefined) {
      const driver = getRuntimeDriver(session.runtimeProtocol)
      const turnRunRootForRead = join(session.scratchRoot, 'run', 'turns', turn.id)
      // RFC-282 C2 — observation source from the driver's static declaration
      // (the presence-proxy sent a third runtime down the claude branch).
      // RFC-297 T12：判据收进 execution 层单点，测试台与 runner 共用同一份
      // （此前两处各写一遍同样的 switch）。取数时机仍归调用方（它持有 runRoot），
      // 判据归被调方——收口后这里只剩一次赋值，故 const。
      const observation: StartupObservation = await observationForVerification(
        driver.capabilities,
        {
          claudeInit: result.startupInventory ?? null,
          // 惰性：只有以文件为观测源的运行时才会真的去读（判据在被调方）。
          loadSnapshot: async () =>
            (await driver
              .readInventory?.({ runRoot: turnRunRootForRead, nodeKind: 'agent-single' })
              .catch(() => null)) ?? null,
        },
      )
      if (result.declared === undefined) {
        throw new Error('mcp-test declared manifest missing from run result (assembly seam broken)')
      }
      verification = verifyStartup(result.declared, observation)
    }
    return verification
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
    supportsSession: (protocol) => getRuntimeDriver(protocol).mcpTestSessionReference !== undefined,
    createNativeSessionId: (runtime) =>
      getRuntimeDriver(runtime.row.protocol).createMcpTestNativeSessionId?.() ?? null,
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
      const driver = getRuntimeDriver(row.protocol)
      if (driver.mcpTestSessionReference === undefined || !deps.isRuntimeEligible(row)) {
        throw new ValidationError(
          'mcp-test-runtime-unsupported',
          `runtime '${selected}' does not support mcp-test-v1`,
        )
      }
      const binary = row.binaryPath ?? driver.defaultBinary(config)[0]
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
      const { mcpOperationConfigHashOf } = await import('@/services/mcpOperationRevision')
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
      const driver = getRuntimeDriver(runtime.row.protocol)
      const result = await runFn({
        feature: 'mcp-runtime-test',
        agentName: AGENT_NAME,
        systemPrompt: SYSTEM_PROMPT,
        prompt: turn.promptText,
        protocol: session.runtimeProtocol,
        runtimeBinary: binaryFor(runtime.target),
        model: runtime.row.model,
        scratchParent: join(deps.appHome, 'mcp-runtime-tests'),
        scratchName: session.id,
        timeoutMs,
        maxEventTextBytes: MCP_RUNTIME_TEST_EVENT_BYTES,
        maxRawFrameBytes: 2 * 1024 * 1024,
        abortSignal: signal,
        eventSink: sink,
        nativeIdentityAuthoritative: true,
        retainScratchOnSuccess: true,
        ...(deps.runFn !== undefined || deps.observe === undefined
          ? {}
          : {
              observe: deps.observe({ session, turn, runtime }),
              ...(turn.seq > 1 && session.runtimeSessionId !== null
                ? { resumeSessionId: session.runtimeSessionId }
                : {}),
            }),
        // RFC-282 B1b (§2.1b) — the old `buildPlan` escape hatch could return an
        // arbitrary plan, making the declared manifest a SECOND computation at
        // settle. Narrowed: buildCtx customizes the assembly INPUT (admission
        // gate runs before assembling), wrapPlan only WRAPS cleanup/beforeSpawn,
        // and the declared manifest rides the run result (§2.1b-2).
        ...(deps.runFn !== undefined
          ? {
              // In-process fake runs (fixture runFn): no real assembly.
              testPlanOverride: (): SpawnPlan => {
                return {
                  cmd: [binaryFor(runtime.target)],
                  env: {},
                  stdin: { mode: 'ignore' },
                  beforeSpawn: assertSpawnAllowed,
                }
              },
            }
          : {
              buildCtx: ({
                worktreePath,
                runDir,
              }: {
                worktreePath: string
                runDir: string
              }): AgentSpawnContext => {
                const turnRunRoot = join(runDir, 'turns', turn.id)
                // RFC-284 T13（审计 N4）：手写二元 cast 会绕开 shared 的
                // RuntimeKind 完备性设计（新增第三 kind 编译照过、运行时
                // TypeError）——改走 runtimeRegistry 的穷尽访问器。
                const protocolDefaults = DEFAULT_CONFIG_DIR_PROFILE[session.runtimeProtocol]
                // RFC-280 T6 — the playground rides the unified injection layer;
                // the RFC-029 inventory plugin is FORCED on runtimes that observe
                // via file (P1-4 — a strict consumer must never run blind).
                return {
                  injection: { mcps: [mcp] },
                  prompt: turn.promptText,
                  agentName: AGENT_NAME,
                  systemPrompt: SYSTEM_PROMPT,
                  resolvedParamsByAgent: new Map([
                    [
                      AGENT_NAME,
                      {
                        model: runtime.row.model ?? null,
                        variant: runtime.row.variant ?? null,
                        temperature: runtime.row.temperature ?? null,
                        steps: runtime.row.steps ?? null,
                        maxSteps: runtime.row.maxSteps ?? null,
                        isSandbox: runtime.row.isSandbox === true,
                      },
                    ],
                  ]),
                  cwd: worktreePath,
                  runRoot: turnRunRoot,
                  configDir: {
                    env: runtime.row.configDirEnv ?? protocolDefaults.env,
                    name: runtime.row.configDirName ?? protocolDefaults.name,
                  },
                  runtimeBinary: binaryFor(runtime.target),
                  // RFC-297 T13：测试台每一轮都是**新 spawn 的 agent 运行**，
                  // 如实陈述即可；「据此要不要物化 dump 插件」是 driver 的知识
                  // （此前这里写的是 `startupObservation === 'inventory-file'`,
                  // 等于把某个运行时的实现细节搬进了调用方）。
                  freshAgentRun: true,
                  ...driver.mcpTestSessionReference?.({
                    turnSeq: turn.seq,
                    nativeSessionId: session.runtimeSessionId,
                  }),
                  nodeRunId: turn.id,
                  log: log,
                }
              },
              // §2.1b（实现门 P2-2）— wrap-only: return just the two slots;
              // the plan itself never passes through adapter hands.
              wrapPlan: (basePlan: AgentSpawnPlan, { runDir }: { runDir: string }) => ({
                // P1-7: secret material must not outlive the turn — the claude
                // mcp-config.json goes here; inventory.json is kept for the
                // post-run observation read (the session scratch owns the dir).
                cleanup: async () => {
                  await basePlan.cleanup?.()
                  await rm(join(runDir, 'turns', turn.id, 'mcp-config.json'), { force: true })
                },
                beforeSpawn: async () => {
                  await basePlan.beforeSpawn?.()
                  await assertSpawnAllowed()
                },
              }),
            }),
        onSpawned: startFor(turnStart),
      })
      return {
        status: result.status,
        exitCode: result.exitCode,
        stderrTail: result.stderrTail,
        durationMs: result.durationMs,
        ...(result.capturedSessionId === undefined
          ? {}
          : { capturedSessionId: result.capturedSessionId }),
        ...(result.nativeSessionIntegrityFailed === undefined
          ? {}
          : { nativeSessionIntegrityFailed: result.nativeSessionIntegrityFailed }),
        verifyAfterCapture: () => verifyTurn(session, turn, result),
      }
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

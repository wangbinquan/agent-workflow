// RFC-488 — the local MCP diagnostic runner: Resource Catalog's `LocalMcpDiagnosticExecution` for the native profile,
// next to the hosted runner (`composition/crewstationMcpDiagnosticRunner.ts`). Moved verbatim from Resource Catalog's
// local diagnostic effects: the driver knowledge (session reference, native session ids, the default executable,
// startup observation), the spawn context and its wrap, the in-process fixture plan and the native system-agent run.
// Resource Catalog keeps leases, pid receipts and reaping, the workspace layout and cleanup, UI events and timers.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG_DIR_PROFILE,
  observationForVerification,
  verifyStartup,
  type Config,
  type Mcp,
  type StartupObservation,
  type StartupVerificationResult,
} from '@agent-workflow/shared'
import { getRuntimeDriver } from '@/services/runtime'
import type { AgentSpawnContext, AgentSpawnPlan, SpawnPlan } from '@/services/runtime/types'
import {
  runSystemAgent,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '@/services/systemAgentRun'
import { createLogger, type Logger } from '@/util/log'

type Protocol = SystemAgentRunOptions['protocol']

/** In-process fake runs for tests: no real assembly, observation, session resume or startup verification. */
export interface LocalMcpDiagnosticRunFixture {
  readonly runFn: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
}

export interface LocalMcpDiagnosticRunnerInput {
  readonly fixture?: LocalMcpDiagnosticRunFixture
}

/** One diagnostic turn as Resource Catalog's local family asks for it (structurally its port's request). */
export interface LocalMcpDiagnosticRunRequest {
  readonly feature: string
  readonly protocol: Protocol
  readonly agentName: string
  readonly systemPrompt: string
  readonly prompt: string
  readonly scratch: { readonly parent: string; readonly name: string; readonly root: string }
  readonly turn: { readonly id: string; readonly seq: number }
  readonly mcp: Mcp
  readonly binary: string
  readonly runtime: {
    readonly protocol: Protocol
    readonly model: string | null
    readonly variant: string | null
    readonly temperature: number | null
    readonly steps: number | null
    readonly maxSteps: number | null
    readonly isSandbox: boolean
    readonly configDirEnv: string | null
    readonly configDirName: string | null
  }
  readonly nativeSessionId: string | null
  readonly observe?: SystemAgentRunOptions['observe']
  readonly resumeSessionId?: string
  readonly timeoutMs: number
  readonly maxEventTextBytes: number
  readonly maxRawFrameBytes: number
  readonly signal: AbortSignal
  readonly sink: NonNullable<SystemAgentRunOptions['eventSink']>
  readonly beforeSpawn: () => Promise<void>
  readonly onSpawned: NonNullable<SystemAgentRunOptions['onSpawned']>
}

/**
 * The run options one local diagnostic turn hands to the native system-agent run. Real runs assemble the spawn context
 * (`buildCtx`) and wrap the driver's plan (`wrapPlan`); fixture runs get the minimal plan (`testPlanOverride`) and no
 * observation or session resume. Pure, so its lock can read the assembly without spawning.
 */
export function localMcpDiagnosticRunOptions(
  request: LocalMcpDiagnosticRunRequest,
  mode: { readonly fixture: boolean; readonly log: Logger },
): SystemAgentRunOptions {
  const driver = getRuntimeDriver(request.runtime.protocol)
  return {
    feature: request.feature,
    agentName: request.agentName,
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
    protocol: request.protocol,
    runtimeBinary: request.binary,
    model: request.runtime.model,
    scratchParent: request.scratch.parent,
    scratchName: request.scratch.name,
    timeoutMs: request.timeoutMs,
    maxEventTextBytes: request.maxEventTextBytes,
    maxRawFrameBytes: request.maxRawFrameBytes,
    abortSignal: request.signal,
    eventSink: request.sink,
    nativeIdentityAuthoritative: true,
    retainScratchOnSuccess: true,
    // Observation and session resume only on real runs (as the caller asked for them).
    ...(mode.fixture
      ? {}
      : {
          ...(request.observe === undefined ? {} : { observe: request.observe }),
          ...(request.resumeSessionId === undefined
            ? {}
            : { resumeSessionId: request.resumeSessionId }),
        }),
    // RFC-282 B1b (§2.1b) — the old `buildPlan` escape hatch could return an
    // arbitrary plan, making the declared manifest a SECOND computation at
    // settle. Narrowed: buildCtx customizes the assembly INPUT (admission
    // gate runs before assembling), wrapPlan only WRAPS cleanup/beforeSpawn,
    // and the declared manifest rides the run result (§2.1b-2).
    ...(mode.fixture
      ? {
          // In-process fake runs (fixture runFn): no real assembly.
          testPlanOverride: (): SpawnPlan => {
            return {
              cmd: [request.binary],
              env: {},
              stdin: { mode: 'ignore' },
              beforeSpawn: request.beforeSpawn,
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
            const turnRunRoot = join(runDir, 'turns', request.turn.id)
            // RFC-284 T13（审计 N4）：手写二元 cast 会绕开 shared 的
            // RuntimeKind 完备性设计——改走 runtimeRegistry 的穷尽访问器。
            const protocolDefaults = DEFAULT_CONFIG_DIR_PROFILE[request.protocol]
            // RFC-280 T6 — the playground rides the unified injection layer;
            // the RFC-029 inventory plugin is FORCED on runtimes that observe
            // via file (P1-4 — a strict consumer must never run blind).
            return {
              injection: { mcps: [request.mcp] },
              prompt: request.prompt,
              agentName: request.agentName,
              systemPrompt: request.systemPrompt,
              resolvedParamsByAgent: new Map([
                [
                  request.agentName,
                  {
                    model: request.runtime.model ?? null,
                    variant: request.runtime.variant ?? null,
                    temperature: request.runtime.temperature ?? null,
                    steps: request.runtime.steps ?? null,
                    maxSteps: request.runtime.maxSteps ?? null,
                    isSandbox: request.runtime.isSandbox === true,
                  },
                ],
              ]),
              cwd: worktreePath,
              runRoot: turnRunRoot,
              configDir: {
                env: request.runtime.configDirEnv ?? protocolDefaults.env,
                name: request.runtime.configDirName ?? protocolDefaults.name,
              },
              runtimeBinary: request.binary,
              // RFC-297 T13：测试台每一轮都是**新 spawn 的 agent 运行**，
              // 「据此要不要物化 dump 插件」是 driver 的知识。
              freshAgentRun: true,
              ...driver.mcpTestSessionReference?.({
                turnSeq: request.turn.seq,
                nativeSessionId: request.nativeSessionId,
              }),
              nodeRunId: request.turn.id,
              log: mode.log,
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
              await rm(join(runDir, 'turns', request.turn.id, 'mcp-config.json'), {
                force: true,
              })
            },
            beforeSpawn: async () => {
              await basePlan.beforeSpawn?.()
              await request.beforeSpawn()
            },
          }),
        }),
    onSpawned: request.onSpawned,
  }
}

/** The startup verification of one finished turn: only real runs that succeeded are verified. */
export async function verifyLocalMcpDiagnosticTurn(
  request: LocalMcpDiagnosticRunRequest,
  result: SystemAgentRunResult,
  mode: { readonly fixture: boolean },
): Promise<StartupVerificationResult | undefined> {
  let verification: StartupVerificationResult | undefined
  if (result.status === 'ok' && !mode.fixture) {
    const driver = getRuntimeDriver(request.protocol)
    const turnRunRootForRead = join(request.scratch.root, 'run', 'turns', request.turn.id)
    // RFC-282 C2 — observation source from the driver's static declaration
    // (the presence-proxy sent a third runtime down the claude branch).
    // RFC-297 T12：判据收进单点（RFC-463 起在 shared），测试台与 runner 共用同一份。
    // 取数时机仍归调用方（它持有 runRoot），判据归被调方。
    const observation: StartupObservation = await observationForVerification(driver.capabilities, {
      claudeInit: result.startupInventory ?? null,
      // 惰性：只有以文件为观测源的运行时才会真的去读（判据在被调方）。
      loadSnapshot: async () =>
        (await driver
          .readInventory?.({ runRoot: turnRunRootForRead, nodeKind: 'agent-single' })
          .catch(() => null)) ?? null,
    })
    if (result.declared === undefined) {
      throw new Error('mcp-test declared manifest missing from run result (assembly seam broken)')
    }
    verification = verifyStartup(result.declared, observation)
  }
  return verification
}

export function createLocalMcpDiagnosticRunner(input: LocalMcpDiagnosticRunnerInput = {}) {
  const fixture = input.fixture
  const runFn = fixture?.runFn ?? runSystemAgent
  const mode = { fixture: fixture !== undefined, log: createLogger('mcp-runtime-test') }
  return {
    supportsSession: (protocol: Protocol) =>
      getRuntimeDriver(protocol).mcpTestSessionReference !== undefined,
    createNativeSessionId: (protocol: Protocol) =>
      getRuntimeDriver(protocol).createMcpTestNativeSessionId?.() ?? null,
    executable: (
      protocol: Protocol,
      registered: string | null,
      configuration: Pick<Config, 'opencodePath' | 'claudeCodePath'>,
    ) => registered ?? getRuntimeDriver(protocol).defaultBinary(configuration)[0],
    async run(request: LocalMcpDiagnosticRunRequest) {
      const result = await runFn(localMcpDiagnosticRunOptions(request, mode))
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
        verifyAfterCapture: () => verifyLocalMcpDiagnosticTurn(request, result, mode),
      }
    },
  }
}

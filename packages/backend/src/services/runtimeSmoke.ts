// RFC-112 PR-B — deep-smoke conformance probe. Given a (protocol, binaryPath),
// run ONE minimal real call through that protocol's driver against the binary
// and verify it speaks the protocol end-to-end: emits a parseable stream of the
// driver's events, captures a session id, and — proving it actually consumed the
// prompt and ran a model turn — echoes back a freshly-generated nonce. This is
// the conformance signal (D2: fork version strings are unreliable, so we never
// probe `--version`). Auth / quota / model failures are CLASSIFIED separately
// (Codex P2) so a conforming fork that merely lacks credentials isn't rejected.
//
// Lifecycle is fully self-contained (NOT runNode — no DB rows / worktree): a
// throwaway temp cwd, a try/finally that drains stdout+stderr under a byte cap,
// and a bounded process-group TERM→KILL→reap sequence. Temp/store deletion occurs
// only after reap and plan cleanup are both confirmed; unsafe remnants are
// deliberately retained for recovery instead of recursively deleted.

import { randomBytes } from 'node:crypto'
import {
  getRuntimeDriver,
  bindNativeAgentMaterialWorkspace,
  type RuntimeKind,
} from '@/services/runtime'
import type { SpawnPlan } from '@/services/runtime/types'
import { createLogger, type Logger } from '@/util/log'
import { bindNativeAgentInvocation } from '@/modules/task-execution/composition/agentInvocation'
import { bindNativeAgentProtocol } from '@/modules/runtime-management/infrastructure/local/agentProtocol'
import { Paths } from '@/util/paths'
import {
  DEFAULT_TIMEOUT_MS,
  runRuntimeSmokeCore,
} from '@/modules/task-execution/application/runtimeSmoke'
export { MODEL_FAIL_SIGNATURES } from '@/modules/task-execution/application/runtimeSmoke'

export type SmokeOutcome =
  | 'conforms'
  | 'spawn-failed'
  | 'auth-missing'
  // RFC-116: binary speaks the protocol but the model endpoint is unreachable
  // (403 region block / connection refused/timeout/DNS / missing proxy).
  | 'network-blocked'
  | 'model-call-failed'
  | 'stream-nonconforming'

export interface SmokeResult {
  outcome: SmokeOutcome
  conforms: boolean
  detail: string
  capturedSessionId?: string
  sawNonce: boolean
  sawEnvelope: boolean
  exitCode: number | null
}

export interface SmokeOptions {
  protocol: RuntimeKind
  /** RFC-254: a string is the binary path (production); an array is a full spawn
   *  command head (`[bun, run, mock]`) — used by Windows tests where a single-file
   *  `.sh`/`.cmd` wrapper cannot stream the protocol. Routed to the driver's
   *  command-array seam (opencodeCmd / runtimeCmd), not runtimeBinary. */
  binaryPath: string | readonly string[]
  config?: { opencodePath?: string | null; claudeCodePath?: string | null }
  model?: string
  /** 2026-08-04 — the runtime row's extraArgs, so a probe reproduces the exact
   *  argv a dispatch would use (fork flags like `--skip-safe-check`). */
  extraArgs?: readonly string[]
  /** RFC-276: reproduce the runtime profile's optional Claude CLI marker. */
  isSandbox?: boolean
  timeoutMs?: number
  log?: Logger
}

/**
 * Build the protocol's minimal smoke spawn plan (binary head = [binaryPath]).
 * RFC-143 PR-4: the smoke IS a system agent (one persona, no skills / mcp /
 * plugins / inventory), so it routes through `driver.buildSpawn` instead of
 * hand-assembling per-protocol argv here — the second spawn-assembly site is
 * gone and a third runtime's probe needs zero smoke changes.
 *
 * runDir = attemptDir: the config dir must EXIST before spawn (opencode 1.17+
 * writes a `.gitignore` into OPENCODE_CONFIG_DIR on startup and exits 1 when
 * it's missing — locked by runtime-smoke.test.ts). mkdtempSync created
 * attemptDir, so the contract holds without a protocol-specific mkdir; claude
 * only writes its generated system prompt there (since RFC-276 it gets no
 * platform-owned config dir at all — it reads the operator's own).
 */
async function buildSmokePlan(
  protocol: RuntimeKind,
  binaryPath: string | readonly string[],
  worktreeDir: string,
  runDir: string,
  prompt: string,
  model: string | undefined,
  extraArgs: readonly string[] | undefined,
  isSandbox: boolean,
  log: Logger,
): Promise<SpawnPlan> {
  const driver = getRuntimeDriver(protocol)
  // RFC-282 B1b — unified persona-only assembly. RFC-254: an array binaryPath
  // is a full command head → the runtime-neutral binaryOverride (each driver
  // maps it onto its own seam); a string stays the plain runtimeBinary.
  return driver.buildSpawn({
    injection: { mcps: [] },
    prompt,
    agentName: 'aw-smoke',
    systemPrompt: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
    resolvedParamsByAgent: new Map([
      [
        'aw-smoke',
        {
          model: model ?? null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
          isSandbox,
        },
      ],
    ]),
    cwd: worktreeDir,
    runRoot: runDir,
    freshAgentRun: false,
    ...(extraArgs !== undefined && extraArgs.length > 0 ? { extraArgs } : {}),
    ...(typeof binaryPath === 'string'
      ? { runtimeBinary: binaryPath }
      : { binaryOverride: binaryPath }),
    nodeRunId: 'runtime-smoke',
    log,
  })
}

/**
 * Run one minimal call against `binaryPath` via the `protocol` driver and
 * classify whether it conforms. Never throws — a spawn failure becomes a
 * `spawn-failed` result.
 */
export async function smokeRuntime(opts: SmokeOptions): Promise<SmokeResult> {
  const log = opts.log ?? createLogger('runtimeSmoke')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const driver = getRuntimeDriver(opts.protocol)
  const nonce = `awsmoke-${randomBytes(8).toString('hex')}`
  // RFC-280 T4/T5（落差⑤）：appHome scratch，不再 OS tmpdir —— GC 归属确定，
  // 与 systemAgentRun 的 scratch 策略一致。
  const materialWorkspace = bindNativeAgentMaterialWorkspace({ kind: 'smoke', appHome: Paths.root })
  const worktreeDir = materialWorkspace.locations.workingDirectory
  const runDir = materialWorkspace.locations.runDirectory
  return runRuntimeSmokeCore(opts, {
    log,
    timeoutMs,
    nonce,
    invocation: {
      workspace: materialWorkspace.workspace,
      prepareWorkspace: () => materialWorkspace.workspace.prepare(),
      async compile(prompt) {
        const plan = await buildSmokePlan(
          opts.protocol,
          opts.binaryPath,
          worktreeDir,
          runDir,
          prompt,
          opts.model,
          opts.extraArgs,
          opts.isSandbox === true,
          log,
        )
        return {
          bind() {
            return bindNativeAgentInvocation({
              plan,
              protocol: bindNativeAgentProtocol(driver),
              workspace: materialWorkspace.workspace,
              workingDirectory: () => worktreeDir,
              cleanupReceiver: 'executor',
              evidenceHooks: driver,
              evidenceScope: {
                environment: () => plan.env,
                runContent: () => runDir,
                sessionLocation: () => ({ worktreePath: worktreeDir }),
              },
            })
          },
        }
      },
    },
  })
}

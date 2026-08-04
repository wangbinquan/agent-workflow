// RFC-224 — the only shell/local-MCP subprocess boundary admitted by the
// verified OpenCode launcher. The tiny on-disk wrapper re-enters this binary;
// this module then dispatches to the sealed containment-provider plan (no
// model-controlled shell interpolation) and rebuilds the child environment
// from an allowlist.

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { canonicalEnvKey, mcpEnvEntryProblem } from '@agent-workflow/shared'
import { isLexicallyInsideForHost } from '@/util/platformExec'
import { assertSameFileIdentityForHost } from '@/util/fileTrust'
import { IS_EMBEDDED } from '@/embed'
import { executionIdentityFailure } from './failure'
import { RuntimeChildProviderPlanSchema, type RuntimeChildProviderPlan } from './containment'
import { platformSpawnOptionsForHost } from '@/util/platformExec'

const SAFE_ENV_NAME =
  /^(?:LANG|LC_ALL|LC_CTYPE|TERM|TZ|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL|[A-Z][A-Z0-9_]{0,127})$/
const DANGEROUS_ENV_NAME =
  /^(?:OPENCODE_|NODE_OPTIONS$|NODE_PATH$|BUN_|DENO_|PYTHON|RUBY|PERL|LD_|DYLD_|BASH_ENV$|ENV$|ZDOTDIR$|GIT_CONFIG|GIT_EXEC|GIT_SSH|SSH_AUTH_SOCK$|DISPLAY$|WAYLAND_DISPLAY$|ELECTRON_RUN_AS_NODE$|NPM_CONFIG_SCRIPT_SHELL$|COREPACK_|EDITOR$|VISUAL$|PAGER$)/i
const BWRAP_CAPABILITY_TIMEOUT_MS = 5_000
const BWRAP_CAPABILITY_STOP_GRACE_MS = 250
const BWRAP_CAPABILITY_STOP_POLL_MS = 25
const BWRAP_CAPABILITY_REPORT_LIMIT_BYTES = 512
const BWRAP_CAPABILITY_WATCHDOG_MS = 10_000
const BWRAP_CAPABILITY_RELEASE_MARGIN_MS = 2_000
const BWRAP_CAPABILITY_CONTROL_LIMIT_BYTES = 512
const BWRAP_CAPABILITY_SUPERVISOR_SUBCOMMAND = '__opencode-bwrap-capability-supervisor'
const NANOSECONDS_PER_MILLISECOND = 1_000_000n

interface RootOwnedBwrapStopState {
  groupExited: boolean
}

type RootOwnedBwrapSignalState = 'owned' | 'releasing' | 'released'

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0') && resolve(value) === value)

export const NetlessSubprocessManifestSchema = z
  .object({
    codec: z.literal(1),
    mode: z.enum(['shell', 'mcp']),
    provider: RuntimeChildProviderPlanSchema,
    worktreePath: AbsolutePathSchema,
    scratchPath: AbsolutePathSchema,
    appHome: AbsolutePathSchema,
    realHome: AbsolutePathSchema,
    /**
     * Exact Git common directories resolved and canonicalized by the daemon.
     * A linked worktree's in-worktree `.git` file points here; without this
     * projection the appHome/realHome masks make every child `git` command
     * fail even though the workspace itself remains writable.
     */
    gitCommonDirs: z.array(AbsolutePathSchema).max(64),
    bindReadOnly: z.array(AbsolutePathSchema).max(256),
    env: z.record(z.string()),
    command: z.array(z.string()).min(1).max(256),
  })
  .strict()

export type NetlessSubprocessManifest = z.infer<typeof NetlessSubprocessManifestSchema>

export interface NetlessSubprocessInvocation {
  cmd: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}

export type NetlessSubprocessProviderRenderer = (
  manifest: NetlessSubprocessManifest,
  provider: RuntimeChildProviderPlan,
  passthroughArgs: readonly string[],
) => NetlessSubprocessInvocation

const customNetlessRenderers = new Map<string, NetlessSubprocessProviderRenderer>()

/**
 * Future platform providers register one strict provider-plan parser/renderer
 * at process initialization. OpenCode's planning core carries the opaque JSON
 * and never needs a Windows/POSIX branch.
 */
export function registerNetlessSubprocessProvider(
  providerId: string,
  renderer: NetlessSubprocessProviderRenderer,
): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId) ||
    providerId === 'linux-bwrap' ||
    providerId === 'macos-seatbelt' ||
    providerId === 'none' ||
    customNetlessRenderers.has(providerId)
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  customNetlessRenderers.set(providerId, renderer)
}

function shellQuote(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function verifiedSelfCommand(subcommand: string, args: readonly string[]): string[] {
  if (!/^__[a-z0-9-]+$/.test(subcommand)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  if (IS_EMBEDDED) return [process.execPath, subcommand, ...args]
  const mainPath = resolve(import.meta.dir, '../../../main.ts')
  return [process.execPath, 'run', mainPath, subcommand, ...args]
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function writeExclusiveRegular(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    mode,
  )
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  } finally {
    await handle.close()
  }
  await chmod(path, mode)
}

export function sanitizeNetlessEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      // RFC-254 T2: match the name in its platform-canonical form. The
      // whitelist demands an ALL-CAPS name, which is right on POSIX but drops
      // every legitimately mixed-case Windows variable — `SystemRoot`, `Temp`,
      // `ProgramData` — and a child without `SystemRoot` cannot even
      // initialise winsock. The ORIGINAL spelling is what gets forwarded.
      !SAFE_ENV_NAME.test(canonicalEnvKey(name, process.platform)) ||
      DANGEROUS_ENV_NAME.test(name)
    ) {
      if (value !== undefined && DANGEROUS_ENV_NAME.test(name)) {
        return executionIdentityFailure('execution-identity-mismatch')
      }
      continue
    }
    output[name] = value
  }
  return output
}

/**
 * RFC-242 — the MCP-AUTHORED half of a netless child's environment.
 *
 * `sanitizeNetlessEnvironment` above sanitizes the DAEMON's environment, where
 * an unknown name is untrusted ambient state and dropping it is right. An MCP's
 * `env` map is the opposite: the author configured both the command and the
 * variables it needs, so
 *   - a name the allowlist merely does not recognize (`token`, `apiKey`) must
 *     be FORWARDED, not silently dropped (opencode) and not turned into an
 *     opaque node failure (the first Claude fence did both, in two runtimes);
 *   - the one family that is genuinely refused — dynamic-loader variables, read
 *     by `bwrap`/`sandbox-exec` itself before the boundary exists — fails
 *     CLOSED, and the pointer names the exact MCP and key so the operator can
 *     act on it.
 *
 * The save-time gate (`McpLocalConfigWriteSchema`) refuses the same entries at
 * the API with a human message; this is the fail-closed backstop for rows
 * written before that gate (or around it).
 */
export function sanitizeMcpAuthoredEnvironment(
  input: Readonly<Record<string, string>>,
  mcpName: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      if (typeof value !== 'string' || mcpEnvEntryProblem(name, value) !== null) {
        return executionIdentityFailure(
          'execution-identity-mismatch',
          `/mcp/${mcpName}/env/${name}`,
        )
      }
      return [name, value]
    }),
  )
}

export interface RootOwnedBwrapCapabilityProcess {
  readonly exited: Promise<number>
  killGroup(signal: NodeJS.Signals): void
  isGroupAlive(): boolean
  hasSignalOwnership?(): boolean
}

export interface RootOwnedBwrapPathMetadata {
  readonly uid: number
  readonly mode: number
  isSymbolicLink(): boolean
  isFile(): boolean
  isDirectory(): boolean
}

export interface RootOwnedBwrapPathDependencies {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<RootOwnedBwrapPathMetadata>
  stat(path: string): Promise<RootOwnedBwrapPathMetadata>
}

export interface RootOwnedBwrapDependencies {
  spawn?: (command: readonly string[]) => RootOwnedBwrapCapabilityProcess
  timeout?: (milliseconds: number) => Promise<void>
  /**
   * Narrow metadata seam for deterministic lifecycle tests. Production omits
   * it and always uses the real filesystem implementation below.
   */
  pathMetadata?: RootOwnedBwrapPathDependencies
  /**
   * The filesystem profile proves the generic runner boundary without
   * requiring a network namespace. The full profile additionally proves the
   * model-controlled OpenCode child boundary.
   */
  trial?: 'filesystem' | 'full'
  /** Stable, non-secret provider diagnosis for the RFC-233 coordinator. */
  onFailure?: (reason: RootOwnedBwrapFailureReason) => void
}

export type RootOwnedBwrapFailureReason =
  | 'provider-not-found'
  | 'provider-path-not-canonical'
  | 'provider-owner-unsafe'
  | 'provider-mode-unsafe'
  | 'provider-parent-unsafe'
  | 'provider-trial-rejected'
  | 'provider-trial-timeout'
  | 'provider-lifecycle-unproven'
  | 'provider-internal-error'

/**
 * Which exact path level failed the root-owned proof, and why. Emitted ONLY
 * on rejection; carries no secrets (absolute path + numeric uid + octal mode
 * are all already visible to any local `stat`). 2026-07-31: a GitHub runner
 * image bump flipped an ancestor's ownership and the failure was
 * indistinguishable from a code regression for hours — the reason code alone
 * cannot say WHICH level moved.
 */
export interface RootOwnedBwrapPathFinding {
  path: string
  /** 'binary' = the resolved executable; 'ancestor' = a directory component. */
  level: 'binary' | 'ancestor'
  uid: number | null
  /** Octal permission bits, e.g. '0755'; null when the stat itself failed. */
  mode: string | null
  symlink: boolean
  /** Which invariant this level broke. */
  violation: 'not-root-owned' | 'group-or-other-writable' | 'symlink' | 'wrong-type' | 'stat-failed'
}

export class RootOwnedBwrapQualificationError extends Error {
  readonly code = 'execution-identity-containment-required' as const

  constructor(
    readonly reason: RootOwnedBwrapFailureReason,
    /** Present for path-shaped rejections; absent for lifecycle failures. */
    readonly finding?: RootOwnedBwrapPathFinding,
  ) {
    super(finding === undefined ? reason : `${reason} (${describeBwrapFinding(finding)})`)
    this.name = 'RootOwnedBwrapQualificationError'
  }
}

/** One-line operator-facing rendering of a path finding (non-secret). */
export function describeBwrapFinding(finding: RootOwnedBwrapPathFinding): string {
  return `${finding.level} ${finding.path}: ${finding.violation}; uid=${finding.uid ?? 'unknown'} mode=${finding.mode ?? 'unknown'}${finding.symlink ? ' symlink' : ''}`
}

function bwrapModeString(mode: number | undefined): string | null {
  return typeof mode === 'number' ? `0${(mode & 0o7777).toString(8).padStart(3, '0')}` : null
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds)
    timer.unref?.()
  })
}

const REAL_ROOT_OWNED_BWRAP_PATH_METADATA: RootOwnedBwrapPathDependencies = {
  realpath: (path) => realpath(path),
  lstat: (path) => lstat(path),
  stat: (path) => stat(path),
}

function remainingMilliseconds(deadline: bigint): number {
  const remaining = deadline - process.hrtime.bigint()
  if (remaining <= 0n) return 0
  return Math.max(
    1,
    Number((remaining + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND),
  )
}

async function settleBefore<T>(
  promise: Promise<T>,
  deadline: bigint,
  timeoutMessage: string,
): Promise<T> {
  const remaining = remainingMilliseconds(deadline)
  if (remaining === 0) throw new Error(timeoutMessage)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), remaining)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function isSafeRootOwnedBwrapMode(mode: number): boolean {
  return (
    Number.isSafeInteger(mode) &&
    mode >= 0 &&
    (mode & 0o6000) === 0 &&
    (mode & 0o022) === 0 &&
    (mode & 0o111) !== 0
  )
}

function killCurrentProcessGroup(): never {
  try {
    process.kill(-process.pid, 'SIGKILL')
  } finally {
    // SIGKILL is delivered synchronously to the owned group. This fallback
    // only terminates the supervisor if the platform unexpectedly rejects the
    // group signal; it is never used to target a child by a reusable PID.
    process.exit(125)
  }
}

async function readBoundedSupervisorControl(): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let value = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      value += decoder.decode(next.value, { stream: true })
      if (Buffer.byteLength(value, 'utf8') > BWRAP_CAPABILITY_CONTROL_LIMIT_BYTES) {
        throw new Error('bwrap capability supervisor control exceeded its bound')
      }
    }
    value += decoder.decode()
    return value
  } finally {
    reader.releaseLock()
  }
}

/**
 * Hidden RFC-224 process-group anchor. It is the real parent of bwrap, watches
 * the daemon-owned control pipe from the moment it starts, and kills its whole
 * group on EOF, malformed control, or the hard deadline. The parent therefore
 * never needs a positive-PID fallback and bwrap's --die-with-parent refers to
 * this still-live, verified-self supervisor.
 */
export async function runRootOwnedBwrapCapabilitySupervisor(
  nonce: string,
  watchdogMilliseconds: number,
  command: readonly string[],
): Promise<number> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce) ||
    watchdogMilliseconds !== BWRAP_CAPABILITY_WATCHDOG_MS ||
    command.length === 0 ||
    command.length > 64 ||
    command.some((value) => value.length === 0 || value.includes('\0'))
  ) {
    return 125
  }

  // Caught dispositions reset to default across exec, so the bwrap child
  // remains TERM-responsive while this group leader survives host TERM long
  // enough to authenticate and report the exact capability outcome.
  const ignoreSignal = () => undefined
  process.on('SIGHUP', ignoreSignal)
  process.on('SIGINT', ignoreSignal)
  process.on('SIGTERM', ignoreSignal)

  const expectedControl = `RFC224_BWRAP_ACK ${nonce}\n`
  const control = readBoundedSupervisorControl().then(
    (value) => {
      if (value !== expectedControl) return killCurrentProcessGroup()
    },
    () => killCurrentProcessGroup(),
  )
  void control.catch(() => undefined)

  const watchdog = setTimeout(killCurrentProcessGroup, watchdogMilliseconds)
  const output = Bun.stdout.writer()
  let code = 125
  try {
    const child = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: [...command],
      cwd: '/',
      env: {},
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    code = await child.exited
  } catch {
    // A spawn failure is an ordinary negative capability result. It still
    // traverses the authenticated report/release protocol before this group
    // leader exits.
  }

  try {
    output.write(`RFC224_BWRAP_EXIT ${nonce} ${code}\n`)
    await output.flush()
    await control
    output.write(`RFC224_BWRAP_RELEASE ${nonce}\n`)
    await output.flush()
    clearTimeout(watchdog)
    return killCurrentProcessGroup()
  } catch {
    return killCurrentProcessGroup()
  }
}

function spawnRootOwnedBwrapCapability(
  command: readonly string[],
): RootOwnedBwrapCapabilityProcess {
  const nonce = randomUUID()
  const child = Bun.spawn({
    ...platformSpawnOptionsForHost(),
    cmd: verifiedSelfCommand(BWRAP_CAPABILITY_SUPERVISOR_SUBCOMMAND, [
      '--nonce',
      nonce,
      '--watchdog-ms',
      String(BWRAP_CAPABILITY_WATCHDOG_MS),
      '--',
      ...command,
    ]),
    cwd: '/',
    env: {},
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    detached: true,
  })
  const releaseDeadline =
    process.hrtime.bigint() +
    BigInt(BWRAP_CAPABILITY_WATCHDOG_MS + BWRAP_CAPABILITY_RELEASE_MARGIN_MS) *
      NANOSECONDS_PER_MILLISECOND
  let signalState: RootOwnedBwrapSignalState = 'owned'
  let groupExited = false
  const exited = (async () => {
    let reader: ReturnType<typeof child.stdout.getReader> | undefined
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffered = ''
    let bwrapCode: number | undefined
    let protocolFailure: unknown = null
    try {
      const acquiredReader = child.stdout.getReader()
      reader = acquiredReader
      for (;;) {
        const next = await settleBefore(
          acquiredReader.read(),
          releaseDeadline,
          'bwrap capability supervisor report deadline exceeded',
        )
        if (next.done) break
        buffered += decoder.decode(next.value, { stream: true })
        if (Buffer.byteLength(buffered, 'utf8') > BWRAP_CAPABILITY_REPORT_LIMIT_BYTES) {
          throw new Error('bwrap capability supervisor report exceeded its bound')
        }
        const newline = buffered.indexOf('\n')
        if (newline < 0) continue
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const match = new RegExp(`^RFC224_BWRAP_EXIT ${nonce} ([0-9]{1,3})$`).exec(line)
        const parsedCode = match?.[1] === undefined ? Number.NaN : Number(match[1])
        if (
          !Number.isSafeInteger(parsedCode) ||
          parsedCode < 0 ||
          parsedCode > 255 ||
          buffered !== ''
        ) {
          throw new Error('invalid bwrap capability supervisor report')
        }
        bwrapCode = parsedCode
        break
      }
      if (bwrapCode === undefined) {
        throw new Error('bwrap capability supervisor exited before its report')
      }

      // The verified-self supervisor cannot exit before receiving this exact
      // EOF-delimited ACK. Relinquish host signaling synchronously before the
      // first byte: from here, its control guardian and hard watchdog are the
      // only cleanup authorities, so a racing timeout cannot hit a reused PGID.
      signalState = 'releasing'
      await settleBefore(
        Promise.resolve(child.stdin.write(`RFC224_BWRAP_ACK ${nonce}\n`)),
        releaseDeadline,
        'bwrap capability supervisor ACK write deadline exceeded',
      )
      await settleBefore(
        Promise.resolve(child.stdin.flush()),
        releaseDeadline,
        'bwrap capability supervisor ACK flush deadline exceeded',
      )
      await settleBefore(
        Promise.resolve(child.stdin.end()),
        releaseDeadline,
        'bwrap capability supervisor ACK close deadline exceeded',
      )

      let releaseReceived = false
      for (;;) {
        const next = await settleBefore(
          acquiredReader.read(),
          releaseDeadline,
          'bwrap capability supervisor release deadline exceeded',
        )
        if (next.done) break
        buffered += decoder.decode(next.value, { stream: true })
        if (Buffer.byteLength(buffered, 'utf8') > BWRAP_CAPABILITY_REPORT_LIMIT_BYTES) {
          throw new Error('bwrap capability supervisor release exceeded its bound')
        }
        const newline = buffered.indexOf('\n')
        if (newline < 0) continue
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (releaseReceived || line !== `RFC224_BWRAP_RELEASE ${nonce}` || buffered !== '') {
          throw new Error('invalid bwrap capability supervisor release')
        }
        releaseReceived = true
      }
      buffered += decoder.decode()
      if (!releaseReceived || buffered !== '') {
        throw new Error('partial trailing bwrap capability supervisor output')
      }
    } catch (error) {
      protocolFailure = error
    } finally {
      try {
        await settleBefore(
          Promise.resolve(child.stdin.end()),
          releaseDeadline,
          'bwrap capability supervisor control close deadline exceeded',
        )
      } catch (error) {
        protocolFailure ??= error
      }
      if (reader !== undefined) {
        try {
          reader.releaseLock()
        } catch (error) {
          protocolFailure ??= error
        }
      }
    }

    let supervisorCode: number | undefined
    try {
      supervisorCode = await settleBefore(
        child.exited,
        releaseDeadline,
        'bwrap capability supervisor exit deadline exceeded',
      )
    } catch (error) {
      protocolFailure ??= error
    }

    // Do not settle the exported protocol promise until the real direct
    // supervisor is reaped and this owned PGID has been observed absent.
    // Once absent is latched, a later same-number group is never considered.
    while (!groupExited && remainingMilliseconds(releaseDeadline) > 0) {
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          groupExited = true
          break
        }
      }
      if (!groupExited) {
        await delay(
          Math.min(
            BWRAP_CAPABILITY_STOP_POLL_MS,
            Math.max(1, remainingMilliseconds(releaseDeadline)),
          ),
        )
      }
    }
    if (!groupExited) {
      protocolFailure ??= new Error('bwrap capability supervisor group release deadline exceeded')
    }
    signalState = 'released'

    if (protocolFailure !== null) throw protocolFailure
    if (bwrapCode === undefined || supervisorCode !== 137) {
      throw new Error('bwrap capability supervisor exit mismatch')
    }
    return bwrapCode
  })()
  void exited.catch(() => undefined)
  return {
    exited,
    killGroup: (signal) => {
      if (signalState !== 'owned' || groupExited) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        // ESRCH/unknown never justify a positive-PID fallback.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') groupExited = true
      }
    },
    isGroupAlive: () => {
      if (groupExited) return false
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        // ESRCH is the only proof that this PGID is absent. Treat permission
        // and unknown failures as live so cleanup remains fail-closed.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
        groupExited = true
        return false
      }
    },
    hasSignalOwnership: () => signalState === 'owned',
  }
}

function rootOwnedBwrapGroupAlive(child: RootOwnedBwrapCapabilityProcess): boolean {
  try {
    return child.isGroupAlive()
  } catch {
    // Unknown liveness is not proof that the process group is absent.
    return true
  }
}

function rootOwnedBwrapHasSignalOwnership(
  child: RootOwnedBwrapCapabilityProcess,
  isDirectSettled: () => boolean,
): boolean {
  try {
    return child.hasSignalOwnership?.() ?? !isDirectSettled()
  } catch {
    return false
  }
}

async function waitForRootOwnedBwrapCapabilityStop(
  child: RootOwnedBwrapCapabilityProcess,
  isDirectSettled: () => boolean,
  timeout: (milliseconds: number) => Promise<void>,
  state: RootOwnedBwrapStopState,
): Promise<boolean> {
  const polls = Math.ceil(BWRAP_CAPABILITY_STOP_GRACE_MS / BWRAP_CAPABILITY_STOP_POLL_MS)
  for (let index = 0; index <= polls; index += 1) {
    const directSettled = isDirectSettled()
    if (!state.groupExited) {
      state.groupExited = !rootOwnedBwrapGroupAlive(child)
    }
    if (directSettled && state.groupExited) return true
    if (index < polls) await timeout(BWRAP_CAPABILITY_STOP_POLL_MS)
  }
  return false
}

async function terminateRootOwnedBwrapCapability(
  child: RootOwnedBwrapCapabilityProcess,
  isDirectSettled: () => boolean,
  timeout: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const state: RootOwnedBwrapStopState = { groupExited: false }
  if (!rootOwnedBwrapHasSignalOwnership(child, isDirectSettled)) return false
  child.killGroup('SIGTERM')
  if (await waitForRootOwnedBwrapCapabilityStop(child, isDirectSettled, timeout, state)) {
    return true
  }
  // A settled direct leader no longer gives us an owned numeric PGID. If the
  // old number still appears live, treat it as ambiguous (including immediate
  // PGID reuse) and fail closed without signaling it again.
  if (
    isDirectSettled() ||
    state.groupExited ||
    !rootOwnedBwrapHasSignalOwnership(child, isDirectSettled)
  ) {
    return false
  }
  child.killGroup('SIGKILL')
  return waitForRootOwnedBwrapCapabilityStop(child, isDirectSettled, timeout, state)
}

export async function requireRootOwnedBwrap(
  path = Bun.which('bwrap'),
  dependencies: RootOwnedBwrapDependencies = {},
): Promise<string> {
  const spawn = dependencies.spawn ?? spawnRootOwnedBwrapCapability
  const timeout = dependencies.timeout ?? delay
  const pathMetadata = dependencies.pathMetadata ?? REAL_ROOT_OWNED_BWRAP_PATH_METADATA
  let child: RootOwnedBwrapCapabilityProcess | undefined
  let exited = false
  let resolvedPath: string | undefined
  let failed = false
  let cleanupFailed = false
  let failureReason: RootOwnedBwrapFailureReason | undefined
  // The terminal throw happens once, after the lifecycle `finally`; carry the
  // path finding alongside the reason so it survives that re-raise.
  let failureFinding: RootOwnedBwrapPathFinding | undefined
  const reject = (
    reason: RootOwnedBwrapFailureReason,
    finding?: RootOwnedBwrapPathFinding,
  ): never => {
    failureReason ??= reason
    failureFinding ??= finding
    throw new RootOwnedBwrapQualificationError(reason, finding)
  }
  try {
    if (path === null) {
      reject('provider-not-found')
    }
    const candidatePath = path as string
    if (
      !isAbsolute(candidatePath) ||
      resolve(candidatePath) !== candidatePath ||
      candidatePath.includes('\0')
    ) {
      reject('provider-path-not-canonical')
    }
    let resolved = candidatePath
    try {
      resolved = await pathMetadata.realpath(candidatePath)
    } catch {
      reject('provider-not-found')
    }
    const before = await pathMetadata.lstat(resolved)
    const metadata = await pathMetadata.stat(resolved)
    if (before.isSymbolicLink() || !metadata.isFile() || metadata.uid !== 0) {
      reject('provider-owner-unsafe', {
        path: resolved,
        level: 'binary',
        uid: metadata.uid ?? null,
        mode: bwrapModeString(metadata.mode),
        symlink: before.isSymbolicLink(),
        violation: before.isSymbolicLink()
          ? 'symlink'
          : !metadata.isFile()
            ? 'wrong-type'
            : 'not-root-owned',
      })
    }
    if (!isSafeRootOwnedBwrapMode(metadata.mode)) {
      reject('provider-mode-unsafe', {
        path: resolved,
        level: 'binary',
        uid: metadata.uid ?? null,
        mode: bwrapModeString(metadata.mode),
        symlink: false,
        violation: 'group-or-other-writable',
      })
    }
    // Executing the canonical inode is insufficient if an untrusted same-uid
    // process can replace any directory component between admission and spawn.
    // Prove the whole canonical ancestor chain through `/`.
    let parent = dirname(resolved)
    for (;;) {
      const parentBefore = await pathMetadata.lstat(parent)
      const parentMetadata = await pathMetadata.stat(parent)
      const parentSymlink = parentBefore.isSymbolicLink()
      const parentNotDir = !parentMetadata.isDirectory()
      const parentNotRoot = parentMetadata.uid !== 0
      const parentWritable = (parentMetadata.mode & 0o022) !== 0
      if (parentSymlink || parentNotDir || parentNotRoot || parentWritable) {
        // Name the EXACT level and invariant: 'the chain is unsafe' cannot be
        // told apart from a code regression by an operator (2026-07-31 runner
        // image incident). The check itself is unchanged.
        reject('provider-parent-unsafe', {
          path: parent,
          level: 'ancestor',
          uid: parentMetadata.uid ?? null,
          mode: bwrapModeString(parentMetadata.mode),
          symlink: parentSymlink,
          violation: parentSymlink
            ? 'symlink'
            : parentNotDir
              ? 'wrong-type'
              : parentNotRoot
                ? 'not-root-owned'
                : 'group-or-other-writable',
        })
      }
      if (parent === '/') break
      const next = dirname(parent)
      if (next === parent) reject('provider-parent-unsafe')
      parent = next
    }
    try {
      child = spawn([
        resolved,
        '--die-with-parent',
        '--new-session',
        ...(dependencies.trial === 'filesystem' ? [] : ['--unshare-net']),
        '--unshare-pid',
        '--unshare-ipc',
        '--unshare-uts',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--clearenv',
        '--',
        '/bin/true',
      ])
    } catch {
      reject('provider-trial-rejected')
    }
    if (child === undefined) reject('provider-trial-rejected')
    const capabilityChild = child as RootOwnedBwrapCapabilityProcess
    const code = await Promise.race([
      capabilityChild.exited.then(
        (value) => {
          exited = true
          return value
        },
        (error: unknown) => {
          exited = true
          throw error
        },
      ),
      timeout(BWRAP_CAPABILITY_TIMEOUT_MS).then(() => null),
    ])
    if (code === null) {
      reject('provider-trial-timeout')
    }
    if (code !== 0) {
      reject('provider-trial-rejected')
    }
    if (rootOwnedBwrapGroupAlive(capabilityChild)) {
      reject('provider-lifecycle-unproven')
    }
    resolvedPath = resolved
  } catch {
    failed = true
    failureReason ??= 'provider-internal-error'
  } finally {
    if (child !== undefined && rootOwnedBwrapGroupAlive(child)) {
      if (exited) {
        // Never signal a numeric PGID after its direct leader has settled.
        cleanupFailed = true
        failureReason = 'provider-lifecycle-unproven'
      } else if (!rootOwnedBwrapHasSignalOwnership(child, () => exited)) {
        // ACK release is outcome-unknown until the guardian/watchdog reaps the
        // real supervisor and latches PGID absence. Wait for that authority;
        // never signal the numeric group during or after this handoff.
        try {
          await child.exited
        } catch {
          // A negative/invalid capability result is expected on this path.
        }
        cleanupFailed = rootOwnedBwrapGroupAlive(child)
        if (cleanupFailed) failureReason = 'provider-lifecycle-unproven'
      } else {
        try {
          let stopped = await terminateRootOwnedBwrapCapability(child, () => exited, timeout)
          if (!stopped && !exited && !rootOwnedBwrapHasSignalOwnership(child, () => exited)) {
            try {
              await child.exited
            } catch {
              // The handoff can complete with a negative capability result.
            }
            stopped = !rootOwnedBwrapGroupAlive(child)
          }
          cleanupFailed = !stopped
          if (cleanupFailed) failureReason = 'provider-lifecycle-unproven'
        } catch {
          cleanupFailed = true
          failureReason = 'provider-lifecycle-unproven'
        }
      }
    }
  }
  if (failed || cleanupFailed || resolvedPath === undefined) {
    try {
      dependencies.onFailure?.(failureReason ?? 'provider-internal-error')
    } catch {
      // Diagnosis callbacks cannot change the fail-closed security outcome.
    }
    throw new RootOwnedBwrapQualificationError(
      failureReason ?? 'provider-internal-error',
      failureFinding,
    )
  }
  return resolvedPath
}

export interface MaterializeNetlessWrapperInput {
  wrapperPath: string
  manifestPath: string
  manifest: NetlessSubprocessManifest
}

export async function materializeNetlessWrapper(
  input: MaterializeNetlessWrapperInput,
): Promise<void> {
  const manifest = NetlessSubprocessManifestSchema.parse(input.manifest)
  if (!contained(dirname(input.wrapperPath), input.manifestPath)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await writeExclusiveRegular(input.manifestPath, JSON.stringify(manifest), 0o400)
  const command = verifiedSelfCommand('__opencode-netless-subprocess', [
    '--manifest',
    input.manifestPath,
  ])
  const script = `#!/bin/sh\nexec ${command.map(shellQuote).join(' ')} "$@"\n`
  await writeExclusiveRegular(input.wrapperPath, script, 0o500)
}

async function readManifest(path: string): Promise<NetlessSubprocessManifest> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.size > 1024 * 1024) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
  )
  try {
    const opened = await handle.stat()
    if (!assertSameFileIdentityForHost(before, opened).trusted || opened.size !== before.size) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const value = JSON.parse(await handle.readFile('utf8')) as unknown
    return NetlessSubprocessManifestSchema.parse(value)
  } catch {
    return executionIdentityFailure('execution-identity-store-unsafe')
  } finally {
    await handle.close()
  }
}

function uniqueMaskRoots(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length)
  return sorted.filter((candidate, index) =>
    sorted.slice(0, index).every((parent) => !contained(parent, candidate)),
  )
}

function parentDirs(maskRoot: string, target: string): string[] {
  if (!contained(maskRoot, target) || target === maskRoot) return []
  const result: string[] = []
  let cursor = dirname(target)
  while (cursor !== maskRoot && contained(maskRoot, cursor)) {
    result.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return result.reverse()
}

function netlessWritableSubtrees(
  parsed: NetlessSubprocessManifest,
  masks: readonly string[],
): string[] {
  const writable = [
    parsed.worktreePath,
    parsed.scratchPath,
    absoluteEnvPath(parsed, 'HOME'),
    absoluteEnvPath(parsed, 'TMPDIR'),
    ...parsed.gitCommonDirs,
  ]
  if (new Set(parsed.gitCommonDirs).size !== parsed.gitCommonDirs.length) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  for (const target of [...writable, ...parsed.bindReadOnly]) {
    if (
      target === '/' ||
      target.includes('\0') ||
      // A later bind/allow of an ancestor would replace a secret mask and
      // expose that whole tree. Descendants are the intended exact allow-back.
      masks.some((mask) => contained(target, mask))
    ) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  }
  for (const target of parsed.bindReadOnly) {
    // RO overlays are applied after RW allow-backs. Never let a broad
    // read-only target replace a writable root; an exact child remains valid.
    if (writable.some((root) => contained(target, root))) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  }
  return [...new Set(writable)]
}

/**
 * The directory the fenced child should start in.
 *
 * 2026-08-04 audit: this used to be hard-pinned to `manifest.worktreePath`,
 * which silently DISCARDED the directory the model asked for. OpenCode's shell
 * tool takes a `workdir` parameter and its own system prompt tells the model to
 * prefer it over `cd <dir> && <cmd>` (opencode
 * `packages/opencode/src/tool/shell/prompt.ts`), then starts the shell — our
 * wrapper — with that cwd (`tool/shell.ts`). Overriding it meant
 * `workdir: packages/x` + `command: pytest tests` ran at the repository root:
 * relative paths resolved elsewhere, the command "succeeded" or failed for an
 * unrelated reason, and the model reasoned on from a wrong result. No log, no
 * warning — the worst failure shape there is, and a monorepo or repo-group task
 * hits it every time.
 *
 * The boundary is preserved by CONSTRUCTION rather than by pinning: a requested
 * directory is honoured only when it sits inside a subtree the fence already
 * makes writable. Anything else (or nothing requested) falls back to the
 * worktree.
 */
export function resolveNetlessCwd(
  manifest: NetlessSubprocessManifest,
  requestedCwd: string | undefined,
): string {
  if (requestedCwd === undefined || !isAbsolute(requestedCwd)) return manifest.worktreePath
  const requested = resolve(requestedCwd)
  if (requested === manifest.worktreePath) return manifest.worktreePath
  let writable: readonly string[]
  try {
    const masks = uniqueMaskRoots([manifest.realHome, manifest.appHome, '/tmp', '/var/tmp'])
    writable = netlessWritableSubtrees(manifest, masks)
  } catch {
    // The writable-subtree computation is itself a validator and throws on a
    // manifest it considers unsafe. Deciding a CWD is not the place to surface
    // that — the renderer below runs the same computation and will fail loudly
    // there. Here, "cannot prove the request is inside the fence" means fall
    // back to the pinned worktree, i.e. the pre-2026-08-04 behaviour.
    return manifest.worktreePath
  }
  for (const allowed of writable) {
    if (isLexicallyInsideForHost(allowed, requested)) return requested
  }
  return manifest.worktreePath
}

export function renderNetlessBwrapArgs(
  manifest: NetlessSubprocessManifest,
  passthroughArgs: readonly string[],
  requestedCwd?: string,
): string[] {
  const parsed = NetlessSubprocessManifestSchema.parse(manifest)
  if (passthroughArgs.some((entry) => entry.includes('\0'))) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const masks = uniqueMaskRoots([parsed.realHome, parsed.appHome, '/tmp', '/var/tmp'])
  const writable = netlessWritableSubtrees(parsed, masks)
  const args = [
    '--die-with-parent',
    '--unshare-net',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
  ]
  for (const mask of masks) args.push('--tmpfs', mask)
  for (const target of [...writable, ...parsed.bindReadOnly]) {
    for (const dir of masks.flatMap((mask) => parentDirs(mask, target))) {
      args.push('--dir', dir)
    }
  }
  for (const target of writable) args.push('--bind', target, target)
  for (const target of parsed.bindReadOnly) args.push('--ro-bind', target, target)
  args.push('--chdir', resolveNetlessCwd(parsed, requestedCwd))
  // RFC-242 — the environment is deliberately NOT rendered into argv. `bwrap`
  // has no `--clearenv` here, so it hands its OWN environment to the child;
  // `renderNetlessInvocation` therefore spawns bwrap WITH `manifest.env` and the
  // child sees the identical map. The `--setenv NAME VALUE` form this replaced
  // published every MCP secret in `/proc/<bwrap-pid>/cmdline`, which is
  // world-readable — exactly the exposure moving MCP env out of claude's
  // `--mcp-config` argv was meant to end.
  args.push('--')
  if (parsed.mode === 'shell') {
    args.push(...parsed.command, ...passthroughArgs)
  } else {
    if (passthroughArgs.length > 0) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    args.push(...parsed.command)
  }
  return args
}

const LinuxBwrapProviderConfigSchema = z.object({ bwrapPath: AbsolutePathSchema }).strict()
const MacSeatbeltProviderConfigSchema = z
  .object({ sandboxExecPath: z.literal('/usr/bin/sandbox-exec') })
  .strict()
const NoContainmentProviderConfigSchema = z.object({}).strict()

function netlessCommand(
  manifest: NetlessSubprocessManifest,
  passthroughArgs: readonly string[],
): string[] {
  if (passthroughArgs.some((entry) => entry.includes('\0'))) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  if (manifest.mode === 'mcp' && passthroughArgs.length > 0) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  return manifest.mode === 'shell'
    ? [...manifest.command, ...passthroughArgs]
    : [...manifest.command]
}

function sbplString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function absoluteEnvPath(manifest: NetlessSubprocessManifest, name: 'HOME' | 'TMPDIR'): string {
  const parsed = AbsolutePathSchema.safeParse(manifest.env[name])
  if (!parsed.success) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return parsed.data
}

/**
 * RFC-252 G2 — macOS 侧的写例外。全局禁写之后必须把这几处放回来，否则连
 * `> /dev/null` 都会失败。
 *
 * - `/dev`：设备节点。非 root 进程无法在 `/dev` 下**新建**文件，所以这不是植入面。
 * - `/private/var/folders` 与其 `/var` 别名：macOS 的 per-user 临时目录
 *   （`confstr(_CS_DARWIN_USER_TEMP_DIR)`）。child 已有私有 `TMPDIR`，但系统库与部分
 *   工具链**绕过 `TMPDIR`** 直接用它。今天（`(allow default)`）它本来就可写，放回来不是
 *   放宽，而是保持现状——Linux 侧没有这个等价物，故两平台在此有一行显式差异。
 */
const SEATBELT_NETLESS_WRITE_EXCEPTIONS: readonly string[] = [
  '/dev',
  '/private/var/folders',
  '/var/folders',
]

/**
 * macOS model-child profile: provider/server networking remains outside this
 * inner launcher, while shell and local MCP descendants lose all network
 * access and see only their exact workspace/scratch/private-home allow-backs.
 *
 * RFC-252 G2 — 基线从 `(allow default)` 改为**全局默认禁写**。此前 macOS 与 Linux 不对称：
 * Linux child 是 `--ro-bind / /`（全盘只读 + allow-back 可写），而 macOS 只遮 masks、
 * masks 之外一律可写。实测本机 `/opt/homebrew/bin` 是 `drwxrwxrwx`，于是 child 可以覆写
 * 任意 brew 二进制，等用户或 daemon 下次执行即在沙箱外获得执行——这条通道在 Linux 上
 * 根本不存在。改为默认禁写后两平台的可写集合一致，而 Linux 早已在同等约束下长期运行，
 * 这本身就是「不会搞坏功能」的证明。
 *
 * SBPL 是 last-match-wins，因此顺序是承重的：
 *   allow default → 全局禁写 → 写例外 → 网络 → masks → 可穿越祖先 → 可写 allow-back
 *   → 只读覆盖（必须最后，才能压过它自己所在的可写子树）
 */
export function renderNetlessSeatbeltProfile(manifest: NetlessSubprocessManifest): string {
  const parsed = NetlessSubprocessManifestSchema.parse(manifest)
  const masks = uniqueMaskRoots([
    parsed.realHome,
    parsed.appHome,
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    '/private/var/tmp',
  ])
  const writable = netlessWritableSubtrees(parsed, masks)

  const lines = ['(version 1)', '(allow default)', '(deny file-write* (subpath "/"))']
  for (const exception of SEATBELT_NETLESS_WRITE_EXCEPTIONS) {
    lines.push(`(allow file-write* (subpath ${sbplString(exception)}))`)
  }
  lines.push('(deny network*)')
  for (const mask of masks) {
    lines.push(`(deny file-read* file-write* (subpath ${sbplString(mask)}))`)
  }
  const traversableAncestors = [
    ...new Set(
      [...writable, ...parsed.bindReadOnly].flatMap((target) =>
        masks.flatMap((mask) =>
          contained(mask, target) && target !== mask ? [mask, ...parentDirs(mask, target)] : [],
        ),
      ),
    ),
  ]
  // Git canonicalizes every prefix before following a linked-worktree `.git`
  // pointer. Restore only metadata on the exact ancestor directories needed
  // for that traversal; directory contents and sibling files stay behind the
  // mask.
  for (const target of traversableAncestors) {
    lines.push(`(allow file-read-metadata (literal ${sbplString(target)}))`)
  }
  for (const target of [...new Set(writable)]) {
    lines.push(`(allow file-read* file-write* (subpath ${sbplString(target)}))`)
  }
  for (const target of [...new Set(parsed.bindReadOnly)]) {
    lines.push(`(allow file-read* (subpath ${sbplString(target)}))`)
    lines.push(`(deny file-write* (subpath ${sbplString(target)}))`)
  }
  return lines.join('\n')
}

/**
 * The exact `cmd`/`cwd`/`env` the hidden subcommand spawns. Exported so the
 * env-out-of-argv contract (RFC-242) is unit-lockable on every host: the Linux
 * boundary is otherwise only exercised by the gated integration suite, and a
 * bwrap child that silently lost its environment would look identical to one
 * that never started.
 */
export function renderNetlessInvocation(
  manifest: NetlessSubprocessManifest,
  passthroughArgs: readonly string[],
  requestedCwd?: string,
): NetlessSubprocessInvocation {
  const provider = RuntimeChildProviderPlanSchema.parse(manifest.provider)
  const cwd = resolveNetlessCwd(manifest, requestedCwd)
  if (provider.providerId === 'linux-bwrap') {
    const config = LinuxBwrapProviderConfigSchema.parse(provider.config)
    return {
      cmd: [config.bwrapPath, ...renderNetlessBwrapArgs(manifest, passthroughArgs, requestedCwd)],
      cwd,
      // bwrap without `--clearenv` passes its own environment through, so this
      // IS the child's environment — and it never touches any argv.
      env: manifest.env,
    }
  }
  if (provider.providerId === 'macos-seatbelt') {
    const config = MacSeatbeltProviderConfigSchema.parse(provider.config)
    return {
      cmd: [
        config.sandboxExecPath,
        '-p',
        renderNetlessSeatbeltProfile(manifest),
        ...netlessCommand(manifest, passthroughArgs),
      ],
      cwd,
      env: manifest.env,
    }
  }
  if (provider.providerId === 'none') {
    NoContainmentProviderConfigSchema.parse(provider.config)
    return {
      cmd: netlessCommand(manifest, passthroughArgs),
      cwd,
      env: manifest.env,
    }
  }
  const renderer = customNetlessRenderers.get(provider.providerId)
  if (renderer === undefined) {
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  }
  const invocation = renderer(manifest, provider, passthroughArgs)
  if (
    invocation.cmd.length === 0 ||
    invocation.cmd.some((entry) => entry.length === 0 || entry.includes('\0')) ||
    invocation.cwd !== manifest.worktreePath
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return invocation
}

export async function runNetlessSubprocess(
  manifestPath: string,
  passthroughArgs: readonly string[],
): Promise<number> {
  const manifest = await readManifest(manifestPath)
  // The runtime started THIS wrapper in the directory the model asked for
  // (opencode's shell tool resolves its `workdir` parameter into the shell's
  // cwd), so our own cwd is the request. `resolveNetlessCwd` keeps it only if
  // the fence already makes it writable.
  const invocation = renderNetlessInvocation(manifest, passthroughArgs, process.cwd())
  const child = Bun.spawn({
    ...platformSpawnOptionsForHost(),
    cmd: [...invocation.cmd],
    cwd: invocation.cwd,
    env: { ...invocation.env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exited
}

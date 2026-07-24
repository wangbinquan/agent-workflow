// RFC-224 T7a — prove that an admitted OpenCode build is using its bundled
// FFF filesystem service before the real server is allowed to start.
//
// The fallback filesystem service can discover/download ripgrep. The probe is
// therefore deliberately stronger than a version/flag check: the same sealed
// executable must find one unpredictable file while running with no network,
// an empty read-only ripgrep cache, and an empty PATH.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { OPENCODE_FFF_CAPABILITY_CODEC } from './hermetic'
import { ExecutionIdentityFailure, executionIdentityFailure } from './failure'
import { requireRootOwnedBwrap, verifiedSelfCommand } from './sealedSubprocess'

const PROBE_BASENAME_RE = /^aw-fff-[0-9a-f]{32}\.txt$/
const MAX_PROBE_OUTPUT_BYTES = 4 * 1024
const PROBE_STOP_GRACE_MS = 250
const PROBE_STOP_POLL_MS = 25
const PROBE_TIMEOUT_MAX_MS = 300_000
const FFF_CAPABILITY_SUPERVISOR_SUBCOMMAND = '__opencode-fff-capability-supervisor'
const FFF_CAPABILITY_SUPERVISOR_WATCHDOG_MARGIN_MS = 1_000
const FFF_CAPABILITY_SUPERVISOR_RELEASE_MARGIN_MS = 2_000
const FFF_CAPABILITY_SUPERVISOR_REPORT_LIMIT_BYTES = 16 * 1024
const FFF_CAPABILITY_SUPERVISOR_CONTROL_LIMIT_BYTES = 512
const NANOSECONDS_PER_MILLISECOND = 1_000_000n
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && resolve(value) === value && !value.includes('\0'))

export const FffCapabilityProbeSchema = z
  .object({
    root: AbsolutePathSchema,
    basename: z.string().regex(PROBE_BASENAME_RE),
    fileDigest: z.string().regex(/^[0-9a-f]{64}$/),
    bwrapPath: AbsolutePathSchema,
  })
  .strict()

export type FffCapabilityProbe = z.infer<typeof FffCapabilityProbeSchema>

export interface MaterializedFffCapabilityProbe {
  codec: typeof OPENCODE_FFF_CAPABILITY_CODEC
  probe: FffCapabilityProbe
  /** Paths that the outer RFC-205 sandbox must keep read-only. */
  readOnlySubtrees: readonly string[]
}

interface ProbePaths {
  cwd: string
  file: string
  cache: string
  cacheApp: string
  cacheBin: string
  path: string
  home: string
  testConfig: string
  config: string
  configApp: string
  managedConfig: string
  explicitConfig: string
  data: string
  state: string
  tmp: string
}

function pathsFor(probe: FffCapabilityProbe): ProbePaths {
  const root = probe.root
  const cwd = join(root, 'cwd')
  const cache = join(root, 'cache')
  const cacheApp = join(cache, 'opencode')
  const home = join(root, 'home')
  const config = join(root, 'config')
  return {
    cwd,
    file: join(cwd, probe.basename),
    cache,
    cacheApp,
    cacheBin: join(cacheApp, 'bin'),
    path: join(root, 'path'),
    home,
    testConfig: join(home, '.opencode'),
    config,
    configApp: join(config, 'opencode'),
    managedConfig: join(root, 'managed-config'),
    explicitConfig: join(root, 'explicit-config'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    tmp: join(root, 'tmp'),
  }
}

function contained(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function probeContents(basename: string): Uint8Array {
  return new TextEncoder().encode(`rfc224-fff-capability:${basename}\n`)
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeExclusiveRegular(
  path: string,
  contents: Uint8Array,
  mode: number,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    mode,
  )
  try {
    await handle.writeFile(contents)
    await handle.sync()
    const metadata = await handle.stat()
    if (!metadata.isFile() || (metadata.mode & 0o777) !== mode) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  } finally {
    await handle.close()
  }
}

export interface MaterializeFffCapabilityProbeInput {
  probeRoot: string
  bwrapPath: string
  random?: (size: number) => Uint8Array
}

/**
 * Materialize the complete probe before the one-shot launch manifest is
 * written. `probeRoot` is kept separate from the immutable binary seal because
 * OpenCode needs private writable data/state/tmp directories during bootstrap.
 */
export async function materializeFffCapabilityProbe(
  input: MaterializeFffCapabilityProbeInput,
): Promise<MaterializedFffCapabilityProbe> {
  if (
    !isAbsolute(input.probeRoot) ||
    resolve(input.probeRoot) !== input.probeRoot ||
    !isAbsolute(input.bwrapPath) ||
    resolve(input.bwrapPath) !== input.bwrapPath
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const random = input.random ?? randomBytes
  const basename = `aw-fff-${Buffer.from(random(16)).toString('hex')}.txt`
  if (!PROBE_BASENAME_RE.test(basename)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const contents = probeContents(basename)
  const probe = FffCapabilityProbeSchema.parse({
    root: input.probeRoot,
    basename,
    fileDigest: digest(contents),
    bwrapPath: input.bwrapPath,
  })
  const paths = pathsFor(probe)

  try {
    await mkdir(probe.root, { mode: 0o700 })
    for (const path of [
      paths.cwd,
      paths.cacheBin,
      paths.path,
      paths.testConfig,
      paths.configApp,
      paths.managedConfig,
      paths.explicitConfig,
      paths.data,
      paths.state,
      paths.tmp,
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
    }
    await writeExclusiveRegular(paths.file, contents, 0o400)
    for (const configRoot of [paths.testConfig, paths.configApp, paths.explicitConfig]) {
      await writeExclusiveRegular(
        join(configRoot, '.gitignore'),
        new TextEncoder().encode('*\n!.gitignore\n'),
        0o400,
      )
    }

    // Existing read-only directories let OpenCode's recursive mkdir bootstrap
    // succeed, while the empty bin directory cannot acquire a fallback rg.
    for (const path of [
      paths.cacheBin,
      paths.cacheApp,
      paths.cache,
      paths.path,
      paths.testConfig,
      paths.home,
      paths.configApp,
      paths.config,
      paths.managedConfig,
      paths.explicitConfig,
      paths.cwd,
    ]) {
      await chmod(path, 0o500)
    }
  } catch {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }

  return {
    codec: OPENCODE_FFF_CAPABILITY_CODEC,
    probe,
    readOnlySubtrees: [
      paths.cwd,
      paths.cache,
      paths.path,
      paths.home,
      paths.config,
      paths.managedConfig,
      paths.explicitConfig,
    ],
  }
}

async function assertDirectory(
  path: string,
  mode: number,
  expectedEntries?: readonly string[],
): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o777) !== mode) {
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  }
  if (expectedEntries !== undefined) {
    const entries = (await readdir(path)).sort()
    if (
      entries.length !== expectedEntries.length ||
      entries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
  }
}

/** Re-attest every filesystem fact that makes a fallback-rg hit impossible. */
export async function verifyFffCapabilityProbeArtifacts(
  runRoot: string,
  probeValue: FffCapabilityProbe,
): Promise<void> {
  const probe = FffCapabilityProbeSchema.parse(probeValue)
  if (
    !isAbsolute(runRoot) ||
    resolve(runRoot) !== runRoot ||
    !contained(runRoot, probe.root) ||
    probe.root === runRoot ||
    (await realpath(probe.root)) !== probe.root
  ) {
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  }
  const paths = pathsFor(probe)
  try {
    await assertDirectory(probe.root, 0o700)
    await assertDirectory(paths.cwd, 0o500, [probe.basename])
    await assertDirectory(paths.cache, 0o500, ['opencode'])
    await assertDirectory(paths.cacheApp, 0o500, ['bin'])
    await assertDirectory(paths.cacheBin, 0o500, [])
    await assertDirectory(paths.path, 0o500, [])
    await assertDirectory(paths.home, 0o500, ['.opencode'])
    await assertDirectory(paths.testConfig, 0o500, ['.gitignore'])
    await assertDirectory(paths.config, 0o500, ['opencode'])
    await assertDirectory(paths.configApp, 0o500, ['.gitignore'])
    await assertDirectory(paths.managedConfig, 0o500, [])
    await assertDirectory(paths.explicitConfig, 0o500, ['.gitignore'])
    await assertDirectory(paths.data, 0o700, [])
    await assertDirectory(paths.state, 0o700, [])
    await assertDirectory(paths.tmp, 0o700, [])
    for (const configRoot of [paths.testConfig, paths.configApp, paths.explicitConfig]) {
      const gitignorePath = join(configRoot, '.gitignore')
      const gitignore = await lstat(gitignorePath)
      if (
        gitignore.isSymbolicLink() ||
        !gitignore.isFile() ||
        (gitignore.mode & 0o777) !== 0o400 ||
        (await readFile(gitignorePath, 'utf8')) !== '*\n!.gitignore\n'
      ) {
        return executionIdentityFailure('execution-identity-bootstrap-failed')
      }
    }

    const file = await lstat(paths.file)
    if (
      file.isSymbolicLink() ||
      !file.isFile() ||
      (file.mode & 0o777) !== 0o400 ||
      digest(await readFile(paths.file)) !== probe.fileDigest
    ) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
  } catch {
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  }
}

function probeEnvironment(paths: ProbePaths): Record<string, string> {
  return {
    HOME: paths.home,
    PATH: paths.path,
    PWD: paths.cwd,
    TMPDIR: paths.tmp,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    OPENCODE_PURE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1',
    OPENCODE_DISABLE_PRUNE: '1',
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
    OPENCODE_CONFIG_DIR: paths.explicitConfig,
    OPENCODE_TEST_HOME: paths.home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: paths.managedConfig,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      plugin: [],
      mcp: {},
      instructions: [],
      skills: { paths: [], urls: [] },
    }),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
}

/** Pure argv oracle used by unit tests and the production spawn seam. */
export function renderFffCapabilityProbeCommand(input: {
  binaryPath: string
  probe: FffCapabilityProbe
}): string[] {
  const probe = FffCapabilityProbeSchema.parse(input.probe)
  if (!isAbsolute(input.binaryPath) || resolve(input.binaryPath) !== input.binaryPath) {
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  }
  const paths = pathsFor(probe)
  const args = [
    probe.bwrapPath,
    '--die-with-parent',
    '--new-session',
    '--unshare-net',
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
  ]
  for (const path of [
    paths.cwd,
    paths.cache,
    paths.path,
    paths.home,
    paths.config,
    paths.managedConfig,
    paths.explicitConfig,
  ]) {
    args.push('--ro-bind', path, path)
  }
  for (const path of [paths.data, paths.state, paths.tmp]) {
    args.push('--bind', path, path)
  }
  args.push('--chdir', paths.cwd)
  for (const [name, value] of Object.entries(probeEnvironment(paths)).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    args.push('--setenv', name, value)
  }
  args.push('--', input.binaryPath, 'debug', 'file', 'search', probe.basename)
  return args
}

export interface FffCapabilityProbeProcess {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  killGroup(signal: NodeJS.Signals): void
  isGroupAlive(): boolean
  hasSignalOwnership?(): boolean
}

export interface RunFffCapabilityProbeInput {
  binaryPath: string
  runRoot: string
  probe: FffCapabilityProbe
  timeoutMs: number
}

export interface FffCapabilityProbeDependencies {
  verifyArtifacts?: typeof verifyFffCapabilityProbeArtifacts
  requireBwrap?: (path: string) => Promise<string>
  spawn?: (command: readonly string[], cwd: string, timeoutMs: number) => FffCapabilityProbeProcess
  timeout?: (milliseconds: number) => Promise<void>
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds)
    timer.unref?.()
  })
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

interface BoundedBytes {
  bytes: Uint8Array
  overflow: boolean
}

async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  deadline?: bigint,
): Promise<BoundedBytes> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let overflow = false
  try {
    for (;;) {
      const next =
        deadline === undefined
          ? await reader.read()
          : await settleBefore(
              reader.read(),
              deadline,
              'FFF capability supervisor stream deadline exceeded',
            )
      if (next.done) break
      if (next.value === undefined) continue
      bytes += next.value.byteLength
      if (bytes <= limit) {
        chunks.push(next.value)
      } else {
        overflow = true
      }
    }
  } finally {
    reader.releaseLock()
  }
  const storedBytes = Math.min(bytes, limit)
  const output = new Uint8Array(storedBytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: output, overflow }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const result = await drainBounded(stream, limit)
  if (result.overflow) {
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  }
  return result.bytes
}

function killCurrentProcessGroup(): never {
  try {
    process.kill(-process.pid, 'SIGKILL')
  } finally {
    // This is a fallback exit for an unexpected group-signal syscall failure,
    // not a positive-PID attempt against a potentially reused child number.
    process.exit(125)
  }
}

async function readFffSupervisorControl(): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let value = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      value += decoder.decode(next.value, { stream: true })
      if (Buffer.byteLength(value, 'utf8') > FFF_CAPABILITY_SUPERVISOR_CONTROL_LIMIT_BYTES) {
        throw new Error('FFF capability supervisor control exceeded its bound')
      }
    }
    value += decoder.decode()
    return value
  } finally {
    reader.releaseLock()
  }
}

export function isValidFffCapabilitySupervisorInvocation(
  nonce: string,
  watchdogMilliseconds: number,
  cwd: string,
  command: readonly string[],
): boolean {
  return (
    UUID_V4_RE.test(nonce) &&
    Number.isSafeInteger(watchdogMilliseconds) &&
    watchdogMilliseconds > FFF_CAPABILITY_SUPERVISOR_WATCHDOG_MARGIN_MS &&
    watchdogMilliseconds <= PROBE_TIMEOUT_MAX_MS + FFF_CAPABILITY_SUPERVISOR_WATCHDOG_MARGIN_MS &&
    AbsolutePathSchema.safeParse(cwd).success &&
    command.length > 0 &&
    command.length <= 256 &&
    command.every((value) => value.length > 0 && !value.includes('\0'))
  )
}

function encodeSupervisorBytes(value: Uint8Array): string {
  return value.byteLength === 0 ? '-' : Buffer.from(value).toString('base64')
}

/**
 * Verified-self process-group anchor for the FFF proof. It drains both probe
 * pipes before reporting, keeps the direct group leader alive for an
 * authenticated EOF-delimited ACK, and then destroys the complete group.
 */
export async function runFffCapabilityProbeSupervisor(
  nonce: string,
  watchdogMilliseconds: number,
  cwd: string,
  command: readonly string[],
): Promise<number> {
  if (!isValidFffCapabilitySupervisorInvocation(nonce, watchdogMilliseconds, cwd, command)) {
    return 125
  }

  // Caught dispositions reset to default across exec. The probe remains
  // TERM-responsive while this group leader retains cleanup authority.
  const ignoreSignal = () => undefined
  process.on('SIGHUP', ignoreSignal)
  process.on('SIGINT', ignoreSignal)
  process.on('SIGTERM', ignoreSignal)

  const expectedControl = `RFC224_FFF_ACK ${nonce}\n`
  const control = readFffSupervisorControl().then(
    (value) => {
      if (value !== expectedControl) return killCurrentProcessGroup()
    },
    () => killCurrentProcessGroup(),
  )
  void control.catch(() => undefined)

  const watchdog = setTimeout(killCurrentProcessGroup, watchdogMilliseconds)
  const output = Bun.stdout.writer()
  let code = 125
  let stdout: Uint8Array = new Uint8Array()
  let stderr: Uint8Array = new Uint8Array()
  try {
    const child = Bun.spawn({
      cmd: [...command],
      cwd,
      env: {},
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitResult, stdoutResult, stderrResult] = await Promise.allSettled([
      child.exited,
      drainBounded(child.stdout as ReadableStream<Uint8Array>, MAX_PROBE_OUTPUT_BYTES),
      drainBounded(child.stderr as ReadableStream<Uint8Array>, MAX_PROBE_OUTPUT_BYTES),
    ])
    if (
      exitResult.status === 'fulfilled' &&
      Number.isSafeInteger(exitResult.value) &&
      exitResult.value >= 0 &&
      exitResult.value <= 255 &&
      stdoutResult.status === 'fulfilled' &&
      !stdoutResult.value.overflow &&
      stderrResult.status === 'fulfilled' &&
      !stderrResult.value.overflow
    ) {
      code = exitResult.value
      stdout = stdoutResult.value.bytes
      stderr = stderrResult.value.bytes
    }
  } catch {
    // Spawn failures and invalid/oversized output are ordinary negative proof
    // results. They still traverse the authenticated release protocol.
  }

  try {
    output.write(
      `RFC224_FFF_RESULT ${nonce} ${code} ${encodeSupervisorBytes(stdout)} ${encodeSupervisorBytes(stderr)}\n`,
    )
    await output.flush()
    await control
    output.write(`RFC224_FFF_RELEASE ${nonce}\n`)
    await output.flush()
    clearTimeout(watchdog)
    return killCurrentProcessGroup()
  } catch {
    return killCurrentProcessGroup()
  }
}

interface FffSupervisorResult {
  code: number
  stdout: Uint8Array
  stderr: Uint8Array
}

type FffSupervisorSignalState = 'owned' | 'releasing' | 'released'

const CANONICAL_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function decodeSupervisorBytes(value: string): Uint8Array {
  if (value === '-') return new Uint8Array()
  if (!CANONICAL_BASE64_RE.test(value)) throw new Error('invalid FFF supervisor output')
  const decoded = new Uint8Array(Buffer.from(value, 'base64'))
  if (
    decoded.byteLength > MAX_PROBE_OUTPUT_BYTES ||
    Buffer.from(decoded).toString('base64') !== value
  ) {
    throw new Error('invalid FFF supervisor output')
  }
  return decoded
}

async function readFffSupervisorProtocol(
  stream: ReadableStream<Uint8Array>,
  nonce: string,
  deadline: bigint,
  acknowledge: () => Promise<void>,
): Promise<FffSupervisorResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffered = ''
  let result: FffSupervisorResult | undefined
  let released = false
  try {
    for (;;) {
      const next = await settleBefore(
        reader.read(),
        deadline,
        'FFF capability supervisor protocol deadline exceeded',
      )
      if (next.done) break
      buffered += decoder.decode(next.value, { stream: true })
      if (Buffer.byteLength(buffered, 'utf8') > FFF_CAPABILITY_SUPERVISOR_REPORT_LIMIT_BYTES) {
        throw new Error('FFF capability supervisor report exceeded its bound')
      }

      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) break
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (result === undefined) {
          const match = new RegExp(
            `^RFC224_FFF_RESULT ${nonce} ([0-9]{1,3}) ([A-Za-z0-9+/=-]+) ([A-Za-z0-9+/=-]+)$`,
          ).exec(line)
          const code = match?.[1] === undefined ? Number.NaN : Number(match[1])
          if (
            !Number.isSafeInteger(code) ||
            code < 0 ||
            code > 255 ||
            match?.[2] === undefined ||
            match[3] === undefined ||
            buffered !== ''
          ) {
            throw new Error('invalid FFF capability supervisor result')
          }
          result = {
            code,
            stdout: decodeSupervisorBytes(match[2]),
            stderr: decodeSupervisorBytes(match[3]),
          }
          // Relinquish numeric-PGID signaling synchronously before the first
          // ACK byte. The supervisor guardian/watchdog owns release from here.
          await acknowledge()
        } else {
          if (released || line !== `RFC224_FFF_RELEASE ${nonce}` || buffered !== '') {
            throw new Error('invalid FFF capability supervisor release')
          }
          released = true
        }
      }
    }
    buffered += decoder.decode()
    if (result === undefined || !released || buffered !== '') {
      throw new Error('partial FFF capability supervisor protocol')
    }
    return result
  } finally {
    reader.releaseLock()
  }
}

function resultStream(
  result: Promise<FffSupervisorResult>,
  select: (value: FffSupervisorResult) => Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void result.then(
        (value) => {
          const bytes = select(value)
          if (bytes.byteLength > 0) controller.enqueue(bytes)
          controller.close()
        },
        (error: unknown) => controller.error(error),
      )
    },
  })
}

function spawnFffCapabilityProbeSupervisor(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
): FffCapabilityProbeProcess {
  const nonce = randomUUID()
  const watchdogMilliseconds = timeoutMs + FFF_CAPABILITY_SUPERVISOR_WATCHDOG_MARGIN_MS
  const child = Bun.spawn({
    cmd: verifiedSelfCommand(FFF_CAPABILITY_SUPERVISOR_SUBCOMMAND, [
      '--nonce',
      nonce,
      '--watchdog-ms',
      String(watchdogMilliseconds),
      '--cwd',
      cwd,
      '--',
      ...command,
    ]),
    cwd,
    env: {},
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  const deadline =
    process.hrtime.bigint() +
    BigInt(watchdogMilliseconds + FFF_CAPABILITY_SUPERVISOR_RELEASE_MARGIN_MS) *
      NANOSECONDS_PER_MILLISECOND
  let signalState: FffSupervisorSignalState = 'owned'
  let directSettled = false
  let groupExited = false
  let controlClosed = false

  const rawExited = child.exited.then(
    (code) => {
      directSettled = true
      return code
    },
    (error: unknown) => {
      directSettled = true
      throw error
    },
  )

  const endControl = async (): Promise<void> => {
    if (controlClosed) return
    controlClosed = true
    await settleBefore(
      Promise.resolve(child.stdin.end()),
      deadline,
      'FFF capability supervisor control close deadline exceeded',
    )
  }

  const acknowledge = async (): Promise<void> => {
    signalState = 'releasing'
    await settleBefore(
      Promise.resolve(child.stdin.write(`RFC224_FFF_ACK ${nonce}\n`)),
      deadline,
      'FFF capability supervisor ACK write deadline exceeded',
    )
    await settleBefore(
      Promise.resolve(child.stdin.flush()),
      deadline,
      'FFF capability supervisor ACK flush deadline exceeded',
    )
    await endControl()
  }

  const protocol = readFffSupervisorProtocol(
    child.stdout as ReadableStream<Uint8Array>,
    nonce,
    deadline,
    acknowledge,
  )
  void protocol.catch(() => {
    void endControl().catch(() => undefined)
  })
  const supervisorStderr = drainBounded(
    child.stderr as ReadableStream<Uint8Array>,
    FFF_CAPABILITY_SUPERVISOR_CONTROL_LIMIT_BYTES,
    deadline,
  )

  const observeGroupAlive = (): boolean => {
    if (groupExited) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
      groupExited = true
      return false
    }
  }

  const result = (async (): Promise<FffSupervisorResult> => {
    const [protocolResult, stderrResult, exitResult] = await Promise.allSettled([
      protocol,
      supervisorStderr,
      settleBefore(rawExited, deadline, 'FFF capability supervisor direct exit deadline exceeded'),
    ])
    let lifecycleFailure: unknown
    try {
      await endControl()
    } catch (error) {
      lifecycleFailure = error
    }

    while (observeGroupAlive() && remainingMilliseconds(deadline) > 0) {
      await delay(Math.min(PROBE_STOP_POLL_MS, Math.max(1, remainingMilliseconds(deadline))))
    }
    signalState = 'released'

    if (observeGroupAlive()) {
      lifecycleFailure ??= new Error('FFF capability supervisor group release deadline exceeded')
    }
    if (protocolResult.status === 'rejected') lifecycleFailure ??= protocolResult.reason
    if (
      stderrResult.status === 'rejected' ||
      (stderrResult.status === 'fulfilled' &&
        (stderrResult.value.overflow || stderrResult.value.bytes.byteLength !== 0))
    ) {
      lifecycleFailure ??=
        stderrResult.status === 'rejected'
          ? stderrResult.reason
          : new Error('FFF capability supervisor emitted stderr')
    }
    if (exitResult.status === 'rejected' || exitResult.value !== 137) {
      lifecycleFailure ??=
        exitResult.status === 'rejected'
          ? exitResult.reason
          : new Error('FFF capability supervisor exit mismatch')
    }
    if (lifecycleFailure !== undefined) throw lifecycleFailure
    if (protocolResult.status !== 'fulfilled') {
      throw new Error('FFF capability supervisor protocol did not settle')
    }
    return protocolResult.value
  })()
  void result.catch(() => undefined)

  return {
    pid: child.pid,
    stdout: resultStream(result, (value) => value.stdout),
    stderr: resultStream(result, (value) => value.stderr),
    exited: result.then((value) => value.code),
    killGroup: (signal) => {
      if (signalState !== 'owned' || directSettled || groupExited) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        // ESRCH/unknown never justify signaling a positive, reusable PID.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') groupExited = true
      }
    },
    isGroupAlive: observeGroupAlive,
    hasSignalOwnership: () => signalState === 'owned' && !directSettled,
  }
}

function defaultSpawn(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
): FffCapabilityProbeProcess {
  return spawnFffCapabilityProbeSupervisor(command, cwd, timeoutMs)
}

function probeGroupAlive(child: FffCapabilityProbeProcess): boolean {
  try {
    return child.isGroupAlive()
  } catch {
    // Unknown liveness is not proof of PGID absence.
    return true
  }
}

function probeHasSignalOwnership(
  child: FffCapabilityProbeProcess,
  isDirectSettled: () => boolean,
): boolean {
  try {
    return child.hasSignalOwnership?.() ?? !isDirectSettled()
  } catch {
    return false
  }
}

interface ProbeStopState {
  groupExited: boolean
}

async function waitForProbeStop(
  child: FffCapabilityProbeProcess,
  isDirectSettled: () => boolean,
  areStreamsSettled: () => boolean,
  timeout: (milliseconds: number) => Promise<void>,
  durationMs: number,
  state: ProbeStopState,
): Promise<boolean> {
  const polls = Math.ceil(durationMs / PROBE_STOP_POLL_MS)
  for (let index = 0; index <= polls; index += 1) {
    if (!state.groupExited) state.groupExited = !probeGroupAlive(child)
    if (isDirectSettled() && areStreamsSettled() && state.groupExited) return true
    if (index < polls) await timeout(PROBE_STOP_POLL_MS)
  }
  return false
}

async function terminateProbe(
  child: FffCapabilityProbeProcess,
  isDirectSettled: () => boolean,
  areStreamsSettled: () => boolean,
  timeout: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const state: ProbeStopState = { groupExited: false }
  if (!probeHasSignalOwnership(child, isDirectSettled)) {
    // ACK/release or an already-settled leader has relinquished numeric PGID
    // authority. Wait only for the bounded native cleanup proof.
    return waitForProbeStop(
      child,
      isDirectSettled,
      areStreamsSettled,
      timeout,
      FFF_CAPABILITY_SUPERVISOR_RELEASE_MARGIN_MS,
      state,
    )
  }

  child.killGroup('SIGTERM')
  if (
    await waitForProbeStop(
      child,
      isDirectSettled,
      areStreamsSettled,
      timeout,
      PROBE_STOP_GRACE_MS,
      state,
    )
  ) {
    return true
  }
  if (isDirectSettled() || state.groupExited || !probeHasSignalOwnership(child, isDirectSettled)) {
    // Once the direct leader settles or ACK handoff begins, the old numeric
    // PGID is ambiguous. Do not signal it; give the native cleanup authority a
    // bounded window to prove direct settlement, both EOFs, and group absence.
    return waitForProbeStop(
      child,
      isDirectSettled,
      areStreamsSettled,
      timeout,
      FFF_CAPABILITY_SUPERVISOR_RELEASE_MARGIN_MS,
      state,
    )
  }
  child.killGroup('SIGKILL')
  return waitForProbeStop(
    child,
    isDirectSettled,
    areStreamsSettled,
    timeout,
    PROBE_STOP_GRACE_MS,
    state,
  )
}

/**
 * Execute and strictly decode the proof. Any drift is intentionally collapsed
 * to the stable bootstrap failure; stdout/stderr bytes never become an oracle.
 */
export async function runFffCapabilityProbe(
  input: RunFffCapabilityProbeInput,
  dependencies: FffCapabilityProbeDependencies = {},
): Promise<void> {
  const verifyArtifacts = dependencies.verifyArtifacts ?? verifyFffCapabilityProbeArtifacts
  const requireBwrap = dependencies.requireBwrap ?? ((path) => requireRootOwnedBwrap(path))
  const spawn = dependencies.spawn ?? defaultSpawn
  const timeout = dependencies.timeout ?? delay
  let child: FffCapabilityProbeProcess | undefined
  let directSettled = false
  let streamsSettled = false
  let bwrapAdmissionFailure: ExecutionIdentityFailure | undefined
  try {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > PROBE_TIMEOUT_MAX_MS
    ) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    await verifyArtifacts(input.runRoot, input.probe)
    let admittedBwrapPath: string
    try {
      admittedBwrapPath = await requireBwrap(input.probe.bwrapPath)
    } catch (error) {
      if (
        error instanceof ExecutionIdentityFailure &&
        error.code === 'execution-identity-sandbox-required'
      ) {
        bwrapAdmissionFailure = error
      }
      throw error
    }
    if (admittedBwrapPath !== input.probe.bwrapPath) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    const command = renderFffCapabilityProbeCommand({
      binaryPath: input.binaryPath,
      probe: input.probe,
    })
    child = spawn(command, pathsFor(input.probe).cwd, input.timeoutMs)
    const exit = child.exited.then(
      (code) => {
        directSettled = true
        return code
      },
      (error: unknown) => {
        directSettled = true
        throw error
      },
    )
    const outputs = Promise.allSettled([
      readBounded(child.stdout, MAX_PROBE_OUTPUT_BYTES),
      readBounded(child.stderr, MAX_PROBE_OUTPUT_BYTES),
    ]).then((results) => {
      streamsSettled = true
      const [stdoutResult, stderrResult] = results
      if (stdoutResult?.status !== 'fulfilled') throw stdoutResult?.reason
      if (stderrResult?.status !== 'fulfilled') throw stderrResult?.reason
      return [stdoutResult.value, stderrResult.value] as const
    })
    const lifecycle = Promise.all([exit, outputs]).then(
      ([code, [stdout, stderr]]) => [code, stdout, stderr] as const,
    )
    void lifecycle.catch(() => undefined)
    const result = await Promise.race([lifecycle, timeout(input.timeoutMs).then(() => null)])
    if (result === null) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    const [code, stdout, stderr] = result
    if (probeGroupAlive(child)) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    const expected = new TextEncoder().encode(`${input.probe.basename}\n`)
    if (
      code !== 0 ||
      stderr.byteLength !== 0 ||
      stdout.byteLength !== expected.byteLength ||
      stdout.some((byte, index) => byte !== expected[index])
    ) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    // A fallback attempt must not have materialized a cached rg even if an
    // unexpected sandbox/network regression somehow let it return.
    const paths = pathsFor(input.probe)
    await assertDirectory(paths.cacheBin, 0o500, [])
    await assertDirectory(paths.path, 0o500, [])
  } catch {
    if (bwrapAdmissionFailure !== undefined) throw bwrapAdmissionFailure
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  } finally {
    if (child !== undefined && (!directSettled || !streamsSettled || probeGroupAlive(child))) {
      let stopped = false
      try {
        stopped = await terminateProbe(
          child,
          () => directSettled,
          () => streamsSettled,
          timeout,
        )
      } catch {
        stopped = false
      }
      if (!stopped) {
        executionIdentityFailure('execution-identity-bootstrap-failed')
      }
    }
  }
}

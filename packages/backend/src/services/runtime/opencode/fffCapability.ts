// RFC-224 T7a — prove that an admitted OpenCode build is using its bundled
// FFF filesystem service before the real server is allowed to start.
//
// The fallback filesystem service can discover/download ripgrep. The probe is
// therefore deliberately stronger than a version/flag check: the same sealed
// executable must find one unpredictable file while running with no network,
// an empty read-only ripgrep cache, and an empty PATH.

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { OPENCODE_FFF_CAPABILITY_CODEC } from './hermetic'
import { executionIdentityFailure } from './failure'
import { requireRootOwnedBwrap } from './sealedSubprocess'

const PROBE_BASENAME_RE = /^aw-fff-[0-9a-f]{32}\.txt$/
const MAX_PROBE_OUTPUT_BYTES = 4 * 1024
const PROBE_STOP_GRACE_MS = 250

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
  spawn?: (command: readonly string[], cwd: string) => FffCapabilityProbeProcess
  timeout?: (milliseconds: number) => Promise<void>
}

function defaultSpawn(command: readonly string[], cwd: string): FffCapabilityProbeProcess {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env: {},
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  return {
    pid: child.pid,
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    exited: child.exited,
    killGroup: (signal) => {
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    },
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds)
    timer.unref?.()
  })
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value === undefined) continue
      bytes += next.value.byteLength
      if (bytes > limit) {
        return executionIdentityFailure('execution-identity-bootstrap-failed')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function terminateProbe(child: FffCapabilityProbeProcess): Promise<void> {
  child.killGroup('SIGTERM')
  const exited = await Promise.race([
    child.exited.then(() => true),
    delay(PROBE_STOP_GRACE_MS).then(() => false),
  ])
  if (!exited) {
    child.killGroup('SIGKILL')
    await Promise.race([child.exited, delay(PROBE_STOP_GRACE_MS)])
  }
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
  let exited = false
  try {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > 300_000
    ) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    await verifyArtifacts(input.runRoot, input.probe)
    if ((await requireBwrap(input.probe.bwrapPath)) !== input.probe.bwrapPath) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    const command = renderFffCapabilityProbeCommand({
      binaryPath: input.binaryPath,
      probe: input.probe,
    })
    child = spawn(command, pathsFor(input.probe).cwd)
    const exit = child.exited.then((code) => {
      exited = true
      return code
    })
    const result = await Promise.race([
      Promise.all([
        exit,
        readBounded(child.stdout, MAX_PROBE_OUTPUT_BYTES),
        readBounded(child.stderr, MAX_PROBE_OUTPUT_BYTES),
      ]),
      timeout(input.timeoutMs).then(() => null),
    ])
    if (result === null) {
      return executionIdentityFailure('execution-identity-bootstrap-failed')
    }
    const [code, stdout, stderr] = result
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
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  } finally {
    if (child !== undefined && !exited) await terminateProbe(child)
  }
}

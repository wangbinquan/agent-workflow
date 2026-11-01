import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { command, REPO_ROOT, writeJson } from './io'
import { DEFAULT_CACHE, resolveRuntimeShim } from './binaries'
import type { BinaryEvidence } from './binaries'
import type { ReleaseEntry } from './model'

export interface OldDaemon {
  home: string
  baseUrl: string
  token: string
  logPath: string
  env: NodeJS.ProcessEnv
  binary: BinaryEvidence
  release: ReleaseEntry
  readonly shutdownMethod: 'not-stopped' | 'control' | 'signal' | 'windows-termination'
  exited: Promise<number | null>
  stop(): Promise<void>
}
export interface DaemonOptions {
  home: string
  release: ReleaseEntry
  binary: BinaryEvidence
  stubPath?: string
  cacheDir?: string
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  /** Candidate/attempt-specific logs keep refusal evidence separate from the retry. */
  logName?: string
}

export class DaemonStartError extends Error {
  constructor(
    message: string,
    readonly started: boolean,
    readonly exitCode: number | null,
    readonly output: string,
    readonly logPath: string,
    readonly timedOut = false,
  ) {
    super(`${message}; see ${logPath}\n${output.slice(-16_000)}`)
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Cannot allocate daemon port')
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  )
  return address.port
}

export async function daemonEnvironment(options: DaemonOptions): Promise<NodeJS.ProcessEnv> {
  const home = resolve(options.home)
  const stub =
    options.stubPath ??
    join(
      REPO_ROOT,
      'dist',
      `stub-opencode-${options.binary.platform}${options.binary.platform.startsWith('windows') ? '.exe' : ''}`,
    )
  if (!existsSync(stub))
    throw new Error(`Build the repository's compiled stub before seeding: ${stub}`)
  const cachedShim = await resolveRuntimeShim(options.cacheDir)
  mkdirSync(home, { recursive: true })
  // Per-home shim copy + settings file + stub state. Sandboxed releases (v0.16.x seatbelt)
  // scrub the runtime environment and deny the whole app home except the task worktree, run dir
  // and repo mirrors, so all of it lives in the cache, keyed by the home path.
  const shimDirectory = join(
    options.cacheDir ?? DEFAULT_CACHE,
    'runtime-homes',
    createHash('sha256').update(home).digest('hex').slice(0, 32),
  )
  mkdirSync(shimDirectory, { recursive: true })
  const shim = join(shimDirectory, basename(cachedShim))
  if (!existsSync(shim))
    try {
      linkSync(cachedShim, shim)
    } catch {
      copyFileSync(cachedShim, shim)
    }
  const shimSettings = {
    AW_RELEASE_STUB_EXECUTABLE: resolve(stub),
    AW_RELEASE_OPENCODE_VERSION: options.release.runtime.probeVersion,
    // The transport follows what the prompt carries, not whether runs store a nonce (v0.15.x).
    AW_RELEASE_LEGACY_ENVELOPE: options.release.runtime.capabilities.promptNonce ? '0' : '1',
    BUSINESS_WORKFLOW_STATE_DIR: join(shimDirectory, 'business'),
    CLARIFY_STUB_STATE: join(shimDirectory, 'clarify'),
  }
  writeJson(join(shimDirectory, 'shim.json'), shimSettings)
  const configPath = join(home, 'config.json')
  const existing = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
    : {}
  // Preserve provider configuration and every old-version setting on restart.
  writeJson(configPath, {
    ...existing,
    opencodePath: shim,
    defaultNodeRetries: 0,
    sessionRestartBudget: 0,
    defaultPerNodeTimeoutMs: 120_000,
    memoryDistillerEnabled: false,
    worktreeAutoGc: { enabled: false },
  })
  mkdirSync(join(home, 'release-upgrade-runtime'), { recursive: true })
  return {
    ...process.env,
    ...options.env,
    AGENT_WORKFLOW_HOME: home,
    ...shimSettings,
    AW_STUB_MODE: 'business-workflows',
    AGENT_WORKFLOW_OPENCODE_BIN: shim,
    GIT_AUTHOR_NAME: 'Release Upgrade Fixture',
    GIT_AUTHOR_EMAIL: 'release-upgrade@example.invalid',
    GIT_COMMITTER_NAME: 'Release Upgrade Fixture',
    GIT_COMMITTER_EMAIL: 'release-upgrade@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    BROWSER: 'none',
  }
}

export async function startOldDaemon(options: DaemonOptions): Promise<OldDaemon> {
  if (options.release.l2.unsupported)
    throw new Error(`${options.release.tag}: ${options.release.l2.unsupported}`)
  const home = resolve(options.home)
  const env = await daemonEnvironment(options)
  const port = await freePort()
  const logPath = join(home, options.logName ?? 'release-upgrade-daemon.log')
  const child = spawn(
    options.binary.path,
    ['start', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  let started = false
  let done = false
  let spawnError: Error | undefined
  const log = (chunk: Buffer) => {
    appendFileSync(logPath, chunk)
    output += chunk.toString()
  }
  child.stdout.on('data', log)
  child.stderr.on('data', log)
  child.once('spawn', () => {
    started = true
  })
  const exited = new Promise<number | null>((accept) => {
    child.once('error', (error) => {
      spawnError = error
      done = true
      accept(null)
    })
    child.once('close', (code) => {
      done = true
      accept(code)
    })
  })
  let stopping: Promise<void> | undefined
  let shutdownMethod: OldDaemon['shutdownMethod'] = 'not-stopped'
  const stop = () =>
    (stopping ??= (async () => {
      if (done) return
      // Windows SIGTERM is a hard kill. Modern binaries expose native shutdown;
      // historical tag builds do not. Record that distinction; scenario.ts must
      // recover/checkpoint their intact WAL before calling the home seeded.
      const controlPath = join(home, '.daemon.control')
      try {
        if (existsSync(controlPath)) {
          shutdownMethod = 'control'
          const control = JSON.parse(readFileSync(controlPath, 'utf8')) as {
            url: string
            nonce: string
          }
          let response: Response | undefined
          try {
            response = await fetch(`${control.url}/shutdown`, {
              method: 'POST',
              headers: { 'x-agent-workflow-control': control.nonce },
              signal: AbortSignal.timeout(10_000),
            })
          } catch (error) {
            // Some releases (v0.18.10) close the control connection as shutdown begins. The
            // graceful-exit wait below still decides; a refusal is only an HTTP error answer.
            const reset =
              (error as { code?: unknown }).code === 'ECONNRESET' ||
              String((error as Error).message).includes('socket connection was closed')
            if (!reset) throw error
          }
          if (response && !response.ok)
            throw new Error(`Daemon shutdown refused: ${response.status}`)
        } else if (process.platform === 'win32') {
          shutdownMethod = 'windows-termination'
          child.kill('SIGKILL')
          await exited
          appendFileSync(
            logPath,
            '\nHistorical Windows binary stopped by termination; intact SQLite WAL requires checkpoint validation.\n',
          )
          return
        } else {
          shutdownMethod = 'signal'
          child.kill('SIGTERM')
        }
      } catch (error) {
        if (!done) {
          child.kill('SIGKILL')
          await exited
        }
        throw error
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((accept) => {
          timer = setTimeout(() => accept(false), 45_000)
        }),
      ]).finally(() => clearTimeout(timer))
      if (!graceful) {
        child.kill('SIGKILL')
        await exited
        throw new Error(`Daemon did not stop cleanly; refusing to record or remove WAL: ${logPath}`)
      }
    })())
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    const deadline = Date.now() + (options.startupTimeoutMs ?? 180_000)
    while (Date.now() < deadline) {
      if (done)
        throw new DaemonStartError(
          `Daemon exited before readiness: ${spawnError?.message ?? ''}`,
          started,
          await exited,
          output,
          logPath,
        )
      const tokenPath = join(home, 'token')
      const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : ''
      if (token) {
        for (const path of ['/health']) {
          try {
            const response = await fetch(`${baseUrl}${path}`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(2_000),
            })
            const body = await response.text()
            if (
              response.ok &&
              /json/i.test(response.headers.get('content-type') ?? '') &&
              body.startsWith('{') &&
              JSON.parse(body).ok === true
            )
              return {
                home,
                baseUrl,
                token,
                logPath,
                env,
                binary: options.binary,
                release: options.release,
                get shutdownMethod() {
                  return shutdownMethod
                },
                exited,
                stop,
              }
          } catch {
            /* Readiness retries only; API scenario failures never retry mutations. */
          }
        }
      }
      await Promise.race([exited, delay(250)])
    }
    throw new DaemonStartError('Daemon readiness timed out', started, null, output, logPath, true)
  } catch (error) {
    await stop()
    throw error
  }
}

/** Call only after stop(); retain stdout/stderr evidence in the home. */
export async function oldCli(
  options: DaemonOptions,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await command([options.binary.path, ...args], {
    cwd: options.home,
    env: { ...(await daemonEnvironment(options)), ...env },
    timeoutMs: 900_000,
    label: `${options.release.tag} ${args.slice(0, 3).join(' ')}`,
  })
  return result.toString('utf8')
}

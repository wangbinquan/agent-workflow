import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface LocalGateCommand {
  label: string
  args: string[]
}

export interface LocalGateLane {
  name: string
  commands: LocalGateCommand[]
}

export const LOCAL_GATE_LANES: LocalGateLane[] = [
  {
    name: 'backend',
    commands: [{ label: 'backend tests', args: ['run', 'test:backend'] }],
  },
  {
    name: 'quality',
    commands: [
      { label: 'typecheck', args: ['run', 'typecheck'] },
      { label: 'lint', args: ['run', 'lint'] },
      { label: 'format check', args: ['run', 'format:check'] },
      { label: 'dependency rules', args: ['run', 'depcheck'] },
      { label: 'shared tests', args: ['run', 'test:shared'] },
      // Two workers keep the 6,313-test suite bounded beside four isolated
      // backend shards. The ordinary test:frontend command stays unrestricted.
      { label: 'frontend tests', args: ['run', 'test:frontend:gate'] },
    ],
  },
]

interface KillableProcess {
  kill(signal?: NodeJS.Signals | number): void
}

interface LocalGateLockOwner {
  pid: number
  token: string
  repoRoot: string
  startedAt: string
}

export interface LocalGateLockOptions {
  lockRoot?: string
  pid?: number
  token?: string
  now?: () => Date
  isProcessAlive?: (pid: number) => boolean
}

export interface LocalGateLock {
  path: string
  release(): void
}

class LocalGateAlreadyRunningError extends Error {
  constructor(readonly owner: LocalGateLockOwner) {
    super(
      `another local gate is already running for this repository ` +
        `(pid ${owner.pid}, started ${owner.startedAt}, cwd ${owner.repoRoot})`,
    )
    this.name = 'LocalGateAlreadyRunningError'
  }
}

class GateCommandError extends Error {
  constructor(
    readonly lane: string,
    readonly label: string,
    readonly exitCode: number,
  ) {
    super(`${lane}: ${label} exited with code ${exitCode}`)
  }
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  return String((error as NodeJS.ErrnoException).code)
}

function gitCommonDir(repoRoot: string): string {
  const dotGit = resolve(repoRoot, '.git')
  if (statSync(dotGit).isDirectory()) return realpathSync(dotGit)

  const directive = readFileSync(dotGit, 'utf8').trim()
  const prefix = 'gitdir:'
  if (!directive.startsWith(prefix)) {
    throw new Error(`invalid worktree gitdir file: ${dotGit}`)
  }
  const gitDir = resolve(repoRoot, directive.slice(prefix.length).trim())
  let commonDir = gitDir
  try {
    const relativeCommonDir = readFileSync(resolve(gitDir, 'commondir'), 'utf8').trim()
    commonDir = resolve(gitDir, relativeCommonDir)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  return realpathSync(commonDir)
}

export function resolveLocalGateLockPath(repoRoot: string, lockRoot = tmpdir()): string {
  const identity = createHash('sha256').update(gitCommonDir(repoRoot)).digest('hex').slice(0, 16)
  return join(lockRoot, `agent-workflow-local-gate-${identity}.lock`)
}

function readLockOwner(lockPath: string): LocalGateLockOwner | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(lockPath, 'owner.json'), 'utf8'),
    ) as Partial<LocalGateLockOwner>
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.token !== 'string' ||
      typeof parsed.repoRoot !== 'string' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return undefined
    }
    return parsed as LocalGateLockOwner
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

export function acquireLocalGateLock(
  repoRoot: string,
  options: LocalGateLockOptions = {},
): LocalGateLock {
  const lockRoot = options.lockRoot ?? tmpdir()
  const pid = options.pid ?? process.pid
  const token = options.token ?? randomUUID()
  const now = options.now ?? (() => new Date())
  const processIsAlive = options.isProcessAlive ?? isProcessAlive
  mkdirSync(lockRoot, { recursive: true })
  const lockPath = resolveLocalGateLockPath(repoRoot, lockRoot)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const owner = readLockOwner(lockPath)
      if (owner !== undefined && processIsAlive(owner.pid)) {
        throw new LocalGateAlreadyRunningError(owner)
      }
      if (owner === undefined) {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs
        if (ageMs < 5_000) {
          throw new Error(`local gate lock is still initializing: ${lockPath}`)
        }
      }
      rmSync(lockPath, { recursive: true, force: true })
      continue
    }

    const owner: LocalGateLockOwner = {
      pid,
      token,
      repoRoot,
      startedAt: now().toISOString(),
    }
    try {
      writeFileSync(resolve(lockPath, 'owner.json'), JSON.stringify(owner, null, 2))
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true })
      throw error
    }

    let released = false
    return {
      path: lockPath,
      release(): void {
        if (released) return
        released = true
        if (readLockOwner(lockPath)?.token === token) {
          rmSync(lockPath, { recursive: true, force: true })
        }
      },
    }
  }

  throw new Error(`unable to acquire local gate lock: ${lockPath}`)
}

function durationLabel(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

async function runCommand(
  repoRoot: string,
  lane: string,
  command: LocalGateCommand,
  active: Set<KillableProcess>,
): Promise<void> {
  const startedAt = performance.now()
  console.log(`[gate:${lane}] start ${command.label}`)
  const child = Bun.spawn([process.execPath, ...command.args], {
    cwd: repoRoot,
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  active.add(child)
  const exitCode = await child.exited
  active.delete(child)
  if (exitCode !== 0) throw new GateCommandError(lane, command.label, exitCode)
  console.log(
    `[gate:${lane}] pass ${command.label} (${durationLabel(performance.now() - startedAt)})`,
  )
}

async function runLane(
  repoRoot: string,
  lane: LocalGateLane,
  active: Set<KillableProcess>,
  isInterrupted: () => boolean,
): Promise<void> {
  const failures: unknown[] = []
  for (const command of lane.commands) {
    if (isInterrupted()) break
    try {
      await runCommand(repoRoot, lane.name, command, active)
    } catch (error) {
      failures.push(error)
      console.error(`[gate:${lane.name}] ${String(error)}; continuing to collect remaining results`)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${lane.name} lane had ${failures.length} failed command(s)`)
  }
}

export async function runLocalGate(): Promise<number> {
  const repoRoot = resolve(import.meta.dir, '..')
  let gateLock: LocalGateLock | undefined
  try {
    gateLock = acquireLocalGateLock(repoRoot)
  } catch (error) {
    console.error(`[gate] ${String(error)}`)
    return 2
  }
  const active = new Set<KillableProcess>()
  let interruptedSignal: NodeJS.Signals | undefined

  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal
    for (const child of active) child.kill(signal)
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  const startedAt = performance.now()
  console.log('[gate] running backend and quality lanes concurrently')
  const lanes = LOCAL_GATE_LANES.map((lane) =>
    runLane(repoRoot, lane, active, () => interruptedSignal !== undefined),
  )
  try {
    const results = await Promise.allSettled(lanes)
    const failures = results.filter((result) => result.status === 'rejected')
    if (interruptedSignal !== undefined) {
      console.error(`[gate] interrupted by ${interruptedSignal}`)
      return interruptedSignal === 'SIGINT' ? 130 : 143
    }
    if (failures.length > 0) {
      for (const failure of failures) console.error(`[gate] ${String(failure.reason)}`)
      console.error(
        `[gate] ${failures.length}/${LOCAL_GATE_LANES.length} lane(s) failed after ${durationLabel(performance.now() - startedAt)}`,
      )
      return 1
    }
    console.log(`[gate] all local gates passed in ${durationLabel(performance.now() - startedAt)}`)
    return 0
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    gateLock.release()
  }
}

if (import.meta.main) process.exitCode = await runLocalGate()

import { resolve } from 'node:path'

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
      // Three workers matched the unrestricted 153s frontend wall time on the
      // measured 10-core host, while bounding gate-wide contention with six
      // backend shards. The ordinary test:frontend command stays unrestricted.
      { label: 'frontend tests', args: ['run', 'test:frontend:gate'] },
    ],
  },
]

interface KillableProcess {
  kill(signal?: NodeJS.Signals | number): void
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
  }
}

if (import.meta.main) process.exitCode = await runLocalGate()

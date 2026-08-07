import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAX_SEED = 2_147_483_647
const MAX_LOCAL_SHARDS = 16

export const DEFAULT_LOCAL_BACKEND_SHARDS = 4

export interface BackendShardPlan {
  index: number
  count: number
  seed: number
  command: string[]
  homeDir: string
  tempDir: string
  env: Record<string, string>
}

interface BuildBackendShardPlansOptions {
  runRoot: string
  shardCount: number
  baseSeed: number
  bunExecutable?: string
}

interface ShardResult {
  plan: BackendShardPlan
  exitCode: number
  durationMs: number
  output: string
}

interface KillableProcess {
  kill(signal?: NodeJS.Signals | number): void
}

function parseInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function resolveLocalBackendShardCount(raw: string | undefined): number {
  return parseInteger(
    raw,
    'AW_LOCAL_BACKEND_SHARDS',
    DEFAULT_LOCAL_BACKEND_SHARDS,
    1,
    MAX_LOCAL_SHARDS,
  )
}

export function resolveLocalTestSeed(raw: string | undefined, now = Date.now()): number {
  const generated = (Math.abs(Math.trunc(now)) % (MAX_SEED - 1)) + 1
  return parseInteger(raw, 'AW_LOCAL_TEST_SEED', generated, 1, MAX_SEED)
}

export function buildBackendShardPlans({
  runRoot,
  shardCount,
  baseSeed,
  bunExecutable = process.execPath,
}: BuildBackendShardPlansOptions): BackendShardPlan[] {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > MAX_LOCAL_SHARDS) {
    throw new Error(`shardCount must be between 1 and ${MAX_LOCAL_SHARDS}`)
  }
  if (!Number.isInteger(baseSeed) || baseSeed < 1 || baseSeed > MAX_SEED) {
    throw new Error(`baseSeed must be between 1 and ${MAX_SEED}`)
  }

  return Array.from({ length: shardCount }, (_, offset) => {
    const index = offset + 1
    const seed = ((baseSeed + offset - 1) % MAX_SEED) + 1
    const homeDir = join(runRoot, `home-${index}`)
    const tempDir = join(runRoot, `tmp-${index}`)
    return {
      index,
      count: shardCount,
      seed,
      command: [
        bunExecutable,
        'test',
        '--isolate',
        '--randomize',
        `--seed=${seed}`,
        `--shard=${index}/${shardCount}`,
        '--dots',
      ],
      homeDir,
      tempDir,
      env: {
        AGENT_WORKFLOW_HOME: homeDir,
        AGENT_WORKFLOW_TEST_SHARD_HOME: homeDir,
        AGENT_WORKFLOW_TEST_SHARD_TMP: tempDir,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
      },
    }
  })
}

function durationLabel(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`
}

function summaryLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:--seed=|\d+ (?:pass|skip|fail)|Ran )/.test(line))
}

function outputTail(output: string, maxLines = 300): string {
  const lines = output.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
}

async function runShard(
  repoRoot: string,
  runRoot: string,
  plan: BackendShardPlan,
  active: Set<KillableProcess>,
): Promise<ShardResult> {
  mkdirSync(plan.homeDir, { recursive: true })
  mkdirSync(plan.tempDir, { recursive: true })
  const startedAt = performance.now()
  console.log(`[backend ${plan.index}/${plan.count}] start seed=${plan.seed}`)

  try {
    const child = Bun.spawn(plan.command, {
      cwd: repoRoot,
      env: { ...process.env, ...plan.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    active.add(child)
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    active.delete(child)
    const output = [stdout, stderr].filter(Boolean).join('\n')
    const durationMs = performance.now() - startedAt

    if (exitCode === 0) {
      const summary = summaryLines(output).join(' | ')
      console.log(
        `[backend ${plan.index}/${plan.count}] pass ${durationLabel(durationMs)}${summary ? ` | ${summary}` : ''}`,
      )
    } else {
      const logPath = join(runRoot, `shard-${plan.index}.log`)
      await Bun.write(logPath, output)
      console.error(
        `[backend ${plan.index}/${plan.count}] FAIL exit=${exitCode} ${durationLabel(durationMs)} log=${logPath}`,
      )
      console.error(outputTail(output))
    }

    return { plan, exitCode, durationMs, output }
  } catch (error) {
    const durationMs = performance.now() - startedAt
    const output = error instanceof Error ? (error.stack ?? error.message) : String(error)
    const logPath = join(runRoot, `shard-${plan.index}.log`)
    await Bun.write(logPath, output)
    console.error(
      `[backend ${plan.index}/${plan.count}] FAIL spawn ${durationLabel(durationMs)} log=${logPath}\n${output}`,
    )
    return { plan, exitCode: 1, durationMs, output }
  }
}

export async function runBackendShards(): Promise<number> {
  const repoRoot = resolve(import.meta.dir, '..')
  const shardCount = resolveLocalBackendShardCount(process.env.AW_LOCAL_BACKEND_SHARDS)
  const baseSeed = resolveLocalTestSeed(process.env.AW_LOCAL_TEST_SEED)
  const runRoot = mkdtempSync(join(tmpdir(), 'agent-workflow-backend-shards-'))
  const plans = buildBackendShardPlans({ runRoot, shardCount, baseSeed })
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

  console.log(
    `[backend] ${shardCount} isolated local shards | base-seed=${baseSeed} | temp=${runRoot}`,
  )
  const startedAt = performance.now()
  try {
    const results = await Promise.all(
      plans.map((plan) => runShard(repoRoot, runRoot, plan, active)),
    )
    const failed = results.filter((result) => result.exitCode !== 0)
    const durationMs = performance.now() - startedAt

    if (interruptedSignal !== undefined) {
      console.error(`[backend] interrupted by ${interruptedSignal}; diagnostics kept at ${runRoot}`)
      return interruptedSignal === 'SIGINT' ? 130 : 143
    }
    if (failed.length > 0) {
      console.error(
        `[backend] ${failed.length}/${shardCount} shard(s) failed after ${durationLabel(durationMs)}; diagnostics kept at ${runRoot}`,
      )
      return 1
    }

    console.log(`[backend] all ${shardCount} shards passed in ${durationLabel(durationMs)}`)
    try {
      rmSync(runRoot, { recursive: true, force: true })
    } catch (error) {
      console.warn(`[backend] passed, but temporary cleanup failed: ${String(error)}`)
    }
    return 0
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

if (import.meta.main) process.exitCode = await runBackendShards()

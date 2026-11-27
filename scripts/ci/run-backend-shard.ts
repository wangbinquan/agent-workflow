// RFC-627: execute a single LPT-planned backend test shard via bun:test with
// stale-timings cleanup and post-run completeness self-verification.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  assertTimingsMatchPlannedFiles,
  discoverBackendTests,
  filterBackendTestsByTier,
  loadBackendTimingWeights,
  parseBackendTestTier,
  parseShardSpec,
  planBackendShards,
  type BackendTestTier,
} from './backend-shards'

export interface RunBackendShardOptions {
  tier: BackendTestTier
  current: number
  total: number
  seed: string
  timingsOut: string
  coverage: boolean
}

export function parseRunBackendShardArgs(args: readonly string[]): RunBackendShardOptions {
  let tierArg: string | undefined
  let shardArg: string | undefined
  let seed: string | undefined
  let timingsOut: string | undefined
  let coverage = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--tier') tierArg = args[++index]
    else if (arg.startsWith('--tier=')) tierArg = arg.slice('--tier='.length)
    else if (arg === '--shard') shardArg = args[++index]
    else if (arg.startsWith('--shard=')) shardArg = arg.slice('--shard='.length)
    else if (arg === '--seed') seed = args[++index]
    else if (arg.startsWith('--seed=')) seed = arg.slice('--seed='.length)
    else if (arg === '--timings-out') timingsOut = args[++index]
    else if (arg.startsWith('--timings-out=')) timingsOut = arg.slice('--timings-out='.length)
    else if (arg === '--coverage') coverage = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!tierArg || !shardArg || !seed || !/^\d+$/.test(seed) || !timingsOut)
    throw new Error(
      'Usage: bun scripts/ci/run-backend-shard.ts --tier=<core|migration|all> --shard=N/M --seed=SEED --timings-out=PATH [--coverage]',
    )
  const tier = parseBackendTestTier(tierArg)
  const { current, total } = parseShardSpec(shardArg)
  return { tier, current, total, seed, timingsOut, coverage }
}

export function buildBunTestCommand(
  options: Pick<RunBackendShardOptions, 'seed' | 'timingsOut' | 'coverage'>,
  files: readonly string[],
): string[] {
  const command = ['bun', 'test', '--isolate', '--randomize', `--seed=${options.seed}`]
  if (options.coverage) command.push('--coverage', '--coverage-reporter=lcov')
  command.push(`--timings=${options.timingsOut}`, '--update-timings', ...files)
  return command
}

export async function runBackendShard(
  options: RunBackendShardOptions,
  repoRoot: string,
  spawn: (command: readonly string[], cwd: string) => Promise<number>,
): Promise<{ selectedFiles: string[]; estimatedMs: number; exitCode: number }> {
  const allFiles = filterBackendTestsByTier(discoverBackendTests(repoRoot), options.tier)
  const weights = loadBackendTimingWeights(repoRoot, options.tier)
  const plan = planBackendShards(allFiles, weights, options.tier, options.current, options.total)
  const selectedFiles = plan.assignments[options.current - 1]!
  if (selectedFiles.length === 0) {
    throw new Error(
      `Refusing to run empty backend shard ${options.current}/${options.total} for tier=${options.tier}`,
    )
  }
  const estimatedMs = plan.estimatedShardMs[options.current - 1]!

  const timingsPath = resolve(options.timingsOut)
  mkdirSync(dirname(timingsPath), { recursive: true })
  // Without `--shard`, Bun merges into an existing `--timings` file. Always start clean.
  rmSync(timingsPath, { force: true })

  const command = buildBunTestCommand(
    { seed: options.seed, timingsOut: timingsPath, coverage: options.coverage },
    selectedFiles,
  )
  const exitCode = await spawn(command, repoRoot)
  if (exitCode === 0) {
    const recorded: unknown = JSON.parse(readFileSync(timingsPath, 'utf8'))
    assertTimingsMatchPlannedFiles(recorded, selectedFiles)
  }
  return { selectedFiles, estimatedMs, exitCode }
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '../..')
  const options = parseRunBackendShardArgs(process.argv.slice(2))
  const result = await runBackendShard(options, repoRoot, async (command, cwd) => {
    console.log(
      `Backend shard ${options.current}/${options.total} (tier=${options.tier}, coverage=${options.coverage}): ` +
        `${command.length - (options.coverage ? 9 : 7)} files`,
    )
    const child = Bun.spawn([...command], {
      cwd,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return await child.exited
  })
  if (result.exitCode !== 0) {
    process.exit(result.exitCode)
  }
  console.log(
    `Verified backend shard ${options.current}/${options.total}: ${result.selectedFiles.length} files recorded (est ${(result.estimatedMs / 1000).toFixed(1)}s)`,
  )
}

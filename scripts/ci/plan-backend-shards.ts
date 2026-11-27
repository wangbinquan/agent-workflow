// RFC-627: CLI entrypoint to inspect or emit a deterministic backend test shard plan.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  discoverBackendTests,
  filterBackendTestsByTier,
  loadBackendTimingWeights,
  parseBackendTestTier,
  parseShardSpec,
  planBackendShards,
  type BackendTestTier,
} from './backend-shards'

export interface PlanBackendShardCliOptions {
  tier: BackendTestTier
  current: number
  total: number
  output?: string
}

export function parsePlanBackendShardArgs(args: readonly string[]): PlanBackendShardCliOptions {
  let tierArg: string | undefined
  let shardArg: string | undefined
  let output: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--tier') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error('Missing value for --tier')
      tierArg = value
    } else if (arg.startsWith('--tier=')) {
      tierArg = arg.slice('--tier='.length)
    } else if (arg === '--shard') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error('Missing value for --shard')
      shardArg = value
    } else if (arg.startsWith('--shard=')) {
      shardArg = arg.slice('--shard='.length)
    } else if (arg === '--output') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error('Missing value for --output')
      output = value
    } else if (arg.startsWith('--output=')) {
      const value = arg.slice('--output='.length)
      if (!value) throw new Error('Missing value for --output')
      output = value
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!tierArg || !shardArg)
    throw new Error(
      'Usage: bun scripts/ci/plan-backend-shards.ts --tier <core|migration|all> --shard=N/M [--output PATH]',
    )
  const tier = parseBackendTestTier(tierArg)
  const { current, total } = parseShardSpec(shardArg)
  return { tier, current, total, output }
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '../..')
  const { tier, current, total, output } = parsePlanBackendShardArgs(process.argv.slice(2))
  const files = filterBackendTestsByTier(discoverBackendTests(repoRoot), tier)
  const weights = loadBackendTimingWeights(repoRoot, tier)
  const plan = planBackendShards(files, weights, tier, current, total)
  const rendered = `${JSON.stringify(plan, null, 2)}\n`
  if (output) {
    const destination = resolve(output)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, rendered)
  } else {
    process.stdout.write(rendered)
  }
}

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  e2ePlatform,
  filterE2EDiscoveryByTier,
  parseE2EDiscovery,
  parseE2ETier,
  parseE2ETimings,
  planE2EShards,
} from './e2e-shards'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const options = new Map<string, string>()
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  const argument = args[index]!
  const equals = argument.indexOf('=')
  const key = equals < 0 ? argument : argument.slice(0, equals)
  const value = equals < 0 ? args[++index] : argument.slice(equals + 1)
  if (
    !['--report', '--platform', '--shard', '--output', '--timings', '--tier'].includes(key) ||
    !value ||
    options.has(key)
  )
    throw new Error(
      'Usage: plan-e2e-shards.ts --report FILE --platform Linux|macOS|Windows --shard N/M --output FILE [--timings FILE] [--tier pr-full|os-core]',
    )
  options.set(key, value)
}
const required = (name: string) => {
  const value = options.get(name)
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const shard = /^(\d+)\/(\d+)$/.exec(required('--shard'))
if (!shard) throw new Error('Shard must be N/M')
const tier = parseE2ETier(options.get('--tier') ?? 'pr-full')
const discovered = parseE2EDiscovery(
  JSON.parse(readFileSync(required('--report'), 'utf8')),
  repoRoot,
)
const tests = filterE2EDiscoveryByTier(discovered, tier)
const timings = parseE2ETimings(
  JSON.parse(
    readFileSync(
      options.get('--timings') ?? resolve(repoRoot, '.github/e2e-test-timings.json'),
      'utf8',
    ),
  ),
)
const plan = planE2EShards(
  tests,
  timings,
  e2ePlatform(required('--platform')),
  Number(shard[1]),
  Number(shard[2]),
  process.env.GITHUB_SHA ?? null,
  tier,
)
writeFileSync(required('--output'), `${JSON.stringify(plan, null, 2)}\n`)
console.log(
  `E2E ${plan.platform} [${plan.tier}] ${plan.shard.current}/${plan.shard.total}: ${plan.assignments[plan.shard.current - 1]!.length}/${new Set(tests.map((test) => test.file)).size} files; discovery ${plan.discoveryDigest}; ${plan.unknownFiles.length} unmeasured files use ${timings.defaultMs}ms`,
)

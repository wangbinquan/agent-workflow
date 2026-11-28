// RFC-611/623/629: only a complete, clean population matching the source SHA's
// approved CI (3/2/2 os-core, historical 3/3/4, or historical 3/4/4) or
// cross-OS nightly (0/3/4 pr-full) topology may update E2E weights.
import { YAML } from 'bun'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  assertSuccessfulTimingSource,
  CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES,
  E2E_CI_TIMING_SOURCES,
} from './refresh-backend-timings'
import { resolveCiWorkSource, resolveCrossOsNightlyE2ESource } from './workflow-source'
import {
  e2ePlatform,
  OS_CORE_E2E_SPECS,
  parseE2EShardPlan,
  parseE2ETimings,
  selectedE2ETests,
  type E2EPlatform,
  type E2ETier,
  type E2ETimings,
} from './e2e-shards'

export const E2E_SHARD_COUNTS = Object.freeze({ linux: 3, macos: 2, windows: 2 } as const)
export const CROSS_OS_NIGHTLY_E2E_SHARD_COUNTS = Object.freeze({
  linux: 0,
  macos: 3,
  windows: 4,
} as const)

export type E2ETimingSourceKind = 'ci' | 'cross-os-nightly'

export type E2EShardTopology =
  | Readonly<{ linux: 3; macos: 2; windows: 2 }>
  | Readonly<{ linux: 3; macos: 3 | 4; windows: 4 }>
  | Readonly<{ linux: 0; macos: 3; windows: 4 }>

export interface E2ETimingArtifact {
  name: string
  plan: unknown
  timings: unknown
}
export interface E2ETimingSource {
  runId: number
  sourceSha: string
  finalAttempt: number
  repository: string
  shardCounts: E2EShardTopology
  sourceWorkflow?: 'CI' | 'e2e-cross-os-nightly'
}
/** Valid evidence can be unsuitable for weights without being a collector failure. */
export class IneligibleE2ETimingSampleError extends Error {
  constructor(readonly retriedFiles: string[]) {
    super(`E2E timing refresh skipped: ${retriedFiles.length} files contain retries`)
    this.name = 'IneligibleE2ETimingSampleError'
  }
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}
const positive = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error('Expected a finite positive duration')
  return value
}

const SORTED_OS_CORE_SPECS = [...OS_CORE_E2E_SPECS].sort((a, b) => a.localeCompare(b))

function isPartialOsCoreCiTopology(counts: E2EShardTopology): boolean {
  return counts.linux === 3 && counts.macos === 2 && counts.windows === 2
}

function isCrossOsNightlyTopology(counts: E2EShardTopology): boolean {
  return counts.linux === 0 && counts.macos === 3 && counts.windows === 4
}

function expectedTierForPlatform(counts: E2EShardTopology, platform: E2EPlatform): E2ETier {
  if (isPartialOsCoreCiTopology(counts) && (platform === 'macos' || platform === 'windows')) {
    return 'os-core'
  }
  return 'pr-full'
}

function readE2EShardCounts(value: unknown): E2EShardTopology {
  const counts = object(value)
  if (JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify(['linux', 'macos', 'windows']))
    throw new Error('Source E2E shard topology must be 3/2/2, 0/3/4, or historical 3/3/4 or 3/4/4')
  const { linux, macos, windows } = counts
  if (linux === 3 && macos === 2 && windows === 2) {
    return Object.freeze({ linux: 3, macos: 2, windows: 2 } as const)
  }
  if (linux === 3 && (macos === 3 || macos === 4) && windows === 4) {
    return Object.freeze({ linux: 3, macos, windows: 4 } as const)
  }
  if (linux === 0 && macos === 3 && windows === 4) {
    return Object.freeze({ linux: 0, macos: 3, windows: 4 } as const)
  }
  throw new Error('Source E2E shard topology must be 3/2/2, 0/3/4, or historical 3/3/4 or 3/4/4')
}

function readMatrixShardCount(
  jobs: Record<string, unknown>,
  job: string,
  os: string,
  allowedCounts: readonly number[],
): number {
  const definition = object(jobs[job])
  const matrix = object(object(definition.strategy).matrix)
  const count = Array.isArray(matrix.shards) ? matrix.shards[0] : undefined
  if (
    definition['runs-on'] !== '${{ matrix.os }}' ||
    JSON.stringify(Object.keys(matrix).sort()) !== JSON.stringify(['os', 'shard', 'shards']) ||
    !Array.isArray(matrix.os) ||
    matrix.os.length !== 1 ||
    matrix.os[0] !== os ||
    !Array.isArray(matrix.shards) ||
    matrix.shards.length !== 1 ||
    typeof count !== 'number' ||
    !allowedCounts.includes(count) ||
    !Array.isArray(matrix.shard) ||
    matrix.shard.length !== count ||
    !matrix.shard.every((index, offset) => index === offset + 1)
  )
    throw new Error(
      `Source ${job} matrix must retain its exact E2E platform and complete numeric shard population`,
    )
  return count
}

/** Read the source SHA's actual CI matrix; never infer its topology from artifacts. */
export function assertE2EShardTopology(workflow: string): E2EShardTopology {
  const jobs = object(object(YAML.parse(workflow)).jobs)
  const counts = {
    linux: readMatrixShardCount(jobs, 'e2e', 'ubuntu-24.04', [3]),
    macos: readMatrixShardCount(jobs, 'e2e-macos', 'macos-latest', [2, 3, 4]),
    windows: readMatrixShardCount(jobs, 'e2e-windows', 'windows-latest', [2, 4]),
  }
  return readE2EShardCounts(counts)
}

/** Read the source SHA's cross-OS nightly E2E matrix (`0/3/4`). */
export function assertCrossOsNightlyE2ETopology(workflow: string): E2EShardTopology {
  const jobs = object(object(YAML.parse(workflow)).jobs)
  const counts = {
    linux: 0,
    macos: readMatrixShardCount(jobs, 'e2e-macos-full', 'macos-latest', [3]),
    windows: readMatrixShardCount(jobs, 'e2e-windows-full', 'windows-latest', [4]),
  }
  return readE2EShardCounts(counts)
}

export function mergeE2ETimings(
  artifacts: readonly E2ETimingArtifact[],
  source: E2ETimingSource,
  defaultMs = 60_000,
  mergeBase?: E2ETimings,
) {
  if (
    !Number.isSafeInteger(source.runId) ||
    source.runId <= 0 ||
    typeof source.sourceSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(source.sourceSha) ||
    !Number.isSafeInteger(source.finalAttempt) ||
    source.finalAttempt < 1
  )
    throw new Error('Invalid E2E timing source')
  const shardCounts = readE2EShardCounts(source.shardCounts)
  const partialCi = isPartialOsCoreCiTopology(shardCounts)
  const crossOsNightly = isCrossOsNightlyTopology(shardCounts)
  const requiresMergeBase = partialCi || crossOsNightly
  if (requiresMergeBase && mergeBase === undefined) {
    throw new Error(
      'Partial E2E timing refresh (3/2/2 os-core or 0/3/4 cross-OS nightly) requires --merge-base to preserve unmeasured entries',
    )
  }
  const validatedBase = mergeBase === undefined ? undefined : parseE2ETimings(mergeBase)
  positive(defaultMs)
  const expectedArtifacts = Object.values(shardCounts).reduce<number>(
    (sum, count) => sum + count,
    0,
  )
  if (artifacts.length !== expectedArtifacts)
    throw new Error(`Expected all ${expectedArtifacts} E2E timing artifacts`)
  const measuredPlatforms: E2ETimings['platforms'] = { linux: {}, macos: {}, windows: {} }
  const seen = new Set<string>()
  const populations = new Map<
    E2EPlatform,
    { digest: string; assignments: string; tests: number; tier: E2ETier }
  >()
  const attempts: Record<string, number> = {}
  const retriedFiles = new Set<string>()
  for (const artifact of artifacts) {
    const match = /^e2e-test-timings-(Linux|macOS|Windows)-(\d+)$/.exec(artifact.name)
    if (!match) throw new Error(`Unexpected E2E artifact name: ${artifact.name}`)
    if (seen.has(artifact.name)) throw new Error(`Duplicate E2E artifact: ${artifact.name}`)
    seen.add(artifact.name)
    const platform = e2ePlatform(match[1]!)
    const current = Number(match[2])
    const expectedTotal = shardCounts[platform]
    if (expectedTotal === 0)
      throw new Error(`Unexpected ${platform} E2E artifact for topology: ${artifact.name}`)
    const plan = parseE2EShardPlan(artifact.plan)
    const expectedTier = expectedTierForPlatform(shardCounts, platform)
    if (
      plan.platform !== platform ||
      plan.tier !== expectedTier ||
      plan.shard.current !== current ||
      plan.shard.total !== expectedTotal ||
      plan.sourceSha !== source.sourceSha
    )
      throw new Error(
        `E2E artifact plan does not match its source/platform/tier/shard: ${artifact.name}`,
      )
    const population = {
      digest: plan.discoveryDigest,
      assignments: JSON.stringify(plan.assignments),
      tests: plan.tests.length,
      tier: plan.tier,
    }
    const prior = populations.get(platform)
    if (
      prior &&
      (prior.digest !== population.digest ||
        prior.assignments !== population.assignments ||
        prior.tier !== population.tier)
    )
      throw new Error(`E2E ${platform} shards disagree on discovery, tier or assignments`)
    populations.set(platform, population)
    const timing = object(artifact.timings)
    const shard = object(timing.shard)
    const attempt =
      typeof timing.runAttempt === 'string' && /^\d+$/.test(timing.runAttempt)
        ? Number(timing.runAttempt)
        : NaN
    if (
      timing.version !== 1 ||
      timing.measurement !== 'first-test-begin-to-last-test-end-per-spec' ||
      timing.sourceSha !== source.sourceSha ||
      timing.runId !== String(source.runId) ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > source.finalAttempt ||
      timing.platform !== platform ||
      shard.current !== current ||
      shard.total !== expectedTotal ||
      timing.discoveryDigest !== plan.discoveryDigest ||
      timing.status !== 'passed' ||
      timing.complete !== true
    )
      throw new Error(`Incomplete or foreign E2E timing evidence: ${artifact.name}`)
    attempts[artifact.name] = attempt
    const expected = selectedE2ETests(plan)
    const expectedById = new Map(expected.map((test) => [test.id, test]))
    if (!Array.isArray(timing.tests) || timing.tests.length !== expected.length)
      throw new Error(`Missing E2E test results: ${artifact.name}`)
    const testIds = new Set<string>()
    const fileResults = new Map<string, { attempts: number; clean: boolean }>()
    for (const entry of timing.tests) {
      const test = object(entry)
      const original = typeof test.id === 'string' ? expectedById.get(test.id) : undefined
      if (
        !original ||
        testIds.has(original.id) ||
        test.file !== original.file ||
        test.expectedStatus !== original.expectedStatus ||
        !Array.isArray(test.results) ||
        test.results.length === 0
      )
        throw new Error(`Duplicate, omitted or foreign E2E test: ${artifact.name}`)
      testIds.add(original.id)
      const fileResult = fileResults.get(original.file) ?? { attempts: 0, clean: true }
      let hasExpected = false
      let hasUnexpected = false
      for (const [retry, entry] of test.results.entries()) {
        const result = object(entry)
        if (
          result.retry !== retry ||
          typeof result.status !== 'string' ||
          !['passed', 'failed', 'timedOut', 'skipped'].includes(result.status)
        )
          throw new Error(`Invalid E2E retry sequence or result: ${original.id}`)
        const expectedStatusMatch =
          result.status === original.expectedStatus || result.status === 'skipped'
        hasExpected ||= result.status === original.expectedStatus
        hasUnexpected ||= !expectedStatusMatch
        fileResult.attempts++
        fileResult.clean &&= retry === 0 && expectedStatusMatch
      }
      // Playwright computes outcome across all attempts. A serial sibling may
      // pass before a later retry fails, while failed -> skipped is unexpected.
      if (hasUnexpected && !hasExpected)
        throw new Error(`E2E test has an unexpected outcome: ${original.id}`)
      fileResults.set(original.file, fileResult)
    }
    const files = object(timing.files)
    const selectedFiles = plan.assignments[current - 1]!
    if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify([...selectedFiles].sort()))
      throw new Error(`E2E file measurements do not cover the planned shard: ${artifact.name}`)
    for (const file of selectedFiles) {
      if (Object.hasOwn(measuredPlatforms[platform], file))
        throw new Error(`Duplicate E2E file measurement: ${file}`)
      const evidence = object(files[file])
      const fileTests = expected.filter((test) => test.file === file)
      const runnable = fileTests.some((test) => test.expectedStatus !== 'skipped')
      const observed = fileResults.get(file)!
      if (
        evidence.complete !== true ||
        evidence.clean !== observed.clean ||
        evidence.attempts !== observed.attempts ||
        evidence.runnable !== runnable
      )
        throw new Error(`E2E file measurement is incomplete or inconsistent: ${file}`)
      const duration = positive(evidence.durationMs)
      if (!observed.clean) retriedFiles.add(`${platform}/${file}`)
      measuredPlatforms[platform][file] = runnable ? duration : 1
    }
  }
  for (const [platform, total] of Object.entries(shardCounts)) {
    const runner = platform === 'linux' ? 'Linux' : platform === 'macos' ? 'macOS' : 'Windows'
    for (let current = 1; current <= total; current++)
      if (!seen.has(`e2e-test-timings-${runner}-${current}`))
        throw new Error(`Missing E2E ${platform} shard ${current}`)
  }
  if (partialCi) {
    for (const platform of ['macos', 'windows'] as const) {
      const measuredFiles = Object.keys(measuredPlatforms[platform]).sort((a, b) =>
        a.localeCompare(b),
      )
      if (JSON.stringify(measuredFiles) !== JSON.stringify(SORTED_OS_CORE_SPECS)) {
        throw new Error(
          `OS-core E2E ${platform} measurements must match the exact ${SORTED_OS_CORE_SPECS.length}-spec OS_CORE_E2E_SPECS set`,
        )
      }
    }
  }
  // Validate every shard first: an earlier retry must not hide later corrupt,
  // incomplete or foreign evidence behind a neutral skip.
  if (retriedFiles.size) throw new IneligibleE2ETimingSampleError([...retriedFiles].sort())

  const platforms: E2ETimings['platforms'] = {
    linux: crossOsNightly ? { ...validatedBase!.platforms.linux } : measuredPlatforms.linux,
    macos: partialCi
      ? { ...validatedBase!.platforms.macos, ...measuredPlatforms.macos }
      : measuredPlatforms.macos,
    windows: partialCi
      ? { ...validatedBase!.platforms.windows, ...measuredPlatforms.windows }
      : measuredPlatforms.windows,
  }
  for (const platform of ['linux', 'macos', 'windows'] as const)
    platforms[platform] = Object.fromEntries(
      Object.entries(platforms[platform]).sort(([a], [b]) => a.localeCompare(b)),
    )
  return {
    version: 1 as const,
    defaultMs,
    provenance: {
      kind: 'controller-wall-clock',
      sourceWorkflow: source.sourceWorkflow ?? (crossOsNightly ? 'e2e-cross-os-nightly' : 'CI'),
      sourceRunId: source.runId,
      sourceSha: source.sourceSha,
      sourceUrl: `https://github.com/${source.repository}/actions/runs/${source.runId}`,
      finalRunAttempt: source.finalAttempt,
      shardAttempts: Object.fromEntries(
        Object.entries(attempts).sort(([a], [b]) => a.localeCompare(b)),
      ),
      sourceShardCounts: shardCounts,
      sourceTiers: Object.fromEntries(
        [...populations].map(([platform, data]) => [platform, data.tier]).sort(),
      ),
      mergedFromBase: validatedBase !== undefined,
      discoveryDigests: Object.fromEntries(
        [...populations].map(([platform, data]) => [platform, data.digest]).sort(),
      ),
      sourceTestCounts: Object.fromEntries(
        [...populations].map(([platform, data]) => [platform, data.tests]).sort(),
      ),
      measurement: 'first-test-begin-to-last-test-end-per-spec',
      limitations:
        'Includes spec hooks; excludes module discovery, worker startup and shared global setup/teardown. Concurrent worker load remains part of observed wall-clock. Only complete, clean, unretried files are accepted; fully skipped files retain a 1ms scheduling weight.',
    },
    platforms,
  }
}

export function writeE2ETimingReview(
  artifacts: readonly E2ETimingArtifact[],
  source: E2ETimingSource,
  output: string,
  mergeBase?: E2ETimings,
): 'updated' | 'skipped' {
  const destination = resolve(output)
  let result: ReturnType<typeof mergeE2ETimings>
  try {
    result = mergeE2ETimings(artifacts, source, 60_000, mergeBase)
  } catch (error) {
    if (!(error instanceof IneligibleE2ETimingSampleError)) throw error
    // Never let an old output be uploaded as if this skipped sample refreshed it.
    if (existsSync(destination)) throw new Error(`Refusing stale timing output: ${destination}`)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(
      `${destination}.status.json`,
      `${JSON.stringify(
        { status: 'skipped', reason: 'retried-tests', source, retriedFiles: error.retriedFiles },
        null,
        2,
      )}\n`,
    )
    console.log(`::notice::${error.message}; existing scheduling weights are unchanged.`)
    return 'skipped'
  }
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(
    `${destination}.status.json`,
    `${JSON.stringify({ status: 'updated', source }, null, 2)}\n`,
  )
  console.log(JSON.stringify(result.provenance, null, 2))
  return 'updated'
}

export function parseRefreshE2ETimingsArgs(args: readonly string[]): {
  sourceKind: E2ETimingSourceKind
  mergeBasePath?: string
  directory: string
  runId: number
  output: string
} {
  let sourceKind: E2ETimingSourceKind = 'ci'
  let mergeBasePath: string | undefined
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--source') {
      const value = args[++index]
      if (value !== 'ci' && value !== 'cross-os-nightly')
        throw new Error(`Invalid --source value: ${value ?? '(missing)'}`)
      sourceKind = value
    } else if (arg.startsWith('--source=')) {
      const value = arg.slice('--source='.length)
      if (value !== 'ci' && value !== 'cross-os-nightly')
        throw new Error(`Invalid --source value: ${value}`)
      sourceKind = value
    } else if (arg === '--merge-base') {
      const value = args[++index]
      if (!value) throw new Error('Missing --merge-base path')
      mergeBasePath = value
    } else if (arg.startsWith('--merge-base=')) {
      const value = arg.slice('--merge-base='.length)
      if (!value) throw new Error('Missing --merge-base path')
      mergeBasePath = value
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  const [directory, runArgument, output] = positional
  if (
    positional.length !== 3 ||
    !directory ||
    !runArgument ||
    !/^\d+$/.test(runArgument) ||
    !output
  )
    throw new Error(
      'Usage: bun scripts/ci/refresh-e2e-timings.ts [--source=ci|cross-os-nightly] [--merge-base FILE] ARTIFACTS_DIR RUN_ID OUTPUT_JSON',
    )
  return { sourceKind, mergeBasePath, directory, runId: Number(runArgument), output }
}

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr}`)
  return result.stdout
}
if (import.meta.main) {
  const { sourceKind, mergeBasePath, directory, runId, output } = parseRefreshE2ETimingsArgs(
    process.argv.slice(2),
  )
  const repository = process.env.GITHUB_REPOSITORY ?? 'wangbinquan/agent-workflow'
  const run: unknown = JSON.parse(
    command('gh', ['api', `repos/${repository}/actions/runs/${runId}`]),
  )
  const allowedSources =
    sourceKind === 'cross-os-nightly' ? CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES : E2E_CI_TIMING_SOURCES
  const sourceSha = assertSuccessfulTimingSource(run, repository, runId, allowedSources)
  const readSourceFile = (path: string) => command('git', ['show', `${sourceSha}:${path}`])
  const shardCounts =
    sourceKind === 'cross-os-nightly'
      ? assertCrossOsNightlyE2ETopology(resolveCrossOsNightlyE2ESource(readSourceFile).workflow)
      : assertE2EShardTopology(resolveCiWorkSource(readSourceFile).workflow)
  const mergeBase =
    mergeBasePath === undefined
      ? undefined
      : parseE2ETimings(JSON.parse(readFileSync(mergeBasePath, 'utf8')))
  const artifacts = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('e2e-test-timings-'))
    .map((entry) => ({
      name: entry.name,
      plan: JSON.parse(
        readFileSync(join(directory, entry.name, 'e2e-shard-plan.json'), 'utf8'),
      ) as unknown,
      timings: JSON.parse(
        readFileSync(join(directory, entry.name, 'e2e-timings.json'), 'utf8'),
      ) as unknown,
    }))
  writeE2ETimingReview(
    artifacts,
    {
      runId,
      repository,
      sourceSha,
      finalAttempt: Number(object(run).run_attempt),
      shardCounts,
      sourceWorkflow: sourceKind === 'cross-os-nightly' ? 'e2e-cross-os-nightly' : 'CI',
    },
    output,
    mergeBase,
  )
}

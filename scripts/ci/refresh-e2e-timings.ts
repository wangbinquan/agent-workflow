// RFC-611/623: only a complete, clean population matching the source SHA's
// approved 3/3/4 or historical 3/4/4 topology may replace E2E weights.
import { YAML } from 'bun'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assertSuccessfulTimingSource } from './refresh-backend-timings'
import { resolveCiWorkSource } from './workflow-source'
import {
  e2ePlatform,
  parseE2EShardPlan,
  selectedE2ETests,
  type E2EPlatform,
  type E2ETimings,
} from './e2e-shards'

export const E2E_SHARD_COUNTS = Object.freeze({ linux: 3, macos: 3, windows: 4 } as const)
export type E2EShardTopology = Readonly<{ linux: 3; macos: 3 | 4; windows: 4 }>
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

function readE2EShardCounts(value: unknown): E2EShardTopology {
  const counts = object(value)
  if (
    JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify(['linux', 'macos', 'windows']) ||
    counts.linux !== 3 ||
    (counts.macos !== 3 && counts.macos !== 4) ||
    counts.windows !== 4
  )
    throw new Error('Source E2E shard topology must be exactly 3/3/4 or historical 3/4/4')
  // Do not retain a caller-owned mutable object in the resulting provenance.
  return Object.freeze({ linux: 3, macos: counts.macos, windows: 4 } as const)
}

/** Read the source SHA's actual matrix; never infer its topology from artifacts. */
export function assertE2EShardTopology(workflow: string): E2EShardTopology {
  const jobs = object(object(YAML.parse(workflow)).jobs)
  const counts: Record<string, unknown> = {}
  for (const [platform, job, os] of [
    ['linux', 'e2e', 'ubuntu-24.04'],
    ['macos', 'e2e-macos', 'macos-latest'],
    ['windows', 'e2e-windows', 'windows-latest'],
  ] as const) {
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
      (count !== 3 && count !== 4) ||
      !Array.isArray(matrix.shard) ||
      matrix.shard.length !== count ||
      !matrix.shard.every((index, offset) => index === offset + 1)
    )
      throw new Error(
        `Source ${job} matrix must retain its exact E2E platform and complete numeric shard population`,
      )
    counts[platform] = count
  }
  return readE2EShardCounts(counts)
}

export function mergeE2ETimings(
  artifacts: readonly E2ETimingArtifact[],
  source: E2ETimingSource,
  defaultMs = 60_000,
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
  positive(defaultMs)
  const expectedArtifacts = Object.values(shardCounts).reduce<number>(
    (sum, count) => sum + count,
    0,
  )
  if (artifacts.length !== expectedArtifacts)
    throw new Error(`Expected all ${expectedArtifacts} E2E timing artifacts`)
  const platforms: E2ETimings['platforms'] = { linux: {}, macos: {}, windows: {} }
  const seen = new Set<string>()
  const populations = new Map<E2EPlatform, { digest: string; assignments: string; tests: number }>()
  const attempts: Record<string, number> = {}
  const retriedFiles = new Set<string>()
  for (const artifact of artifacts) {
    const match = /^e2e-test-timings-(Linux|macOS|Windows)-(\d+)$/.exec(artifact.name)
    if (!match) throw new Error(`Unexpected E2E artifact name: ${artifact.name}`)
    if (seen.has(artifact.name)) throw new Error(`Duplicate E2E artifact: ${artifact.name}`)
    seen.add(artifact.name)
    const platform = e2ePlatform(match[1]!)
    const current = Number(match[2])
    const plan = parseE2EShardPlan(artifact.plan)
    if (
      plan.platform !== platform ||
      plan.shard.current !== current ||
      plan.shard.total !== shardCounts[platform] ||
      plan.sourceSha !== source.sourceSha
    )
      throw new Error(
        `E2E artifact plan does not match its source/platform/shard: ${artifact.name}`,
      )
    const population = {
      digest: plan.discoveryDigest,
      assignments: JSON.stringify(plan.assignments),
      tests: plan.tests.length,
    }
    const prior = populations.get(platform)
    if (
      prior &&
      (prior.digest !== population.digest || prior.assignments !== population.assignments)
    )
      throw new Error(`E2E ${platform} shards disagree on discovery or assignments`)
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
      shard.total !== shardCounts[platform] ||
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
        const expected = result.status === original.expectedStatus || result.status === 'skipped'
        hasExpected ||= result.status === original.expectedStatus
        hasUnexpected ||= !expected
        fileResult.attempts++
        fileResult.clean &&= retry === 0 && expected
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
      if (Object.hasOwn(platforms[platform], file))
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
      platforms[platform][file] = runnable ? duration : 1
    }
  }
  for (const [platform, total] of Object.entries(shardCounts)) {
    const runner = platform === 'linux' ? 'Linux' : platform === 'macos' ? 'macOS' : 'Windows'
    for (let current = 1; current <= total; current++)
      if (!seen.has(`e2e-test-timings-${runner}-${current}`))
        throw new Error(`Missing E2E ${platform} shard ${current}`)
  }
  // Validate every shard first: an earlier retry must not hide later corrupt,
  // incomplete or foreign evidence behind a neutral skip.
  if (retriedFiles.size) throw new IneligibleE2ETimingSampleError([...retriedFiles].sort())
  for (const platform of ['linux', 'macos', 'windows'] as const)
    platforms[platform] = Object.fromEntries(
      Object.entries(platforms[platform]).sort(([a], [b]) => a.localeCompare(b)),
    )
  return {
    version: 1 as const,
    defaultMs,
    provenance: {
      kind: 'controller-wall-clock',
      sourceRunId: source.runId,
      sourceSha: source.sourceSha,
      sourceUrl: `https://github.com/${source.repository}/actions/runs/${source.runId}`,
      finalRunAttempt: source.finalAttempt,
      shardAttempts: Object.fromEntries(
        Object.entries(attempts).sort(([a], [b]) => a.localeCompare(b)),
      ),
      sourceShardCounts: shardCounts,
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
): 'updated' | 'skipped' {
  const destination = resolve(output)
  let result: ReturnType<typeof mergeE2ETimings>
  try {
    result = mergeE2ETimings(artifacts, source)
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

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr}`)
  return result.stdout
}
if (import.meta.main) {
  const [directory, runArgument, output] = process.argv.slice(2)
  if (!directory || !runArgument || !/^\d+$/.test(runArgument) || !output)
    throw new Error('Usage: bun scripts/ci/refresh-e2e-timings.ts ARTIFACTS_DIR RUN_ID OUTPUT_JSON')
  const runId = Number(runArgument)
  const repository = process.env.GITHUB_REPOSITORY ?? 'wangbinquan/agent-workflow'
  const run: unknown = JSON.parse(
    command('gh', ['api', `repos/${repository}/actions/runs/${runId}`]),
  )
  const sourceSha = assertSuccessfulTimingSource(run, repository, runId)
  const sourceDefinition = resolveCiWorkSource((path) =>
    command('git', ['show', `${sourceSha}:${path}`]),
  )
  const shardCounts = assertE2EShardTopology(sourceDefinition.workflow)
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
    { runId, repository, sourceSha, finalAttempt: Number(object(run).run_attempt), shardCounts },
    output,
  )
}

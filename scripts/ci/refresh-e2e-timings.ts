// RFC-611: only a complete, clean 3/4/4 main-CI population may replace E2E weights.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assertSuccessfulTimingSource } from './refresh-backend-timings'
import {
  e2ePlatform,
  parseE2EShardPlan,
  selectedE2ETests,
  type E2EPlatform,
  type E2ETimings,
} from './e2e-shards'

export const E2E_SHARD_COUNTS = { linux: 3, macos: 4, windows: 4 } as const
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

/** Fail closed if the source workflow changes the agreed platform/shard contract. */
export function assertE2EShardTopology(workflow: string): void {
  for (const [platform, job, osPrefix] of [
    ['linux', 'e2e', 'ubuntu-'],
    ['macos', 'e2e-macos', 'macos-'],
    ['windows', 'e2e-windows', 'windows-'],
  ] as const) {
    const section = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[a-zA-Z][\w-]*:\n/)[0]
    const count = Number(section?.match(/\n\s+shards: \[(\d+)\]/)?.[1])
    const indices = section
      ?.match(/\n\s+shard: \[([\d, ]+)\]/)?.[1]
      ?.split(',')
      .map((s) => Number(s.trim()))
    const os = section?.match(/\n\s+os: \[([^\]]+)\]/)?.[1]
    if (
      count !== E2E_SHARD_COUNTS[platform] ||
      !os?.startsWith(osPrefix) ||
      os.includes(',') ||
      JSON.stringify(indices) !== JSON.stringify(Array.from({ length: count }, (_, i) => i + 1))
    )
      throw new Error(
        `Source ${job} matrix must retain the E2E ${platform} ${E2E_SHARD_COUNTS[platform]}-shard contract`,
      )
  }
}

export function mergeE2ETimings(
  artifacts: readonly E2ETimingArtifact[],
  source: E2ETimingSource,
  defaultMs = 60_000,
) {
  if (
    !Number.isSafeInteger(source.runId) ||
    source.runId <= 0 ||
    !/^[0-9a-f]{40}$/.test(source.sourceSha) ||
    !Number.isSafeInteger(source.finalAttempt) ||
    source.finalAttempt < 1
  )
    throw new Error('Invalid E2E timing source')
  positive(defaultMs)
  if (artifacts.length !== 11) throw new Error('Expected all 11 E2E timing artifacts')
  const platforms: E2ETimings['platforms'] = { linux: {}, macos: {}, windows: {} }
  const seen = new Set<string>()
  const populations = new Map<E2EPlatform, { digest: string; assignments: string; tests: number }>()
  const attempts: Record<string, number> = {}
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
      plan.shard.total !== E2E_SHARD_COUNTS[platform] ||
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
      shard.total !== E2E_SHARD_COUNTS[platform] ||
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
    for (const entry of timing.tests) {
      const test = object(entry)
      const original = typeof test.id === 'string' ? expectedById.get(test.id) : undefined
      if (
        !original ||
        testIds.has(original.id) ||
        test.file !== original.file ||
        test.expectedStatus !== original.expectedStatus ||
        !Array.isArray(test.results) ||
        test.results.length !== 1
      )
        throw new Error(`Duplicate, omitted, foreign or retried E2E test: ${artifact.name}`)
      testIds.add(original.id)
      const result = object(test.results[0])
      if (
        result.retry !== 0 ||
        (result.status !== original.expectedStatus && result.status !== 'skipped')
      )
        throw new Error(`E2E test result is not clean: ${original.id}`)
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
      if (
        evidence.complete !== true ||
        evidence.clean !== true ||
        evidence.attempts !== fileTests.length ||
        evidence.runnable !== runnable
      )
        throw new Error(`E2E file measurement is incomplete or retried: ${file}`)
      const duration = positive(evidence.durationMs)
      platforms[platform][file] = runnable ? duration : 1
    }
  }
  for (const [platform, total] of Object.entries(E2E_SHARD_COUNTS)) {
    const runner = platform === 'linux' ? 'Linux' : platform === 'macos' ? 'macOS' : 'Windows'
    for (let current = 1; current <= total; current++)
      if (!seen.has(`e2e-test-timings-${runner}-${current}`))
        throw new Error(`Missing E2E ${platform} shard ${current}`)
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
      sourceRunId: source.runId,
      sourceSha: source.sourceSha,
      sourceUrl: `https://github.com/${source.repository}/actions/runs/${source.runId}`,
      finalRunAttempt: source.finalAttempt,
      shardAttempts: Object.fromEntries(
        Object.entries(attempts).sort(([a], [b]) => a.localeCompare(b)),
      ),
      sourceShardCounts: E2E_SHARD_COUNTS,
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
  assertE2EShardTopology(command('git', ['show', `${sourceSha}:.github/workflows/ci.yml`]))
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
  const result = mergeE2ETimings(artifacts, {
    runId,
    repository,
    sourceSha,
    finalAttempt: Number(object(run).run_attempt),
  })
  const destination = resolve(output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result.provenance, null, 2))
}

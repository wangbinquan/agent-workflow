// RFC-611: partition Playwright's own discovered tests by complete spec file.
// This module never discovers tests or runs a second test engine.
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

export type E2EPlatform = 'linux' | 'macos' | 'windows'
export type E2ETier = 'pr-full' | 'os-core'

/**
 * RFC-629: single-source authoritative OS-core E2E spec list (19 specs) executed on every
 * code push on macOS (2 shards) and Windows (2 shards). Linux always executes the complete
 * pr-full suite on every push, and macOS/Windows run the complete pr-full suite daily in
 * `e2e-cross-os-nightly.yml`.
 */
export const OS_CORE_E2E_SPECS = Object.freeze([
  'e2e/main.spec.ts',
  'e2e/system-mocks.spec.ts',
  'e2e/crash-recovery.spec.ts',
  'e2e/ops-local-recovery.spec.ts',
  'e2e/rfc294-human-gate-restart.spec.ts',
  'e2e/rfc294-webhook-runtime-failures.spec.ts',
  'e2e/webhook-mr-runtime-races.spec.ts',
  'e2e/task-lifecycle-states.spec.ts',
  'e2e/runtime-scenario-matrix.spec.ts',
  'e2e/commit-push.spec.ts',
  'e2e/commit-push-rejection.spec.ts',
  'e2e/rfc319-worktree-and-commit.spec.ts',
  'e2e/rfc321-code-push-credentials.spec.ts',
  'e2e/repo-group-launch.spec.ts',
  'e2e/repo-governance.spec.ts',
  'e2e/rfc253-script-node.spec.ts',
  'e2e/rfc264-unicode-names.spec.ts',
  'e2e/rfc396-graph-care-repair.spec.ts',
  'e2e/rfc319-canvas-editing-ops.spec.ts',
] as const)

const OS_CORE_E2E_SPEC_SET: ReadonlySet<string> = new Set(OS_CORE_E2E_SPECS)

export interface DiscoveredE2ETest {
  id: string
  file: string
  expectedStatus: string
}
export interface E2ETimings {
  version: 1
  defaultMs: number
  platforms: Record<E2EPlatform, Record<string, number>>
}
export interface E2EShardPlan {
  version: 1
  tier: E2ETier
  platform: E2EPlatform
  sourceSha: string | null
  shard: { current: number; total: number }
  discoveryDigest: string
  tests: DiscoveredE2ETest[]
  assignments: string[][]
  estimatedShardMs: number[]
  unknownFiles: string[]
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new Error('Expected a nonempty string')
  return value
}
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Expected a JSON array')
  return value
}
const positive = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error('Expected a finite positive duration')
  return value
}
export function e2ePlatform(value: string): E2EPlatform {
  if (value === 'Linux' || value === 'linux') return 'linux'
  if (value === 'macOS' || value === 'macos') return 'macos'
  if (value === 'Windows' || value === 'windows') return 'windows'
  throw new Error(`Unknown E2E platform: ${value}`)
}
export function parseE2ETier(value: string): E2ETier {
  if (value === 'pr-full' || value === 'os-core') return value
  throw new Error(`Unknown E2E tier: ${value}`)
}
export function filterE2EDiscoveryByTier(
  discovered: DiscoveredE2ETest[],
  tier: E2ETier,
): DiscoveredE2ETest[] {
  const canonical = canonicalTests(discovered)
  if (tier === 'pr-full') return canonical
  const discoveredFiles = new Set(canonical.map((test) => e2eSpecPath(test.file)))
  const missing = OS_CORE_E2E_SPECS.filter((spec) => !discoveredFiles.has(spec))
  if (missing.length > 0) {
    throw new Error(
      `OS-core E2E discovery is missing ${missing.length} required spec(s): ${missing.join(', ')}`,
    )
  }
  return canonicalTests(canonical.filter((test) => OS_CORE_E2E_SPEC_SET.has(test.file)))
}
export function e2eSpecPath(value: string): string {
  const path = value.replaceAll('\\', '/')
  if (
    !path.startsWith('e2e/') ||
    !path.endsWith('.spec.ts') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Not a repository-relative E2E spec: ${value}`)
  return path
}
export function relativeE2ESpec(repoRoot: string, absolute: string): string {
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(repoRoot) ? win32 : posix
  return e2eSpecPath(paths.relative(repoRoot, absolute))
}
export function discoveryDigest(tests: DiscoveredE2ETest[]): string {
  return createHash('sha256').update(JSON.stringify(tests)).digest('hex')
}
function canonicalTests(tests: DiscoveredE2ETest[]): DiscoveredE2ETest[] {
  const sorted = [...tests].sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id))
  if (!sorted.length) throw new Error('Playwright discovery is empty')
  if (new Set(sorted.map((test) => test.id)).size !== sorted.length)
    throw new Error('Playwright discovery contains duplicate test identities')
  return sorted
}

/** JSON comes from `playwright test --list --reporter=json`, with the same grep as execution. */
export function parseE2EDiscovery(value: unknown, repoRoot: string): DiscoveredE2ETest[] {
  const report = object(value)
  if (array(report.errors).length) throw new Error('Playwright discovery reported errors')
  const config = object(report.config)
  if (config.shard) throw new Error('Discovery must not use native sharding')
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(repoRoot) ? win32 : posix
  const reportRoot = text(config.rootDir)
  if (!paths.isAbsolute(reportRoot)) throw new Error('Playwright rootDir must be absolute')
  const tests: DiscoveredE2ETest[] = []
  const visit = (value: unknown) => {
    const suite = object(value)
    for (const value of array(suite.specs)) {
      const spec = object(value)
      const entries = array(spec.tests)
      if (entries.length !== 1 || object(entries[0]).projectName !== 'chromium')
        throw new Error('The main CI discovery must contain chromium only, exactly once')
      const test = object(entries[0])
      if (array(test.results).length)
        throw new Error('Expected discovery, not an executed test report')
      tests.push({
        id: text(spec.id),
        file: relativeE2ESpec(repoRoot, paths.resolve(reportRoot, text(spec.file))),
        expectedStatus: text(test.expectedStatus),
      })
    }
    for (const child of array(suite.suites ?? [])) visit(child)
  }
  for (const suite of array(report.suites)) visit(suite)
  return canonicalTests(tests)
}

export function parseE2ETimings(value: unknown): E2ETimings {
  const data = object(value)
  if (data.version !== 1) throw new Error('Unsupported E2E timings version')
  const sources = object(data.platforms)
  const platforms = {} as E2ETimings['platforms']
  for (const platform of ['linux', 'macos', 'windows'] as const) {
    platforms[platform] = Object.fromEntries(
      Object.entries(object(sources[platform])).map(([file, ms]) => [
        e2eSpecPath(file),
        positive(ms),
      ]),
    )
  }
  return { version: 1, defaultMs: positive(data.defaultMs), platforms }
}

export function planE2EShards(
  discovered: DiscoveredE2ETest[],
  timings: E2ETimings,
  platform: E2EPlatform,
  current: number,
  total: number,
  sourceSha: string | null = null,
  tier: E2ETier = 'pr-full',
): E2EShardPlan {
  if (
    !Number.isInteger(total) ||
    total < 1 ||
    !Number.isInteger(current) ||
    current < 1 ||
    current > total
  )
    throw new Error('Invalid E2E shard N/M')
  parseE2ETier(tier)
  const tests = canonicalTests(discovered)
  const files = [...new Set(tests.map((test) => e2eSpecPath(test.file)))]
  if (files.length < total) throw new Error('More E2E shards than discovered files')
  const unknownFiles: string[] = []
  const weighted = files.map((file) => {
    // A fully skipped spec still belongs to exactly one shard; it has no worker workload.
    const skipped = tests
      .filter((test) => test.file === file)
      .every((test) => test.expectedStatus === 'skipped')
    const known = timings.platforms[platform][file]
    if (known === undefined && !skipped) unknownFiles.push(file)
    return { file, ms: skipped ? 1 : (known ?? timings.defaultMs) }
  })
  weighted.sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file))
  const assignments: string[][] = Array.from({ length: total }, () => [])
  const estimatedShardMs = Array.from({ length: total }, () => 0)
  for (const { file, ms } of weighted) {
    let index = 0
    for (let candidate = 1; candidate < total; candidate++)
      if (estimatedShardMs[candidate]! < estimatedShardMs[index]!) index = candidate
    assignments[index]!.push(file)
    estimatedShardMs[index]! += ms
  }
  for (const files of assignments) files.sort()
  return {
    version: 1,
    tier,
    platform,
    sourceSha,
    shard: { current, total },
    discoveryDigest: discoveryDigest(tests),
    tests,
    assignments,
    estimatedShardMs,
    unknownFiles: unknownFiles.sort(),
  }
}

export function parseE2EShardPlan(value: unknown): E2EShardPlan {
  const data = object(value)
  if (data.version !== 1) throw new Error('Unsupported E2E shard plan version')
  const tier: E2ETier = data.tier === undefined ? 'pr-full' : parseE2ETier(text(data.tier))
  const shard = object(data.shard)
  const current = positive(shard.current)
  const total = positive(shard.total)
  if (!Number.isInteger(current) || !Number.isInteger(total) || current > total)
    throw new Error('Invalid E2E shard N/M')
  const tests = canonicalTests(
    array(data.tests).map((value) => {
      const test = object(value)
      return {
        id: text(test.id),
        file: e2eSpecPath(text(test.file)),
        expectedStatus: text(test.expectedStatus),
      }
    }),
  )
  if (data.discoveryDigest !== discoveryDigest(tests))
    throw new Error('E2E discovery digest mismatch')
  const assignments = array(data.assignments).map((files) =>
    array(files).map((file) => e2eSpecPath(text(file))),
  )
  const assigned = assignments.flat()
  const discoveredFiles = [...new Set(tests.map((test) => test.file))].sort()
  if (
    assignments.length !== total ||
    assignments.some((files) => files.length === 0) ||
    assigned.length !== new Set(assigned).size ||
    JSON.stringify([...assigned].sort()) !== JSON.stringify(discoveredFiles)
  )
    throw new Error('E2E assignments must be a complete, disjoint partition of discovered files')
  const estimatedShardMs = array(data.estimatedShardMs).map(positive)
  if (estimatedShardMs.length !== total) throw new Error('E2E shard duration count mismatch')
  const unknownFiles = array(data.unknownFiles).map((file) => e2eSpecPath(text(file)))
  if (unknownFiles.some((file) => !discoveredFiles.includes(file)))
    throw new Error('Unknown timing path is outside discovery')
  return {
    version: 1,
    tier,
    platform: e2ePlatform(text(data.platform)),
    sourceSha: data.sourceSha === null ? null : text(data.sourceSha),
    shard: { current, total },
    discoveryDigest: discoveryDigest(tests),
    tests,
    assignments,
    estimatedShardMs,
    unknownFiles,
  }
}

export function selectedE2ETests(plan: E2EShardPlan): DiscoveredE2ETest[] {
  const files = new Set(plan.assignments[plan.shard.current - 1])
  return plan.tests.filter((test) => files.has(test.file))
}
export function assertE2ESelection(plan: E2EShardPlan, actualIds: string[]): void {
  const expected = selectedE2ETests(plan)
    .map((test) => test.id)
    .sort()
  if (JSON.stringify([...actualIds].sort()) !== JSON.stringify(expected))
    throw new Error(
      'Actual Playwright tests differ from the planned shard; refusing incomplete or duplicated coverage',
    )
}
export const EXPECTED_E2E_WORKERS: Readonly<Record<E2EPlatform, number>> = Object.freeze({
  linux: 4,
  macos: 3,
  windows: 4,
})

export function parseConfiguredE2EWorkers(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  if (!/^[1-8]$/.test(raw))
    throw new Error(`Invalid AW_E2E_WORKERS '${raw}': expected an integer from 1 to 8`)
  return Number(raw)
}

export function assertE2ERuntimeSelection(
  plan: E2EShardPlan,
  actualIds: string[],
  config: { shard: unknown; workers: number; fullyParallel: boolean },
): void {
  if (config.shard) throw new Error('Do not combine a duration plan with native --shard')
  const expectedWorkers = EXPECTED_E2E_WORKERS[plan.platform]
  if (config.workers !== expectedWorkers || config.fullyParallel)
    throw new Error(
      `The main E2E plan for ${plan.platform} requires ${expectedWorkers} workers and file-local sequential execution`,
    )
  assertE2ESelection(plan, actualIds)
}
/** Regex matching avoids glob metacharacters in otherwise legitimate filenames. */
export function exactE2EMatch(absolutePath: string): RegExp {
  return new RegExp(
    `^${absolutePath
      .split(/[\\/]/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\\\/]')}$`,
  )
}

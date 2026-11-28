// RFC-611 / RFC-627: merge measured whole-file durations without publishing partial or invented weights.
// Zero third-party dependencies: runs directly under Bun in no-install CI jobs.
import { YAML } from 'bun'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  BACKEND_CORE_SHARDS,
  BACKEND_FULL_SHARDS,
  BACKEND_TEST_PATH_PATTERN,
  LEGACY_BACKEND_CORE_SHARDS,
  filterBackendTestsByTier,
  isValidBackendTestPath,
} from './backend-shards'
import {
  BACKEND_FULL_NIGHTLY_PATH,
  CI_WORKFLOW_PATH,
  resolveCiWorkSource,
  resolveNightlyBackendSource,
} from './workflow-source'

export type BackendTimingTier = 'core' | 'all'

export interface TimingSourceRule {
  readonly workflowName: string
  readonly allowedEvents: readonly string[]
}

export const LEGACY_CI_TIMING_SOURCES: readonly TimingSourceRule[] = Object.freeze([
  { workflowName: 'CI', allowedEvents: ['push'] },
])

export const CORE_CI_TIMING_SOURCES: readonly TimingSourceRule[] = Object.freeze([
  { workflowName: 'CI', allowedEvents: ['push', 'workflow_dispatch'] },
])

export const ALL_BACKEND_TIMING_SOURCES: readonly TimingSourceRule[] = Object.freeze([
  { workflowName: 'backend-full-nightly', allowedEvents: ['schedule', 'workflow_dispatch'] },
  { workflowName: 'CI', allowedEvents: ['push'] },
])

export const E2E_CI_TIMING_SOURCES: readonly TimingSourceRule[] = Object.freeze([
  { workflowName: 'CI', allowedEvents: ['push', 'workflow_dispatch'] },
])

export const CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES: readonly TimingSourceRule[] = Object.freeze([
  { workflowName: 'e2e-cross-os-nightly', allowedEvents: ['schedule', 'workflow_dispatch'] },
])

export interface BackendTimings {
  version: 1
  files: Record<string, number>
}

export interface TimingShard {
  shard: number
  data: unknown
}

export interface BackendTimingProvenance {
  tier: BackendTimingTier
  sourceRun: number
  sourceSha: string
  sourceRepository: string
  sourceWorkflowPath: string
  finalRunAttempt: number
  sourceShards: number
  sourceFiles: number
  measuredMilliseconds: number
}

export interface BackendTimingSource {
  timings: BackendTimings
  expectedFiles: readonly string[]
  provenance: BackendTimingProvenance
}

export interface BackendTimingSourceRequest {
  artifactsDirectory: string
  runId: number
  repository: string
  tier?: BackendTimingTier
}

export interface BackendTimingSourceReader {
  readRun(repository: string, runId: number): unknown
  readSourceFile(sourceSha: string, path: string): string
  readSourceTests(sourceSha: string): readonly string[]
  readShards(artifactsDirectory: string): readonly TimingShard[]
}

export function assertBackendTestPopulation(expectedFiles: readonly string[]): Set<string> {
  if (!Array.isArray(expectedFiles)) throw new Error('Source test population must be an array')
  const expected = new Set(expectedFiles)
  if (expected.size === 0 || expected.size !== expectedFiles.length)
    throw new Error('Source test population is empty or duplicated')
  for (const path of expected)
    if (typeof path !== 'string' || !isValidBackendTestPath(path))
      throw new Error(`Invalid source path: ${path}`)
  return expected
}

/** The source tree, not today's working tree, defines the required measurement population. */
export function mergeBackendTimings(
  shards: readonly TimingShard[],
  expectedFiles: readonly string[],
  shardCount: number,
): BackendTimings {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('Invalid shard count')
  if (shards.length !== shardCount) throw new Error(`Expected ${shardCount} timing shards`)
  const expected = assertBackendTestPopulation(expectedFiles)
  const indices = new Set<number>()
  const files = new Map<string, number>()
  for (const { shard, data } of shards) {
    if (!Number.isInteger(shard) || shard < 1 || shard > shardCount || indices.has(shard))
      throw new Error(`Invalid or duplicate shard: ${shard}`)
    indices.add(shard)
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new Error(`Invalid timing document in shard ${shard}`)
    const document = data as { version?: unknown; files?: unknown }
    if (
      document.version !== 1 ||
      document.files === null ||
      typeof document.files !== 'object' ||
      Array.isArray(document.files)
    )
      throw new Error(`Unsupported timing format in shard ${shard}`)
    for (const [path, ms] of Object.entries(document.files)) {
      if (!isValidBackendTestPath(path) || !expected.has(path))
        throw new Error(`Unexpected measured file: ${path}`)
      if (files.has(path)) throw new Error(`Duplicate measured file: ${path}`)
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
        throw new Error(`Invalid duration for ${path}`)
      files.set(path, ms)
    }
  }
  const missing = [...expected].filter((path) => !files.has(path))
  if (missing.length) throw new Error(`Missing source measurements: ${missing.join(', ')}`)
  return {
    version: 1,
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))),
  }
}

export function projectBackendTimings(measured: BackendTimings, currentFiles: readonly string[]) {
  const current = new Set(currentFiles)
  return {
    timings: {
      version: 1 as const,
      files: Object.fromEntries(
        Object.entries(measured.files).filter(([path]) => current.has(path)),
      ),
    },
    unmeasured: [...current].filter((path) => !(path in measured.files)).sort(),
    removed: Object.keys(measured.files)
      .filter((path) => !current.has(path))
      .sort(),
  }
}

export function assertSuccessfulTimingSource(
  value: unknown,
  repository: string,
  runId: number,
  allowedSources: readonly TimingSourceRule[] = LEGACY_CI_TIMING_SOURCES,
): string {
  const run = value as {
    id?: unknown
    name?: unknown
    status?: unknown
    conclusion?: unknown
    event?: unknown
    head_branch?: unknown
    head_sha?: unknown
    head_repository?: { full_name?: unknown }
  } | null
  const matchesAllowed =
    run !== null &&
    typeof run?.name === 'string' &&
    typeof run?.event === 'string' &&
    allowedSources.some(
      (rule) => rule.workflowName === run.name && rule.allowedEvents.includes(run.event as string),
    )
  if (
    !run ||
    !matchesAllowed ||
    run.id !== runId ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== repository ||
    typeof run.head_sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(run.head_sha)
  )
    throw new Error('Timing source must be a successful complete main CI run in this repository')
  return run.head_sha
}

interface ParsedWorkflowStep {
  name?: unknown
  if?: unknown
  uses?: unknown
  env?: Record<string, unknown>
  with?: Record<string, unknown>
}

interface ParsedWorkflowJob {
  env?: Record<string, unknown>
  strategy?: { matrix?: Record<string, unknown> }
  steps?: ParsedWorkflowStep[]
}

function parseWorkflowJob(workflow: string, jobId: string): ParsedWorkflowJob | null {
  try {
    const parsed = YAML.parse(workflow) as { jobs?: Record<string, ParsedWorkflowJob> } | null
    const job = parsed?.jobs?.[jobId]
    if (job && typeof job === 'object' && !Array.isArray(job)) return job
  } catch {
    // Fall through to legacy partial-snippet parser used by older unit fixtures.
  }
  return null
}

function jobHasSqliteProviderNarrowing(job: ParsedWorkflowJob | null): boolean {
  if (!job) return false
  if (job.env && String(job.env['AW_TEST_PROVIDERS'] ?? '') === 'sqlite') return true
  if (Array.isArray(job.steps)) {
    for (const step of job.steps) {
      if (step?.env && String(step.env['AW_TEST_PROVIDERS'] ?? '') === 'sqlite') return true
    }
  }
  return false
}

function readJobShardCount(job: ParsedWorkflowJob | null): number | null {
  const shards = job?.strategy?.matrix?.shards
  if (Array.isArray(shards) && shards.length === 1 && typeof shards[0] === 'number')
    return shards[0]
  return null
}

/** Legacy failed uploads are safe only when the source succeeded on its first attempt. */
export function assertSafeBackendTimingUploads(
  workflow: string,
  finalAttempt: number,
  jobId = 'test-backend',
): void {
  if (!Number.isSafeInteger(finalAttempt) || finalAttempt < 1)
    throw new Error('Invalid source run attempt')
  if (finalAttempt === 1) return

  const job = parseWorkflowJob(workflow, jobId)
  if (job && Array.isArray(job.steps)) {
    const hasOsMatrix = Array.isArray(job.strategy?.matrix?.os)
    const upload = job.steps.find(
      (step) =>
        typeof step?.uses === 'string' &&
        step.uses.startsWith('actions/upload-artifact@') &&
        typeof step.with?.name === 'string' &&
        /^backend-(?:test|core|full)-timings-/.test(step.with.name),
    )
    const condition = typeof upload?.if === 'string' ? upload.if.trim() : ''
    const expected = hasOsMatrix ? "success() && matrix.os == 'ubuntu-latest'" : 'success()'
    if (condition !== expected) {
      throw new Error(
        'Legacy rerun artifacts may retain failed samples; require success-only uploads',
      )
    }
    return
  }

  // Fallback for minimal non-YAML text fragments in unit tests.
  const backendJob = workflow.split(`\n  ${jobId}:`)[1]?.split('\n  test-backend-postgresql:')[0]
  const upload = backendJob
    ?.split('      - name: Upload measured backend test timings')[1]
    ?.split('\n      - name:')[0]
  if (
    !upload?.includes("        if: success() && matrix.os == 'ubuntu-latest'\n") &&
    !upload?.includes('        if: success()\n')
  )
    throw new Error(
      'Legacy rerun artifacts may retain failed samples; require success-only uploads',
    )
}

/** Every consumer reads the complete raw source before projecting or composing it. */
export function readBackendTimingSource(
  request: BackendTimingSourceRequest,
  reader: BackendTimingSourceReader,
): BackendTimingSource {
  const { artifactsDirectory, runId, repository } = request
  const tier: BackendTimingTier = request.tier ?? 'all'
  if (tier !== 'core' && tier !== 'all') throw new Error(`Invalid backend timing tier: ${tier}`)
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error('Invalid backend timing source run ID')
  const sourceRun = reader.readRun(repository, runId)
  const allowedSources = tier === 'core' ? CORE_CI_TIMING_SOURCES : ALL_BACKEND_TIMING_SOURCES
  const sourceSha = assertSuccessfulTimingSource(sourceRun, repository, runId, allowedSources)
  const runName = (sourceRun as { name: string }).name
  const finalRunAttempt = (sourceRun as { run_attempt: number }).run_attempt

  const readFile = (path: string) => reader.readSourceFile(sourceSha, path)
  const isNightly = runName === 'backend-full-nightly'
  const jobId = isNightly ? 'test-backend-full' : 'test-backend'
  const sourceDefinition = isNightly
    ? resolveNightlyBackendSource(readFile)
    : resolveCiWorkSource(readFile)
  const sourceWorkflow = sourceDefinition.workflow
  assertSafeBackendTimingUploads(sourceWorkflow, finalRunAttempt, jobId)

  const parsedJob = parseWorkflowJob(sourceWorkflow, jobId)
  const shardCount = readJobShardCount(parsedJob)
  if (!shardCount) throw new Error('Source backend shard matrix is missing')

  const hasSqliteOnly = jobHasSqliteProviderNarrowing(parsedJob)
  if (tier === 'core') {
    const validCoreShards =
      shardCount === BACKEND_CORE_SHARDS || shardCount === LEGACY_BACKEND_CORE_SHARDS
    if (sourceDefinition.path !== CI_WORKFLOW_PATH || !validCoreShards || !hasSqliteOnly) {
      throw new Error(
        `Core backend timing source must be ${CI_WORKFLOW_PATH} with ${BACKEND_CORE_SHARDS} (or historical ${LEGACY_BACKEND_CORE_SHARDS}) SQLite shards`,
      )
    }
  } else {
    if (hasSqliteOnly) {
      throw new Error('Full backend timing source must not narrow AW_TEST_PROVIDERS to sqlite')
    }
    if (
      isNightly &&
      (sourceDefinition.path !== BACKEND_FULL_NIGHTLY_PATH || shardCount !== BACKEND_FULL_SHARDS)
    ) {
      throw new Error(
        `Nightly backend timing source must be ${BACKEND_FULL_NIGHTLY_PATH} with ${BACKEND_FULL_SHARDS} shards`,
      )
    }
  }

  const rawFiles = [...reader.readSourceTests(sourceSha)]
  const expectedFiles = tier === 'core' ? filterBackendTestsByTier(rawFiles, 'core') : rawFiles
  const timings = mergeBackendTimings(
    reader.readShards(artifactsDirectory),
    expectedFiles,
    shardCount,
  )
  return {
    timings,
    expectedFiles,
    provenance: {
      tier,
      sourceRun: runId,
      sourceSha,
      sourceRepository: repository,
      sourceWorkflowPath: sourceDefinition.path,
      finalRunAttempt,
      sourceShards: shardCount,
      sourceFiles: Object.keys(timings.files).length,
      measuredMilliseconds: Object.values(timings.files).reduce((sum, ms) => sum + ms, 0),
    },
  }
}

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr}`)
  return result.stdout
}

function treeTests(ref: string): string[] {
  return command('git', ['ls-tree', '-rz', '--name-only', ref, '--', 'packages/backend/tests'])
    .split('\0')
    .filter((path) => BACKEND_TEST_PATH_PATTERN.test(path))
}

/** Capture the committed target once; later source reads must not follow a moving HEAD. */
export function readBackendTimingTarget(tier: BackendTimingTier = 'all'): {
  targetSha: string
  files: string[]
} {
  const targetSha = command('git', ['rev-parse', 'HEAD']).trim()
  return { targetSha, files: filterBackendTestsByTier(treeTests(targetSha), tier) }
}

function artifactLayout(
  tier: BackendTimingTier,
  runName: string,
): {
  dirPrefix: string
  fileName: string
} {
  if (tier === 'core') {
    return { dirPrefix: 'backend-core-timings-', fileName: 'backend-core-timings.json' }
  }
  if (runName === 'backend-full-nightly') {
    return { dirPrefix: 'backend-full-timings-', fileName: 'backend-full-timings.json' }
  }
  return { dirPrefix: 'backend-test-timings-', fileName: 'backend-test-timings.json' }
}

export function loadBackendTimingSource(
  artifactsDirectory: string,
  runId: number,
  repository: string,
  tier: BackendTimingTier = 'all',
): BackendTimingSource {
  let observedRunName = 'CI'
  return readBackendTimingSource(
    { artifactsDirectory, runId, repository, tier },
    {
      readRun: (repo, id) => {
        const parsed = JSON.parse(command('gh', ['api', `repos/${repo}/actions/runs/${id}`])) as {
          name?: unknown
        }
        if (typeof parsed?.name === 'string') observedRunName = parsed.name
        return parsed
      },
      readSourceFile: (sourceSha, path) => command('git', ['show', `${sourceSha}:${path}`]),
      readSourceTests: treeTests,
      readShards: (directory) => {
        const { dirPrefix, fileName } = artifactLayout(tier, observedRunName)
        const dirPattern = new RegExp(`^${dirPrefix.replaceAll('-', '\\-')}(\\d+)$`)
        return readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && dirPattern.test(entry.name))
          .map((entry) => ({
            shard: Number(entry.name.slice(dirPrefix.length)),
            data: JSON.parse(
              readFileSync(join(directory, entry.name, fileName), 'utf8'),
            ) as unknown,
          }))
      },
    },
  )
}

export function parseRefreshBackendTimingsArgs(args: readonly string[]): {
  tier: BackendTimingTier
  artifacts: string
  runId: number
  output: string
} {
  let tier: BackendTimingTier = 'all'
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--tier') {
      const value = args[++index]
      if (value !== 'core' && value !== 'all')
        throw new Error(`Invalid --tier value: ${value ?? '(missing)'}`)
      tier = value
    } else if (arg.startsWith('--tier=')) {
      const value = arg.slice('--tier='.length)
      if (value !== 'core' && value !== 'all') throw new Error(`Invalid --tier value: ${value}`)
      tier = value
    } else {
      positional.push(arg)
    }
  }
  const [artifacts, runArg, output] = positional
  if (positional.length !== 3 || !artifacts || !runArg || !/^\d+$/.test(runArg) || !output)
    throw new Error(
      'Usage: bun scripts/ci/refresh-backend-timings.ts [--tier <core|all>] ARTIFACTS_DIR RUN_ID OUTPUT_JSON',
    )
  return { tier, artifacts, runId: Number(runArg), output }
}

if (import.meta.main) {
  const { tier, artifacts, runId, output } = parseRefreshBackendTimingsArgs(process.argv.slice(2))
  const repository = process.env.GITHUB_REPOSITORY ?? 'wangbinquan/agent-workflow'
  const source = loadBackendTimingSource(artifacts, runId, repository, tier)
  const target = readBackendTimingTarget(tier)
  const projected = projectBackendTimings(source.timings, target.files)
  const destination = resolve(output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(projected.timings, null, 2)}\n`)
  const provenance = {
    ...source.provenance,
    unmeasured: projected.unmeasured,
    removed: projected.removed,
  }
  writeFileSync(`${destination}.source.json`, `${JSON.stringify(provenance, null, 2)}\n`)
  console.log(JSON.stringify(provenance, null, 2))
}

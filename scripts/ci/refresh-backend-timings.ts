// RFC-611: merge measured whole-file durations without publishing partial or invented weights.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface BackendTimings {
  version: 1
  files: Record<string, number>
}

export interface TimingShard {
  shard: number
  data: unknown
}

const backendTestPath = /^packages\/backend\/tests\/(?:[^/]+\/)*[^/]+\.(?:test|spec)\.ts$/

function validPath(path: string): boolean {
  return (
    backendTestPath.test(path) &&
    !path.split('/').some((part) => part === '.' || part === '..') &&
    !path.includes('\\') &&
    ![...path].some((character) => character.charCodeAt(0) < 32)
  )
}

/** The source tree, not today's working tree, defines the required measurement population. */
export function mergeBackendTimings(
  shards: readonly TimingShard[],
  expectedFiles: readonly string[],
  shardCount: number,
): BackendTimings {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('Invalid shard count')
  if (shards.length !== shardCount) throw new Error(`Expected ${shardCount} timing shards`)
  const expected = new Set(expectedFiles)
  if (expected.size === 0 || expected.size !== expectedFiles.length)
    throw new Error('Source test population is empty or duplicated')
  for (const path of expected) if (!validPath(path)) throw new Error(`Invalid source path: ${path}`)
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
      if (!validPath(path) || !expected.has(path))
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

export function assertSuccessfulTimingSource(value: unknown, repository: string, runId: number) {
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
  if (
    !run ||
    run.id !== runId ||
    run.name !== 'CI' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'push' ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== repository ||
    typeof run.head_sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(run.head_sha)
  )
    throw new Error('Timing source must be a successful complete main push CI in this repository')
  return run.head_sha
}

/** Legacy failed uploads are safe only when the source succeeded on its first attempt. */
export function assertSafeBackendTimingUploads(workflow: string, finalAttempt: number): void {
  if (!Number.isSafeInteger(finalAttempt) || finalAttempt < 1)
    throw new Error('Invalid source run attempt')
  if (finalAttempt === 1) return
  const backendJob = workflow
    .split('\n  test-backend:')[1]
    ?.split('\n  test-backend-postgresql:')[0]
  const upload = backendJob
    ?.split('      - name: Upload measured backend test timings (ubuntu shards)')[1]
    ?.split('\n      - name:')[0]
  if (!upload?.includes("        if: success() && matrix.os == 'ubuntu-latest'\n"))
    throw new Error(
      'Legacy rerun artifacts may retain failed samples; require success-only uploads',
    )
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
    .filter((path) => backendTestPath.test(path))
}

if (import.meta.main) {
  const [artifacts, runArg, output] = process.argv.slice(2)
  if (!artifacts || !runArg || !/^\d+$/.test(runArg) || !output)
    throw new Error(
      'Usage: bun scripts/ci/refresh-backend-timings.ts ARTIFACTS_DIR RUN_ID OUTPUT_JSON',
    )
  const repository = process.env.GITHUB_REPOSITORY ?? 'wangbinquan/agent-workflow'
  const runId = Number(runArg)
  const sourceRun = JSON.parse(command('gh', ['api', `repos/${repository}/actions/runs/${runId}`]))
  const sourceSha = assertSuccessfulTimingSource(sourceRun, repository, runId)
  // The checked-out source workflow is authoritative for the expected matrix size.
  const sourceWorkflow = command('git', ['show', `${sourceSha}:.github/workflows/ci.yml`])
  assertSafeBackendTimingUploads(sourceWorkflow, sourceRun.run_attempt)
  const backendJob = sourceWorkflow
    .split('\n  test-backend:')[1]
    ?.split('\n  test-backend-postgresql:')[0]
  const countText = backendJob?.match(/\n\s+shards: \[(\d+)\]/)?.[1]
  if (!countText) throw new Error('Source backend shard matrix is missing')
  const shards = readdirSync(artifacts, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^backend-test-timings-\d+$/.test(entry.name))
    .map((entry) => ({
      shard: Number(entry.name.slice('backend-test-timings-'.length)),
      data: JSON.parse(
        readFileSync(join(artifacts, entry.name, 'backend-test-timings.json'), 'utf8'),
      ) as unknown,
    }))
  const merged = mergeBackendTimings(shards, treeTests(sourceSha), Number(countText))
  const projected = projectBackendTimings(merged, treeTests('HEAD'))
  const destination = resolve(output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(projected.timings, null, 2)}\n`)
  const provenance = {
    sourceRun: runId,
    sourceSha,
    sourceRepository: repository,
    finalRunAttempt: sourceRun.run_attempt,
    sourceShards: Number(countText),
    sourceFiles: Object.keys(merged.files).length,
    measuredMilliseconds: Object.values(merged.files).reduce((sum, ms) => sum + ms, 0),
    unmeasured: projected.unmeasured,
    removed: projected.removed,
  }
  writeFileSync(`${destination}.source.json`, `${JSON.stringify(provenance, null, 2)}\n`)
  console.log(JSON.stringify(provenance, null, 2))
}

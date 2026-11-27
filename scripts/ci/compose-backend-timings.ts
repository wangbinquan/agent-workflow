// RFC-623: prepare reviewed scheduling weights from complete green sources.
// Automatic CI collection continues to publish each run's own measurements.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  assertBackendTestPopulation,
  loadBackendTimingSource,
  mergeBackendTimings,
  readBackendTimingTarget,
  type BackendTimingProvenance,
  type BackendTimingSource,
} from './refresh-backend-timings'
import { CI_WORKFLOW_PATH } from './workflow-source'

export interface BackendTimingTarget {
  targetSha: string
  files: readonly string[]
}

function checkedSource(source: BackendTimingSource) {
  const metadata = source?.provenance
  if (
    !metadata ||
    !Number.isSafeInteger(metadata.sourceRun) ||
    metadata.sourceRun < 1 ||
    typeof metadata.sourceSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(metadata.sourceSha) ||
    typeof metadata.sourceRepository !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/.test(metadata.sourceRepository) ||
    !['.github/workflows/ci.yml', CI_WORKFLOW_PATH].includes(metadata.sourceWorkflowPath) ||
    !Number.isSafeInteger(metadata.finalRunAttempt) ||
    metadata.finalRunAttempt < 1 ||
    metadata.sourceShards !== 44
  )
    throw new Error('Composition requires complete 44-shard backend timing sources')

  // read/load already validates the raw source shards. Recheck the merged map
  // against that source's entire tree, including files removed from the target.
  const timings = mergeBackendTimings([{ shard: 1, data: source.timings }], source.expectedFiles, 1)
  const sourceFiles = Object.keys(timings.files).length
  const measuredMilliseconds = Object.values(timings.files).reduce((sum, ms) => sum + ms, 0)
  if (
    metadata.sourceFiles !== sourceFiles ||
    !Number.isFinite(measuredMilliseconds) ||
    metadata.measuredMilliseconds !== measuredMilliseconds
  )
    throw new Error('Backend timing source metadata disagrees with its complete measurements')
  const provenance: BackendTimingProvenance = {
    sourceRun: metadata.sourceRun,
    sourceSha: metadata.sourceSha,
    sourceRepository: metadata.sourceRepository,
    sourceWorkflowPath: metadata.sourceWorkflowPath,
    finalRunAttempt: metadata.finalRunAttempt,
    sourceShards: metadata.sourceShards,
    sourceFiles,
    measuredMilliseconds,
  }
  return { timings, provenance }
}

export function composeBackendTimings(
  sources: readonly BackendTimingSource[],
  target: BackendTimingTarget,
) {
  if (!Array.isArray(sources) || sources.length < 2)
    throw new Error('Composition requires at least two distinct source runs')
  if (typeof target?.targetSha !== 'string' || !/^[0-9a-f]{40}$/.test(target.targetSha))
    throw new Error('Invalid committed timing target SHA')
  const targetFiles = assertBackendTestPopulation(target.files)
  const checked = sources
    .map(checkedSource)
    .sort((a, b) => a.provenance.sourceRun - b.provenance.sourceRun)
  if (new Set(checked.map((source) => source.provenance.sourceRun)).size !== checked.length)
    throw new Error(
      'Composition requires distinct source runs, not repeated attempts or directories',
    )
  if (new Set(checked.map((source) => source.provenance.sourceRepository)).size !== 1)
    throw new Error('Backend timing sources must belong to the same repository')

  const selected = new Map<string, { sourceRun: number; sourceSha: string; milliseconds: number }>()
  const removed = new Set<string>()
  for (const source of checked) {
    for (const [file, milliseconds] of Object.entries(source.timings.files)) {
      if (!targetFiles.has(file)) {
        removed.add(file)
        continue
      }
      const prior = selected.get(file)
      const { sourceRun, sourceSha } = source.provenance
      if (
        !prior ||
        milliseconds > prior.milliseconds ||
        (milliseconds === prior.milliseconds && sourceRun > prior.sourceRun)
      )
        selected.set(file, { sourceRun, sourceSha, milliseconds })
    }
  }
  const entries = [...selected].sort(([a], [b]) => a.localeCompare(b))
  const files = Object.fromEntries(entries.map(([file, chosen]) => [file, chosen.milliseconds]))
  const aggregatedMilliseconds = Object.values(files).reduce((sum, ms) => sum + ms, 0)
  if (!Number.isFinite(aggregatedMilliseconds)) throw new Error('Invalid aggregate timing total')
  return {
    timings: { version: 1 as const, files },
    provenance: {
      aggregation: 'per-file-maximum' as const,
      targetSha: target.targetSha,
      sourceRepository: checked[0]!.provenance.sourceRepository,
      targetFiles: targetFiles.size,
      measuredFiles: entries.length,
      sources: checked.map(({ provenance }) => ({ ...provenance, complete: true as const })),
      selectedSources: Object.fromEntries(entries),
      aggregatedMilliseconds,
      unmeasured: [...targetFiles].filter((file) => !selected.has(file)).sort(),
      removed: [...removed].sort(),
    },
  }
}

export function parseBackendTimingCompositionArgs(args: readonly string[]) {
  const [output] = args
  if (!output || args.length < 5 || (args.length - 1) % 2 !== 0)
    throw new Error(
      'Usage: bun scripts/ci/compose-backend-timings.ts OUTPUT_JSON ARTIFACTS_DIR RUN_ID [ARTIFACTS_DIR RUN_ID ...] (at least two sources)',
    )
  const sources: { artifactsDirectory: string; runId: number }[] = []
  for (let index = 1; index < args.length; index += 2) {
    const artifactsDirectory = args[index]!
    const runArg = args[index + 1]!
    const runId = Number(runArg)
    if (!artifactsDirectory || !/^\d+$/.test(runArg) || !Number.isSafeInteger(runId) || runId < 1)
      throw new Error('Each source requires an artifact directory and a positive integer run ID')
    sources.push({ artifactsDirectory, runId })
  }
  if (new Set(sources.map((source) => source.runId)).size !== sources.length)
    throw new Error('Composition requires distinct source run IDs')
  return { output, sources }
}

if (import.meta.main) {
  const { output, sources } = parseBackendTimingCompositionArgs(process.argv.slice(2))
  const target = readBackendTimingTarget()
  const repository = process.env.GITHUB_REPOSITORY ?? 'wangbinquan/agent-workflow'
  const result = composeBackendTimings(
    sources.map(({ artifactsDirectory, runId }) =>
      loadBackendTimingSource(artifactsDirectory, runId, repository),
    ),
    target,
  )
  const destination = resolve(output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(result.timings, null, 2)}\n`)
  writeFileSync(`${destination}.source.json`, `${JSON.stringify(result.provenance, null, 2)}\n`)
  console.log(JSON.stringify(result.provenance, null, 2))
}

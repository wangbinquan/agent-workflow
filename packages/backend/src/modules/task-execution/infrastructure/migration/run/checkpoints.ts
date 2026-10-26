import type {
  TaskFacts,
  TaskMountFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import { scanJsonObjectEntries } from '@/platform/persistence/migration/conversion/orderedJson'
import type {
  JsonValue,
  SourceRow,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { nullableText, text } from './source'

export interface RunDecision {
  readonly code: string
  readonly missingFields: readonly string[]
  readonly detail: JsonValue
  readonly unprovable: boolean
}
const checkpointColumns = [
  ['pre_snapshot', 'pre_snapshot', 'pre_snapshot_repos_json'],
  ['isolation_base', 'iso_base_snapshot', 'iso_base_snapshot_repos_json'],
  ['node_tree', 'iso_node_tree', 'iso_node_tree_repos_json'],
  ['submodules', 'iso_submodules_json', 'iso_submodules_repos_json'],
] as const

export function convertCheckpoints(
  row: SourceRow,
  mounts: TaskMountFacts,
  execution: TaskFacts['execution'],
): {
  readonly rows: readonly TargetRow[]
  readonly decisions: readonly RunDecision[]
} {
  const decisions: RunDecision[] = []
  const result = new Map<string, Record<string, string | null>>()
  const decision = (code: string, field: string, detail: JsonValue, unprovable = true) =>
    decisions.push({ code, missingFields: [field], detail, unprovable })
  const set = (repoKey: string, field: string, value: string | null, source: string) => {
    const checkpoint = result.get(repoKey) ?? {
      node_run_id: text(row, 'id'),
      task_id: text(row, 'task_id'),
      repo_key: repoKey,
      pre_snapshot: null,
      isolation_base: null,
      node_tree: null,
      submodules: null,
    }
    if (checkpoint[field] !== null && checkpoint[field] !== value)
      decision('v2-run-checkpoint-conflict', source, {
        repoKey,
        field,
        previous: checkpoint[field]!,
        value,
      })
    else checkpoint[field] = value
    result.set(repoKey, checkpoint)
  }
  for (const [field, scalar, map] of checkpointColumns) {
    const value = nullableText(row, scalar)
    const raw = nullableText(row, map)
    if (value !== null) {
      if (mounts.mounts.length !== 1)
        decision('v2-run-checkpoint-scalar-unmapped', scalar, {
          value,
          mountCount: mounts.mounts.length,
        })
      else {
        if (field === 'submodules' && value !== '') {
          try {
            JSON.parse(value)
          } catch {
            decision('v2-run-checkpoint-malformed', scalar, { raw: value })
            continue
          }
        }
        set(
          mounts.mounts[0]!.repoKey,
          field,
          field === 'submodules' && value === '' ? '""' : value,
          scalar,
        )
      }
    }
    if (raw === null) continue
    try {
      const entries = scanJsonObjectEntries(raw)
      const seen = new Set<string>()
      for (const entry of entries) {
        if (seen.has(entry.key)) {
          decision('v2-run-checkpoint-duplicate-key', map, { key: entry.key, raw })
          continue
        }
        seen.add(entry.key)
        const matching = mounts.mounts.filter((mount) =>
          entry.key === '' ? mount.mountPath === '' : mount.worktreeDirName === entry.key,
        )
        if (matching.length !== 1) {
          decision('v2-run-checkpoint-key-unmapped', map, { key: entry.key, value: entry.value })
          continue
        }
        if (field !== 'submodules' && entry.value !== null && typeof entry.value !== 'string') {
          decision('v2-run-checkpoint-malformed', map, { key: entry.key, value: entry.value })
          continue
        }
        set(
          matching[0]!.repoKey,
          field,
          entry.value === null
            ? null
            : field === 'submodules'
              ? entry.rawValue
              : (entry.value as string),
          map,
        )
      }
    } catch {
      decision('v2-run-checkpoint-malformed', map, { raw })
    }
  }
  const mergeState = nullableText(row, 'merge_state')
  if (
    mounts.mounts.length === 1 &&
    mounts.mounts[0]!.mountPath !== '' &&
    row.values.iso_node_tree === null &&
    row.values.iso_node_tree_repos_json === null &&
    (mergeState !== null || row.values.iso_worktree_path !== null)
  ) {
    decision(
      'node-tree-lost-by-known-defect',
      'iso_node_tree',
      { runId: text(row, 'id'), mergeState, execution },
      execution !== 'terminal-history' &&
        (mergeState === 'isolating' || mergeState === 'pending-merge'),
    )
  }
  return { rows: [...result.values()], decisions }
}

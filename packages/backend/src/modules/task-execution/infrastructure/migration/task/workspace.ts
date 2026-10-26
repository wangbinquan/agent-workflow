import { isSingleRootRepository } from '@agent-workflow/shared'
import {
  REQUESTED_SOURCE_CODEC,
  encodeRequestedSource,
  type PersistedRequestedSource,
} from '../../../domain/requestedSourceCodec'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type {
  SourceRow,
  TargetRow,
  TargetValue,
} from '@/platform/persistence/migration/conversion/types'
import { text, nullableText, number, pick } from './values'

export type MountScenario =
  | 'equal'
  | 'legacy-root-only'
  | 'internal-branch-split'
  | 'branch-fallback'
  | 'legacy-mount-name'
  | 'unexplained-conflict'
  | 'zero-mounts'
  | 'single-nonroot-member'
  | 'multi-repo'

export interface MountDecision {
  readonly scenario: MountScenario
  readonly code: string
  readonly ordinal: number | null
  readonly fieldDiffs: readonly { field: string; root: TargetValue; child: TargetValue }[]
  readonly blocking: boolean
}

export function requestedSourceFromTask(task: SourceRow): PersistedRequestedSource {
  const spaceKind = text(task, 'space_kind') as PersistedRequestedSource['spaceKind']
  const repoGroupId = nullableText(task, 'repo_group_id')
  const cachedRepoId = nullableText(task, 'cached_repo_id')
  const repoUrl = nullableText(task, 'repo_url')
  const kind: PersistedRequestedSource['kind'] =
    spaceKind === 'local' ||
    spaceKind === 'internal' ||
    spaceKind === 'inherited' ||
    spaceKind === 'scratch'
      ? spaceKind
      : repoGroupId
        ? 'repo-group'
        : cachedRepoId
          ? 'cached-repo'
          : repoUrl
            ? 'url'
            : 'scratch'
  return {
    codec: REQUESTED_SOURCE_CODEC,
    kind,
    kindProvenance: 'epoch1-stored-fields',
    spaceKind,
    repoPath: text(task, 'repo_path'),
    repoUrl,
    cachedRepoId,
    repoGroupId,
    repoGroupName: nullableText(task, 'repo_group_name'),
    requestedRef: { value: text(task, 'base_branch'), provenance: 'resolved-base-branch' },
    legacyBaseCommit: nullableText(task, 'base_commit'),
  }
}

/** Source paths may come from a different OS than the offline converter. */
export function mountedWorktreePath(root: string, mount: string): string {
  if (mount === '') return root
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]$/, '')}${separator}${mount.split('/').join(separator)}`
}

function legacyRootMount(task: SourceRow): TargetRow {
  return {
    ...pick(task, [
      'repo_path',
      'repo_url',
      'cached_repo_id',
      'base_branch',
      'branch',
      'working_branch',
      'base_commit',
    ]),
    task_id: text(task, 'id'),
    repo_index: 0,
    worktree_path: text(task, 'worktree_path'),
    worktree_dir_name: '',
    mount_path: '',
    subdir: '',
    readonly: false,
    readonly_dirty_count: null,
    workspace_profile_version: null,
    workspace_profile_digest: null,
    has_submodules: null,
    submodule_init_ok: null,
    submodule_init_error: null,
    schema_version: 1,
  }
}

/** Both TASK_MOUNTS and row emission call this exact assignment algorithm. */
export function assignTaskRepositoryMounts(
  task: SourceRow,
  repos: readonly SourceRow[],
  facts: TaskFacts,
  ids: RuleContext['ids'],
  inFlightIsolation: readonly string[] = [],
) {
  const taskId = text(task, 'id')
  const root = text(task, 'worktree_path')
  const rootRef = root === '' ? null : root
  const decisions: MountDecision[] = []
  const problem = (code: string, ordinal: number | null, fieldDiffs: MountDecision['fieldDiffs']) =>
    decisions.push({
      scenario: 'unexplained-conflict',
      code,
      ordinal,
      fieldDiffs,
      blocking: facts.execution === 'executable',
    })
  const note = (scenario: MountScenario, ordinal: number | null = null) =>
    decisions.push({
      scenario,
      code: `v2-task-mount-${scenario}`,
      ordinal,
      fieldDiffs: [],
      blocking: false,
    })
  const sorted = [...repos].sort((a, b) => number(a, 'repo_index') - number(b, 'repo_index'))
  const sources = sorted.length
    ? sorted.map((row) => row.values)
    : rootRef === null
      ? []
      : [legacyRootMount(task)]
  if (!sorted.length) note(sources.length ? 'legacy-root-only' : 'zero-mounts')
  if (sources.length === 1 && sources[0]!.mount_path !== '') note('single-nonroot-member')
  if (sources.length > 1) note('multi-repo')
  const mounts: TargetRow[] = []
  const repoKeys = new Map<number, string>()
  for (const source of sources) {
    const ordinal = source.repo_index as number
    const mount = source.mount_path as string
    const conflicts: MountDecision['fieldDiffs'][number][] = []
    if (source === sources[0] && ordinal !== 0)
      conflicts.push({ field: 'repo_index', root: 0, child: ordinal })
    if (source.worktree_dir_name !== mount) {
      const diff = { field: 'worktree_dir_name', root: mount, child: source.worktree_dir_name! }
      if (facts.execution === 'executable' && inFlightIsolation.length) conflicts.push(diff)
      else
        decisions.push({
          scenario: 'legacy-mount-name',
          code: 'v2-task-mount-name-evidence',
          ordinal,
          fieldDiffs: [diff],
          blocking: false,
        })
    }
    const expected = mountedWorktreePath(root, mount)
    if (rootRef === null || source.worktree_path !== expected)
      conflicts.push({
        field: 'worktree_path',
        root: rootRef === null ? null : expected,
        child: source.worktree_path!,
      })
    if (!Number.isSafeInteger(ordinal) || ordinal < 0)
      conflicts.push({ field: 'repo_index', root: 0, child: ordinal })
    if (conflicts.length) problem('v2-task-mount-path', ordinal, conflicts)

    const branch = source.branch === '' ? null : source.branch
    const baseBranch = source.base_branch === '' ? null : source.base_branch
    const baseCommit = source.base_commit
    const branchState = branch !== null ? 'branch' : baseCommit ? 'detached' : 'none'
    if (
      (branchState === 'detached' && baseBranch !== null && baseBranch !== baseCommit) ||
      (branchState === 'none' && (baseBranch !== null || baseCommit !== null))
    ) {
      problem('v2-task-mount-branch-state', ordinal, [
        {
          field: 'base_branch',
          root: branchState === 'detached' ? baseCommit! : null,
          child: baseBranch!,
        },
      ])
      conflicts.push({ field: 'branch_state', root: null, child: branchState })
    }

    if (source === sources[0] && sorted.length) {
      const diffs = ['repo_path', 'repo_url', 'cached_repo_id', 'base_branch', 'base_commit']
        .filter((field) => task.values[field] !== source[field])
        .map((field) => ({ field, root: task.values[field]!, child: source[field]! }))
      const branchSplit = source.branch === '' && task.values.branch !== ''
      if (task.values.branch !== (source.branch || task.values.branch))
        diffs.push({ field: 'branch', root: task.values.branch!, child: source.branch! })
      if (diffs.length) {
        problem('v2-task-mount-conflict', ordinal, diffs)
        conflicts.push(...diffs)
      } else
        note(
          branchSplit
            ? facts.spaceKind === 'internal'
              ? 'internal-branch-split'
              : 'branch-fallback'
            : 'equal',
          ordinal,
        )
    }
    if (conflicts.length) continue
    const repoKey = ids.child('task-repository-mount', task.encodedKey, ordinal)
    repoKeys.set(ordinal, repoKey)
    const {
      repo_index: _index,
      worktree_path: _path,
      worktree_dir_name: _directory,
      ...columns
    } = source
    mounts.push({
      ...columns,
      repo_key: repoKey,
      ordinal,
      branch: branch!,
      base_branch: baseBranch!,
      branch_state: branchState,
    })
  }
  if (number(task, 'repo_count') !== Math.max(1, sources.length))
    problem('v2-task-repo-count', null, [
      { field: 'repo_count', root: number(task, 'repo_count'), child: Math.max(1, sources.length) },
    ])
  return {
    mounts,
    repoKeys,
    rootRef,
    layout:
      mounts.length === 0
        ? ('none' as const)
        : isSingleRootRepository(mounts.map((row) => String(row.mount_path)))
          ? ('single-root' as const)
          : ('mounts' as const),
    workspace: {
      task_id: taskId,
      ...pick(task, [
        'repo_group_id',
        'repo_group_name',
        'git_user_name',
        'git_user_email',
        'auto_commit_push',
        'space_kind',
        'working_branch',
      ]),
      requested_source: encodeRequestedSource(requestedSourceFromTask(task)),
      task_branch: text(task, 'branch'),
    } satisfies TargetRow,
    decisions,
  }
}

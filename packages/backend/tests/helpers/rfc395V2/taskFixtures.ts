import { buildWorkgroupHostSnapshot } from '@/modules/task-execution/infrastructure/workgroupRuntimeConfig'
import { buildDynamicWorkflowGenerateSnapshot } from '@/services/orchestratorAgent'
import {
  decodeLogicalValue,
  type CanonicalLogicalRow,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { expect } from 'bun:test'
import { mountDepth, decodeTaskWorkgroupConfig, type WorkgroupMode } from '@agent-workflow/shared'
import type { V2Harness } from '../rfc395V2Harness'
import { V2MemorySink } from '../rfc395V2MemorySink'
import { conversion } from '@/modules/task-execution/infrastructure/migration/task'
import { conversion as repositoryUrls } from '@/modules/source-control/infrastructure/migration/repositoryUrlRule'
import { mountedWorktreePath } from '@/modules/task-execution/infrastructure/migration/task/workspace'
import { decodeTaskRepositoryMount } from '@/modules/task-execution/infrastructure/taskRepositoryCodec'
import {
  decodeRequestedSourceJson,
  requestedSourceView,
  requestedSourcePrimary,
} from '@/modules/task-execution/domain/requestedSourceCodec'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { columnLookup, idSetLookup } from '@/platform/persistence/migration/conversion/lookups'
import {
  TASK_FACTS,
  TASK_MOUNTS,
  type TaskFacts,
  type TaskMountFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import type {
  VersionedSourceReader,
  DecodedSourceRow,
} from '@/platform/persistence/migration/sourceTypes'
import { projectStoredTaskRepositorySurface } from '@/platform/persistence/taskRepositorySurface'
import {
  projectTaskRepositorySurface,
  taskRepositoryNodePaths,
  type TaskRepositoryMount,
} from '@/platform/taskRepository'

export const TASK_SNAPSHOT =
  '{ "$schema_version": 7, "inputs": [], "nodes": [], "edges": [], "frozenUnknown": "retained" }'

/** Physical epoch-1 input for h.write, never a live model builder. */
export function taskRow(id: string, overrides: DecodedSourceRow = {}): DecodedSourceRow {
  const config = decodeTaskWorkgroupConfig(
    typeof overrides.workgroup_config_json === 'string' ? overrides.workgroup_config_json : null,
  ).runtime.config
  const snapshot = config
    ? JSON.stringify(
        config.mode === 'dynamic_workflow'
          ? buildDynamicWorkflowGenerateSnapshot()
          : buildWorkgroupHostSnapshot(config),
      )
    : TASK_SNAPSHOT
  return {
    id,
    name: id,
    workflow_id: 'deleted-workflow',
    workflow_snapshot: snapshot,
    workflow_version: 7,
    inputs: '{ "goal": "frozen" }',
    repo_path: '/cache/repository',
    repo_url: null,
    cached_repo_id: null,
    base_branch: 'main',
    branch: `task/${id}`,
    base_commit: 'sha-base',
    worktree_path: `/work/${id}`,
    status: 'done',
    started_at: 1001,
    execution_lineage_id: id,
    lineage_slot_path_json: `[{"stableNodeKey":"task-root","frozenOccurrenceKey":${JSON.stringify(id)},"workflowRevision":7}]`,
    ...overrides,
  }
}

export function repoRow(
  task: DecodedSourceRow,
  overrides: DecodedSourceRow = {},
): DecodedSourceRow {
  return {
    task_id: task.id!,
    repo_index: 0,
    repo_path: task.repo_path!,
    repo_url: task.repo_url!,
    cached_repo_id: task.cached_repo_id!,
    base_branch: task.base_branch!,
    branch: task.branch!,
    base_commit: task.base_commit!,
    worktree_path: task.worktree_path!,
    working_branch: task.working_branch ?? null,
    ...overrides,
  }
}

export function workgroupConfig(
  mode: WorkgroupMode = 'leader_worker',
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify(
    {
      workgroupId: 'group',
      workgroupName: 'Frozen group',
      mode,
      goal: 'Original goal',
      leaderMemberId: mode === 'leader_worker' ? 'member' : null,
      switches: { shareOutputs: true, directMessages: false, blackboard: true },
      maxRounds: 30,
      completionGate: false,
      instructions: 'Room-editable instructions',
      members: [
        {
          id: 'member',
          memberType: 'human',
          agentName: null,
          userId: 'user',
          displayName: 'Member',
          roleDesc: 'role',
        },
      ],
      unknownRuntime: { original: true },
      ...extra,
    },
    null,
    2,
  )
}

export async function writeTaskFixture(
  h: V2Harness,
  task: DecodedSourceRow,
  options: {
    repos?: readonly DecodedSourceRow[]
    nodes?: readonly string[]
    state?: DecodedSourceRow
  } = {},
): Promise<void> {
  await h.write('tasks', [task])
  if (options.repos) await h.write('task_repos', options.repos)
  if (options.nodes)
    await h.write(
      'task_space_nodes',
      options.nodes.map((node_path) => ({ task_id: task.id!, node_path })),
    )
  if (options.state)
    await h.write('workgroup_task_state', [
      { task_id: task.id!, gate_status: 'idle', updated_at: 4321, ...options.state },
    ])
}

export async function convertTaskFixtures(
  h: V2Harness,
  options: {
    contribution?: ConversionContribution
    extra?: readonly ConversionContribution[]
    sourceScope?: readonly string[]
    source?: VersionedSourceReader
  } = {},
) {
  const sourceRows = new Map<string, SourceRow[]>()
  const facts = new Map<string, TaskFacts>()
  const mounts = new Map<string, TaskMountFacts>()
  const base = options.contribution ?? conversion
  const capture: ConversionContribution = {
    ...base,
    rules: base.rules.map((rule) => ({
      ...rule,
      async convert(unit, ctx) {
        for (const [table, rows] of unit.rows)
          sourceRows.set(table, [...(sourceRows.get(table) ?? []), ...rows])
        for (const task of unit.rows.get('tasks') ?? []) {
          const id = String(task.values.id)
          facts.set(id, ctx.lookup(TASK_FACTS).require(id))
          mounts.set(id, ctx.lookup(TASK_MOUNTS).require(id))
        }
        await rule.convert(unit, ctx)
      },
    })),
  }
  const generic: ConversionContribution = {
    rules: [],
    validators: [],
    lookups: [
      idSetLookup('users', 'id'),
      columnLookup('workflows', ['id'], ['builtin']),
      columnLookup('node_runs', ['id'], ['continuation_slot_key']),
      ...repositoryUrls.lookups.filter(
        (lookup) =>
          ![capture, ...(options.extra ?? [])].some((contribution) =>
            contribution.lookups.some(
              (other) => other.key.id === lookup.key.id && other.key.version === lookup.key.version,
            ),
          ),
      ),
    ],
  }
  const input = await h.input([capture, generic, ...(options.extra ?? [])], {
    candidateBuild: 'v2-t-fixtures',
    ...(options.source ? { source: options.source } : {}),
    ...(options.sourceScope ? { sourceScope: options.sourceScope } : {}),
  })
  const sink = new V2MemorySink()
  try {
    const summary = await runConversion(input, sink)
    return { summary, sink, facts, mounts, sourceRows }
  } finally {
    await input.source.close()
  }
}

export type TaskFixtureResult = Awaited<ReturnType<typeof convertTaskFixtures>>

function primary(row: TargetRow) {
  return {
    id: row.id as string,
    repoPath: row.repo_path as string,
    repoUrl: row.repo_url as string | null,
    cachedRepoId: row.cached_repo_id as string | null,
    baseBranch: row.base_branch as string,
    branch: row.branch as string,
    baseCommit: row.base_commit as string | null,
    worktreePath: row.worktree_path as string,
    workingBranch: row.working_branch as string | null,
    repoGroupId: row.repo_group_id as string | null,
    repoGroupName: row.repo_group_name as string | null,
    repoCount: row.repo_count as number,
    spaceKind: row.space_kind as string,
  }
}

export function sourceMount(
  row: TargetRow,
): TaskRepositoryMount & { readonly worktreeDirName?: string } {
  return decodeTaskRepositoryMount({
    repoIndex: row.repo_index as number,
    repoPath: row.repo_path as string,
    repoUrl: row.repo_url as string | null,
    cachedRepoId: row.cached_repo_id as string | null,
    baseBranch: row.base_branch as string,
    branch: row.branch as string,
    workingBranch: row.working_branch as string | null,
    baseCommit: row.base_commit as string | null,
    worktreePath: row.worktree_path as string,
    worktreeDirName: row.worktree_dir_name as string,
    mountPath: row.mount_path as string,
    subdir: row.subdir as string,
    readonly: row.readonly as boolean,
    readonlyDirtyCount: row.readonly_dirty_count as number | null,
    hasSubmodules: row.has_submodules as boolean | null,
    submoduleInitOk: row.submodule_init_ok as boolean | null,
    submoduleInitError: row.submodule_init_error as string | null,
  })
}

export function assertTaskProjection(result: TaskFixtureResult, taskId: string): void {
  const source = result.sourceRows.get('tasks')!.find((row) => row.values.id === taskId)!
  const repos = (result.sourceRows.get('task_repos') ?? [])
    .filter((row) => row.values.task_id === taskId)
    .map((row) => sourceMount(row.values))
  const paths = (result.sourceRows.get('task_space_nodes') ?? [])
    .filter((row) => row.values.task_id === taskId)
    .map((row) => row.values.node_path as string)
  // Freeze HEAD's epoch-1 directory fallback; the live epoch-2 helper no longer derives it.
  const old = projectStoredTaskRepositorySurface(
    primary(source.values),
    repos,
    paths.length ? paths : taskRepositoryNodePaths(repos.map((repo) => repo.mountPath)),
  )
  const lifecycle = result.sink.rows('tasks').find((row) => row.id === taskId)!
  const workspace = result.sink.rows('task_workspaces').find((row) => row.task_id === taskId)!
  const request = decodeRequestedSourceJson(workspace.requested_source as string)
  const targetMounts = result.sink
    .rows('task_repository_mounts')
    .filter((row) => row.task_id === taskId)
    .map((row) =>
      sourceMount({
        ...row,
        repo_index: row.ordinal!,
        worktree_dir_name: row.mount_path!,
        worktree_path: mountedWorktreePath(
          lifecycle.workspace_root_ref as string,
          row.mount_path as string,
        ),
        branch: row.branch ?? '',
        base_branch: row.base_branch ?? '',
      }),
    )
  const nodePaths = result.sink
    .rows('task_space_nodes')
    .filter((row) => row.task_id === taskId)
    .map((row) => row.node_path as string)
    .sort((a, b) => mountDepth(a) - mountDepth(b) || a.localeCompare(b))
  const actual = projectTaskRepositorySurface(
    {
      requestedSource: requestedSourceView(request),
      taskBranch: workspace.task_branch as string,
      workingBranch: workspace.working_branch as string | null,
      nodePaths,
    },
    lifecycle.workspace_root_ref as string | null,
    targetMounts,
    targetMounts.length === 0
      ? { primary: requestedSourcePrimary(request, workspace.task_branch as string), repoCount: 1 }
      : undefined,
  )
  expect(actual).toEqual(old)
}

/** Unknown rows are replayed from target evidence, never fed into normal execution. */
export function assertTaskHistoryProjection(result: TaskFixtureResult, taskId: string): void {
  const evidence = result.sink
    .rows('execution_legacy_evidence')
    .filter((row) => row.task_id === taskId)
  const stored = (row: TargetRow): TargetRow => {
    const evidence = JSON.parse(Buffer.from(row.content_inline_bytes as Uint8Array).toString()) as {
      source: CanonicalLogicalRow
      detail: { sourceColumns: string[] }
    }
    return Object.fromEntries(
      evidence.detail.sourceColumns.map((column, index) => [
        column,
        decodeLogicalValue(evidence.source.values[index]!),
      ]),
    ) as TargetRow
  }
  const task = stored(evidence.find((row) => row.record_kind === 'task')!)
  const repos = evidence
    .filter((row) => row.record_kind === 'task-repo')
    .map((row) => sourceMount(stored(row)))
  const source = result.sourceRows.get('tasks')!.find((row) => row.values.id === taskId)!
  const originalRepos = (result.sourceRows.get('task_repos') ?? [])
    .filter((row) => row.values.task_id === taskId)
    .map((row) => sourceMount(row.values))
  const legacy = projectStoredTaskRepositorySurface(
    primary(source.values),
    originalRepos,
    taskRepositoryNodePaths(originalRepos.map((repo) => repo.mountPath)),
  )
  const workspace = result.sink.rows('task_workspaces').find((row) => row.task_id === taskId)!
  const request = decodeRequestedSourceJson(workspace.requested_source as string)
  const replayed = projectTaskRepositorySurface(
    {
      requestedSource: requestedSourceView(request),
      taskBranch: workspace.task_branch as string,
      workingBranch: workspace.working_branch as string | null,
      nodePaths: taskRepositoryNodePaths(repos.map((repo) => repo.mountPath)),
    },
    task.worktree_path as string,
    repos,
    {
      primary: requestedSourcePrimary(request, workspace.task_branch as string),
      repoCount: task.repo_count as number,
      worktreeDirNames: new Map(
        repos.map((repo) => [repo.ordinal, repo.worktreeDirName ?? repo.mountPath]),
      ),
    },
  )
  expect(replayed).toEqual(legacy)
}

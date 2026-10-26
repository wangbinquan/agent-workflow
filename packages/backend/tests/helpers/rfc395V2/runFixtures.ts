import { TASK_DEFINITION_HOSTS, decodeTaskWorkgroupConfig } from '@agent-workflow/shared'
import { buildWorkgroupHostSnapshot } from '@/modules/task-execution/infrastructure/workgroupRuntimeConfig'
import { buildDynamicWorkflowGenerateSnapshot } from '@/services/orchestratorAgent'
import { workgroupConfig } from './taskFixtures'
import type { V2Harness } from '../rfc395V2Harness'
import { fixtureLookup } from '../rfc395V2Harness'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import {
  executionClass,
  type TaskFacts,
  type TaskMountFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'
import { RUN_DEFINITIONS } from '@/modules/task-execution/infrastructure/migration/run/lookups'
import type { FrozenRunDefinition } from '@/modules/task-execution/infrastructure/migration/run/definitions'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'

export const ordinaryDefinition = {
  $schema_version: 7,
  inputs: [],
  nodes: [{ id: 'ordinary', kind: 'script' }],
  edges: [],
}
export function taskFacts(
  taskId = 'task',
  status = 'done',
  over: Partial<TaskFacts> = {},
): TaskFacts {
  return {
    taskId,
    status,
    startedAt: 100,
    execution: executionClass(status),
    parentTaskId: null,
    rootTaskId: null,
    subjectKind: 'workflow',
    sourceId: null,
    definitionAnchorId: 'definition',
    engineKind: 'dag',
    spaceKind: 'internal',
    workflowVersion: 1,
    ...over,
  }
}
export function taskMounts(taskId = 'task', paths: readonly string[] = ['']): TaskMountFacts {
  return {
    taskId,
    layout:
      paths.length === 0
        ? 'none'
        : paths.length === 1 && paths[0] === ''
          ? 'single-root'
          : 'mounts',
    mounts: paths.map((mountPath, ordinal) => ({
      ordinal,
      repoKey: `mc1_fixture_repo_${taskId}_${ordinal}`,
      mountPath,
      worktreeDirName: mountPath,
    })),
  }
}
export function sourceRow(table: string, values: DecodedSourceRow): SourceRow {
  const definition = frozenEpoch1Contract.tables.find((entry) => entry.id === table)!
  const key = definition.migrationKey.map((column) => canonicalValue(values[column]!))
  return {
    table,
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey(table, key),
    values,
    canonical: {
      key: [...key],
      values: definition.columns.map((column) => canonicalValue(values[column.name] ?? null)),
    },
  }
}
export function runValues(id: string, over: DecodedSourceRow = {}): DecodedSourceRow {
  const definition = frozenEpoch1Contract.tables.find((entry) => entry.id === 'node_runs')!
  return {
    ...Object.fromEntries(definition.columns.map((column) => [column.name, null])),
    id,
    task_id: 'task',
    node_id: 'ordinary',
    scope_path: '',
    iteration: 0,
    retry_index: 0,
    review_iteration: 0,
    status: 'done',
    force_activated: false,
    operation_generation: 0,
    envelope_nonce: 'recorded-nonce',
    seq: 1,
    ...over,
  }
}
export function runSource(id: string, over: DecodedSourceRow = {}): SourceRow {
  return sourceRow('node_runs', runValues(id, over))
}

export function platformSnapshot(task: TaskFacts) {
  return task.subjectKind === 'workgroup' && task.engineKind === 'workgroup-turns'
    ? buildWorkgroupHostSnapshot(decodeTaskWorkgroupConfig(workgroupConfig()).runtime.config!)
    : task.subjectKind === 'workgroup' && task.engineKind === 'dw-generate'
      ? buildDynamicWorkflowGenerateSnapshot()
      : ordinaryDefinition
}

export async function writeTask(
  h: V2Harness,
  task: TaskFacts,
  snapshot: unknown = platformSnapshot(task),
): Promise<void> {
  await h.write('tasks', [
    {
      id: task.taskId,
      name: task.taskId,
      workflow_id:
        task.subjectKind === 'workgroup' ? TASK_DEFINITION_HOSTS.workgroup.id : 'frozen-workflow',
      ...(task.subjectKind === 'workgroup'
        ? {
            workgroup_id: 'group',
            workgroup_config_json: workgroupConfig(
              task.engineKind === 'workgroup-turns' ? 'leader_worker' : 'dynamic_workflow',
            ),
          }
        : {}),
      workflow_snapshot: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot),
      repo_path: '/frozen',
      worktree_path: '/frozen',
      base_branch: 'main',
      branch: 'task-branch',
      status: task.status,
      inputs: '{}',
      started_at: task.startedAt,
      space_kind: task.spaceKind,
    },
  ])
}
export function conversionWithDefinitions(
  definitions: readonly (readonly [string, FrozenRunDefinition])[],
): ConversionContribution {
  return {
    ...conversion,
    lookups: [
      ...conversion.lookups.filter((lookup) => lookup.key.id !== RUN_DEFINITIONS.id),
      fixtureLookup(RUN_DEFINITIONS, definitions),
    ],
  }
}
export function selectionRandom(seed: number) {
  let value = seed >>> 0
  return (max: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return (value >>> 8) % max
  }
}

/** K8 history shapes written through the frozen epoch-1 raw writer, never live A1 builders. */
export async function seedFrozenSelectionFamilies(h: V2Harness, seed: number, status: string) {
  const next = selectionRandom(seed)
  const prefix = `v2-${seed}-${status}`
  const tasks = [
    taskFacts(`${prefix}-dag`, status),
    taskFacts(`${prefix}-host`, status, {
      subjectKind: 'workgroup',
      engineKind: 'workgroup-turns',
    }),
    taskFacts(`${prefix}-dw`, status, { subjectKind: 'workgroup', engineKind: 'dw-generate' }),
  ]
  const dag = tasks[0]!.taskId,
    host = tasks[1]!.taskId,
    dw = tasks[2]!.taskId
  const snapshot = {
    $schema_version: 7,
    inputs: [],
    nodes: [
      {
        id: 'wrapper',
        kind: 'wrapper-fanout',
        nodeIds: ['inner', 'shared', 'agg'],
        shardSourcePort: 'items',
      },
      { id: 'inner', kind: 'script' },
      { id: 'shared', kind: 'script' },
      { id: 'agg', kind: 'agent-single', agentName: 'aggregator' },
      { id: 'ordinary', kind: 'script' },
    ],
    edges: [
      {
        id: 'fanout-input',
        source: { nodeId: 'wrapper', portName: 'items' },
        target: { nodeId: 'inner', portName: 'items' },
        boundary: 'wrapper-input',
      },
      {
        id: 'fanout-aggregate',
        source: { nodeId: 'inner', portName: 'out' },
        target: { nodeId: 'agg', portName: 'in' },
      },
      {
        id: 'fanout-output',
        source: { nodeId: 'agg', portName: 'out' },
        target: { nodeId: 'wrapper', portName: 'out' },
        boundary: 'wrapper-output',
      },
    ],
  }
  for (const task of tasks)
    await writeTask(h, task, task.taskId === dag ? snapshot : platformSnapshot(task))
  const rows: DecodedSourceRow[] = []
  const add = (id: string, over: DecodedSourceRow) => rows.push(runValues(id, over))
  const parent = `${prefix}-parent`,
    commitParent = `${prefix}-commit-parent`
  const generations = [`${prefix}-g0`, `${prefix}-g1`]
  add(parent, {
    task_id: dag,
    seq: -10,
    iso_worktree_path: 'iso',
    iso_base_snapshot: 'base',
    merge_state: 'conflict-human',
  })
  for (const [index, id] of generations.entries())
    add(id, { task_id: dag, node_id: 'wrapper', seq: -8 + index, rerun_cause: 'wrapper-init' })
  add(commitParent, {
    task_id: dag,
    node_id: '__commit_push__:ordinary',
    parent_node_run_id: parent,
    seq: -5,
    rerun_cause: 'commit-push',
    commit_push_json: '{ "ok": true }',
  })
  const assignments: DecodedSourceRow[] = []
  const statuses = ['done', 'failed', 'interrupted', 'pending', 'canceled', 'running'] as const
  for (let round = 0; round < 12; round++)
    for (let category = 0; category < 11; category++) {
      const id = `${prefix}-${category}-${(round * 7) % 13}`
      const iteration = next(2),
        generation = generations[next(2)]!
      const spec: DecodedSourceRow = {
        status: statuses[next(statuses.length)]!,
        seq: round % 4 === 0 ? null : round * 11 + category + 1,
        retry_index: next(5),
        iteration,
        started_at: next(3) === 0 ? null : next(50),
        merge_state: null,
      }
      if (category < 3)
        add(id, {
          ...spec,
          task_id: dag,
          node_id: ['inner', 'shared', 'agg'][category]!,
          parent_node_run_id: generation,
          container_run_id: generation,
          scope_path: `wrapper:${iteration}`,
          shard_key: category === 0 ? ['a', ''][next(2)]! : null,
          shard_value_hash: 'hash-a',
          rerun_cause: category === 2 ? 'fanout-aggregator' : 'fanout-shard',
        })
      else if (category === 3) {
        add(id, {
          ...spec,
          task_id: host,
          node_id: round % 2 === 0 ? '__wg_leader__' : '__wg_member__',
          shard_key: [null, '', 'assignment', 'msg:member:message'][next(4)]!,
          wg_round: next(4),
          rerun_cause: 'wg-protocol-retry',
        })
        assignments.push({
          id: `${id}-assignment`,
          task_id: host,
          source: 'system',
          title: 'persisted assignment',
          status: 'done',
          node_run_id: id,
          created_at: 100,
          updated_at: 100,
        })
      } else {
        const [nodeId, cause, owner, taskId] = [
          ['__repo_prep__', 'retry-node', null, dag],
          ['__commit_push__:ordinary', 'commit-push', parent, dag],
          ['__commit_push__:ordinary', 'commit-push-session', commitParent, dag],
          [`__merge_resolve__:ordinary:${iteration}`, 'merge-resolve', parent, dag],
          ['__dw_orchestrator__', 'dw-generate', null, dw],
          ['__dw_orchestrator__', 'dw-gate', null, dw],
          ['__wg_leader__', 'wg-gate', null, host],
        ][category - 4]!
        add(id, {
          ...spec,
          task_id: taskId!,
          node_id: nodeId!,
          rerun_cause: cause!,
          parent_node_run_id: owner!,
          ...(category === 5 ? { commit_push_json: '{ "ok": true }' } : {}),
          ...(category === 4
            ? { retry_index: round < 3 || round === 4 ? 9 : spec.retry_index! }
            : {}),
        })
      }
    }
  await h.write('node_runs', rows)
  await h.write('node_run_seq_allocations', [
    { seq: 500, task_id: dag, node_run_id: 'pruned-run', allocated_at: 99 },
  ])
  await h.write('workgroup_assignments', assignments)
  await h.write('task_workspace_preparations', [
    {
      id: `${prefix}-preparation`,
      admission_key: `${prefix}-admission`,
      request_digest: 'frozen-request',
      lane: 'repository-preparation',
      state: 'admitted',
      admitted_task_id: dag,
      created_at: 100,
      updated_at: 100,
    },
  ])
  await h.write('workgroup_task_state', [
    { task_id: host, gate_status: 'approved', updated_at: 100 },
    { task_id: dw, dw_state_json: '{"phase":"generating"}', updated_at: 100 },
  ])
  return {
    tasks,
    rows: rows.map((row) => sourceRow('node_runs', row)),
    generations,
    contribution: conversion,
    mounts: tasks.map((task) => taskMounts(task.taskId)),
    dag,
  }
}

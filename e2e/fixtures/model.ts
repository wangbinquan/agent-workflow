// RFC-395 II-a A1: Playwright supplies projection specs; all epoch-1 SQL for these fixtures lives here.
// A2 replaces the task/mount/checkpoint SQL codec; A3 replaces run allocation/provenance SQL.
// Node loads this module. Bun-only persistence imports must remain type-only.
import {
  encodeTaskCheckpointColumns,
  taskCheckpointColumns,
} from '../../packages/backend/src/modules/task-execution/infrastructure/taskCheckpointCodec'
import { taskRepositoryMountIdentity } from '../../packages/backend/src/modules/task-execution/infrastructure/taskRepositoryCodec'
import { deriveTaskCreationLineage } from '../../packages/backend/src/modules/task-execution/domain/taskCreation'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  AgentFixtureSpec,
  ClarifyRoundFixtureSpec,
  NodeRunFixtureSpec,
  NodeRunOutputFixtureSpec,
  TaskFixtureSpec,
  TaskRepoFixtureSpec,
  WorkflowFixtureSpec,
} from '../../packages/backend/tests/helpers/model'

type Entry = {
  table: string
  property: string
  physical: string
  spec: string
  target: string
  json?: boolean
}
const inventory = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../packages/backend/tests/fixtures/rfc395-column-destinations.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as { columns: Entry[] }
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return String(value)
  return "'" + String(value).replaceAll("'", "''") + "'"
}
function json(value: unknown): string | null {
  return value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)
}
function insert(
  table: string,
  row: Record<string, unknown>,
  expressions: Record<string, string> = {},
): string {
  const columns = [...new Set([...Object.keys(row), ...Object.keys(expressions)])]
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => expressions[column] ?? literal(row[column])).join(', ')});`
}
function encode(table: string, spec: object): Record<string, unknown> {
  const input = spec as Record<string, unknown>
  return Object.fromEntries(
    inventory.columns
      .filter(
        (entry) =>
          entry.table === table &&
          !['repos', 'checkpoints', 'consumedEdges'].includes(entry.spec) &&
          entry.target !== 'deleted-shape' &&
          input[entry.spec] !== undefined,
      )
      .map((entry) => [entry.physical, entry.json ? json(input[entry.spec]) : input[entry.spec]]),
  )
}
function rows<S>(input: S | readonly S[]): readonly S[] {
  return Array.isArray(input) ? input : [input as S]
}
function simple<S extends object>(
  table: string,
  input: S | readonly S[],
  generatedId = true,
): string {
  return rows(input)
    .map((spec) => {
      const row = encode(table, spec)
      if (generatedId) row.id ??= randomUUID()
      return insert(table, row)
    })
    .join('\n')
}
export function taskFixtureSql(input: TaskFixtureSpec | readonly TaskFixtureSpec[]): string {
  return rows(input)
    .map((spec) => {
      const row = encode('tasks', spec)
      row.id ??= randomUUID()
      row.name ??= 'task-' + String(row.id).slice(-10)
      row.repo_count = 1
      // Child fixtures are emitted before their parent rows can be read. Their SQL triggers
      // remain an epoch-1 fixture transport; production always supplies these fields explicitly.
      if (spec.parentTaskId == null) {
        const lineage = deriveTaskCreationLineage(String(row.id), spec.workflowVersion ?? null, {
          kind: 'root',
          launchOrigin: spec.launchOrigin ?? 'manual',
        })
        row.execution_lineage_id ??= lineage.executionLineageId
        row.lineage_slot_path_json ??= lineage.lineageSlotPathJson
      }
      return (
        insert('tasks', row) +
        '\n' +
        (spec.repos?.length
          ? taskRepoFixtureSql(spec.repos.map((repo) => ({ ...repo, taskId: String(row.id) })))
          : '')
      )
    })
    .join('\n')
}
export function taskRepoFixtureSql(
  input: TaskRepoFixtureSpec | readonly TaskRepoFixtureSpec[],
): string {
  return rows(input)
    .map((spec) => {
      const row = encode('task_repos', spec)
      row.worktree_dir_name = taskRepositoryMountIdentity(spec.mountPath ?? '').worktreeDirName
      return (
        insert('task_repos', row) +
        ` UPDATE tasks SET repo_count = max(1, (SELECT count(*) FROM task_repos WHERE task_id = ${literal(spec.taskId)})) WHERE id = ${literal(spec.taskId)};`
      )
    })
    .join('\n')
}
export function nodeRunFixtureSql(
  input: NodeRunFixtureSpec | readonly NodeRunFixtureSpec[],
): string {
  return rows(input)
    .map((spec) => {
      const row = encode('node_runs', spec)
      row.id ??= randomUUID()
      const expressions: Record<string, string> = {}
      const prefix =
        spec.seq === undefined
          ? insert('node_run_seq_allocations', {
              task_id: spec.taskId,
              node_run_id: row.id,
              allocated_at: Date.now(),
            })
          : ''
      if (spec.seq === undefined)
        expressions.seq = `(SELECT seq FROM node_run_seq_allocations WHERE node_run_id = ${literal(row.id)})`
      if (spec.consumedEdges !== undefined)
        row.consumed_upstream_runs_json = JSON.stringify(
          Object.fromEntries(
            spec.consumedEdges.map((edge) => [edge.producerNodeId, edge.producerRunId]),
          ),
        )
      if (spec.checkpoints !== undefined) {
        Object.assign(
          expressions,
          checkpointExpressions(spec.checkpoints, literal(spec.taskId), false),
        )
      }
      return (
        'SAVEPOINT rfc395_fixture; ' +
        prefix +
        insert('node_runs', row, expressions) +
        ' RELEASE rfc395_fixture;'
      )
    })
    .join('\n')
}
export const workflowFixtureSql = (
  spec: WorkflowFixtureSpec | readonly WorkflowFixtureSpec[],
): string => simple('workflows', spec)
export const agentFixtureSql = (spec: AgentFixtureSpec | readonly AgentFixtureSpec[]): string =>
  simple('agents', spec)
export const clarifyRoundFixtureSql = (
  spec: ClarifyRoundFixtureSpec | readonly ClarifyRoundFixtureSpec[],
): string => simple('clarify_rounds', spec)
export const nodeRunOutputFixtureSql = (
  spec: NodeRunOutputFixtureSpec | readonly NodeRunOutputFixtureSpec[],
): string => simple('node_run_outputs', spec, false)

/** A bound value keeps existing sqlite CLI placeholders and their argument order. */
export const fixtureSqlParameter = Symbol('fixture-sql-parameter')
type SqlValue = string | number | boolean | null | typeof fixtureSqlParameter
type SqlWhere = Record<string, SqlValue | { $in?: readonly SqlValue[]; $ne?: SqlValue }>
function column(table: string, field: string): string {
  const entry = inventory.columns.find((entry) => entry.table === table && entry.spec === field)
  if (!entry || ['repos', 'checkpoints', 'consumedEdges'].includes(field))
    throw new Error('Unsupported fixture SQL field: ' + field)
  return entry.physical
}
function parameter(value: SqlValue): string {
  return value === fixtureSqlParameter ? '?' : literal(value)
}
function predicate(table: string, where: SqlWhere): string {
  return (
    Object.entries(where)
      .map(([field, value]) => {
        const name = column(table, field)
        if (value === null) return `${name} IS NULL`
        if (typeof value === 'object') {
          if (value.$in) return `${name} IN (${value.$in.map(parameter).join(', ')})`
          if ('$ne' in value)
            return value.$ne === null
              ? `${name} IS NOT NULL`
              : `${name} <> ${parameter(value.$ne!)}`
          throw new Error('Unsupported fixture SQL predicate')
        }
        return `${name} = ${parameter(value)}`
      })
      .join(' AND ') || '1 = 1'
  )
}
function selectFixturesSql(
  table: string,
  where: SqlWhere,
  fields: Readonly<Record<string, string>>,
): string {
  return `SELECT ${Object.entries(fields)
    .map(([alias, field]) => `${column(table, field)} AS "${alias}"`)
    .join(', ')} FROM ${table} WHERE ${predicate(table, where)}`
}
export const readTaskFixturesSql = (
  where: SqlWhere,
  fields: Readonly<Record<string, keyof TaskFixtureSpec>>,
) => selectFixturesSql('tasks', where, fields)
export const readNodeRunFixturesSql = (
  where: SqlWhere,
  fields: Readonly<Record<string, keyof NodeRunFixtureSpec>>,
) => selectFixturesSql('node_runs', where, fields)
export function patchTaskFixtureSql(where: SqlWhere, patch: Partial<TaskFixtureSpec>): string {
  const values = encode('tasks', patch)
  return `UPDATE tasks SET ${Object.entries(values)
    .map(([key, value]) => `${key} = ${literal(value)}`)
    .join(', ')} WHERE ${predicate('tasks', where)};`
}
function singleRootSql(taskId: string): string {
  return `(NOT EXISTS (SELECT 1 FROM task_repos WHERE task_id = ${taskId}) OR ((SELECT count(*) FROM task_repos WHERE task_id = ${taskId}) = 1 AND EXISTS (SELECT 1 FROM task_repos WHERE task_id = ${taskId} AND mount_path = '')))`
}
const checkpointColumns = {
  preSnapshot: ['pre_snapshot', 'pre_snapshot_repos_json'],
  isolationBase: ['iso_base_snapshot', 'iso_base_snapshot_repos_json'],
  nodeTree: ['iso_node_tree', 'iso_node_tree_repos_json'],
  submodules: ['iso_submodules_json', 'iso_submodules_repos_json'],
} as const
function checkpointExpressions(
  checkpoints: NonNullable<NodeRunFixtureSpec['checkpoints']>,
  taskId: string,
  patch: boolean,
): Record<string, string> {
  const scalarValues = encodeTaskCheckpointColumns(checkpoints, 'single-root')
  const mapValues = encodeTaskCheckpointColumns(checkpoints, 'mounts')
  const expressions: Record<string, string> = {}
  for (const [field, scalar, map] of taskCheckpointColumns) {
    if (
      patch &&
      checkpoints.length > 0 &&
      !checkpoints.some((checkpoint) => Object.hasOwn(checkpoint, field))
    )
      continue
    const [scalarColumn, mapColumn] = checkpointColumns[field]
    expressions[scalarColumn] =
      `CASE WHEN ${singleRootSql(taskId)} THEN ${literal(scalarValues[scalar])} ELSE NULL END`
    expressions[mapColumn] =
      `CASE WHEN ${singleRootSql(taskId)} THEN NULL ELSE ${literal(mapValues[map])} END`
  }
  return expressions
}
export function patchNodeRunFixtureSql(
  where: SqlWhere,
  patch: Partial<NodeRunFixtureSpec>,
): string {
  const assignments = Object.entries(encode('node_runs', patch)).map(
    ([key, value]) => `${key} = ${literal(value)}`,
  )
  if (patch.checkpoints !== undefined)
    assignments.push(
      ...Object.entries(checkpointExpressions(patch.checkpoints, 'node_runs.task_id', true)).map(
        ([column, value]) => `${column} = ${value}`,
      ),
    )
  return `UPDATE node_runs SET ${assignments.join(', ')} WHERE ${predicate('node_runs', where)};`
}
export const deleteNodeRunFixturesSql = (where: SqlWhere): string =>
  `DELETE FROM node_runs WHERE ${predicate('node_runs', where)};`
/** Read one checkpoint component by mount identity, independent of epoch-1 scalar/map layout. */
export function readNodeRunCheckpointFixturesSql(
  where: SqlWhere,
  mountPath: string,
  field: keyof typeof checkpointColumns,
): string {
  const [scalar, map] = checkpointColumns[field]
  const scalarValue = mountPath === '' ? scalar : 'NULL'
  const path = '$.' + JSON.stringify(mountPath)
  return `SELECT id, CASE WHEN ${singleRootSql('node_runs.task_id')} THEN ${scalarValue} ELSE json_extract(${map}, ${literal(path)}) END AS "${field}" FROM node_runs WHERE ${predicate('node_runs', where)}`
}

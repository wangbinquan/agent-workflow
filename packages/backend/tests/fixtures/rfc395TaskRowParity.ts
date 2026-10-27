// RFC-395 CI-1: preserve the existing parity exclusions at their epoch-2
// destinations. Only normalize values already excluded by the caller, and
// assert their relationship to this launch before comparing the remaining row.
import { expect } from 'bun:test'
import { comparableTaskRow, VOLATILE_TASK_ROW_COLUMNS } from '../helpers/taskRowParity'

export function normalizeEpoch2TaskFacts(
  row: Record<string, unknown>,
  volatile: ReadonlySet<string>,
): Record<string, unknown> {
  const result = { ...row }
  const normalized = (value: unknown, expected: unknown, field: string) => {
    expect(value, `epoch-2 parity: ${field} must retain this launch's value`).toBe(expected)
    return value === null || value === undefined ? value : `<${field}>`
  }
  if (volatile.has('worktreePath') && row.workspaceRootRef !== undefined)
    result.workspaceRootRef = normalized(
      row.workspaceRootRef,
      row.worktreePath === '' ? null : row.worktreePath,
      'worktreePath',
    )
  if (typeof row.requestedSource === 'string') {
    const source = JSON.parse(row.requestedSource) as Record<string, unknown>
    expect(row.requestedSource).toBe(JSON.stringify(source))
    for (const [field, legacy] of [
      ['repoPath', 'repoPath'],
      ['legacyBaseCommit', 'baseCommit'],
    ] as const)
      if (volatile.has(legacy)) source[field] = normalized(source[field], row[legacy], legacy)
    result.requestedSource = JSON.stringify(source)
  }
  const sourceIdField =
    row.subjectKind === 'workflow'
      ? 'workflowId'
      : row.subjectKind === 'agent'
        ? 'sourceAgentId'
        : row.subjectKind === 'workgroup'
          ? 'workgroupId'
          : undefined
  if (sourceIdField && volatile.has(sourceIdField))
    result.sourceId = normalized(row.sourceId, row[sourceIdField], sourceIdField)
  if (row.subjectKind === 'agent' && volatile.has('sourceAgentName'))
    result.sourceName = normalized(row.sourceName, row.sourceAgentName, 'sourceAgentName')
  if (volatile.has('workgroupConfigJson') && typeof row.workgroupLaunchConfigJson === 'string') {
    const launch = JSON.parse(row.workgroupLaunchConfigJson) as Record<string, unknown>
    expect(row.workgroupLaunchConfigJson).toBe(JSON.stringify(launch))
    const runtime = JSON.parse(String(row.workgroupConfigJson)) as Record<string, unknown>
    for (const field of ['workgroupId', 'workgroupName', 'leaderMemberId'])
      if (field in launch) launch[field] = normalized(launch[field], runtime[field], field)
    result.workgroupLaunchConfigJson = JSON.stringify(launch)
  }
  if (volatile.has('id') && Array.isArray(row.repos))
    result.repos = row.repos.map((repo: Record<string, unknown>) => {
      expect(repo.repoKey, 'mount identity must retain this task and mount path').toBe(
        `${String(row.id)}:mount:${String(repo.mountPath)}`,
      )
      return { ...repo, repoKey: `<taskId>:mount:${String(repo.mountPath)}` }
    })
  return result
}

export function comparableEpoch2TaskRow(
  row: Record<string, unknown>,
  extraVolatile: readonly string[] = [],
): Record<string, unknown> {
  return comparableTaskRow(
    normalizeEpoch2TaskFacts(row, new Set([...VOLATILE_TASK_ROW_COLUMNS, ...extraVolatile])),
    extraVolatile,
  )
}

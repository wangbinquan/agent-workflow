// RFC-164 PR-4 + follow-up — the /tasks "workflow" cell for a workgroup task.
//
// A workgroup task is FK-anchored to the builtin `__workgroup_host__` workflow
// (WORKGROUP_HOST_WORKFLOW_ID), because tasks.workflow_id / workflow_snapshot
// are NOT NULL. PR-4 first only added a StatusChip badge but left the cell
// LINKING to that host workflow (`to="/workflows/$id"` with the host id) and
// PRINTING its name (`workflowName` === "__workgroup_host__"). The follow-up
// fix (this lock) makes the cell surface the GROUP: link to /workgroups/$name
// with the live-joined `row.workgroupName`, never the host anchor.
//
// Source-level lock, same idiom as tasks-list-name-column.test.ts — the list
// route renders against live queries, so pinning the wiring + i18n keys here
// plus the backend join lock (tasks-list-workgroup-name.test.ts) fully cover
// the regression without a full RTL render.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')

// The "workflow" <td> spans from its `row.workgroupId != null ?` branch to the
// next column's <TaskStatusChip>. The workgroup branch is everything before the
// ternary's else (the plain `/workflows/$id` link).
const cell = SRC.slice(SRC.indexOf('row.workgroupId != null ?'), SRC.indexOf('<TaskStatusChip'))
const wgBranch = cell.slice(0, cell.indexOf('to="/workflows/$id"'))

describe('routes/tasks.tsx — workgroup cell targets the group, not the host workflow', () => {
  test('the workflow cell branches on row.workgroupId', () => {
    expect(cell).toContain('row.workgroupId != null ?')
  })

  test('a workgroup task links to /workgroups/$name with the group name', () => {
    // The whole point of the fix: navigate to the GROUP, labelled by its name.
    expect(wgBranch).toContain('to="/workgroups/$name"')
    expect(wgBranch).toContain('params={{ name: row.workgroupName }}')
    expect(wgBranch).toContain('{row.workgroupName}')
  })

  test('the workgroup branch never falls back to the host workflow link/name', () => {
    // Regression guard: the branch that renders for a workgroup task must not
    // reach the `/workflows/$id` link nor print `row.workflowName` (which is
    // the internal "__workgroup_host__" anchor name).
    expect(wgBranch).not.toContain('to="/workflows/$id"')
    expect(wgBranch).not.toContain('row.workflowName')
  })

  test('the badge (StatusChip + label + per-row testid) rides in the workgroup branch', () => {
    expect(wgBranch).toContain('<StatusChip')
    expect(wgBranch).toContain("t('tasks.workgroupBadge')")
    expect(wgBranch).toContain('task-workgroup-badge-${row.id}')
  })

  test('non-workgroup tasks keep the plain workflow link', () => {
    expect(cell).toContain('to="/workflows/$id"')
    expect(cell).toContain('{row.workflowName ?? row.workflowId}')
  })

  test('both bundles label the badge', () => {
    expect(zhCN.tasks.workgroupBadge).toBe('工作组')
    expect(enUS.tasks.workgroupBadge.length).toBeGreaterThan(0)
  })
})

// RFC-164 PR-4 + follow-up — the /tasks "workflow" cell for a workgroup task,
// and (RFC-164 follow-up²) the identical treatment for single-agent tasks.
//
// A workgroup / single-agent task is FK-anchored to a builtin `__workgroup_host__`
// / `__agent_host__` workflow (WORKGROUP_HOST_WORKFLOW_ID / AGENT_HOST_WORKFLOW_ID),
// because tasks.workflow_id / workflow_snapshot are NOT NULL. A naive cell would
// LINK to that host workflow and PRINT its internal name. The fix surfaces the
// OWNING resource instead — /workgroups/$name or /agents/$name with a kind badge,
// never the anchor.
//
// That decision now lives in the shared components/TaskSubjectLink.tsx (the list
// cell AND the detail page share one implementation), and its behavior — link
// targets, badges, host-anchor non-leak, deleted-resource em-dash — is covered
// behaviorally by tests/task-subject-link.test.tsx. This file keeps a thin
// source lock: the /tasks list cell DELEGATES to that component (never
// re-inlining a host-workflow link), plus the i18n badge labels.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')

describe('routes/tasks.tsx — subject cell delegates to TaskSubjectLink (no host-workflow leak)', () => {
  test('the subject <td> renders <TaskSubjectLink> with the row + badge', () => {
    expect(SRC).toContain('<TaskSubjectLink task={row} taskId={row.id} badge />')
  })

  test('the list no longer inlines a subject link (moved into the shared component)', () => {
    // The only /workflows/$id + /workgroups/$name links used to live in this
    // cell; they moved into TaskSubjectLink, so a workgroup/agent row can no
    // longer fall back to the __workgroup_host__ / __agent_host__ anchor here.
    expect(SRC).not.toContain('to="/workflows/$id"')
    expect(SRC).not.toContain('to="/workgroups/$name"')
  })

  test('both bundles label the workgroup + agent subject badges', () => {
    expect(zhCN.tasks.workgroupBadge).toBe('工作组')
    expect(enUS.tasks.workgroupBadge.length).toBeGreaterThan(0)
    expect(zhCN.tasks.agentBadge).toBe('代理')
    expect(enUS.tasks.agentBadge.length).toBeGreaterThan(0)
  })
})

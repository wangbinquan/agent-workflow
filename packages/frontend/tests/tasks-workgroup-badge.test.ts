// RFC-164 PR-4 + follow-up — the /tasks "workflow" cell for a workgroup task,
// and (RFC-164 follow-up²) the identical treatment for single-agent tasks.
//
// A workgroup / single-agent task is FK-anchored to a builtin `__workgroup_host__`
// / `__agent_host__` workflow (WORKGROUP_HOST_WORKFLOW_ID / AGENT_HOST_WORKFLOW_ID),
// because tasks.workflow_id / workflow_snapshot are NOT NULL. A naive cell would
// LINK to that host workflow and PRINT its internal name. The fix surfaces the
// OWNING resource instead — /workgroups/$id or /agents/$id with a kind badge,
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

describe('routes/tasks.tsx — task metadata consumes normalized source identity', () => {
  test('the compact metadata renders the registered source and localized subject', () => {
    expect(SRC).toContain('t(taskSourceRegistration(item.sourceId).labelKey)')
    expect(SRC).toContain('const subject = localized(item.subject.label, language)')
    expect(SRC).not.toContain('<TaskSubjectLink task={item}')
  })

  test('the list no longer inlines a subject link (moved into the shared component)', () => {
    // The only /workflows/$id + /workgroups/$name links used to live in this
    // cell; they moved into TaskSubjectLink, so a workgroup/agent row can no
    // longer fall back to the __workgroup_host__ / __agent_host__ anchor here.
    expect(SRC).not.toContain('to="/workflows/$id"')
    expect(SRC).not.toContain('to="/workgroups/$name"')
  })

  test('both bundles label every registered task source', () => {
    expect(zhCN.taskWizard.kindWorkgroup).toBe('工作组')
    expect(enUS.taskWizard.kindWorkgroup.length).toBeGreaterThan(0)
    expect(zhCN.taskWizard.kindAgent.length).toBeGreaterThan(0)
    expect(enUS.taskWizard.kindAgent.length).toBeGreaterThan(0)
    expect(zhCN.taskWizard.kindWorkflow).toBe('工作流')
    expect(enUS.taskWizard.kindWorkflow.length).toBeGreaterThan(0)
    expect(zhCN.taskWizard.kindDigitalEmployee).toBe('数字员工')
    expect(enUS.taskWizard.kindDigitalEmployee.length).toBeGreaterThan(0)
  })
})

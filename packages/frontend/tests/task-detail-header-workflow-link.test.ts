// 2026-06-24: surface a jump link to the task's execution SUBJECT in the task
// detail PAGE HEADER (visible by default, before the tab bar). Previously the
// only subject link lived inside the "details" tab's meta list, which sits
// behind a NON-default tab (the default is "workflow-status") — so a user
// landing on a task could not reach its subject without switching tabs.
//
// RFC-164 follow-up: the header used to hardcode a `/workflows/$id` link showing
// `workflowName`, which for a workgroup / single-agent task LEAKED the internal
// `__workgroup_host__` / `__agent_host__` FK-anchor + a dead workflow link. Both
// the header and the details-tab meta row now delegate to the shared
// components/TaskSubjectLink.tsx, which resolves workgroup / agent / workflow and
// links to the owning resource. Link-target + badge behavior is covered by
// tests/task-subject-link.test.tsx; this file locks the header/details-tab WIRING
// (that both spots render the component, that the header labels the kind exactly
// once — via the badge, 2026-07-14 — and that the details-tab meta row keeps its
// <dt> label + parenthesised ULID for plain workflow tasks).
//
// Source-level scan because the routed component registers against TanStack
// Router at runtime and is awkward to mount in happy-dom. We split the source at
// the page-section workspace so the assertions prove the link lives in the always-visible
// header region, not just "somewhere in the file".

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)

// Everything before the page-section workspace is always-rendered header chrome;
// everything after includes the section navigation + the Details section.
const SECTION_MARKER = 'task-detail__workspace'
const HEADER = SRC.split(SECTION_MARKER)[0] ?? ''
const AFTER_HEADER = SRC.slice(SRC.indexOf(SECTION_MARKER))

describe('task detail header — subject jump link', () => {
  test('the page-section marker exists so the header/sections split is valid', () => {
    expect(SRC).toContain(SECTION_MARKER)
    expect(HEADER.length).toBeGreaterThan(0)
  })

  test('header carries a dedicated subject jump link (not buried in a tab)', () => {
    expect(HEADER).toContain('task-detail__workflow')
    expect(HEADER).toContain('<TaskSubjectLink task={tk} taskId={tk.id} badge />')
  })

  test('header resolves the subject via TaskSubjectLink, not a hardcoded workflow link', () => {
    const block = HEADER.slice(HEADER.indexOf('task-detail__workflow'))
    // The old leak: a raw /workflows/$id link printing workflowName. Both must
    // be gone from the header (they live inside TaskSubjectLink now).
    expect(block).not.toMatch(/to="\/workflows\/\$id"/)
    expect(block).not.toContain('tk.workflowName ?? tk.workflowId')
  })

  test('the header prints the kind ONCE — badge only, no 「工作流」text label', () => {
    // 2026-07-14: TaskSubjectLink's badge now covers all three kinds (workflow
    // rows used to render bare, so the header prepended a 「工作流」text label to
    // compensate). Keeping both would print the kind twice ("工作流 My Flow
    // [工作流]"), so the header label is gone and the badge is the single source.
    // The details-tab meta row still labels via its <dt> — see the test below —
    // because it passes badge={false}.
    const block = HEADER.slice(HEADER.indexOf('task-detail__workflow'))
    expect(block).not.toContain("t('tasks.metaWorkflow')")
    expect(block).not.toContain("subjectKind === 'workflow'")
  })

  test('the details-tab subject meta row also delegates to TaskSubjectLink', () => {
    // The richer meta row (subject-aware <dt> + parenthesised ULID for workflow
    // tasks) stays in the details tab — this change keeps the header shortcut and
    // routes both through the same component.
    expect(AFTER_HEADER).toContain('<TaskSubjectLink task={tk} taskId={tk.id} />')
    expect(AFTER_HEADER).toContain("t('tasks.metaWorkflow')")
    // ULID parenthetical is workflow-only now.
    expect(AFTER_HEADER).toContain("subjectKind === 'workflow' && tk.workflowName !== null")
  })
})

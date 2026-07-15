// Locks in that the tasks list table and the task detail render the joined
// workflow name (with a fallback to the workflow id when the row was deleted),
// so a refactor can't silently revert to "show the opaque ULID only" — which is
// exactly what we moved away from.
//
// RFC-164 follow-up: the workflow-name-with-fallback + /workflows/$id link moved
// into the shared components/TaskSubjectLink.tsx (the list cell and the detail
// header/meta now delegate to it, alongside the workgroup/agent subjects). So we
// pin the tokens in the COMPONENT now, plus that both routes delegate to it.
// Source text (not a routed mount) because tasks.tsx / tasks.detail.tsx register
// against TanStack Router and are awkward to mount in happy-dom; behavior is
// covered by tests/task-subject-link.test.tsx.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const LIST_SRC = path.join(HERE, '../src/routes/tasks.tsx')
const DETAIL_SRC = path.join(HERE, '../src/routes/tasks.detail.tsx')
const SUBJECT_SRC = path.join(HERE, '../src/components/TaskSubjectLink.tsx')

describe('tasks list shows workflow name', () => {
  test('table header includes the Subject column (RFC-192: colWorkflow → colSubject)', async () => {
    const src = await fs.readFile(LIST_SRC, 'utf8')
    expect(src).toMatch(/<th>\{t\('tasks\.colSubject'\)\}<\/th>/)
  })

  test('the subject cell delegates to TaskSubjectLink', async () => {
    const src = await fs.readFile(LIST_SRC, 'utf8')
    expect(src).toContain('<TaskSubjectLink')
  })
})

describe('TaskSubjectLink renders the workflow name with an id fallback + link', () => {
  test('workflow-kind renders workflowName ?? workflowId, linked to /workflows/$id', async () => {
    const src = await fs.readFile(SUBJECT_SRC, 'utf8')
    expect(src).toMatch(/task\.workflowName \?\? task\.workflowId/)
    expect(src).toMatch(/to="\/workflows\/\$id"\s+params=\{\{ id: task\.workflowId \}\}/)
  })
})

describe('task detail shows the subject (workflow name kept for workflow tasks)', () => {
  test('detail delegates to TaskSubjectLink and keeps the parenthesised ULID for workflow tasks', async () => {
    const src = await fs.readFile(DETAIL_SRC, 'utf8')
    expect(src).toContain('<TaskSubjectLink task={tk}')
    // The id is still preserved alongside (parenthesised, muted) for workflow
    // tasks so power users can copy the ULID without round-tripping the editor.
    expect(src).toMatch(/tk\.workflowName !== null/)
  })
})

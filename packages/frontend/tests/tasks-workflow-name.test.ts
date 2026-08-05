// RFC-164/RFC-244 — subject identity remains in compact task metadata.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIST_SRC = path.join(HERE, '../src/routes/tasks.tsx')
const DETAIL_SRC = path.join(HERE, '../src/routes/tasks.detail.tsx')
const SUBJECT_SRC = path.join(HERE, '../src/components/TaskSubjectLink.tsx')

describe('tasks operations list shows its compact subject', () => {
  test('the visual grid uses business columns while task metadata delegates subject rendering', async () => {
    const src = await fs.readFile(LIST_SRC, 'utf8')
    expect(src).toContain("t('tasks.operations.columns.task')")
    expect(src).toContain("t('tasks.operations.columns.execution')")
    expect(src).toContain('<TaskSubjectLink task={item} taskId={item.id} badge />')
  })
})

describe('TaskSubjectLink renders workflow name with id fallback + link', () => {
  test('workflow-kind renders workflowName ?? workflowId, linked to /workflows/$id', async () => {
    const src = await fs.readFile(SUBJECT_SRC, 'utf8')
    expect(src).toMatch(/task\.workflowName \?\? task\.workflowId/)
    expect(src).toMatch(/to="\/workflows\/\$id"\s+params=\{\{ id: task\.workflowId \}\}/)
  })
})

describe('task detail keeps the same subject identity', () => {
  test('detail delegates to TaskSubjectLink and preserves the workflow ULID', async () => {
    const src = await fs.readFile(DETAIL_SRC, 'utf8')
    expect(src).toContain('<TaskSubjectLink task={tk}')
    expect(src).toMatch(/tk\.workflowName !== null/)
  })
})

// RFC-244 — task identity remains primary in the compact five-column record.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')
const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

describe('routes/tasks.tsx — dense task identity column', () => {
  test('business-facing visual headers replace the eight-column table', () => {
    for (const key of ['task', 'execution', 'time']) {
      expect(SRC).toContain(`t('tasks.operations.columns.${key}')`)
    }
    expect(SRC).toContain("t('acl.owner')")
    expect(SRC).not.toContain('<th')
  })

  test('task name is the linked primary label', () => {
    expect(SRC).toMatch(/task-operations__name[\s\S]*?\{item\.title\}/)
  })

  test('metadata keeps subject, repository, and a compact recoverable id', () => {
    expect(SRC).toContain('const subject = localized(item.subject.label, language)')
    expect(SRC).toContain('t(taskSourceRegistration(item.sourceId).labelKey)')
    expect(SRC).toContain('item.targetLabel')
    expect(SRC).toMatch(
      /className="task-operations__id" title=\{item\.id\}[\s\S]*?item\.id\.slice\(-8\)/,
    )
  })

  test('status, time, duration, and Owner are present in the same record', () => {
    expect(SRC).toContain('<TaskStatusChip status={item.status}')
    expect(SRC).toContain('<RelativeTime ts={item.startedAt} />')
    expect(SRC).toContain('taskOperationsDuration(item, now)')
    expect(SRC).toContain('<OwnerLabel ownerUserId={item.ownerUserId} owner={item.owner} wrap />')
  })

  test('styles declare the task identity layout family', () => {
    expect(CSS).toMatch(/\.task-operations__task,/)
    expect(CSS).toMatch(/\.task-operations__name\s*\{/)
    expect(CSS).toMatch(/\.task-operations__id\s*\{/)
  })
})

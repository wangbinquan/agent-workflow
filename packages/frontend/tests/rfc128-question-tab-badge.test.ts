// RFC-128 (用户 2026-06-29) — source-level guard for the 「问题」tab badge.
//
// TAB_ORDER position (question board moved to SECOND) is locked in
// task-detail-tabs.test.ts. tasks.detail.tsx is a large route component not
// unit-rendered here, so pin the badge wiring at the file level: a refactor that
// drops the pending-count badge or changes its count basis shows up red instead
// of a silent UI regression.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(__dirname, '..', 'src', 'routes', 'tasks.detail.tsx'), 'utf8')

describe('RFC-128 question tab badge (source-level lock)', () => {
  test('「问题」tab renders a count badge gated to the task-questions tab + positive count', () => {
    expect(SRC).toContain('tabs__tab-badge')
    expect(SRC).toContain("k === 'task-questions' && pendingQuestionCount > 0")
  })

  test('badge count = non-terminal (needs-attention) questions, incl. manual', () => {
    expect(SRC).toMatch(/const pendingQuestionCount = useMemo/)
    expect(SRC).toContain("filter((e) => e.phase !== 'done')")
  })
})

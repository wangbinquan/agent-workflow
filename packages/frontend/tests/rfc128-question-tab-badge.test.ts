// RFC-128 / RFC-201 — source-level guard for the 「问题」section badge.
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

describe('RFC-128 question section badge (source-level lock)', () => {
  test('「问题」pending count is visible on both the collaboration group and leaf', () => {
    expect(SRC).toContain('data-testid="tq-section-badge"')
    expect(SRC).toContain('data-testid="tq-group-badge"')
    expect(SRC).toContain("key === 'task-questions' ? questionBadge : undefined")
    expect(SRC).toContain("group.key === 'collaboration' && pendingQuestionCount > 0")
    expect(SRC).toContain("? 'attention' : undefined")
  })

  test('badge count = 待指派(pending) + 待下发(staged) only (needs-action), incl. manual', () => {
    expect(SRC).toMatch(/const pendingQuestionCount = useMemo/)
    expect(SRC).toContain("e.phase === 'pending' || e.phase === 'staged'")
  })
})

describe('RFC-128 canvas node badge (source-level lock)', () => {
  // The canvas per-node badge (questionCounts) counts ONLY 'processing' — the questions a
  // node is actively running. Pre-dispatch (待指派/待下发) live in the pool; 已处理待确认/
  // 完成 no longer belong to the node. Distinct from the tab badge (pending+staged) above.
  //
  // 2026-07-02 badge-dimension fix (用户拍板, task …QMGP5): the badge groups by the
  // HANDLER node (effectiveTargetNodeId = override ?? default), NOT the asking source —
  // "actively running" is the handler's dimension. Grouping by sourceNodeId put a question
  // reassigned to a downstream node on the ASKER's badge (20/0 instead of 19/1) and gave
  // manual questions (no source node) no badge at all. This lock keeps the count basis on
  // the handler dimension — a revert to sourceNodeId turns it red.
  test('canvas node badge counts ONLY processing, grouped by the HANDLER (effective target)', () => {
    expect(SRC).toMatch(/const questionCounts = useMemo/)
    expect(SRC).toContain("e.effectiveTargetNodeId !== null && e.phase === 'processing'")
    expect(SRC).not.toContain("e.sourceNodeId !== null && e.phase === 'processing'")
  })
})

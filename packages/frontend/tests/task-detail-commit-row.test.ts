// RFC-075 PR-C — source-layer guards for the task-detail commit&push row +
// session dialog. The task-detail route is expensive to mount (Router + Query
// + canvas), so — matching launch-working-branch.test.ts — we grep the source
// for the wiring invariants + assert i18n parity. A regression that dropped
// the child-row filter would dump ugly __commit_push__ session rows into the
// table; one that dropped the Dialog+SessionTab wiring would break "view the
// commit conversation".

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const DETAIL_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('tasks.detail.tsx — RFC-075 commit&push row wiring', () => {
  test('hides commit session CHILD rows from the table', () => {
    expect(DETAIL_SRC).toContain('COMMIT_PUSH_PREFIX')
    // The visible filter drops commit-prefixed rows with no commitPush meta.
    expect(DETAIL_SRC).toMatch(/startsWith\(COMMIT_PUSH_PREFIX\)\s*&&\s*r\.commitPush == null/)
  })

  test('renders the commit container row via CommitRunRow', () => {
    expect(DETAIL_SRC).toMatch(/r\.commitPush != null/)
    expect(DETAIL_SRC).toContain('<CommitRunRow')
    expect(DETAIL_SRC).toContain('data-testid="commit-push-row"')
    expect(DETAIL_SRC).toContain('data-testid="commit-push-outcome"')
  })

  test('view-session button opens a Dialog with SessionTab over the child runs', () => {
    expect(DETAIL_SRC).toContain('data-testid="commit-push-session-btn"')
    expect(DETAIL_SRC).toMatch(/<Dialog[\s\S]*?<SessionTab/)
    // SessionTab is fed the session children (parent = the container row).
    expect(DETAIL_SRC).toMatch(/r\.parentNodeRunId === run\.id/)
  })

  test('maps every push outcome to a label key', () => {
    for (const key of [
      "'tasks.commitOutcomePushed'",
      "'tasks.commitOutcomeLocalAuth'",
      "'tasks.commitOutcomeLocalFailed'",
      "'tasks.commitOutcomeSubrepoFailed'",
      "'tasks.commitOutcomeSkippedExcluded'",
      "'tasks.commitOutcomeExcludedHistory'",
      "'tasks.commitOutcomeSkippedEmpty'",
    ]) {
      expect(DETAIL_SRC).toContain(key)
    }
  })

  test('RFC-308 renders the bounded path receipt and distinguishes history blocks', () => {
    expect(DETAIL_SRC).toContain('data-testid="commit-push-exclusions"')
    expect(DETAIL_SRC).toContain('cp.exclusions.historyBlocked')
    expect(DETAIL_SRC).toContain('tasks.commitExclusionsHistory')
    expect(DETAIL_SRC).toContain('cp.exclusions.paths.map')
  })
})

describe('i18n — RFC-075 commit-row keys present in both locales', () => {
  test('zh-CN values', () => {
    expect(ZH).toContain("commitPushNode: '提交并推送'")
    expect(ZH).toContain("commitViewSession: '查看会话'")
    expect(ZH).toContain("commitOutcomePushed: '已推送'")
  })
  test('en-US values', () => {
    expect(EN).toContain("commitPushNode: 'commit & push'")
    expect(EN).toContain("commitViewSession: 'View session'")
    expect(EN).toContain("commitOutcomePushed: 'Pushed'")
  })
})

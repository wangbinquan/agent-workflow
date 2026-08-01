// Locks in the request "任务详情界面，节点运行页签，耗时列不用标记人工还是非人工":
// the task-detail node-runs table AND the node detail drawer must render the
// "耗时" / duration column as a plain elapsed time (or em-dash), with NO marker
// distinguishing a review node's human-review wait from a compute span.
//
// Before this change the duration cell appended "（人工）" / "(review)" to a
// review row and showed "等待人工" / "awaiting" while undecided (the i18n keys
// tasks.reviewWaitDuration / tasks.reviewAwaiting). Both keys were deleted and
// both surfaces now format reviewRunDisplay's unified `durationMs`. This is a
// source/i18n-level safety net (jsdom doesn't lay out the table and the i18n
// provider can race on first paint); the behavioural contract lives in
// review-run-display.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

const SRC = join(__dirname, '..', 'src')
const TABLE = readFileSync(join(SRC, 'routes', 'tasks.detail.tsx'), 'utf8')
const DRAWER = readFileSync(join(SRC, 'components', 'NodeDetailDrawer.tsx'), 'utf8')

describe('node-run duration column carries no 人工/非人工 marker', () => {
  test('the human-vs-compute marker i18n keys no longer exist in either bundle', () => {
    // `in` (not property access) so this still compiles once the keys are gone.
    for (const tasks of [enUS.tasks, zhCN.tasks]) {
      expect('reviewWaitDuration' in tasks).toBe(false)
      expect('reviewAwaiting' in tasks).toBe(false)
    }
  })

  test('no surviving review-duration marker strings in the zh bundle', () => {
    // The retired parenthetical marker is specific enough to guard the
    // duration cell. Generic「等待人工」copy is valid elsewhere (for example
    // the RFC-244 task execution detail) and must not be banned bundle-wide.
    const blob = JSON.stringify(zhCN.tasks)
    expect(blob).not.toContain('（人工）')
    expect(blob).not.toContain('等待人工耗时')
  })

  test('both surfaces render the unified durationMs, not the removed keys', () => {
    for (const src of [TABLE, DRAWER]) {
      expect(src).not.toContain('reviewWaitDuration')
      expect(src).not.toContain('reviewAwaiting')
      expect(src).toContain('durationMs')
    }
  })
})

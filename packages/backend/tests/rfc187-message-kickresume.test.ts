// RFC-187 F2 (audit design/workgroup-e2e-audit.md §5 F2) — sending a room message (or a
// delivery / config-patch) to a LIVE `interrupted` workgroup task inserted a dispatched
// assignment but only kicked the engine when the task was `awaiting_human` — so an
// interrupted task (reaped mid-run by orphan-reaping WITHOUT a daemon restart) became a
// black hole: the work sat undriven until the next restart. Fix: kick on any resumable
// state (awaiting_human OR interrupted); resumeTask handles both (RFC-186 P0-B) and no-ops
// on running/terminal states.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isWorkgroupKickResumable } from '../src/routes/workgroupTasks'

describe('RFC-187 F2 — isWorkgroupKickResumable', () => {
  test('awaiting_human and interrupted are resumable (message/delivery/patch re-drive)', () => {
    expect(isWorkgroupKickResumable('awaiting_human')).toBe(true)
    expect(isWorkgroupKickResumable('interrupted')).toBe(true)
  })

  test('running and terminal states are NOT kicked (no double-drive / no revive of a dead task)', () => {
    for (const s of ['running', 'pending', 'done', 'failed', 'canceled', 'awaiting_review']) {
      expect(isWorkgroupKickResumable(s)).toBe(false)
    }
    expect(isWorkgroupKickResumable(undefined)).toBe(false)
  })
})

describe('RFC-187 F2 — source lock (all gated kick sites use the resumable gate)', () => {
  // RFC-217 T4 moved the write endpoints (and their kick sites) out of
  // routes/workgroupTasks.ts into services/workgroup/{taskActions,configActions}.
  const SRC = ['routes/workgroupTasks.ts', 'services/workgroup/taskActions.ts']
    .concat(['services/workgroup/configActions.ts', 'services/workgroup/dwActions.ts'])
    .map((p) => readFileSync(resolve(import.meta.dir, '..', 'src', ...p.split('/')), 'utf8'))
    .join('\n')

  test('the message/delivery/patch sites gate on isWorkgroupKickResumable, not awaiting_human alone', () => {
    // the old awaiting_human-only gate on kickResume must be gone.
    expect(SRC).not.toMatch(/status === 'awaiting_human'\) kickResume\(taskId\)/)
    // at least the three room paths (message, delivery, patch) route through the helper.
    const uses = SRC.split('kickResumeIfResumable(taskId,').length - 1
    expect(uses).toBeGreaterThanOrEqual(3)
  })
})

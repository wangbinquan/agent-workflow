// RFC-186 PR-2 — restart-recovery reconciliation (design.md §3.3; audit
// design/workgroup-e2e-audit.md §4 F1 / §5 F1).
//
// Why this test exists: a daemon restart reaps a mid-run worker `node_run` to
// `interrupted` but leaves the workgroup_assignment `running`. Adoption only
// re-drives `pending` rows, so the assignment is never re-driven AND a `running`
// assignment counts as blocking → the leader barrier wedges the resumed task
// `awaiting_human` forever (3/10 production tasks died this way). RFC-186 PR-2
// reconciles these ONCE at engine (re)entry. This locks the decision table + the
// wiring (the full-flow recovery is covered by the real e2e in
// rfc186-workgroup-e2e.test.ts).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideAssignmentReconcile } from '../src/services/workgroupRunner'

describe('RFC-186 PR-2 — decideAssignmentReconcile', () => {
  test('interrupted before the worker run was minted → re-dispatch', () => {
    expect(decideAssignmentReconcile(undefined)).toBe('redispatch')
  })

  test('worker run done (finished + merged pre-crash) → close the card', () => {
    expect(decideAssignmentReconcile('done')).toBe('done')
  })

  test.each(['interrupted', 'failed', 'canceled'])(
    'worker run %s (reaped mid-run) → re-dispatch for a clean re-run',
    (status) => {
      expect(decideAssignmentReconcile(status)).toBe('redispatch')
    },
  )

  test.each(['pending', 'running'])(
    'worker run %s (a live driver owns it) → leave it (no-op)',
    (status) => {
      expect(decideAssignmentReconcile(status)).toBe('none')
    },
  )
})

describe('RFC-186 PR-2 — source wiring locks', () => {
  const read = (f: string) =>
    readFileSync(resolve(import.meta.dir, '..', 'src', 'services', f), 'utf8')

  test('autoResume no longer excludes turn-engine workgroups', () => {
    const src = read('autoResume.ts')
    expect(src).not.toContain('!isTurnEngineWorkgroupTask(t)')
  })

  test('reconcileRunningAssignments is wired into the engine (re)entry', () => {
    const src = read('workgroupRunner.ts')
    expect(src).toContain('reconcileRunningAssignments(db, taskId')
  })
})

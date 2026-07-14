// RFC-186 Phase 3 — batch of P2/P3 correctness fixes from the workgroup audit
// (design/workgroup-e2e-audit.md §3). Small, mechanical hardening on the engine;
// these locks pin the fixes so a future refactor can't silently drop them.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'workgroupRunner.ts'),
  'utf8',
)

describe('RFC-186 Phase 3 — engine hardening locks', () => {
  // §3-6: `done` co-emitted with new assignments is a protocol violation (the
  // dispatched work would run but never be aggregated).
  test('§3-6: leader `done` + new assignments is rejected as a protocol violation', () => {
    expect(SRC).toContain('action "done" cannot be emitted together with new wg_assignments')
    // gated on decision=done AND dispatches non-empty.
    expect(SRC).toMatch(
      /decision\.value\.action === 'done'[\s\S]{0,120}dispatches\.value\.length > 0/,
    )
  })

  // §3-4: message ids must be monotonic (room slicing / cursor advance assume
  // lexical ordering; plain ulid() reorders same-ms posts).
  test('§3-4: postMessage uses a monotonic ULID factory, not plain ulid()', () => {
    expect(SRC).toContain('const nextMessageId = monotonicFactory()')
    expect(SRC).toMatch(/async function postMessage[\s\S]{0,120}const id = nextMessageId\(\)/)
  })

  // §3-5 / F5: an adopted assignment run must pass its TRUE status so a still-
  // `dispatched` row gets its dispatched→running CAS (else the closing running→
  // done CAS misses and the assignment re-runs).
  test('§3-5: driveAdoptedRun passes the true assignment status (no forced running)', () => {
    expect(SRC).toContain('let drivenStatus = assignment.status')
    expect(SRC).toContain('status: drivenStatus')
    // the old forced-running form must be gone.
    expect(SRC).not.toContain(
      "driveAssignmentTurn(args, state, { ...assignment, status: 'running' }, row.id)",
    )
  })

  // TRAP-2: the roster renders `- @writer`, so the wg_assignments `member` doc
  // must NOT contradict it with "not @writer" (the @ is tolerated by
  // WgMemberRefSchema). Reconcile the copy so a weak model isn't confused.
  test('TRAP-2: protocol no longer contradicts the roster on the @ prefix', () => {
    const ctx = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workgroupContext.ts'),
      'utf8',
    )
    expect(ctx).toContain('the leading @ shown in the')
    expect(ctx).not.toContain('not "@writer"')
    // the roster itself still uses the @ display form (unchanged).
    expect(ctx).toContain('const head = `- @${m.displayName}')
  })
})

// Locks the two distinct memory access authorities after RFC-305:
//   - distill-job administration uses its explicit account capability;
//   - the sidebar candidate badge follows each server-returned canManage bit.
//
// `memory:approve` is in the user baseline, so it is not an admin oracle. The
// badge must not replace the per-row server decision with either a role check
// or a missing-field truthiness fallback.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { countManageableMemoryCandidates } from '../src/components/shell/MemoryPendingBadge'

const DISTILL_ROUTE = readFileSync(
  resolve(__dirname, '../src/routes/memory.distill-jobs.$jobId.tsx'),
  'utf8',
)
const PENDING_BADGE = readFileSync(
  resolve(__dirname, '../src/components/shell/MemoryPendingBadge.tsx'),
  'utf8',
)

describe('memory access authorities', () => {
  test('distill-job detail is gated by its exact capability and never by role', () => {
    expect(DISTILL_ROUTE).not.toContain("usePermission('memory:approve')")
    expect(DISTILL_ROUTE).toContain("usePermission('memory-distill-jobs:manage')")
    expect(DISTILL_ROUTE).not.toMatch(/useIsAdmin|useIsResourceAdmin|\.user\.role/)
    expect(DISTILL_ROUTE).toMatch(/enabled: canManageDistillJobs/)
  })

  test('pending badge delegates candidate eligibility only to explicit canManage=true', () => {
    expect(PENDING_BADGE).not.toContain("usePermission('memory:approve')")
    expect(PENDING_BADGE).not.toMatch(/useIsAdmin|useIsResourceAdmin|\.user\.role/)
    expect(PENDING_BADGE).toContain('item.canManage === true')

    const candidates = [
      { canManage: true },
      { canManage: false },
      { canManage: undefined },
      {},
    ] as unknown as Parameters<typeof countManageableMemoryCandidates>[0]
    expect(countManageableMemoryCandidates(candidates)).toBe(1)
  })
})

// Locks the RFC-099 audit (2026-07-15) fix: the distill-jobs detail route and
// the sidebar memory badge must gate their admin-only surfaces on the admin
// ROLE (useIsAdmin), NOT the memory:approve PERMISSION. RFC-099 D12 moved
// memory:approve into the user baseline, so usePermission('memory:approve') is
// true for EVERY logged-in user — keying the gate off it made the "admin only"
// branch a no-op: non-admins fired the admin requests (403 → WS reconnect
// loop) and the badge counted the whole candidate pool. If this goes red,
// someone reintroduced the permission-point gate; use the role instead.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const FILES = [
  ['distill-jobs detail route', 'src/routes/memory.distill-jobs.$jobId.tsx'],
  ['sidebar memory badge', 'src/components/shell/MemoryPendingBadge.tsx'],
] as const

describe('memory admin gate keys off role, not the memory:approve permission', () => {
  for (const [label, rel] of FILES) {
    test(`${label} gates on useIsAdmin, not usePermission('memory:approve')`, () => {
      const src = readFileSync(resolve(__dirname, '..', rel), 'utf8')
      expect(src).not.toContain("usePermission('memory:approve')")
      expect(src).toContain('useIsAdmin')
    })
  }
})

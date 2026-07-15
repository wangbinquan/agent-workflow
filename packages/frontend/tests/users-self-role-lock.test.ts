// Locks in the self-role lockout guard on /users: an admin demoting
// themselves loses the very permission needed to undo it, so the row for the
// current user must render a static role chip instead of the role <Select>.
// Mirrors the backend's `self-role-change-forbidden` guard in
// services/users.ts (patchUser).
//
// Source-text assertions per CLAUDE.md's test-with-every-change rule.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'users.tsx'), 'utf-8')

describe('routes/users.tsx — current user cannot edit own role', () => {
  test('derives isSelf from the /api/auth/me actor id', () => {
    expect(SRC).toMatch(/const \{ data: me, isLoading: isActorLoading \} = useActor\(\)/)
    expect(SRC).toMatch(/const isSelf = u\.id === me\?\.user\.id/)
  })

  test('self row joins the __system__ row in the static-chip branch', () => {
    // Both immutable rows share one branch: no <Select> is rendered for them.
    expect(SRC).toMatch(/isSystem \|\| isSelf \? \(/)
  })

  test('self chip explains why via the users.selfRoleLocked tooltip', () => {
    expect(SRC).toMatch(/users\.selfRoleLocked/)
  })
})

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

const source = (path: string) =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', path), 'utf-8')
const ROUTE_SRC = source('routes/users.tsx')
const DIRECTORY_SRC = source('components/users/UserDirectory.tsx')
const EDIT_SRC = source('components/users/EditUserDialog.tsx')

describe('routes/users.tsx — current user cannot edit own role', () => {
  test('derives isSelf from the /api/auth/me actor id', () => {
    expect(ROUTE_SRC).toMatch(/currentUserId=\{actor\.data\?\.user\.id\}/)
    expect(DIRECTORY_SRC).toMatch(/isSelf=\{user\.id === props\.currentUserId\}/)
    expect(ROUTE_SRC).toMatch(/isSelf=\{target\.id === actor\.data\?\.user\.id\}/)
  })

  test('self edit dialog disables role selection while system stays outside the human list', () => {
    expect(EDIT_SRC).toMatch(/disabled=\{props\.isSelf\}/)
    expect(DIRECTORY_SRC).toMatch(/props\.model\.system !== null/)
    expect(DIRECTORY_SRC).toMatch(/<SystemPrincipal user=\{props\.model\.system\}/)
  })

  test('self chip explains why via the users.selfRoleLocked tooltip', () => {
    expect(EDIT_SRC).toMatch(/users\.selfRoleLocked/)
  })
})

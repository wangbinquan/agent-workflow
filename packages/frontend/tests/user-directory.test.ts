import type { AdminUserView } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import {
  deriveUserDirectory,
  diffUserPatch,
  filtersFromUsersSearch,
  searchFromUserFilters,
  serializeCreateUser,
  validateUsersSearch,
  withUsersSearch,
} from '../src/lib/user-directory'

function user(id: string, overrides: Partial<AdminUserView> = {}): AdminUserView {
  return {
    id,
    username: id === '__system__' ? '__system__' : id,
    email: null,
    displayName: id,
    role: 'user',
    status: 'active',
    forcePasswordChange: false,
    createdBy: null,
    createdAt: 1,
    updatedAt: 1,
    lastLoginAt: null,
    hasOidcIdentity: false,
    ...overrides,
  }
}

describe('RFC-221 user directory model', () => {
  test('validates owned URL keys, omits defaults, and preserves adjacent state', () => {
    expect(
      validateUsersSearch({
        q: '  Alice  ',
        status: 'active',
        role: 'root',
        adjacent: 'kept',
      }),
    ).toEqual({ q: 'Alice', status: 'active', adjacent: 'kept' })
    expect(
      withUsersSearch(
        { q: 'old', status: 'disabled', role: 'admin', adjacent: 7 },
        { role: 'user' },
      ),
    ).toEqual({ role: 'user', adjacent: 7 })
    expect(
      searchFromUserFilters(filtersFromUsersSearch({ q: '', status: undefined, role: undefined })),
    ).toEqual({})
    expect(validateUsersSearch({ role: 'manager' })).toEqual({ role: 'manager' })
  })

  test('separates system, computes human-only counts, intersects filters, and never mutates input', () => {
    const rows = [
      user('__system__', { role: 'admin', displayName: 'System' }),
      user('zoe', { displayName: 'Zoe', status: 'disabled' }),
      user('alice', {
        displayName: 'Alice Chen',
        email: 'alice@example.test',
        role: 'admin',
        status: 'invited',
      }),
      user('bob', { displayName: 'Bob', role: 'admin' }),
    ]
    const originalOrder = rows.map((row) => row.id)
    const model = deriveUserDirectory(
      rows,
      { q: 'ＡＬＩＣＥ', status: 'invited', role: 'admin' },
      'en-US',
    )

    expect(model.system?.id).toBe('__system__')
    expect(model.humans.map((row) => row.id)).toEqual(['zoe', 'alice', 'bob'])
    expect(model.visible.map((row) => row.id)).toEqual(['alice'])
    expect(model.counts).toEqual({
      total: 3,
      admin: 2,
      invited: 1,
      disabled: 1,
      byStatus: { active: 1, invited: 1, disabled: 1 },
    })
    expect(rows.map((row) => row.id)).toEqual(originalOrder)
  })

  test('sorts stably and distinguishes initial from filtered empty', () => {
    const rows = [
      user('b', { displayName: 'Same' }),
      user('a', { displayName: 'Same' }),
      user('z', { displayName: 'Alpha' }),
    ]
    expect(
      deriveUserDirectory(rows, { q: '', status: 'all', role: 'all' }, 'en-US').visible.map(
        (row) => row.id,
      ),
    ).toEqual(['z', 'a', 'b'])
    expect(deriveUserDirectory([], { q: '', status: 'all', role: 'all' }, 'en-US').emptyKind).toBe(
      'initial',
    )
    expect(
      deriveUserDirectory(rows, { q: 'missing', status: 'all', role: 'all' }, 'en-US').emptyKind,
    ).toBe('filtered')
  })

  test('serializes create modes without leaking hidden password fields', () => {
    expect(
      serializeCreateUser({
        username: ' alice ',
        displayName: ' Alice ',
        email: ' ALICE@EXAMPLE.TEST ',
        role: 'user',
        mode: 'password',
        password: 'password-123',
      }),
    ).toEqual({
      username: 'alice',
      displayName: 'Alice',
      email: 'alice@example.test',
      role: 'user',
      password: 'password-123',
    })
    expect(
      serializeCreateUser({
        username: 'bob',
        displayName: 'Bob',
        email: 'bob@example.test',
        role: 'admin',
        mode: 'sso',
        password: 'must-not-leak',
      }),
    ).toEqual({
      username: 'bob',
      displayName: 'Bob',
      email: 'bob@example.test',
      role: 'admin',
    })
  })

  test('builds a normalized dirty-only edit patch', () => {
    const original = user('alice', {
      displayName: 'Alice',
      email: 'alice@example.test',
      role: 'user',
    })
    expect(
      diffUserPatch(original, {
        displayName: ' Alice ',
        email: ' ALICE@EXAMPLE.TEST ',
        role: 'user',
      }),
    ).toEqual({})
    expect(
      diffUserPatch(original, { displayName: 'Alice Chen', email: '', role: 'admin' }),
    ).toEqual({ displayName: 'Alice Chen', email: null, role: 'admin' })
  })
})

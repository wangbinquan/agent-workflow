// RFC-036 — UserSchema + CreateUserBodySchema invariants. Username regex is
// the canonical login identifier; loosening it would break URL routing.

import { describe, expect, test } from 'bun:test'
import {
  ChangePasswordBodySchema,
  CreatePatBodySchema,
  CreateUserBodySchema,
  LoginBodySchema,
  PatchUserBodySchema,
  ResetPasswordBodySchema,
  UpdateOwnProfileBodySchema,
  UserPrivateProfileSchema,
  USERNAME_REGEX,
  UserPublicSchema,
  UserSchema,
} from '../src/schemas/user'

describe('USERNAME_REGEX', () => {
  test('accepts the canonical forms', () => {
    expect(USERNAME_REGEX.test('alice')).toBe(true)
    expect(USERNAME_REGEX.test('bob-2024')).toBe(true)
    expect(USERNAME_REGEX.test('ci_user_99')).toBe(true)
    expect(USERNAME_REGEX.test('a')).toBe(true)
    expect(USERNAME_REGEX.test('a'.repeat(64))).toBe(true)
  })

  test('rejects out-of-band shapes', () => {
    expect(USERNAME_REGEX.test('')).toBe(false)
    expect(USERNAME_REGEX.test('Alice')).toBe(false) // uppercase
    expect(USERNAME_REGEX.test('-alice')).toBe(false) // leading dash
    expect(USERNAME_REGEX.test('_alice')).toBe(false) // leading underscore
    expect(USERNAME_REGEX.test('alice@example.com')).toBe(false)
    expect(USERNAME_REGEX.test('a'.repeat(65))).toBe(false) // too long
  })
})

describe('CreateUserBodySchema', () => {
  test('happy path with explicit password', () => {
    const parsed = CreateUserBodySchema.parse({
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'correctHorseBattery',
    })
    expect(parsed.username).toBe('alice')
    expect(parsed.role).toBe('admin')
  })

  test('password optional → status=invited path is allowed', () => {
    const parsed = CreateUserBodySchema.parse({
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
    })
    expect(parsed.password).toBeUndefined()
  })

  test('rejects too-short password', () => {
    expect(() =>
      CreateUserBodySchema.parse({
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        password: 'short',
      }),
    ).toThrow()
  })

  test('rejects bad username', () => {
    expect(() =>
      CreateUserBodySchema.parse({
        username: 'Alice',
        displayName: 'Alice',
        role: 'admin',
      }),
    ).toThrow()
  })

  test('rejects bad email', () => {
    expect(() =>
      CreateUserBodySchema.parse({
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        email: 'not-an-email',
      }),
    ).toThrow()
  })
})

describe('PatchUserBodySchema', () => {
  test('rejects unknown fields (strict)', () => {
    expect(() =>
      PatchUserBodySchema.parse({
        displayName: 'New',
        passwordHash: 'should-not-be-here',
      }),
    ).toThrow()
  })

  test('all fields optional', () => {
    expect(PatchUserBodySchema.parse({})).toEqual({})
  })
})

describe('LoginBodySchema', () => {
  test('happy path', () => {
    LoginBodySchema.parse({ username: 'alice', password: 'pw' })
  })
  test('empty username rejected', () => {
    expect(() => LoginBodySchema.parse({ username: '', password: 'pw' })).toThrow()
  })
})

describe('ChangePasswordBodySchema', () => {
  test('oldPassword optional (force_password_change flow)', () => {
    ChangePasswordBodySchema.parse({ newPassword: 'newPw1234' })
  })
  test('newPassword must satisfy min length', () => {
    expect(() => ChangePasswordBodySchema.parse({ newPassword: 'short' })).toThrow()
  })
})

describe('CreatePatBodySchema', () => {
  test('scopes default to []', () => {
    const parsed = CreatePatBodySchema.parse({ name: 'ci' })
    expect(parsed.scopes).toEqual([])
  })

  test('rejects unknown scope', () => {
    expect(() => CreatePatBodySchema.parse({ name: 'ci', scopes: ['not-a-real-scope'] })).toThrow()
  })
})

describe('ResetPasswordBodySchema', () => {
  test('happy path', () => {
    ResetPasswordBodySchema.parse({ newPassword: 'newSecret123' })
  })

  test('newPassword min length enforced', () => {
    expect(() => ResetPasswordBodySchema.parse({ newPassword: 'short' })).toThrow()
  })
})

describe('UserPublicSchema', () => {
  test('strips email + lastLoginAt + other private fields', () => {
    const fullRow = UserSchema.parse({
      id: '01',
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'admin',
      status: 'active',
      forcePasswordChange: false,
      createdBy: null,
      createdAt: 0,
      updatedAt: 0,
      lastLoginAt: 12345,
    })
    const publicView = UserPublicSchema.parse(fullRow)
    expect(Object.keys(publicView).sort()).toEqual([
      'displayName',
      'id',
      'role',
      'status',
      'username',
    ])
    expect((publicView as unknown as Record<string, unknown>).email).toBeUndefined()
    expect((publicView as unknown as Record<string, unknown>).lastLoginAt).toBeUndefined()
  })
})

describe('RFC-335 private profile Git name', () => {
  test('display and Git names are independent required fields', () => {
    const profile = UserPrivateProfileSchema.parse({
      displayName: 'Alice Chen',
      gitName: 'A. Chen',
      email: 'alice@example.test',
      gitCommitIdentity: { name: 'A. Chen', email: 'alice@example.test' },
    })
    expect(profile.gitName).toBe('A. Chen')
    expect(
      UpdateOwnProfileBodySchema.parse({
        displayName: ' Alice Chen ',
        gitName: ' A. Chen ',
        email: ' Alice@Example.TEST ',
      }),
    ).toEqual({
      displayName: 'Alice Chen',
      gitName: 'A. Chen',
      email: 'alice@example.test',
    })
  })
})

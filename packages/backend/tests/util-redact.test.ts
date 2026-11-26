// RFC-030 — locks redactSensitiveString covers the patterns the probe service
// relies on. If a regex loosens or a key list shrinks, this catches it before
// secrets reach the mcp_probes.error_detail_json column.

import { describe, expect, test } from 'bun:test'
import { redactSensitiveString } from '@/platform/logging/redact'

describe('redactSensitiveString', () => {
  test('null / undefined → empty string', () => {
    expect(redactSensitiveString(null)).toBe('')
    expect(redactSensitiveString(undefined)).toBe('')
  })

  test('preserves non-sensitive text untouched', () => {
    expect(redactSensitiveString('hello world')).toBe('hello world')
  })

  test('Authorization: Bearer ... → ***', () => {
    const out = redactSensitiveString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')
    expect(out).toBe('Authorization: ***')
  })

  test('Proxy-Authorization same treatment', () => {
    const out = redactSensitiveString('Proxy-Authorization: Basic dXNlcjpwYXNz')
    expect(out).toBe('Proxy-Authorization: ***')
  })

  test('key=value forms: token / password / secret / api_key / pwd', () => {
    expect(redactSensitiveString('token=abc123')).toBe('token=***')
    expect(redactSensitiveString('password=hunter2')).toBe('password=***')
    expect(redactSensitiveString('SECRET=topsecret')).toBe('SECRET=***')
    expect(redactSensitiveString('api_key=xyz')).toBe('api_key=***')
    expect(redactSensitiveString('pwd=qwerty')).toBe('pwd=***')
  })

  test('postgresql:// userinfo redacted', () => {
    expect(redactSensitiveString('PG_URL=postgresql://user:secret@host:5432/db')).toBe(
      // After URI-userinfo redaction the `user:secret` becomes ***:*** and
      // the PG_URL key=value pair *itself* matches no sensitive-key list, so
      // it stays as `PG_URL=postgresql://***:***@host:5432/db`.
      'PG_URL=postgresql://***:***@host:5432/db',
    )
  })

  test('does NOT redact unrelated key like log_level=debug', () => {
    expect(redactSensitiveString('log_level=debug')).toBe('log_level=debug')
  })

  test('git URL still redacted via redactGitUrl chain', () => {
    // RFC-024's redactGitUrl strips embedded basic-auth from https/ssh git URLs.
    // We just assert the chain runs; the exact format is locked by that
    // function's own test suite in @agent-workflow/shared.
    const out = redactSensitiveString('https://oauth2:ghp_abc@github.com/o/r.git')
    expect(out.includes('ghp_abc')).toBe(false)
  })

  test('multi-line stderr is processed line-globally', () => {
    const stderr = [
      'connecting to host',
      'PG_URL=postgresql://alice:secret@db:5432/x',
      'Authorization: Bearer eyJ.abc',
      'unrelated info line',
    ].join('\n')
    const out = redactSensitiveString(stderr)
    expect(out.includes('secret')).toBe(false)
    expect(out.includes('eyJ.abc')).toBe(false)
    expect(out.includes('unrelated info line')).toBe(true)
  })
})

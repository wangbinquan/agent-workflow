// RFC-349 — database provider config is an explicit discriminated union.
// SQLite must stay zero-config; PostgreSQL stores only an env-var reference and
// bounded pool/timeouts, never a connection URL.

import { describe, expect, test } from 'bun:test'
import {
  ConfigPatchSchema,
  ConfigSchema,
  DatabaseConfigSchema,
  DEFAULT_CONFIG,
} from '../src/schemas/config.js'

describe('RFC-349 database provider config', () => {
  test('old config snapshots backfill the SQLite default', () => {
    const { database: _omitted, ...legacy } = DEFAULT_CONFIG
    expect(ConfigSchema.parse(legacy).database).toEqual({ provider: 'sqlite' })
  })

  test('DEFAULT_CONFIG remains SQLite and schema-valid', () => {
    expect(DEFAULT_CONFIG.database).toEqual({ provider: 'sqlite' })
    expect(ConfigSchema.parse(DEFAULT_CONFIG).database).toEqual({ provider: 'sqlite' })
  })

  test('PostgreSQL defaults are bounded and reference an env name', () => {
    expect(DatabaseConfigSchema.parse({ provider: 'postgresql' })).toEqual({
      provider: 'postgresql',
      urlEnv: 'AGENT_WORKFLOW_DATABASE_URL',
      poolMax: 16,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    })
  })

  test('patch accepts the complete PostgreSQL shape', () => {
    const parsed = ConfigPatchSchema.parse({
      database: {
        provider: 'postgresql',
        urlEnv: 'AW_TEST_DATABASE_URL',
        poolMax: 24,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 120_000,
        idleTimeoutMs: 45_000,
      },
    })
    expect(parsed.database?.provider).toBe('postgresql')
  })

  test('rejects raw URLs, invalid env names, unknown keys and unbounded values', () => {
    expect(
      DatabaseConfigSchema.safeParse({
        provider: 'postgresql',
        urlEnv: 'postgresql://user:secret@example.invalid/db',
      }).success,
    ).toBe(false)
    expect(
      DatabaseConfigSchema.safeParse({ provider: 'postgresql', urlEnv: '1INVALID' }).success,
    ).toBe(false)
    expect(DatabaseConfigSchema.safeParse({ provider: 'postgresql', poolMax: 0 }).success).toBe(
      false,
    )
    expect(
      DatabaseConfigSchema.safeParse({ provider: 'sqlite', urlEnv: 'SHOULD_NOT_EXIST' }).success,
    ).toBe(false)
  })
})

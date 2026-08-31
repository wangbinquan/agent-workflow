// RFC-349 — database config is a discriminated union. A provider change must
// replace the old variant rather than deep-merging SQLite and PostgreSQL keys.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyConfigPatch, loadConfig } from '@/config'

const roots: string[] = []

function configPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-config-'))
  roots.push(root)
  return join(root, 'config.json')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 database provider config switching', () => {
  test('legacy files without database remain zero-config SQLite', () => {
    const path = configPath()
    writeFileSync(path, JSON.stringify({ $schema_version: 1, logLevel: 'debug' }))
    expect(loadConfig(path).database).toEqual({ provider: 'sqlite' })
  })

  test('SQLite -> PostgreSQL -> SQLite does not retain keys from the other variant', () => {
    const path = configPath()
    loadConfig(path)
    const postgresql = applyConfigPatch(path, {
      database: {
        provider: 'postgresql',
        urlEnv: 'AW_DATABASE_URL',
        poolMax: 24,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 120_000,
        idleTimeoutMs: 45_000,
      },
    })
    expect(postgresql.database).toEqual({
      provider: 'postgresql',
      urlEnv: 'AW_DATABASE_URL',
      poolMax: 24,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 120_000,
      idleTimeoutMs: 45_000,
    })

    const sqlite = applyConfigPatch(path, { database: { provider: 'sqlite' } })
    expect(sqlite.database).toEqual({ provider: 'sqlite' })
    expect(JSON.parse(readFileSync(path, 'utf8')).database).toEqual({ provider: 'sqlite' })
  })

  test('only the environment-variable name is persisted, never its secret value', () => {
    const path = configPath()
    const secret = 'postgresql://user:password@example.invalid/database'
    process.env.AW_RFC349_TEST_DATABASE_URL = secret
    try {
      loadConfig(path)
      applyConfigPatch(path, {
        database: {
          provider: 'postgresql',
          urlEnv: 'AW_RFC349_TEST_DATABASE_URL',
          poolMax: 16,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
        },
      })
      const stored = readFileSync(path, 'utf8')
      expect(stored).toContain('AW_RFC349_TEST_DATABASE_URL')
      expect(stored).not.toContain(secret)
    } finally {
      delete process.env.AW_RFC349_TEST_DATABASE_URL
    }
  })
})

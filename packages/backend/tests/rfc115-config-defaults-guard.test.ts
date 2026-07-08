// RFC-115 (Codex impl-gate F-high) — assertConfigDefaultsMigrated fail-loud
// guard for the CONFIG-only skip-upgrade data-loss path.
//
// WHY THIS FILE EXISTS: PR-D dropped the 6 generation-default config keys
// (defaultModel / defaultVariant / defaultTemperature / defaultSteps /
// defaultMaxSteps / defaultClaudeModel) from ConfigSchema, so loadConfig() (Zod)
// strips them silently. RFC-113 had backfilled them into the built-in runtime
// rows' profile. A DB that jumps pre-RFC-113 → HEAD keeps those keys on disk but
// never ran that backfill — silently continuing would change every inherited
// runtime's default model (and the next config save deletes them from disk). The
// 0057 agents guard does NOT cover this config-only case; this guard is its
// symmetric counterpart. It reads the RAW config and ABORTs when legacy defaults
// are present while every built-in runtime profile is still NULL.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { runtimes } from '../src/db/schema'
import { assertConfigDefaultsMigrated, seedBuiltinRuntimes } from '../src/services/runtimeRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-115 assertConfigDefaultsMigrated — config skip-upgrade guard', () => {
  let db: DbClient
  let tmp: string
  let cfg: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db) // built-in opencode / claude-code rows, profile NULL
    tmp = mkdtempSync(join(tmpdir(), 'aw-cfg-guard-'))
    cfg = join(tmp, 'config.json')
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  test('legacy defaults on disk + ALL built-in profiles NULL → ABORT (fail-loud)', async () => {
    writeFileSync(cfg, JSON.stringify({ $schema_version: 1, defaultModel: 'anthropic/opus' }))
    await expect(assertConfigDefaultsMigrated(db, cfg)).rejects.toThrow(
      /un-migrated generation defaults/,
    )
  })

  test('legacy defaults on disk but a built-in profile is set (RFC-113 ran) → passes', async () => {
    writeFileSync(cfg, JSON.stringify({ $schema_version: 1, defaultModel: 'anthropic/opus' }))
    // Simulate RFC-113's config→runtime backfill having migrated the default.
    await db.update(runtimes).set({ model: 'anthropic/opus' }).where(eq(runtimes.name, 'opencode'))
    await expect(assertConfigDefaultsMigrated(db, cfg)).resolves.toBeUndefined()
  })

  test('no legacy defaults in config → passes (normal upgraded / fresh config)', async () => {
    writeFileSync(cfg, JSON.stringify({ $schema_version: 1, opencodePath: '/x' }))
    await expect(assertConfigDefaultsMigrated(db, cfg)).resolves.toBeUndefined()
  })

  test('no config file (fresh install) → passes', async () => {
    await expect(
      assertConfigDefaultsMigrated(db, join(tmp, 'nonexistent.json')),
    ).resolves.toBeUndefined()
  })

  test('defaultClaudeModel alone also triggers the guard (names the offending key)', async () => {
    writeFileSync(cfg, JSON.stringify({ $schema_version: 1, defaultClaudeModel: 'claude-opus' }))
    await expect(assertConfigDefaultsMigrated(db, cfg)).rejects.toThrow(/defaultClaudeModel/)
  })

  // F4 (Codex gate followup): built-ins absent + legacy config must STILL abort —
  // the config-loss risk is real (loadConfig already stripped the keys, no runtime
  // profile preserves them, the next save deletes the only copy). The fix is an
  // ACCURATE message that names the seed-failure possibility, NOT skipping the
  // guard (my first F4 attempt returned here and reopened the data-loss path).
  test('built-ins absent (seed failed) + legacy config → ABORTs with seed-aware message', async () => {
    await db.delete(runtimes) // simulate seedBuiltinRuntimes never having run
    writeFileSync(cfg, JSON.stringify({ $schema_version: 1, defaultModel: 'anthropic/opus' }))
    await expect(assertConfigDefaultsMigrated(db, cfg)).rejects.toThrow(
      /seed failed|rows are missing or all-NULL/,
    )
  })

  test('RFC-153 F3: a user row reusing a preseeded NAME under a mismatched protocol does NOT satisfy the guard', async () => {
    // Delete the canonical opencode row and recreate 'opencode' as a claude-code
    // row WITH a model. The name matches BUILTIN_NAMES but protocol !== name, so it
    // must NOT count as proof the RFC-113 backfill preserved the legacy defaults —
    // the surviving canonical claude-code row is still all-NULL → still ABORT.
    await db.delete(runtimes).where(eq(runtimes.name, 'opencode'))
    await db.insert(runtimes).values({
      id: 'r-fake-oc',
      name: 'opencode',
      protocol: 'claude-code',
      model: 'anthropic/opus',
    })
    writeFileSync(cfg, JSON.stringify({ $schema_version: 1, defaultModel: 'anthropic/opus' }))
    await expect(assertConfigDefaultsMigrated(db, cfg)).rejects.toThrow(
      /un-migrated generation defaults/,
    )
  })
})

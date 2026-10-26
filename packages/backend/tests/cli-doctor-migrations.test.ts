// Locks in the fix for the `doctor` migrations check under IS_EMBEDDED=true.
//
// Pre-fix bug: `Paths.migrationsDir` resolves via `import.meta.dirname`, which
// `bun build --compile` bakes into `/` inside the single binary. So
// `<binary>/db/migrations` was checked against `/db/migrations` on the host
// filesystem (always missing), and `agent-workflow doctor` always exited
// with `✗ migrations folder` for any installed binary — first surfaced when
// the CI build-binary smoke step added `<bin> doctor` and discovered it
// (see ci.yml's smoke comment).
//
// Fix: `evaluateMigrationsStatus()` branches on IS_EMBEDDED. In dev (false)
// it keeps the original filesystem check; in the compiled binary (true) it
// reports the count of `.sql` entries inside `MIGRATION_FILES` (the binary's
// embedded table), since the on-disk path is meaningless in that mode.
//
// We test the pure decision function directly because IS_EMBEDDED cannot be
// flipped at runtime in dev (`bun --compile` rewrites `embed.generated.ts`).

import { describe, expect, test } from 'bun:test'
import { evaluateMigrationsStatus } from '../src/cli/doctor'

describe('doctor: evaluateMigrationsStatus', () => {
  describe('embedded mode (single binary)', () => {
    test('ok when embedded SQL count > 0 — reports "embedded in binary"', () => {
      const r = evaluateMigrationsStatus({
        embedded: true,
        embeddedSqlCount: 42,
        fsExists: false,
        fsSqlCount: 0,
        fsPath: '/db/migrations',
      })
      expect(r.ok).toBe(true)
      expect(r.name).toBe('migrations folder')
      expect(r.message).toContain('42')
      expect(r.message).toContain('embedded')
      // Must NOT leak the meaningless `/db/migrations` path in embedded mode.
      expect(r.message).not.toContain('/db/migrations')
    })

    test('singular form when exactly 1 embedded migration', () => {
      const r = evaluateMigrationsStatus({
        embedded: true,
        embeddedSqlCount: 1,
        fsExists: false,
        fsSqlCount: 0,
        fsPath: '/db/migrations',
      })
      expect(r.ok).toBe(true)
      expect(r.message).toContain('1 migration ')
      expect(r.message).not.toContain('migrations')
    })

    test('fail when embedded SQL count is 0 — indicates broken build', () => {
      const r = evaluateMigrationsStatus({
        embedded: true,
        embeddedSqlCount: 0,
        fsExists: false,
        fsSqlCount: 0,
        fsPath: '/db/migrations',
      })
      expect(r.ok).toBe(false)
      // Error message must point at the build script, not at the user's fs.
      expect(r.message).toContain('build-binary')
      expect(r.message).not.toContain('restore the frozen epoch-1 migration bundle')
    })

    test('embedded mode ignores any fs values — fs presence is irrelevant', () => {
      // Even if a (stale) on-disk migrations dir is present, embedded count
      // is what counts in a compiled binary.
      const r = evaluateMigrationsStatus({
        embedded: true,
        embeddedSqlCount: 5,
        fsExists: true, // intentionally true to assert it's ignored
        fsSqlCount: 999, // intentionally large to assert it's ignored
        fsPath: '/db/migrations',
      })
      expect(r.ok).toBe(true)
      expect(r.message).toContain('5')
      expect(r.message).not.toContain('999')
    })
  })

  describe('dev / source-tree mode', () => {
    test('ok when fs exists and has SQL files — reports count "bundled"', () => {
      const r = evaluateMigrationsStatus({
        embedded: false,
        embeddedSqlCount: 0,
        fsExists: true,
        fsSqlCount: 7,
        fsPath: '/repo/packages/backend/db/migrations',
      })
      expect(r.ok).toBe(true)
      expect(r.message).toContain('7 migrations bundled')
    })

    test('singular form when exactly 1 fs migration', () => {
      const r = evaluateMigrationsStatus({
        embedded: false,
        embeddedSqlCount: 0,
        fsExists: true,
        fsSqlCount: 1,
        fsPath: '/repo/packages/backend/db/migrations',
      })
      expect(r.ok).toBe(true)
      expect(r.message).toContain('1 migration ')
      expect(r.message).not.toContain('migrations')
    })

    test('fail when fs missing — message includes the path + frozen-bundle restore hint', () => {
      const r = evaluateMigrationsStatus({
        embedded: false,
        embeddedSqlCount: 0,
        fsExists: false,
        fsSqlCount: 0,
        fsPath: '/repo/packages/backend/db/migrations',
      })
      expect(r.ok).toBe(false)
      expect(r.message).toContain('/repo/packages/backend/db/migrations')
      expect(r.message).toContain('restore the frozen epoch-1 migration bundle')
    })

    test('fail when fs exists but is empty of .sql', () => {
      const r = evaluateMigrationsStatus({
        embedded: false,
        embeddedSqlCount: 0,
        fsExists: true,
        fsSqlCount: 0,
        fsPath: '/repo/packages/backend/db/migrations',
      })
      expect(r.ok).toBe(false)
      expect(r.message).toContain('no .sql migrations found')
      expect(r.message).toContain('restore the frozen epoch-1 migration bundle')
    })

    test('dev mode ignores embedded count — IS_EMBEDDED=false stays on fs check', () => {
      // A stale generated embed.generated.ts (e.g. forgotten reset after a
      // build-binary attempt) should not silently pass dev when fs is empty.
      const r = evaluateMigrationsStatus({
        embedded: false,
        embeddedSqlCount: 999, // intentionally large to assert it's ignored
        fsExists: false,
        fsSqlCount: 0,
        fsPath: '/repo/packages/backend/db/migrations',
      })
      expect(r.ok).toBe(false)
      expect(r.message).toContain('restore the frozen epoch-1 migration bundle')
    })
  })
})

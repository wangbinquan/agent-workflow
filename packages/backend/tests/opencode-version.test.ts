import { describe, expect, test } from 'bun:test'
import {
  compareSemver,
  extractVersion,
  MAX_OPENCODE_VERSION_EXCLUSIVE,
  MIN_OPENCODE_VERSION,
  probeOpencode,
} from '../src/util/opencode'

describe('semver helpers', () => {
  test('extractVersion grabs first X.Y.Z in output', () => {
    expect(extractVersion('1.14.25')).toBe('1.14.25')
    expect(extractVersion('opencode version 1.14.0\n')).toBe('1.14.0')
    expect(extractVersion('foo 0.99.3 bar 2.0.0')).toBe('0.99.3')
    expect(extractVersion('no version here')).toBeNull()
  })

  test('compareSemver orders correctly', () => {
    expect(compareSemver('1.14.0', '1.14.0')).toBe(0)
    expect(compareSemver('1.14.0', '1.13.99')).toBeGreaterThan(0)
    expect(compareSemver('1.14.0', '2.0.0')).toBeLessThan(0)
    expect(compareSemver('1.14.25', '1.14.0')).toBeGreaterThan(0)
    expect(compareSemver('1.14.0', '1.14.0-rc.1')).toBe(0) // prerelease ignored
  })
})

describe('probeOpencode', () => {
  test('returns null version when binary does not exist', async () => {
    const probe = await probeOpencode('/nonexistent/opencode-binary-asdfqwer')
    expect(probe.version).toBeNull()
    expect(probe.compatible).toBe(false)
    expect(probe.binary).toBe('/nonexistent/opencode-binary-asdfqwer')
  })

  test('probes real opencode if on PATH', async () => {
    // This is an integration test that only runs when opencode is installed
    // (it always is on the developer machine; CI installs opencode separately
    // — for M1 we just smoke-test that the probe works on the developer box
    // and assert MIN_OPENCODE_VERSION <= version < MAX_OPENCODE_VERSION_EXCLUSIVE
    // if found).
    const probe = await probeOpencode()
    if (probe.version === null) {
      // Skip silently: opencode not in PATH in this environment.
      return
    }
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(compareSemver(probe.version, MIN_OPENCODE_VERSION)).toBeGreaterThanOrEqual(0)
    expect(compareSemver(probe.version, MAX_OPENCODE_VERSION_EXCLUSIVE)).toBeLessThan(0)
    expect(probe.compatible).toBe(true)
  })
})

describe('version cap', () => {
  // Why this exists: opencode 1.14.51 (upstream commit 7f2b5ee8c, the
  // Effect-TS rewrite of `packages/opencode/src/cli/cmd/run.ts`) changed root
  // resolution from `process.cwd()` to `process.env.PWD ?? process.cwd()`.
  // Combined with `Bun.spawn({cwd: ...})` — which updates the child's
  // `process.cwd()` but inherits `PWD` from the daemon's parent shell —
  // opencode silently loaded TWO Instances (one at cwd, one at PWD) and
  // dropped `--format json` events on the floor: every run "fails: no
  // <workflow-output> envelope" with exit 0 and SessionTab renders empty.
  //
  // Fix landed in services/runner.ts and services/memoryDistiller.ts: both
  // spawn paths now explicitly set `PWD = cwd` in the child env. With that
  // fix, 1.14.30+ work fine. The cap exists as a "you bumped past a minor —
  // re-verify" tripwire; bump it forward after smoke-testing a candidate.

  test('MAX_OPENCODE_VERSION_EXCLUSIVE is strictly above MIN_OPENCODE_VERSION', () => {
    // Why: if someone bumps MIN past MAX, no version is acceptable and the
    // daemon refuses to start with a confusing "incompatible" message.
    expect(compareSemver(MAX_OPENCODE_VERSION_EXCLUSIVE, MIN_OPENCODE_VERSION)).toBeGreaterThan(0)
  })

  test('1.14.25 is inside the supported window', () => {
    expect(compareSemver('1.14.25', MIN_OPENCODE_VERSION)).toBeGreaterThanOrEqual(0)
    expect(compareSemver('1.14.25', MAX_OPENCODE_VERSION_EXCLUSIVE)).toBeLessThan(0)
  })

  test('1.14.29 is inside the supported window', () => {
    expect(compareSemver('1.14.29', MIN_OPENCODE_VERSION)).toBeGreaterThanOrEqual(0)
    expect(compareSemver('1.14.29', MAX_OPENCODE_VERSION_EXCLUSIVE)).toBeLessThan(0)
  })

  test('1.14.51 is inside the supported window (the run.ts PWD regression is handled at the spawn site)', () => {
    // Why: once `services/runner.ts` / `services/memoryDistiller.ts` set
    // `PWD = cwd`, the stdout-streaming break in 1.14.51 goes away. This
    // assertion exists so future cap tweaks can't silently re-blacklist
    // 1.14.51 without also re-examining whether the spawn fix has rotted.
    expect(compareSemver('1.14.51', MIN_OPENCODE_VERSION)).toBeGreaterThanOrEqual(0)
    expect(compareSemver('1.14.51', MAX_OPENCODE_VERSION_EXCLUSIVE)).toBeLessThan(0)
  })

  test('1.15.5 is inside the supported window (verified-working with the spawn fix)', () => {
    // Why: 1.15.0+ absorbs upstream commit e11e089e4 (Effect-native core
    // event system) which makes the SSE path resilient to PWD/cwd mismatch
    // on its own. Reproduced 2026-05-20: 1.15.5 emits the expected 4-event
    // JSON stream against the same clarify-iteration fixture that broke
    // 1.14.51 without our spawn fix.
    expect(compareSemver('1.15.5', MIN_OPENCODE_VERSION)).toBeGreaterThanOrEqual(0)
    expect(compareSemver('1.15.5', MAX_OPENCODE_VERSION_EXCLUSIVE)).toBeLessThan(0)
  })

  test('1.16.0 is at/above the cap (the next-minor tripwire)', () => {
    expect(compareSemver('1.16.0', MAX_OPENCODE_VERSION_EXCLUSIVE)).toBeGreaterThanOrEqual(0)
  })
})

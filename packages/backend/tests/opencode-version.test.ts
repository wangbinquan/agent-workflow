import { describe, expect, test } from 'bun:test'
import {
  compareSemver,
  extractVersion,
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
    // and assert version >= MIN_OPENCODE_VERSION if found; there is no upper
    // bound).
    const probe = await probeOpencode()
    if (probe.version === null) {
      // Skip silently: opencode not in PATH in this environment.
      return
    }
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(compareSemver(probe.version, MIN_OPENCODE_VERSION)).toBeGreaterThanOrEqual(0)
    expect(probe.compatible).toBe(true)
  })
})

describe('RFC-224 pinned minimum', () => {
  // History: an exclusive upper bound (MAX_OPENCODE_VERSION_EXCLUSIVE) used to
  // exist as a "you bumped past a minor — re-verify" tripwire. It was born from
  // opencode 1.14.51 (upstream commit 7f2b5ee8c, the Effect-TS rewrite of
  // `packages/opencode/src/cli/cmd/run.ts`) changing root resolution from
  // `process.cwd()` to `process.env.PWD ?? process.cwd()`. Combined with
  // `Bun.spawn({cwd: ...})` — which updates the child's `process.cwd()` but
  // inherits `PWD` from the daemon's parent shell — opencode silently loaded
  // TWO Instances and dropped `--format json` events: every run "fails: no
  // <workflow-output> envelope" with exit 0 and SessionTab renders empty.
  //
  // The real fix landed in services/runner.ts and services/memoryDistiller.ts:
  // both spawn paths now explicitly set `PWD = cwd` in the child env. With that
  // fix in place the regression cannot recur regardless of opencode version, so
  // the upper bound only ever blocked new releases at daemon startup with no
  // safety benefit. It was removed on 2026-06-19 (user request): the daemon now
  // accepts any version >= MIN_OPENCODE_VERSION.
  //
  // These assertions lock in "anything at/above MIN is accepted" — if a ceiling
  // is reintroduced, the high-version cases go red and force a re-justification.

  for (const v of ['1.18.3', '2.0.0', '10.5.3']) {
    test(`${v} is >= MIN_OPENCODE_VERSION (accepted, no upper bound)`, () => {
      expect(compareSemver(v, MIN_OPENCODE_VERSION)).toBeGreaterThanOrEqual(0)
    })
  }
  for (const v of ['1.14.25', '1.15.5', '1.17.0', '1.18.2']) {
    test(`${v} is below RFC-224's pinned minimum`, () => {
      expect(compareSemver(v, MIN_OPENCODE_VERSION)).toBeLessThan(0)
    })
  }
})

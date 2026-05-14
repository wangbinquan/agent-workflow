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
    // and assert >= MIN_OPENCODE_VERSION if found).
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

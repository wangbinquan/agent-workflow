// RFC-254 T21 — doctor's ssh prerequisite probe.
//
// ssh is OPTIONAL (only ssh:// git remotes need it; https goes through T20's
// credential subcommand), so the check is ADVISORY: always ok, never fails
// doctor, but surfaces presence + a platform-specific install hint. These lock
// that contract and the win32-specific hint (OpenSSH is an Optional Feature).

import { describe, expect, test } from 'bun:test'
import { evaluateSshCheck } from '@/cli/doctor'

describe('RFC-254 T21 — doctor ssh probe (advisory)', () => {
  test('present: ok, reports the banner, notes ssh:// is available', () => {
    const r = evaluateSshCheck('OpenSSH_for_Windows_9.5', 'win32')
    expect(r.ok).toBe(true)
    expect(r.name).toBe('ssh (optional)')
    expect(r.message).toContain('OpenSSH_for_Windows_9.5')
    expect(r.message).toContain('ssh:// remotes available')
  })

  test('absent on win32: STILL ok (advisory), with the Optional-Feature hint', () => {
    const r = evaluateSshCheck(null, 'win32')
    expect(r.ok).toBe(true) // never fails doctor — ssh is optional
    expect(r.message).toContain('Optional Features')
    expect(r.message).toContain('OpenSSH Client')
    // makes clear https is unaffected, so operators don't panic
    expect(r.message).toContain('https remotes are unaffected')
  })

  test('absent on POSIX: ok, with the openssh-client hint (no Windows wording)', () => {
    const r = evaluateSshCheck(null, 'linux')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('openssh-client')
    expect(r.message).not.toContain('Optional Features')
  })

  test('empty banner is treated as absent', () => {
    expect(evaluateSshCheck('', 'darwin').message).toContain('openssh-client')
  })
})

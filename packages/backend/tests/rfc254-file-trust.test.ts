// RFC-254 T0a (D22) — the verified store's file-trust primitive.
//
// The design gate (P0-C) found the three trust proofs — privacy, not-a-link,
// same-object — spelled inline as POSIX arithmetic across six files, where
// Windows would answer nonsense: Node synthesizes `mode` from the read-only
// attribute (a writable file reports 0o666 regardless of its ACL) and `ino` is
// 0 or unstable on NTFS. These cases lock the contract that replaced it, and in
// particular that an unprovable platform FAILS rather than skipping.

import { describe, expect, test } from 'bun:test'
import {
  PRIVATE_FILE_MODE,
  SEALED_EXEC_MODE,
  assertPrivateRegularFile,
  assertSameFileIdentity,
  assertUnopenedPrivateFile,
  statMetadataIsAuthoritative,
  type TrustStats,
} from '@/util/fileTrust'

function stats(overrides: Partial<TrustStats> & { mode?: number } = {}): TrustStats {
  return {
    isFile: () => overrides.isFile?.() ?? true,
    isSymbolicLink: () => overrides.isSymbolicLink?.() ?? false,
    mode: overrides.mode ?? 0o100600,
    dev: overrides.dev ?? 1,
    ino: overrides.ino ?? 2,
    size: overrides.size ?? 10,
  }
}

describe('RFC-254 file trust primitive', () => {
  test('only POSIX can prove these properties from stat metadata', () => {
    expect(statMetadataIsAuthoritative('linux')).toBe(true)
    expect(statMetadataIsAuthoritative('darwin')).toBe(true)
    expect(statMetadataIsAuthoritative('win32')).toBe(false)
  })

  describe('assertPrivateRegularFile', () => {
    test('accepts an owner-only regular file', () => {
      expect(assertPrivateRegularFile(stats(), 'linux')).toEqual({ trusted: true })
    })

    test('rejects group/other-readable modes', () => {
      // 0o640 is the classic "harmless" relaxation; the store's threat model
      // has no other local principal it trusts, so it is not harmless here.
      expect(assertPrivateRegularFile(stats({ mode: 0o100640 }), 'linux')).toEqual({
        trusted: false,
        reason: 'not-private',
      })
      expect(assertPrivateRegularFile(stats({ mode: 0o100666 }), 'linux')).toEqual({
        trusted: false,
        reason: 'not-private',
      })
    })

    test('rejects non-regular files', () => {
      expect(assertPrivateRegularFile(stats({ isFile: () => false }), 'linux')).toEqual({
        trusted: false,
        reason: 'not-regular-file',
      })
    })

    test('supports the sealed read+execute mode', () => {
      expect(
        assertPrivateRegularFile(stats({ mode: 0o100500 }), 'linux', SEALED_EXEC_MODE),
      ).toEqual({ trusted: true })
      expect(
        assertPrivateRegularFile(stats({ mode: 0o100700 }), 'linux', SEALED_EXEC_MODE),
      ).toEqual({ trusted: false, reason: 'not-private' })
    })

    test('win32 fails CLOSED with a legible reason, never a silent pass', () => {
      // The whole point of D22. A win32 verdict of `trusted: true` here would
      // let a receipt claim "verified" over a file nothing verified.
      expect(assertPrivateRegularFile(stats(), 'win32')).toEqual({
        trusted: false,
        reason: 'platform-unsupported',
      })
      // Even for a file whose synthesized mode happens to look right.
      expect(assertPrivateRegularFile(stats({ mode: 0o100600 }), 'win32')).toEqual({
        trusted: false,
        reason: 'platform-unsupported',
      })
    })
  })

  describe('assertUnopenedPrivateFile', () => {
    test('accepts a private regular file within budget', () => {
      expect(assertUnopenedPrivateFile(stats({ size: 100 }), 'linux', { maxBytes: 200 })).toEqual({
        trusted: true,
      })
    })

    test('reports a symlink AS a link, ahead of any permission verdict', () => {
      // Diagnosis matters: a planted symlink whose target is world-readable
      // must not be reported as "not-private", which reads like a chmod bug.
      const link = stats({ isSymbolicLink: () => true, mode: 0o100666 })
      expect(assertUnopenedPrivateFile(link, 'linux')).toEqual({
        trusted: false,
        reason: 'is-link',
      })
    })

    test('enforces the size ceiling when one is given', () => {
      expect(assertUnopenedPrivateFile(stats({ size: 201 }), 'linux', { maxBytes: 200 })).toEqual({
        trusted: false,
        reason: 'size-changed',
      })
      expect(assertUnopenedPrivateFile(stats({ size: 10_000 }), 'linux')).toEqual({ trusted: true })
    })

    test('win32 fails closed', () => {
      expect(assertUnopenedPrivateFile(stats(), 'win32')).toEqual({
        trusted: false,
        reason: 'platform-unsupported',
      })
    })
  })

  describe('assertSameFileIdentity', () => {
    test('accepts the same dev/ino', () => {
      expect(assertSameFileIdentity(stats(), stats(), 'linux')).toEqual({ trusted: true })
    })

    test('rejects a swapped inode or device', () => {
      expect(assertSameFileIdentity(stats(), stats({ ino: 999 }), 'linux')).toEqual({
        trusted: false,
        reason: 'identity-changed',
      })
      expect(assertSameFileIdentity(stats(), stats({ dev: 999 }), 'linux')).toEqual({
        trusted: false,
        reason: 'identity-changed',
      })
    })

    test('does NOT judge size — callers own that rule', () => {
      // Locked deliberately: the manifest wants byte-exact equality, the
      // control ACK wants a ceiling. Folding either in here would silently
      // change the other.
      expect(assertSameFileIdentity(stats({ size: 10 }), stats({ size: 99 }), 'linux')).toEqual({
        trusted: true,
      })
    })

    test('win32 fails closed', () => {
      expect(assertSameFileIdentity(stats(), stats(), 'win32')).toEqual({
        trusted: false,
        reason: 'platform-unsupported',
      })
    })
  })

  test('PRIVATE_FILE_MODE is the mode the verified store actually writes', () => {
    expect(PRIVATE_FILE_MODE).toBe(0o600)
    expect(SEALED_EXEC_MODE).toBe(0o500)
  })
})

// RFC-254 T0a (D22) — cross-platform sensitive-file and identity checks.
//
// The design gate (P0-C) found the three trust proofs — privacy, not-a-link,
// same-object — spelled inline as POSIX arithmetic across six files, where
// Windows would answer nonsense: Node synthesizes `mode` from the read-only
// attribute (a writable file reports 0o666 regardless of its ACL) and `ino` is
// 0 or unstable on NTFS. These cases lock the contract that replaced it, and in
// particular that an unprovable platform reports a failure rather than skipping.

import { describe, expect, test } from 'bun:test'
import {
  PRIVATE_FILE_MODE,
  OWNER_READ_EXECUTE_MODE,
  assertPrivateRegularFile,
  assertPrivateRegularFileByPath,
  assertPrivateRegularFileByPathSync,
  assertSameDirectoryIdentity,
  assertSameFileIdentity,
  assertUnopenedPrivateFile,
  assertUnopenedPrivateFileByPath,
  assertUnopenedPrivateFileByPathSync,
  statMetadataIsAuthoritative,
  type FileTrustVerdict,
  type TrustStats,
} from '@/util/fileTrust'

function stats(overrides: Partial<TrustStats> & { mode?: number } = {}): TrustStats {
  return {
    isFile: () => overrides.isFile?.() ?? true,
    isDirectory: () => overrides.isDirectory?.() ?? false,
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
      // 0o640 grants a second local principal access, so it is not owner-only.
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

    test('supports the owner read+execute mode', () => {
      expect(
        assertPrivateRegularFile(stats({ mode: 0o100500 }), 'linux', OWNER_READ_EXECUTE_MODE),
      ).toEqual({ trusted: true })
      expect(
        assertPrivateRegularFile(stats({ mode: 0o100700 }), 'linux', OWNER_READ_EXECUTE_MODE),
      ).toEqual({ trusted: false, reason: 'not-private' })
    })

    test('win32 fails CLOSED with a legible reason, never a silent pass', () => {
      // The whole point of D22. A win32 verdict of `trusted: true` here would
      // let a caller treat an unproven privacy property as owner-only.
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
      // Locked deliberately: callers apply their own size equality or ceiling.
      expect(assertSameFileIdentity(stats({ size: 10 }), stats({ size: 99 }), 'linux')).toEqual({
        trusted: true,
      })
    })

    // RFC-254 T40a: identity IS authoritative on win32 — Bun populates dev/ino
    // from GetFileInformationByHandle (VolumeSerialNumber + FileIndex), measured
    // reliable on NTFS. Unlike the mode-based PRIVACY assertions above (which
    // stay win32 fail-closed pending the DACL), the identity check compares the
    // real index there.
    test('win32 accepts a matching nonzero dev/ino (authoritative via file index)', () => {
      expect(assertSameFileIdentity(stats(), stats(), 'win32')).toEqual({ trusted: true })
    })

    test('win32 rejects a swapped index just like POSIX', () => {
      expect(assertSameFileIdentity(stats(), stats({ ino: 999 }), 'win32')).toEqual({
        trusted: false,
        reason: 'identity-changed',
      })
    })

    test('win32 fails CLOSED when the filesystem supplied no index (0 = FAT / some shares)', () => {
      // Two indexless "0" objects must never be treated as the same file.
      expect(assertSameFileIdentity(stats({ ino: 0 }), stats({ ino: 0 }), 'win32')).toEqual({
        trusted: false,
        reason: 'platform-unsupported',
      })
      // A zero on either side is unprovable, even if the other side has an index.
      expect(assertSameFileIdentity(stats({ ino: 0 }), stats(), 'win32')).toEqual({
        trusted: false,
        reason: 'platform-unsupported',
      })
    })
  })

  describe('assertSameDirectoryIdentity', () => {
    const directory = (
      overrides: Partial<Pick<TrustStats, 'dev' | 'ino' | 'isSymbolicLink'>> = {},
    ): TrustStats => stats({ ...overrides, isFile: () => false, isDirectory: () => true })

    test('accepts the same real directory and rejects replacement or a link', () => {
      expect(assertSameDirectoryIdentity(directory(), directory(), 'linux')).toEqual({
        trusted: true,
      })
      expect(assertSameDirectoryIdentity(directory(), directory({ ino: 999 }), 'linux')).toEqual({
        trusted: false,
        reason: 'identity-changed',
      })
      expect(
        assertSameDirectoryIdentity(
          directory(),
          directory({ isSymbolicLink: () => true }),
          'linux',
        ),
      ).toEqual({ trusted: false, reason: 'not-directory' })
    })
  })

  describe('bigint stats (Node { bigint: true } variant)', () => {
    // Some callers stat with `bigint: true` to keep the full permission word.
    // The typechecker found this when the primitive first
    // landed with number-only fields — a reminder that "same shape" is not the
    // same as "same representation".
    const big = (o: Partial<Record<'dev' | 'ino' | 'mode' | 'size', bigint>> = {}): TrustStats => ({
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      mode: o.mode ?? 0o100600n,
      dev: o.dev ?? 1n,
      ino: o.ino ?? 2n,
      size: o.size ?? 10n,
    })

    test('privacy verdict is identical for bigint and number modes', () => {
      expect(assertPrivateRegularFile(big(), 'linux')).toEqual({ trusted: true })
      expect(assertPrivateRegularFile(big({ mode: 0o100666n }), 'linux')).toEqual({
        trusted: false,
        reason: 'not-private',
      })
    })

    test('identity compares bigint pairs by value', () => {
      expect(assertSameFileIdentity(big(), big(), 'linux')).toEqual({ trusted: true })
      expect(assertSameFileIdentity(big(), big({ ino: 999n }), 'linux')).toEqual({
        trusted: false,
        reason: 'identity-changed',
      })
    })

    test('the size ceiling works against a bigint size', () => {
      expect(assertUnopenedPrivateFile(big({ size: 201n }), 'linux', { maxBytes: 200 })).toEqual({
        trusted: false,
        reason: 'size-changed',
      })
    })
  })

  test('owner-only mode constants keep their exact POSIX values', () => {
    expect(PRIVATE_FILE_MODE).toBe(0o600)
    expect(OWNER_READ_EXECUTE_MODE).toBe(0o500)
  })
})

// RFC-254 T40b: the PATH-aware privacy variants. On POSIX they route to the
// existing mode arithmetic (the win32 DACL reader is never consulted); on win32
// they apply the stat-based guards (regular file, not a link, size) and then
// defer to the injected reader. The reader is injected here so both branches run
// on any OS — the real reader (`win32Acl.ts`) is proven on a Windows VM.
describe('RFC-254 path-aware privacy (T40b)', () => {
  const READER_VERDICT: FileTrustVerdict = { trusted: false, reason: 'is-link' }
  function spyReader() {
    const calls: string[] = []
    const reader = (path: string) => {
      calls.push(path)
      return READER_VERDICT
    }
    return { calls, reader }
  }

  describe('POSIX routes to mode arithmetic, never the DACL reader', () => {
    test('async: private mode trusted, reader untouched', async () => {
      const { calls, reader } = spyReader()
      expect(
        await assertPrivateRegularFileByPath('/x', stats(), 'linux', async (p) => reader(p)),
      ).toEqual({ trusted: true })
      expect(
        await assertPrivateRegularFileByPath('/x', stats({ mode: 0o100666 }), 'linux', async (p) =>
          reader(p),
        ),
      ).toEqual({
        trusted: false,
        reason: 'not-private',
      })
      expect(calls).toEqual([])
    })

    test('sync: same verdict, reader untouched', () => {
      const { calls, reader } = spyReader()
      expect(assertPrivateRegularFileByPathSync('/x', stats(), 'linux', reader)).toEqual({
        trusted: true,
      })
      expect(calls).toEqual([])
    })

    test('unopened async/sync honor link + size on POSIX without the reader', () => {
      const { calls, reader } = spyReader()
      const link = stats({ isSymbolicLink: () => true })
      expect(assertUnopenedPrivateFileByPathSync('/x', link, 'linux', reader)).toEqual({
        trusted: false,
        reason: 'is-link',
      })
      expect(calls).toEqual([])
    })
  })

  describe('win32 applies stat guards, THEN the DACL reader', () => {
    test('a non-regular file is rejected before the reader runs', async () => {
      const { calls, reader } = spyReader()
      expect(
        await assertPrivateRegularFileByPath(
          '/x',
          stats({ isFile: () => false }),
          'win32',
          async (p) => reader(p),
        ),
      ).toEqual({ trusted: false, reason: 'not-regular-file' })
      expect(calls).toEqual([])
    })

    test('a symlink is reported as a link before the reader runs (unopened)', () => {
      const { calls, reader } = spyReader()
      const link = stats({ isSymbolicLink: () => true })
      expect(assertUnopenedPrivateFileByPathSync('/x', link, 'win32', reader)).toEqual({
        trusted: false,
        reason: 'is-link',
      })
      expect(calls).toEqual([])
    })

    test('an oversize file fails the ceiling before the reader runs (unopened)', () => {
      const { calls, reader } = spyReader()
      expect(
        assertUnopenedPrivateFileByPathSync('/x', stats({ size: 999 }), 'win32', reader, {
          maxBytes: 100,
        }),
      ).toEqual({ trusted: false, reason: 'size-changed' })
      expect(calls).toEqual([])
    })

    test('async unopened: guards pass -> reader decides (and a symlink short-circuits it)', async () => {
      const { calls, reader } = spyReader()
      // symlink short-circuits before the reader
      const link = stats({ isSymbolicLink: () => true })
      expect(
        await assertUnopenedPrivateFileByPath('/x', link, 'win32', async (p) => reader(p)),
      ).toEqual({ trusted: false, reason: 'is-link' })
      // a clean regular file reaches the reader
      expect(
        await assertUnopenedPrivateFileByPath('C:\\store\\ack.json', stats(), 'win32', async (p) =>
          reader(p),
        ),
      ).toBe(READER_VERDICT)
      expect(calls).toEqual(['C:\\store\\ack.json'])
    })

    test('guards passed -> the DACL reader decides, and gets the path', async () => {
      const { calls, reader } = spyReader()
      const asyncVerdict = await assertPrivateRegularFileByPath(
        'C:\\store\\manifest.json',
        stats(),
        'win32',
        async (p) => reader(p),
      )
      expect(asyncVerdict).toBe(READER_VERDICT)
      const syncVerdict = assertPrivateRegularFileByPathSync(
        'C:\\store\\ack.json',
        stats(),
        'win32',
        reader,
      )
      expect(syncVerdict).toBe(READER_VERDICT)
      expect(calls).toEqual(['C:\\store\\manifest.json', 'C:\\store\\ack.json'])
    })

    test('the win32 branch ignores the synthesized mode (0o666 is fine here)', () => {
      const { reader } = spyReader()
      // A win32 file always reports 0o666; the DACL reader — not the mode — decides.
      const trustingReader = () => ({ trusted: true }) as FileTrustVerdict
      expect(
        assertPrivateRegularFileByPathSync(
          '/x',
          stats({ mode: 0o100666 }),
          'win32',
          trustingReader,
        ),
      ).toEqual({ trusted: true })
      void reader
    })
  })
})

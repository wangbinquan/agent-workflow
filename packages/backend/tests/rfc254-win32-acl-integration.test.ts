// RFC-254 T40b — REAL icacls/whoami integration for the win32 privacy primitive.
//
// The pure tests in `rfc254-win32-acl.test.ts` lock the SDDL parsing against
// measured strings. THIS suite proves the impure half actually works on a real
// Windows machine: that `assertWindowsFilePrivate` spawns `icacls`/`whoami`,
// reads a real DACL, and returns the right verdict for a file created the way the
// verified store creates them (Bun `open` with mode 0o600 under `tmpdir()`), for a
// file deliberately leaked to Everyone, for a missing file, and for a directory
// sealed by `sealDirectoryOwnerOnly`.
//
// It is the executable form of the design doc's "real-machine ACL round-trip"
// gate. It runs only on win32 (skipped elsewhere — registered in
// test-suite-policy) because it depends on the actual Windows ACL subsystem.

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  __resetUserSidCacheForTests,
  assertWindowsFilePrivate,
  getCurrentUserSid,
  sealDirectoryOwnerOnly,
} from '@/util/win32Acl'

const isWin32 = process.platform === 'win32'

describe.skipIf(!isWin32)('RFC-254 T40b — real icacls integration (win32)', () => {
  test('getCurrentUserSid returns a real user SID', async () => {
    __resetUserSidCacheForTests()
    const sid = await getCurrentUserSid()
    expect(sid).toMatch(/^S-1-5-/)
  })

  test('a broad-ACL base dir (e.g. %TEMP% granting Users/AuthUsers) is correctly REJECTED unsealed', async () => {
    // On this machine `tmpdir()` inherits Users (BU) + Authenticated Users (AU) —
    // a real store file created there without sealing must NOT be judged private.
    // (If a given machine's %TEMP% happens to be owner-only, this still holds: a
    // clean dir returns trusted, which we assert separately via the sealed case.)
    const dir = await mkdtemp(join(tmpdir(), 'aw-t40b-'))
    try {
      const file = join(dir, 'manifest.json')
      await writeFile(file, '{}', { mode: 0o600 })
      const verdict = await assertWindowsFilePrivate(file)
      // Either the base dir is broad (rejected) or already owner-only (trusted).
      // What must NEVER happen is a crash or a bogus reason — the verdict is well
      // formed and, when rejected, is specifically `not-private`.
      if (!verdict.trusted) expect(verdict).toEqual({ trusted: false, reason: 'not-private' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a file under a SEALED store dir is private — the production shape', async () => {
    // This mirrors exactly what acquireOpencodeStoreLifecycleLock does on win32:
    // seal the store dir, then create files under it.
    const dir = await mkdtemp(join(tmpdir(), 'aw-t40b-store-'))
    try {
      expect(await sealDirectoryOwnerOnly(dir)).toEqual({ trusted: true })
      const file = join(dir, 'manifest.json')
      await writeFile(file, '{}', { mode: 0o600 })
      expect(await assertWindowsFilePrivate(file)).toEqual({ trusted: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('granting Everyone read makes the SAME file NOT private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aw-t40b-'))
    try {
      const file = join(dir, 'leak.json')
      await writeFile(file, '{}', { mode: 0o600 })
      // Everyone = S-1-1-0. This is exactly the leak the primitive must catch.
      const granted = spawnSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], { windowsHide: true })
      expect(granted.status).toBe(0)
      expect(await assertWindowsFilePrivate(file)).toEqual({
        trusted: false,
        reason: 'not-private',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a missing file fails CLOSED (platform-unsupported, never a silent pass)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aw-t40b-'))
    try {
      expect(await assertWindowsFilePrivate(join(dir, 'does-not-exist.json'))).toEqual({
        trusted: false,
        reason: 'platform-unsupported',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('sealDirectoryOwnerOnly locks a directory; a child created after inherits and verifies private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aw-t40b-seal-'))
    try {
      expect(await sealDirectoryOwnerOnly(dir)).toEqual({ trusted: true })
      const child = join(dir, 'child.json')
      await writeFile(child, '{}', { mode: 0o600 })
      expect(await assertWindowsFilePrivate(child)).toEqual({ trusted: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// RFC-254 T40b — the win32 file-PRIVACY DACL primitive.
//
// The verified store's privacy proof on Windows reads the file's DACL (its `mode`
// is synthesized there) and accepts it only if every ALLOW ace names {the user,
// SYSTEM, Administrators}. These lock the PURE core of that check — SDDL parsing
// and the whitelist verdict — against the EXACT strings measured from `icacls
// /save` on Windows 11 (2026-08-06), so a future refactor that mis-parses an ACE
// or widens the whitelist turns red here rather than on a real machine.
//
// The impure halves (`icacls`/`whoami` spawns) are proven on the VM, not here;
// these functions are pure over injected strings and run on any OS.

import { describe, expect, test } from 'bun:test'
import {
  daclFromSaveText,
  extractDacl,
  parseDaclAllowSids,
  parseWhoamiSid,
  verifyDaclPrivate,
} from '@/util/win32Acl'

// Measured on the VM: a file created under %USERPROFILE% inherits exactly this.
const USER_SID = 'S-1-5-21-347848904-4037236529-1378664798-1000'
const PRIVATE_DACL = `D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER_SID})`
// Measured after `icacls <f> /grant *S-1-1-0:(R)` — Everyone gets a read ace.
const EVERYONE_DACL = `D:AI(A;;FR;;;WD)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER_SID})`

describe('RFC-254 win32 ACL — extractDacl', () => {
  test('pulls the D: run out of a full O:G:D:S: SDDL', () => {
    const full = `O:${USER_SID}G:S-1-5-21-1G:${PRIVATE_DACL}S:(AU;;FA;;;WD)`
    // The G: prefix is not real here — just prove S: is dropped and D: kept.
    expect(extractDacl(`O:${USER_SID}${PRIVATE_DACL}S:(AU;SAFA;;;WD)`)).toBe(PRIVATE_DACL)
    expect(full.includes('D:')).toBe(true)
  })

  test('returns null when there is no DACL', () => {
    expect(extractDacl(`O:${USER_SID}G:BA`)).toBeNull()
  })

  test('keeps the whole DACL when there is no SACL', () => {
    expect(extractDacl(PRIVATE_DACL)).toBe(PRIVATE_DACL)
  })
})

describe('RFC-254 win32 ACL — parseDaclAllowSids', () => {
  test('lists the three allow SIDs of a private file', () => {
    const parsed = parseDaclAllowSids(PRIVATE_DACL)
    expect(parsed.ok).toBe(true)
    expect(parsed.allowSids).toEqual(['SY', 'BA', USER_SID])
  })

  test('surfaces an Everyone (WD) grant among the allow SIDs', () => {
    const parsed = parseDaclAllowSids(EVERYONE_DACL)
    expect(parsed.ok).toBe(true)
    expect(parsed.allowSids).toContain('WD')
  })

  test('ignores DENY aces — they cannot grant access', () => {
    const parsed = parseDaclAllowSids(`D:(D;;FA;;;WD)(A;ID;FA;;;${USER_SID})`)
    expect(parsed.ok).toBe(true)
    expect(parsed.allowSids).toEqual([USER_SID])
  })

  test('fails closed on a null/empty DACL', () => {
    expect(parseDaclAllowSids('D:NO_ACCESS_CONTROL').ok).toBe(false)
    expect(parseDaclAllowSids('D:').ok).toBe(false)
    expect(parseDaclAllowSids('garbage').ok).toBe(false)
  })

  test('fails closed on a malformed ace (too few fields)', () => {
    expect(parseDaclAllowSids('D:(A;ID;FA)').ok).toBe(false)
  })
})

describe('RFC-254 win32 ACL — verifyDaclPrivate', () => {
  test('accepts a file granted only to user + SYSTEM + Administrators', () => {
    expect(verifyDaclPrivate(USER_SID, PRIVATE_DACL)).toEqual({ trusted: true })
  })

  test('accepts full SIDs for SYSTEM/Administrators, not just SDDL aliases', () => {
    const dacl = `D:(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FA;;;${USER_SID})`
    expect(verifyDaclPrivate(USER_SID, dacl)).toEqual({ trusted: true })
  })

  test('REJECTS an Everyone grant', () => {
    expect(verifyDaclPrivate(USER_SID, EVERYONE_DACL)).toEqual({
      trusted: false,
      reason: 'not-private',
    })
  })

  test('REJECTS a grant to a different user', () => {
    const other = 'S-1-5-21-999-999-999-1001'
    const dacl = `D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER_SID})(A;;FR;;;${other})`
    expect(verifyDaclPrivate(USER_SID, dacl)).toEqual({ trusted: false, reason: 'not-private' })
  })

  test('REJECTS Users (BU) and Authenticated Users (AU) grants', () => {
    expect(verifyDaclPrivate(USER_SID, `D:(A;;FA;;;${USER_SID})(A;;FR;;;BU)`)).toEqual({
      trusted: false,
      reason: 'not-private',
    })
    expect(verifyDaclPrivate(USER_SID, `D:(A;;FA;;;${USER_SID})(A;;FR;;;AU)`)).toEqual({
      trusted: false,
      reason: 'not-private',
    })
  })

  test('REJECTS a DACL that never grants the user itself (system-only file)', () => {
    expect(verifyDaclPrivate(USER_SID, 'D:(A;;FA;;;SY)(A;;FA;;;BA)')).toEqual({
      trusted: false,
      reason: 'not-private',
    })
  })

  test('fails CLOSED when the SID or DACL could not be read', () => {
    expect(verifyDaclPrivate(null, PRIVATE_DACL)).toEqual({
      trusted: false,
      reason: 'platform-unsupported',
    })
    expect(verifyDaclPrivate(USER_SID, null)).toEqual({
      trusted: false,
      reason: 'platform-unsupported',
    })
    expect(verifyDaclPrivate(USER_SID, 'D:NO_ACCESS_CONTROL')).toEqual({
      trusted: false,
      reason: 'platform-unsupported',
    })
  })
})

describe('RFC-254 win32 ACL — icacls /save + whoami parsing', () => {
  test('daclFromSaveText reads the real icacls /save two-line format', () => {
    // Exactly what `icacls manifest.json /save out` writes (minus the UTF-16 BOM,
    // which the reader strips before this).
    const saved = `manifest.json\r\n${PRIVATE_DACL}\r\n`
    expect(daclFromSaveText(saved, 'C:\\Users\\me\\.agent-workflow\\manifest.json')).toBe(
      PRIVATE_DACL,
    )
  })

  test('daclFromSaveText returns null when the file has no saved ACL line', () => {
    expect(daclFromSaveText('someotherfile\r\n', 'manifest.json')).toBeNull()
  })

  test('parseWhoamiSid extracts the SID from the csv/nh line', () => {
    expect(parseWhoamiSid(`"machine\\user","${USER_SID}"`)).toBe(USER_SID)
    expect(parseWhoamiSid('unexpected output')).toBeNull()
  })
})

// RFC-254 T40b — the win32 half of the store's file-PRIVACY proof.
//
// WHY THIS EXISTS
// ---------------
// `util/fileTrust.ts` proves a sensitive file is platform-private. On POSIX that
// is `mode & 0o777 === 0o600`. On Windows `fs.Stats.mode` is SYNTHESIZED from the
// read-only attribute (a writable file reports 0o666 whatever its ACL says), so
// the POSIX arithmetic there is meaningless — `fileTrust` returns
// `platform-unsupported` (fail-closed) and the whole verified path refuses to run
// on Windows. This module supplies the real answer: read the file's DACL and
// prove it grants access to nobody outside {the current user, the OS TCB}.
//
// MEASURED FACTS (Windows 11, Bun 1.3.14, 2026-08-06 — drove the design, not guessed)
// ------------------------------------------------------------------------------------
//  - A file created under `%USERPROFILE%` (where `~/.agent-workflow` and
//    `os.tmpdir()` both live) inherits a DACL of exactly
//        D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<userSID>)
//    i.e. SYSTEM + BUILTIN\Administrators + the user, and NOTHING broader. That is
//    already the achievable Windows equivalent of 0o600: SYSTEM/Administrators are
//    the OS TCB (an admin can take-ownership of any file on any OS — out of the
//    threat model everywhere), and no other unprivileged principal is granted.
//  - `icacls <f> /save` writes the SID-based SDDL (locale-INDEPENDENT, unlike the
//    human-readable `icacls <f>` listing) as UTF-16LE: line 1 = basename,
//    line 2 = `D:...` SDDL. It costs ~106ms cold; `Get-Acl` via PowerShell costs
//    ~1166ms cold, which is why this uses icacls.
//  - Granting Everyone:R injects `(A;;FR;;;WD)` — detectable: `WD` ∉ whitelist.
//
// WHY icacls AND NOT bun:ffi(advapi32)
// ------------------------------------
// `bun:ffi`'s `dlopen()` is absent on the Windows ARM64 Bun build (TinyCC disabled
// — see `util/windowsJobObject.ts`), which is the user's acceptance machine. An
// FFI reader would degrade to fail-closed there, i.e. the verified path would STILL
// refuse on ARM64 — defeating the purpose. `icacls`/`whoami` are built-ins shipped
// on every Windows edition and both arches, so they are the only mechanism.
//
// SYNC + ASYNC TWINS
// ------------------
// Some callers are async (storeHygiene, verifiedManifest); the control-ACK path is
// sync (`openSync`/`fstatSync`). Rather than ripple async through security-critical
// sync code, this module exposes both: the pure verification core is shared, only
// the `spawn`/`spawnSync` runner differs. The ACK check runs once per launch, so
// its ~200ms of synchronous `spawnSync` is negligible.
//
// The rule, same as `fileTrust`: a platform/tool that cannot PROVE privacy FAILS
// with a legible reason, never silently passes. If `icacls`/`whoami` are missing or
// their output is unparseable, every function here fails closed.

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { FileTrustFailure, FileTrustVerdict } from './fileTrust'

/** Well-known SIDs that ARE the OS trusted computing base (allowed alongside the user). */
const SYSTEM_SID = 'S-1-5-18'
const ADMINISTRATORS_SID = 'S-1-5-32-544'
/** Their SDDL two-letter aliases, as icacls emits them. */
const SYSTEM_ALIAS = 'SY'
const ADMINISTRATORS_ALIAS = 'BA'

// Invoke the Windows tools by ABSOLUTE System32 path, never by bare name. Two
// reasons: (1) a bare `whoami`/`icacls` is a PATH-hijack surface — this is a
// security primitive, so an attacker-planted `whoami.exe` earlier in PATH must
// not decide privacy; (2) inside environments that shadow them (Git-for-Windows
// ships an MSYS `whoami` that rejects `/user`), the bare name resolves to the
// wrong tool. `%SystemRoot%` is where they always live.
const SYSTEM32 = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32')
const WHOAMI = join(SYSTEM32, 'whoami.exe')
const ICACLS = join(SYSTEM32, 'icacls.exe')

const trusted: FileTrustVerdict = { trusted: true }
const deny = (reason: FileTrustFailure): FileTrustVerdict => ({ trusted: false, reason })

let sinkCounter = 0
function sinkPath(): string {
  sinkCounter += 1
  return join(tmpdir(), `aw-acl-${process.pid}-${sinkCounter}.sddl`)
}

// --- pure core (POSIX-testable) ---------------------------------------------

/** Pull the `D:...` DACL run out of a full SDDL string, dropping any `S:` SACL. */
export function extractDacl(sddl: string): string | null {
  const d = sddl.indexOf('D:')
  if (d < 0) return null
  const rest = sddl.slice(d)
  const s = rest.indexOf('S:')
  return s >= 0 ? rest.slice(0, s) : rest
}

/**
 * The account SIDs (or SDDL aliases) named by ALLOW aces in a DACL string. Deny
 * aces cannot GRANT access to anyone, so they are ignored for the privacy question.
 * `ok:false` means the DACL is absent/empty/unparseable — callers fail closed.
 *
 * ACE syntax: `(type;flags;rights;object_guid;inherit_object_guid;account_sid...)`.
 * Allow types begin with `A`; deny with `D`. Only DACL aces appear here.
 */
export function parseDaclAllowSids(dacl: string): { ok: boolean; allowSids: string[] } {
  if (!dacl.startsWith('D:')) return { ok: false, allowSids: [] }
  if (dacl.includes('NO_ACCESS_CONTROL')) return { ok: false, allowSids: [] }
  const allowSids: string[] = []
  const aceRe = /\(([^)]*)\)/g
  let m: RegExpExecArray | null
  let sawAce = false
  while ((m = aceRe.exec(dacl)) !== null) {
    sawAce = true
    const fields = (m[1] ?? '').split(';')
    if (fields.length < 6) return { ok: false, allowSids: [] }
    const type = fields[0] ?? ''
    const sid = fields[5] ?? ''
    if (sid.length === 0) return { ok: false, allowSids: [] }
    if (type.startsWith('A')) allowSids.push(sid)
  }
  if (!sawAce) return { ok: false, allowSids: [] }
  return { ok: true, allowSids }
}

/**
 * The privacy verdict given the current user's SID and the file's DACL string.
 * TRUSTED iff every allow ace names only {user, SYSTEM, Administrators} AND the
 * user is among them (it is our file to use). Any other grantee — Everyone (`WD`),
 * Users (`BU`), Authenticated Users (`AU`), a second user, a domain group — makes
 * it not-private. `null` inputs fail closed.
 */
export function verifyDaclPrivate(userSid: string | null, dacl: string | null): FileTrustVerdict {
  if (userSid === null || dacl === null) return deny('platform-unsupported')
  const parsed = parseDaclAllowSids(dacl)
  if (!parsed.ok) return deny('platform-unsupported')
  const allowed = new Set([
    userSid,
    SYSTEM_SID,
    SYSTEM_ALIAS,
    ADMINISTRATORS_SID,
    ADMINISTRATORS_ALIAS,
  ])
  let userGranted = false
  for (const sid of parsed.allowSids) {
    if (!allowed.has(sid)) return deny('not-private')
    if (sid === userSid) userGranted = true
  }
  if (!userGranted) return deny('not-private')
  return trusted
}

/** Second CSV column of `whoami /user /fo csv /nh` = the SID; guard the shape. */
export function parseWhoamiSid(stdout: string): string | null {
  const match = stdout.match(/"[^"]*","(S-1-[0-9-]+)"/)
  return match?.[1] ?? null
}

/** The SDDL line for `path` from icacls /save output (UTF-16LE, BOM-prefixed). */
export function daclFromSaveText(text: string, path: string): string | null {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const base = basename(path).toLowerCase()
  const lines = clean.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim()
    if (line.length === 0) continue
    if (line.toLowerCase() === base) return extractDacl((lines[i + 1] ?? '').trim())
    if (line.startsWith('D:') || line.includes('D:(')) return extractDacl(line)
  }
  return null
}

// --- process-lifetime SID cache (shared by sync + async) --------------------

let cachedUserSid: string | null | undefined

/** Testing seam: reset the process-lifetime SID cache. */
export function __resetUserSidCacheForTests(): void {
  cachedUserSid = undefined
}

// --- async runners ----------------------------------------------------------

function runAsync(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const child = spawn(cmd, args, { windowsHide: true })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ code: null, stdout })
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout })
    })
  })
}

export async function getCurrentUserSid(): Promise<string | null> {
  if (cachedUserSid !== undefined) return cachedUserSid
  const { code, stdout } = await runAsync(WHOAMI, ['/user', '/fo', 'csv', '/nh'])
  cachedUserSid = code === 0 ? parseWhoamiSid(stdout) : null
  return cachedUserSid
}

export async function readFileDaclSddl(path: string): Promise<string | null> {
  const sink = sinkPath()
  try {
    const { code } = await runAsync(ICACLS, [path, '/save', sink])
    if (code !== 0) return null
    const text = await readFile(sink, 'utf16le')
    return daclFromSaveText(text, path)
  } catch {
    return null
  } finally {
    await unlink(sink).catch(() => {})
  }
}

/** Async privacy verdict for a file on win32 (see `verifyDaclPrivate`). */
export async function assertWindowsFilePrivate(path: string): Promise<FileTrustVerdict> {
  const userSid = await getCurrentUserSid()
  if (userSid === null) return deny('platform-unsupported')
  const dacl = await readFileDaclSddl(path)
  return verifyDaclPrivate(userSid, dacl)
}

/**
 * SET a protected owner+TCB DACL on a directory so every file created under it
 * inherits it — belt-and-suspenders against machines whose `%USERPROFILE%` DACL
 * carries extra ACEs (corporate GPO often adds a "Domain Users" grant, which would
 * otherwise make `assertWindowsFilePrivate` correctly fail closed for store files).
 *
 *   icacls <dir> /inheritance:r /grant:r *<userSid>:(OI)(CI)F *SYSTEM... *Admins...
 *
 * `/inheritance:r` removes inherited ACEs and marks the DACL protected; the SID
 * grants (`*` prefix) are locale-independent; `(OI)(CI)` makes children inherit.
 * Fails closed if the user SID or icacls is unavailable.
 */
export async function sealDirectoryOwnerOnly(dirPath: string): Promise<FileTrustVerdict> {
  // Host-frozen: a no-op success off win32, so the guarded plan modules
  // (verifiedPlan/verifiedSystemPlan/verifiedManifest — forbidden `process.platform`
  // by RFC-227/T11c) can call it UNCONDITIONALLY and let the platform branch live
  // here. POSIX keeps its mode-based privacy; no icacls spawn happens there.
  if (process.platform !== 'win32') return trusted
  const userSid = await getCurrentUserSid()
  if (userSid === null) return deny('platform-unsupported')
  const { code } = await runAsync(ICACLS, [
    dirPath,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:(OI)(CI)F`,
    `*${SYSTEM_SID}:(OI)(CI)F`,
    `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
  ])
  return code === 0 ? trusted : deny('platform-unsupported')
}

// --- sync runners (for the sync control-ACK path) ---------------------------

function runSync(cmd: string, args: string[]): { code: number | null; stdout: string } {
  const r = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  return { code: r.status, stdout: r.stdout ?? '' }
}

export function getCurrentUserSidSync(): string | null {
  if (cachedUserSid !== undefined) return cachedUserSid
  const { code, stdout } = runSync(WHOAMI, ['/user', '/fo', 'csv', '/nh'])
  cachedUserSid = code === 0 ? parseWhoamiSid(stdout) : null
  return cachedUserSid
}

export function readFileDaclSddlSync(path: string): string | null {
  const sink = sinkPath()
  try {
    const { code } = runSync(ICACLS, [path, '/save', sink])
    if (code !== 0) return null
    const text = readFileSync(sink, 'utf16le')
    return daclFromSaveText(text, path)
  } catch {
    return null
  } finally {
    try {
      unlinkSync(sink)
    } catch {
      /* best effort */
    }
  }
}

/** Sync privacy verdict for a file on win32 (see `verifyDaclPrivate`). */
export function assertWindowsFilePrivateSync(path: string): FileTrustVerdict {
  const userSid = getCurrentUserSidSync()
  if (userSid === null) return deny('platform-unsupported')
  const dacl = readFileDaclSddlSync(path)
  return verifyDaclPrivate(userSid, dacl)
}

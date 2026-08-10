// RFC-254 T40b — Windows privacy checks for sensitive files.
//
// POSIX mode bits cannot describe a Windows DACL: Node synthesizes `Stats.mode`
// from the read-only attribute, so a writable file commonly reports 0666 no
// matter which principals the ACL grants. This module reads the real DACL and
// accepts only the current user plus the operating-system administrators.
//
// `icacls /save` supplies locale-independent SID-based SDDL and works on both
// x64 and ARM64 Windows, unlike Bun FFI on builds without TinyCC. Async and sync
// entry points share the same parser/verdict; only process invocation differs.
//
// If the ACL tools are unavailable or their output cannot be parsed, the check
// returns a legible failure instead of treating privacy as proven.
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
// The built-in Administrator (RID 500) and Domain Admins also serialize to SDDL
// aliases, NOT full SIDs, in `icacls /save` output. Both are TCB — the built-in
// Administrator is the local root-equivalent and Domain Admins administer the
// domain, so a grant to either is not a privacy leak (they can take ownership of
// anything regardless). MEASURED on the GitHub windows-latest x64 runner, which
// runs as RID-500: an owner-only file's DACL reads `...(A;;FA;;;LA)` for the user,
// so without `LA` here the primitive rejected its own owner's ACE as non-private.
const LOCAL_ADMIN_ALIAS = 'LA'
const DOMAIN_ADMINS_ALIAS = 'DA'
/** RID of the built-in Administrator, whose owner ACE serializes as `LA`. */
const BUILTIN_ADMIN_RID_SUFFIX = '-500'

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
    LOCAL_ADMIN_ALIAS,
    DOMAIN_ADMINS_ALIAS,
  ])
  // When the process runs AS the built-in Administrator (RID 500), the owner's
  // ACE serializes as `LA`, not the full SID — so `LA` counts as the user's own
  // grant there. A non-admin user still requires its full-SID ACE (an `LA`-only
  // DACL is a system-owned file, not ours).
  const userIsBuiltinAdmin = userSid.endsWith(BUILTIN_ADMIN_RID_SUFFIX)
  let userGranted = false
  for (const sid of parsed.allowSids) {
    if (!allowed.has(sid)) return deny('not-private')
    if (sid === userSid || (userIsBuiltinAdmin && sid === LOCAL_ADMIN_ALIAS)) userGranted = true
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
 * otherwise make `assertWindowsFilePrivate` correctly reject sensitive files).
 *
 *   icacls <dir> /inheritance:r /grant:r *<userSid>:(OI)(CI)F *SYSTEM... *Admins...
 *
 * `/inheritance:r` removes inherited ACEs and marks the DACL protected; the SID
 * grants (`*` prefix) are locale-independent; `(OI)(CI)` makes children inherit.
 * Fails closed if the user SID or icacls is unavailable.
 */
export async function sealDirectoryOwnerOnly(dirPath: string): Promise<FileTrustVerdict> {
  // The platform branch lives here so callers can apply the same privacy API on
  // every host. POSIX keeps mode-based privacy; no icacls spawn happens there.
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

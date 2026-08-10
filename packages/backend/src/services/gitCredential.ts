// RFC-205 G1 / RFC-254 T20 (D11) — git credential injection WITHOUT credentials
// on disk (mirror config), in argv (ps), or in env (/proc/<pid>/environ is
// same-uid readable on linux).
//
// Mechanism: a `credential.helper` pointing at THIS binary's hidden
// `__git-credential` subcommand. The daemon writes the username/password to a
// 0600 one-shot file under appHome, wires git
// with `-c credential.helper= -c credential.helper=!<self __git-credential>`,
// and deletes the file as soon as the git subprocess exits. git invokes the
// helper with the credential-helper protocol (`get`/`store`/`erase` in argv,
// fields on stdin); the subcommand answers a `get` from the file — but ONLY when
// the requested host matches the lease host. The env carries only PATHS, never
// secrets.
//
// Why a subcommand, not the old `#!/bin/sh` GIT_ASKPASS helper: a `.sh` has no
// shebang on Windows (`CreateProcess` cannot exec it directly), so the POSIX
// script was unportable. A hidden subcommand of the platform's own binary is one
// implementation for all three platforms (RFC-254 D11 / design §6).
//
// Impl-gate P0-2 (host binding, PRESERVED): git calls the helper for EVERY remote
// it authenticates — including a recurse-submodules fetch whose remote a malicious
// `.gitmodules` controls. Without the host check the helper would hand the parent
// repo's PAT to any host, so a hostile submodule remote could harvest it. The
// subcommand therefore returns credentials only when the request host equals the
// lease host.
//
// GCM interop: `credential.helper` is APPEND semantics and the daemon-side git
// intentionally does not isolate system/global config (gitHardening.ts), so Git
// for Windows' default Git-Credential-Manager would otherwise answer first. The
// wiring emits an EMPTY `credential.helper=` before ours to clear the inherited
// list, and ONLY on lease-bearing calls (credential-less calls keep the user's
// environment helper untouched).
//
// Agent-side effect (intended): a worktree's `git push origin` inside an agent
// runs WITHOUT these args/env and with a credential-less origin URL → the
// platform credential is simply not reachable from agent processes anymore.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { Paths } from '@/util/paths'
import { IS_EMBEDDED } from '@/embed'

const GIT_CREDENTIAL_SUBCOMMAND = '__git-credential'

// Invoke THIS binary's hidden subcommand. Embedded = the compiled binary; dev =
// `bun run main.ts`.
function gitCredentialSelfArgv(): string[] {
  if (IS_EMBEDDED) return [process.execPath, GIT_CREDENTIAL_SUBCOMMAND]
  const mainPath = resolve(import.meta.dir, '..', 'main.ts')
  return [process.execPath, 'run', mainPath, GIT_CREDENTIAL_SUBCOMMAND]
}

// sh single-quote: safe for spaces, backslashes (literal inside single quotes,
// so Windows paths survive), and embedded single quotes (design §6 obligation 4).
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/** The `!`-prefixed `credential.helper` value git runs as a shell snippet. */
export function gitCredentialHelperValue(): string {
  return `!${gitCredentialSelfArgv().map(shQuote).join(' ')}`
}

/** Parse git's credential-helper stdin (`key=value` lines, blank line ends). */
export function parseGitCredentialRequest(stdin: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const raw of stdin.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') break
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    fields[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return fields
}

/**
 * The credential-helper `get` response, or '' to answer nothing. Pure so the
 * host-binding security property (impl-gate P0-2) is testable without a real
 * git. `store`/`erase` never reach here — they are silent successes.
 *
 * Host binding: the request host (git may append `:port`) is compared to the
 * lease host after stripping a trailing port, matching the old sh helper's
 * `s#:.*##`. A mismatch — a hostile submodule remote — yields ''.
 */
export function computeGitCredentialResponse(
  requestFields: Record<string, string>,
  leaseHost: string,
  username: string,
  password: string,
): string {
  const requestHost = (requestFields.host ?? '').replace(/:.*$/, '')
  if (requestHost === '' || requestHost !== leaseHost) return ''
  return `username=${username}\npassword=${password}\n`
}

/**
 * The `__git-credential` subcommand body: read the lease host + one-shot file
 * from the env, and answer a `get` for the matching host only. Returns the text
 * to write to stdout (empty for store/erase or any non-match). Never logs.
 */
export function runGitCredentialSubcommand(operation: string, stdin: string): string {
  if (operation !== 'get') return '' // store/erase: silent success, no output, no log
  const leaseHost = process.env.AW_GIT_CRED_HOST
  const credFile = process.env.AW_GIT_CRED_FILE
  if (leaseHost === undefined || leaseHost === '' || credFile === undefined || credFile === '') {
    return ''
  }
  let content: string
  try {
    content = readFileSync(credFile, 'utf-8')
  } catch {
    return ''
  }
  const [username = '', password = ''] = content.split('\n')
  return computeGitCredentialResponse(
    parseGitCredentialRequest(stdin),
    leaseHost,
    username,
    password,
  )
}

/** Extract userinfo from an http(s) git URL. null → nothing to inject. */
export function extractGitUserinfo(
  plainUrl: string,
): { username: string; password: string } | null {
  try {
    const u = new URL(plainUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username === '' && u.password === '') return null
    return { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
  } catch {
    return null
  }
}

export interface GitCredentialLease {
  /**
   * Prepend to the git argv BEFORE the subcommand (`runGit(cwd, [...leadingArgs,
   * 'fetch', ...])`). Wires `credential.helper` at the exact host.
   */
  leadingArgs: string[]
  /** Spread into the git subprocess env (paths + terminal-prompt guard only). */
  env: Record<string, string>
  /** Delete the one-shot credential file. ALWAYS call (finally). */
  cleanup: () => void
}

/**
 * Lease a one-shot credential for a git network operation. Returns null when
 * the URL carries no userinfo (file://, ssh, public https) — callers just run
 * git unmodified in that case.
 */
export function leaseGitCredential(
  plainUrl: string,
  appHome: string = Paths.root,
): GitCredentialLease | null {
  const info = extractGitUserinfo(plainUrl)
  if (info === null) return null
  // Impl-gate P0-2: bind the lease to the exact remote host. The helper only
  // answers a prompt whose URL host matches this — so git authenticating a
  // DIFFERENT remote (a hostile submodule / rewritten origin) gets nothing.
  let host: string
  try {
    host = new URL(plainUrl).hostname
  } catch {
    return null
  }
  if (host === '') return null
  const credFile = join(appHome, `.gitcred-${ulid()}`)
  writeFileSync(credFile, `${info.username}\n${info.password}\n`, { mode: 0o600 })
  chmodSync(credFile, 0o600)
  return {
    // Prepend to the git argv BEFORE the subcommand. The empty helper clears any
    // inherited (GCM) list first; ours points at the `__git-credential` subcommand.
    leadingArgs: [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=${gitCredentialHelperValue()}`,
    ],
    env: {
      AW_GIT_CRED_FILE: credFile,
      AW_GIT_CRED_HOST: host,
      // Belt & braces: never fall back to an interactive prompt.
      GIT_TERMINAL_PROMPT: '0',
    },
    cleanup: () => {
      try {
        rmSync(credFile, { force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Push-side credential (RFC-205 G1): the mirror origin is credential-free now,
// so the framework's own `git push origin` (RFC-075 auto-push) needs the same
// askpass lease. The resolver is installed by start.ts (it owns db+secretBox);
// tests / credential-less repos resolve to null → push runs unmodified and
// RFC-075's existing auth-fail fallback (commit-local + warn) still applies.
// ---------------------------------------------------------------------------

export type PushCredentialResolver = (taskId: string) => Promise<string | null>

let pushCredentialResolver: PushCredentialResolver | null = null

export function setPushCredentialResolver(r: PushCredentialResolver | null): void {
  pushCredentialResolver = r
}

/** Lease the push credential for a task's origin, or null (no resolver / no
 *  credential / resolver error — never throws: push falls back to unauthed). */
export async function leasePushCredential(
  taskId: string,
  appHome: string = Paths.root,
): Promise<GitCredentialLease | null> {
  if (pushCredentialResolver === null) return null
  try {
    const plain = await pushCredentialResolver(taskId)
    if (plain === null) return null
    return leaseGitCredential(plain, appHome)
  } catch {
    return null
  }
}

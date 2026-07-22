// RFC-205 G1 — git credential injection WITHOUT credentials on disk (mirror
// config), in argv (ps), or in env (/proc/<pid>/environ is same-uid readable
// on linux).
//
// Mechanism: GIT_ASKPASS. The daemon writes the username/password to a
// 0600 one-shot file under appHome (inside the sandbox DENY zone — the agent
// cannot read it even while it exists), points GIT_ASKPASS at a tiny helper
// script, and deletes the file as soon as the git subprocess exits. git calls
// the helper twice ("Username for …", "Password for …"); the helper answers
// from the file. The env carries only PATHS, never secrets.
//
// Agent-side effect (intended): a worktree's `git push origin` inside an agent
// runs WITHOUT these env vars and with a credential-less origin URL → the
// platform credential is simply not reachable from agent processes anymore.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { Paths } from '@/util/paths'

const HELPER_REL = join('libexec', 'git-askpass.sh')

const HELPER_BODY = `#!/bin/sh
# agent-workflow (RFC-205 G1) — answers git credential prompts from the one-shot
# file in $AW_GIT_CRED_FILE (line 1 = username, line 2 = password), but ONLY for
# the exact remote HOST the lease was minted for ($AW_GIT_CRED_HOST). Impl-gate
# P0-2 (Codex 2026-07-22): git calls the helper for EVERY remote it authenticates
# — including a recurse-submodules fetch whose remote a malicious .gitmodules
# controls. Without the host check the helper handed the parent repo's PAT to any
# host, so a hostile submodule remote could harvest it. git's prompt is
# "Username for 'https://host/…'" / "Password for 'https://user@host:port/…'".
[ -n "$AW_GIT_CRED_FILE" ] || exit 1
[ -n "$AW_GIT_CRED_HOST" ] || exit 1
prompt_host=$(printf '%s' "$1" | sed -e "s/.*for '//" -e "s/'.*//" -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#/.*##' -e 's#.*@##' -e 's#:.*##')
[ "$prompt_host" = "$AW_GIT_CRED_HOST" ] || exit 1
case "$1" in
  *sername*) sed -n 1p "$AW_GIT_CRED_FILE" ;;
  *) sed -n 2p "$AW_GIT_CRED_FILE" ;;
esac
`

/** Write the askpass helper; returns its absolute path. */
export function ensureAskpassHelper(appHome: string = Paths.root): string {
  const path = join(appHome, HELPER_REL)
  mkdirSync(join(appHome, 'libexec'), { recursive: true })
  // Impl-gate P0-2: ALWAYS (re)write — the body evolves (host check), so a helper
  // left over from an older version must be refreshed, not trusted as-is.
  writeFileSync(path, HELPER_BODY, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
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
  /** Spread into the git subprocess env. */
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
  const helper = ensureAskpassHelper(appHome)
  const credFile = join(appHome, `.gitcred-${ulid()}`)
  writeFileSync(credFile, `${info.username}\n${info.password}\n`, { mode: 0o600 })
  chmodSync(credFile, 0o600)
  return {
    env: {
      GIT_ASKPASS: helper,
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

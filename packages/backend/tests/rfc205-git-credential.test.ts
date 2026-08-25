// RFC-205 G1 / RFC-254 T20 (D11) — credential un-disking. Locks design §4-5 + §6:
//   - the lease carries PATHS in env + `credential.helper` wiring in leadingArgs,
//     never the secret itself;
//   - the one-shot file is 0600, structured, and deleted by cleanup;
//   - the `__git-credential` subcommand answers a `get` from the file, but ONLY
//     for the exact protocol + authority + repository path (impl-gate P0-2: a
//     sibling project or hostile submodule must not harvest the parent PAT);
//   - clone/fetch source-level locks: mirror ops use the REDACTED url + a lease
//     (regressing to the plain URL re-disks the credential silently);
//   - publication no longer uses a process-global push resolver.
//
// The old `#!/bin/sh` GIT_ASKPASS helper was replaced by the subcommand (RFC-254
// D11) because a `.sh` has no shebang on Windows. These tests exercise the pure
// host-binding verdict + the env-driven subcommand directly, so they run on every
// platform without spawning a script.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupOrphanedGitCredentialLeases,
  computeGitCredentialResponse,
  extractGitUserinfo,
  gitCredentialHelperValue,
  leaseGitCredential,
  leaseTargetBoundGitCredential,
  parseGitCredentialRequest,
  runGitCredentialSubcommand,
  type GitCredentialLeasePayloadV1,
} from '../src/util/gitCredentialLease'

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc205-cred-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  delete process.env.AW_GIT_CRED_FILE
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('extractGitUserinfo', () => {
  test('https userinfo in/out; file/ssh/public → null; percent-decoding', () => {
    expect(extractGitUserinfo('https://u:p%40ss@host/x.git')).toEqual({
      username: 'u',
      password: 'p@ss',
    })
    expect(extractGitUserinfo('https://host/x.git')).toBeNull()
    expect(extractGitUserinfo('file:///tmp/x')).toBeNull()
    expect(extractGitUserinfo('ssh://git@host/x.git')).toBeNull() // ssh keys, not URL creds
    expect(extractGitUserinfo('not a url')).toBeNull()
  })
})

describe('leaseGitCredential', () => {
  test('leadingArgs bind helper by path; env carries only lease path; file is 0600 and cleanup deletes it', () => {
    const home = tmp()
    const lease = leaseGitCredential('https://alice:s3cret@host/repo.git', home)
    expect(lease).not.toBeNull()
    const env = lease!.env
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    // The askpass env var is gone — the mechanism is credential.helper now.
    expect(env.GIT_ASKPASS).toBeUndefined()
    expect(Object.keys(env).sort()).toEqual([
      'AW_GIT_CRED_FILE',
      'GIT_CURL_VERBOSE',
      'GIT_TERMINAL_PROMPT',
      'GIT_TRACE',
      'GIT_TRACE_CURL',
      'GIT_TRACE_PACKET',
      'GIT_TRACE_REDACT',
    ])
    // Clear inherited helpers/headers, force exact-path lookup and pin the TLS
    // policy before installing the one session helper.
    expect(lease!.leadingArgs).toContain('credential.helper=')
    expect(lease!.leadingArgs).toContain('credential.useHttpPath=true')
    expect(lease!.leadingArgs).toContain('credential.interactive=false')
    expect(lease!.leadingArgs).toContain('http.https://host/repo.git.extraHeader=')
    expect(lease!.leadingArgs).toContain('http.https://host/repo.git.followRedirects=false')
    expect(lease!.leadingArgs).toContain('http.https://host/repo.git.sslVerify=true')
    expect(lease!.leadingArgs.at(-1)).toMatch(/^credential\.helper=!/)
    expect(lease!.leadingArgs.at(-1)).toContain('__git-credential')
    expect(lease!.leadingArgs.slice(0, 4)).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.useHttpPath=true',
    ])
    const credFile = env.AW_GIT_CRED_FILE!
    expect(JSON.parse(readFileSync(credFile, 'utf-8'))).toEqual({
      version: 1,
      protocol: 'https',
      host: 'host',
      path: 'repo.git',
      username: 'alice',
      password: 's3cret',
    })
    // POSIX proves 0600 from the mode; win32 synthesizes 0o666, so the DACL is
    // the proof there (the file lives under appHome, which the store seals).
    if (process.platform !== 'win32') {
      expect(statSync(credFile).mode & 0o777).toBe(0o600)
    }
    // the SECRET never appears in env values OR the wiring args (argv shows in ps).
    for (const v of Object.values(env)) expect(v).not.toContain('s3cret')
    for (const a of lease!.leadingArgs) expect(a).not.toContain('s3cret')
    lease!.cleanup()
    expect(existsSync(credFile)).toBe(false)
  })

  test('credential-less URL → null lease (git runs unmodified)', () => {
    expect(leaseGitCredential('file:///tmp/x', tmp())).toBeNull()
  })

  test('the managed Git lease applies the connection TLS exception only to its exact endpoint', () => {
    const lease = leaseTargetBoundGitCredential({
      endpointUrl: 'https://gitlab.internal/team/app.git',
      username: 'oauth2',
      password: 'personal-token',
      appHome: tmp(),
      rejectUnauthorized: false,
    })
    expect(lease).not.toBeNull()
    expect(lease!.leadingArgs).toContain(
      'http.https://gitlab.internal/team/app.git.sslVerify=false',
    )
    expect(lease!.leadingArgs.join('\n')).not.toContain('personal-token')
    lease!.cleanup()
  })

  test('gitCredentialHelperValue is an sh snippet invoking the hidden subcommand', () => {
    const value = gitCredentialHelperValue()
    expect(value.startsWith('!')).toBe(true)
    expect(value).toContain('__git-credential')
    // Every argv element is single-quoted, so a spaced/backslashed install path
    // (C:\Program Files\…) survives sh word-splitting (design §6 obligation 4).
    expect(value).toMatch(/^!'.*'/)
  })

  test('boot cleanup removes only an old owner-controlled RFC-321 lease file', () => {
    const home = tmp()
    const now = 2_000_000
    const old = join(home, '.gitcred-01ARZ3NDEKTSV4RRFFQ69G5FAV')
    const young = join(home, '.gitcred-01ARZ3NDEKTSV4RRFFQ69G5FAW')
    const directory = join(home, '.gitcred-01ARZ3NDEKTSV4RRFFQ69G5FAY')
    const unrelated = join(home, '.gitcred-not-a-ulid')
    for (const path of [old, young, unrelated]) writeFileSync(path, '{}', { mode: 0o600 })
    mkdirSync(directory)
    for (const path of [old, directory]) {
      utimesSync(path, new Date(now - 120_000), new Date(now - 120_000))
    }

    let wrongMode: string | null = null
    if (process.platform !== 'win32') {
      wrongMode = join(home, '.gitcred-01ARZ3NDEKTSV4RRFFQ69G5FAX')
      writeFileSync(wrongMode, '{}', { mode: 0o600 })
      chmodSync(wrongMode, 0o644)
      utimesSync(wrongMode, new Date(now - 120_000), new Date(now - 120_000))
    }

    expect(cleanupOrphanedGitCredentialLeases(home, { now, minAgeMs: 60_000 })).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(directory)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    if (wrongMode !== null) expect(existsSync(wrongMode)).toBe(true)
  })
})

// impl-gate P0-2 + RFC-321 I-5: the helper answers only for one exact target.
describe('__git-credential exact target binding (P0-2)', () => {
  const lease: GitCredentialLeasePayloadV1 = {
    version: 1,
    protocol: 'https',
    host: 'good.example',
    path: 'team/repo.git',
    username: 'bob',
    password: 'pw123',
  }

  test('computeGitCredentialResponse binds protocol, normalized authority and exact path', () => {
    expect(
      computeGitCredentialResponse(
        { protocol: 'https', host: 'good.example', path: 'team/repo.git' },
        lease,
      ),
    ).toBe('username=bob\npassword=pw123\n')
    // Default ports normalize; a non-default port remains part of authority.
    expect(
      computeGitCredentialResponse(
        { protocol: 'https', host: 'GOOD.EXAMPLE:443', path: '/team/repo.git/' },
        lease,
      ),
    ).toBe('username=bob\npassword=pw123\n')
    expect(
      computeGitCredentialResponse(
        { protocol: 'https', host: 'good.example:8443', path: 'team/repo.git' },
        lease,
      ),
    ).toBe('')
    // Host, scheme and sibling path mismatches all refuse without a prefix fallback.
    expect(
      computeGitCredentialResponse(
        { protocol: 'https', host: 'evil.example', path: 'team/repo.git' },
        lease,
      ),
    ).toBe('')
    expect(
      computeGitCredentialResponse(
        { protocol: 'http', host: 'good.example', path: 'team/repo.git' },
        lease,
      ),
    ).toBe('')
    expect(
      computeGitCredentialResponse(
        { protocol: 'https', host: 'good.example', path: 'team/sibling.git' },
        lease,
      ),
    ).toBe('')
    expect(
      computeGitCredentialResponse(
        { protocol: 'https', host: 'good.example', path: 'team/repo.git/child' },
        lease,
      ),
    ).toBe('')
    // Suffix/substring collisions and incomplete requests are refused.
    expect(
      computeGitCredentialResponse(
        { protocol: 'https', host: 'good.example.evil.com', path: 'team/repo.git' },
        lease,
      ),
    ).toBe('')
    expect(computeGitCredentialResponse({ protocol: 'https', host: 'good.example' }, lease)).toBe(
      '',
    )
  })

  test('parseGitCredentialRequest reads git stdin (key=value, blank line ends)', () => {
    expect(parseGitCredentialRequest('protocol=https\nhost=good.example\npath=r.git\n\n')).toEqual({
      protocol: 'https',
      host: 'good.example',
      path: 'r.git',
    })
    // CRLF tolerated; content after the blank terminator ignored.
    expect(parseGitCredentialRequest('host=h\r\n\nhost=leaked')).toEqual({ host: 'h' })
  })

  test('runGitCredentialSubcommand: exact target answers; sibling paths + store/erase yield nothing', () => {
    const home = tmp()
    const lease = leaseGitCredential('https://bob:pw123@good.example/r.git', home)!
    process.env.AW_GIT_CRED_FILE = lease.env.AW_GIT_CRED_FILE
    // get + matching target → creds.
    expect(
      runGitCredentialSubcommand('get', 'protocol=https\nhost=good.example\npath=r.git\n\n'),
    ).toBe('username=bob\npassword=pw123\n')
    // get + hostile submodule host → nothing leaked.
    expect(
      runGitCredentialSubcommand('get', 'protocol=https\nhost=evil.example\npath=r.git\n\n'),
    ).toBe('')
    expect(
      runGitCredentialSubcommand('get', 'protocol=https\nhost=good.example\npath=sibling.git\n\n'),
    ).toBe('')
    // store / erase are silent successes (never echo the secret, never log).
    expect(
      runGitCredentialSubcommand('store', 'protocol=https\nhost=good.example\npath=r.git\n\n'),
    ).toBe('')
    expect(
      runGitCredentialSubcommand('erase', 'protocol=https\nhost=good.example\npath=r.git\n\n'),
    ).toBe('')
    lease.cleanup()
    // After cleanup the file is gone → even a matching get answers nothing.
    expect(
      runGitCredentialSubcommand('get', 'protocol=https\nhost=good.example\npath=r.git\n\n'),
    ).toBe('')
  })

  test('runGitCredentialSubcommand fails closed when the lease env is absent', () => {
    expect(runGitCredentialSubcommand('get', 'host=good.example\n\n')).toBe('')
  })
})

describe('source locks — the mirror never re-disks the credential', () => {
  test('clone/fetch use the redacted URL + lease leadingArgs; warm fetch normalises origin first', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf-8',
    )
    expect(src).toContain('cloneArgs.push(redacted, tmpDir)')
    expect(src).not.toContain('cloneArgs.push(input.url, tmpDir)')
    expect(src).toContain("['remote', 'set-url', 'origin', input.redactedUrl]")
    expect(src).toContain('leaseGitCredential(input.url)')
    expect(src).toContain('leaseGitCredential(input.credentialUrl, input.appHome)')
    expect(src.match(/await fetchSanitizedOrigin\(\{/g)).toHaveLength(2)
    // The credential.helper wiring must ride on the git argv, not just env.
    expect(src).toContain('lease?.leadingArgs')
  })

  test('push uses one exact-target transport session instead of the old global resolver', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'commitPushRunner.ts'),
      'utf-8',
    )
    expect(src).toContain('publicationTransport.open({')
    expect(src).toContain('session.runNetwork(')
    expect(src).not.toContain('leasePushCredential')
  })
})

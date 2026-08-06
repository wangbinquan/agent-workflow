// RFC-205 G1 / RFC-254 T20 (D11) — credential un-disking. Locks design §4-5 + §6:
//   - the lease carries PATHS in env + `credential.helper` wiring in leadingArgs,
//     never the secret itself;
//   - the one-shot file is 0600, two lines, deleted by cleanup;
//   - the `__git-credential` subcommand answers a `get` from the file, but ONLY
//     for the exact lease host (impl-gate P0-2: a hostile submodule remote must
//     not harvest the parent repo's PAT); store/erase are silent successes;
//   - clone/fetch source-level locks: mirror ops use the REDACTED url + a lease
//     (regressing to the plain URL re-disks the credential silently);
//   - push resolver: absent → null (tests / RFC-075 fallback unchanged).
//
// The old `#!/bin/sh` GIT_ASKPASS helper was replaced by the subcommand (RFC-254
// D11) because a `.sh` has no shebang on Windows. These tests exercise the pure
// host-binding verdict + the env-driven subcommand directly, so they run on every
// platform without spawning a script.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeGitCredentialResponse,
  extractGitUserinfo,
  gitCredentialHelperValue,
  leaseGitCredential,
  leasePushCredential,
  parseGitCredentialRequest,
  runGitCredentialSubcommand,
  setPushCredentialResolver,
} from '../src/services/gitCredential'

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc205-cred-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  setPushCredentialResolver(null)
  delete process.env.AW_GIT_CRED_FILE
  delete process.env.AW_GIT_CRED_HOST
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
  test('leadingArgs wire credential.helper; env carries paths only; file 0600 two-line; cleanup deletes it', () => {
    const home = tmp()
    const lease = leaseGitCredential('https://alice:s3cret@host/repo.git', home)
    expect(lease).not.toBeNull()
    const env = lease!.env
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    // The askpass env var is gone — the mechanism is credential.helper now.
    expect(env.GIT_ASKPASS).toBeUndefined()
    expect(env.AW_GIT_CRED_HOST).toBe('host')
    // leadingArgs: clear the inherited (GCM) helper list, then point at our subcommand.
    expect(lease!.leadingArgs.slice(0, 3)).toEqual(['-c', 'credential.helper=', '-c'])
    expect(lease!.leadingArgs[3]).toMatch(/^credential\.helper=!/)
    expect(lease!.leadingArgs[3]).toContain('__git-credential')
    const credFile = env.AW_GIT_CRED_FILE!
    expect(readFileSync(credFile, 'utf-8')).toBe('alice\ns3cret\n')
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

  test('gitCredentialHelperValue is an sh snippet invoking the hidden subcommand', () => {
    const value = gitCredentialHelperValue()
    expect(value.startsWith('!')).toBe(true)
    expect(value).toContain('__git-credential')
    // Every argv element is single-quoted, so a spaced/backslashed install path
    // (C:\Program Files\…) survives sh word-splitting (design §6 obligation 4).
    expect(value).toMatch(/^!'.*'/)
  })
})

// impl-gate P0-2 + RFC-254 D11: the subcommand answers ONLY for the lease host,
// via the credential-helper protocol (operation in argv, fields on stdin).
describe('__git-credential host binding (P0-2)', () => {
  test('computeGitCredentialResponse: matching host answers, any other host refuses', () => {
    const ok = { host: 'good.example' }
    expect(computeGitCredentialResponse(ok, 'good.example', 'bob', 'pw123')).toBe(
      'username=bob\npassword=pw123\n',
    )
    // git may append :port — the port is stripped before comparison.
    expect(
      computeGitCredentialResponse({ host: 'good.example:8443' }, 'good.example', 'b', 'p'),
    ).toBe('username=b\npassword=p\n')
    // A different host (hostile submodule remote) → nothing.
    expect(computeGitCredentialResponse({ host: 'evil.example' }, 'good.example', 'b', 'p')).toBe(
      '',
    )
    // Suffix/substring collisions → refused (exact match only).
    expect(
      computeGitCredentialResponse({ host: 'good.example.evil.com' }, 'good.example', 'b', 'p'),
    ).toBe('')
    // No host in the request → nothing.
    expect(computeGitCredentialResponse({}, 'good.example', 'b', 'p')).toBe('')
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

  test('runGitCredentialSubcommand: get for the lease host answers; other hosts + store/erase yield nothing', () => {
    const home = tmp()
    const lease = leaseGitCredential('https://bob:pw123@good.example/r.git', home)!
    process.env.AW_GIT_CRED_FILE = lease.env.AW_GIT_CRED_FILE
    process.env.AW_GIT_CRED_HOST = lease.env.AW_GIT_CRED_HOST
    // get + matching host → creds.
    expect(runGitCredentialSubcommand('get', 'protocol=https\nhost=good.example\n\n')).toBe(
      'username=bob\npassword=pw123\n',
    )
    // get + hostile submodule host → nothing leaked.
    expect(runGitCredentialSubcommand('get', 'protocol=https\nhost=evil.example\n\n')).toBe('')
    // store / erase are silent successes (never echo the secret, never log).
    expect(runGitCredentialSubcommand('store', 'protocol=https\nhost=good.example\n\n')).toBe('')
    expect(runGitCredentialSubcommand('erase', 'protocol=https\nhost=good.example\n\n')).toBe('')
    lease.cleanup()
    // After cleanup the file is gone → even a matching get answers nothing.
    expect(runGitCredentialSubcommand('get', 'protocol=https\nhost=good.example\n\n')).toBe('')
  })

  test('runGitCredentialSubcommand fails closed when the lease env is absent', () => {
    expect(runGitCredentialSubcommand('get', 'host=good.example\n\n')).toBe('')
  })
})

describe('leasePushCredential (resolver injection)', () => {
  test('no resolver → null; resolver url → lease; resolver throw → null', async () => {
    expect(await leasePushCredential('t1', tmp())).toBeNull()
    setPushCredentialResolver(async () => 'https://u:pw@h/r.git')
    const lease = await leasePushCredential('t1', tmp())
    expect(lease).not.toBeNull()
    lease!.cleanup()
    setPushCredentialResolver(async () => {
      throw new Error('db down')
    })
    expect(await leasePushCredential('t1', tmp())).toBeNull()
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
    expect(src).toContain("['remote', 'set-url', 'origin', redacted]")
    expect(src).toContain('leaseGitCredential(input.url)')
    // The credential.helper wiring must ride on the git argv, not just env.
    expect(src).toContain('lease?.leadingArgs')
  })

  test('push wires the lease leadingArgs too', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'commitPushRunner.ts'),
      'utf-8',
    )
    expect(src).toContain('pushLease?.leadingArgs')
  })
})

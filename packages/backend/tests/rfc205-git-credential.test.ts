// RFC-205 G1 — credential un-disking. Locks design §4-5:
//   - the lease carries PATHS in env, never the secret itself;
//   - the one-shot file is 0600, two lines, deleted by cleanup;
//   - the askpass helper answers username/password prompts from the file;
//   - clone/fetch source-level locks: mirror ops use the REDACTED url + a
//     lease (regressing to the plain URL re-disks the credential silently);
//   - push resolver: absent → null (tests / RFC-075 fallback unchanged).

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureAskpassHelper,
  extractGitUserinfo,
  leaseGitCredential,
  leasePushCredential,
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
  test('env carries paths only; file is 0600 two-line; cleanup deletes it', () => {
    const home = tmp()
    const lease = leaseGitCredential('https://alice:s3cret@host/repo.git', home)
    expect(lease).not.toBeNull()
    const env = lease!.env
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_ASKPASS).toContain('libexec')
    const credFile = env.AW_GIT_CRED_FILE!
    expect(readFileSync(credFile, 'utf-8')).toBe('alice\ns3cret\n')
    expect(statSync(credFile).mode & 0o777).toBe(0o600)
    // the SECRET never appears in env values (argv-side is locked in source)
    for (const v of Object.values(env)) expect(v).not.toContain('s3cret')
    lease!.cleanup()
    expect(existsSync(credFile)).toBe(false)
  })

  test('credential-less URL → null lease (git runs unmodified)', () => {
    expect(leaseGitCredential('file:///tmp/x', tmp())).toBeNull()
  })

  // RFC-205 impl-gate P0-2 (Codex 2026-07-22): the helper must answer ONLY for the
  // lease's remote host, so a recurse-submodules fetch whose remote a malicious
  // .gitmodules controls cannot harvest the parent repo's PAT.
  test('the helper answers prompts for the lease host and REFUSES other hosts (P0-2)', async () => {
    const home = tmp()
    const lease = leaseGitCredential('https://bob:pw123@good.example/r.git', home)!
    expect(lease.env.AW_GIT_CRED_HOST).toBe('good.example')
    const run = async (prompt: string): Promise<{ out: string; code: number }> => {
      const proc = Bun.spawn([lease.env.GIT_ASKPASS!, prompt], {
        env: {
          ...process.env,
          AW_GIT_CRED_FILE: lease.env.AW_GIT_CRED_FILE!,
          AW_GIT_CRED_HOST: lease.env.AW_GIT_CRED_HOST!,
        },
        stdout: 'pipe',
      })
      const code = await proc.exited
      return { out: (await new Response(proc.stdout).text()).trim(), code }
    }
    // Matching host → answers.
    expect((await run("Username for 'https://good.example'")).out).toBe('bob')
    expect((await run("Password for 'https://bob@good.example'")).out).toBe('pw123')
    // A DIFFERENT host (hostile submodule remote) → refused, nothing leaked.
    const evil = await run("Password for 'https://evil.example/x'")
    expect(evil.out).toBe('')
    expect(evil.code).not.toBe(0)
    // The lease host smuggled into the USERINFO of another host → still refused.
    const spoofUser = await run("Password for 'https://good.example@evil.example/x'")
    expect(spoofUser.out).toBe('')
    // A host that merely CONTAINS the lease host as a suffix-prefix → refused.
    const substr = await run("Password for 'https://good.example.evil.com/x'")
    expect(substr.out).toBe('')
    lease.cleanup()
  })

  test('ensureAskpassHelper is idempotent and executable', () => {
    const home = tmp()
    const p1 = ensureAskpassHelper(home)
    const p2 = ensureAskpassHelper(home)
    expect(p1).toBe(p2)
    expect(statSync(p1).mode & 0o111).not.toBe(0)
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
  test('clone uses the redacted URL + lease; warm fetch normalises origin first', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf-8',
    )
    expect(src).toContain('cloneArgs.push(redacted, tmpDir)')
    expect(src).not.toContain('cloneArgs.push(input.url, tmpDir)')
    expect(src).toContain("['remote', 'set-url', 'origin', redacted]")
    expect(src).toContain('leaseGitCredential(input.url)')
  })
})

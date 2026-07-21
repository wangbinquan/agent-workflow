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

  test('the helper script actually answers prompts from the file', async () => {
    const home = tmp()
    const lease = leaseGitCredential('https://bob:pw123@host/r.git', home)!
    const run = async (prompt: string): Promise<string> => {
      const proc = Bun.spawn([lease.env.GIT_ASKPASS!, prompt], {
        env: { ...process.env, AW_GIT_CRED_FILE: lease.env.AW_GIT_CRED_FILE! },
        stdout: 'pipe',
      })
      await proc.exited
      return (await new Response(proc.stdout).text()).trim()
    }
    expect(await run('Username for https://host')).toBe('bob')
    expect(await run("Password for 'https://bob@host'")).toBe('pw123')
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

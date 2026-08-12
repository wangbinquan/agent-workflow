import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureTokenFile, generateToken, rotateTokenFile } from '../src/auth/token'
import { statMetadataIsAuthoritative } from '../src/util/fileTrust'

describe('token file management', () => {
  let tmp: string
  let tokenPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-token-'))
    tokenPath = join(tmp, 'token')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('generateToken returns 64-char hex string', () => {
    const t = generateToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  test('ensureTokenFile generates on first call, reads on second', () => {
    expect(existsSync(tokenPath)).toBe(false)
    const first = ensureTokenFile(tokenPath)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(tokenPath)).toBe(true)
    expect(readFileSync(tokenPath, 'utf-8').trim()).toBe(first)

    const second = ensureTokenFile(tokenPath)
    expect(second).toBe(first) // stable across reads
  })

  test('ensureTokenFile sets mode 0600', () => {
    ensureTokenFile(tokenPath)
    const mode = statSync(tokenPath).mode & 0o777
    // RFC-254 T32: POSIX mode bits are only meaningful where `stat` is the
    // authority on who can read the file. On Windows `chmod` is a no-op and
    // `stat` answers a synthesized 0o666 for every file — asserting 0o600 there
    // measures nothing and fails for a reason that has nothing to do with the
    // token. Confidentiality on that platform comes from the ACL the per-user
    // app home carries, which is what `doctor`'s secret-file check reports and
    // what the file-trust primitive verifies; the same primitive decides here
    // whether the mode is worth asserting at all.
    if (statMetadataIsAuthoritative(process.platform)) {
      expect(mode).toBe(0o600)
      return
    }
    // The mode is not the guarantee here, so assert what IS true: the file was
    // created, and the platform reports the permissions it always reports —
    // pinning that keeps this branch honest instead of vacuous.
    expect(existsSync(tokenPath)).toBe(true)
    expect(mode).toBe(0o666)
  })

  test('rotateTokenFile overwrites existing token', () => {
    const first = ensureTokenFile(tokenPath)
    const second = rotateTokenFile(tokenPath)
    expect(second).not.toBe(first)
    expect(readFileSync(tokenPath, 'utf-8').trim()).toBe(second)
  })
})

// RFC-285 B4：曾在此的「tokenAuth middleware」describe 段随生产死体一并删除
// —— 该中间件生产零消费（多用户 multiAuth 是唯一在网鉴权面），其 query 优先
// 接受 ?token= 的行为正是 B4 关闭的泄露通道。REST 面 query-token → 401 的
// 行为锁在 auth-session.test.ts（对在网中间件断言，而非对死体）。

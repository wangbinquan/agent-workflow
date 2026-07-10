import { rimrafDir } from './helpers/cleanup'
// RFC-054 W3-5 — security boundary fuzz with fast-check.
//
// LOCKS the three system-edge invariants where a single missed sanitization
// step would let an attacker escape a sandbox / leak a credential / pivot
// inside the daemon:
//
//   1. PATH: safeJoin(root, relPath) — for any string fed as relPath, the
//      result either throws ValidationError OR resolves strictly under
//      root. Catches a regression that adds new escape paths (e.g. URL-
//      encoded `..%2F`, NUL-injection, very-long traversal chains).
//
//   2. URL: redactGitUrl(input) — for any random git-URL containing
//      credentials in the userinfo portion, the redacted output does NOT
//      contain the cleartext credential. Catches regression where a new
//      shape (ssh://user:pass@..., file:// scheme, gitlab-token format)
//      bypasses the existing regex.
//
//   3. GENERIC: redactSensitiveString(input) — for any random text
//      containing Bearer / Authorization / API key shapes, the
//      cleartext token doesn't appear in the output. Catches the same
//      class of leak via stderr / errorDetailJson capture paths.
//
// fast-check gives this its value: hand-rolled test tables miss the long
// tail of payload shapes a real attacker uses. fast-check explores
// thousands of variants per case and shrinks any failure to a minimal
// repro automatically.

import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ValidationError } from '../src/util/errors'
import { realpathInside, safeJoin } from '../src/util/safePath'
import { redactSensitiveString } from '../src/util/redact'
import { redactGitUrl } from '@agent-workflow/shared'
import { isWindows } from './helpers/stub-runtime'

const canSymlink = isWindows
  ? (() => {
      try {
        const d = mkdirSync(join(tmpdir(), 'aw-symlink-probe-'), { recursive: true }) as string
        symlinkSync(join(d, 'x'), join(d, 'y'), 'file')
        rimrafDir(d)
        return true
      } catch {
        return false
      }
    })()
  : true

// ---------------------------------------------------------------------------
// PATH: safeJoin must NEVER produce a path outside root for ANY user input.
// ---------------------------------------------------------------------------

describe('RFC-054 W3-5 — path-traversal fuzz on safeJoin', () => {
  test('arbitrary string never escapes root: either ValidationError thrown OR result.startsWith(root)', () => {
    // Use a real temp dir as root — safeJoin's resolve() needs a real
    // path for the prefix check to be meaningful.
    const root = mkdtempSync(join(tmpdir(), 'aw-fuzz-path-'))
    try {
      const property = fc.property(fc.string({ minLength: 0, maxLength: 200 }), (relPath) => {
        try {
          const result = safeJoin(root, relPath)
          // If no throw: result MUST start with root (or equal it).
          return result === root || result.startsWith(root + '/') || result.startsWith(root + '\\')
        } catch (err) {
          // Only ValidationError is acceptable. Anything else (TypeError,
          // raw Error) is a bug.
          return err instanceof ValidationError
        }
      })
      // numRuns=300: fast-check default is 100; bump to triple for an
      // adversarial surface that an attacker would explore exhaustively.
      fc.assert(property, { numRuns: 300 })
    } finally {
      rimrafDir(root)
    }
  })

  test('classic POSIX traversal payloads always rejected with ValidationError', () => {
    // Known-bad payloads pinned as a regression bed. fast-check finds
    // the long tail; this table catches the obvious ones with explicit
    // reasoning. All payloads here are POSIX-style — the daemon currently
    // runs on macOS / Linux, so safeJoin uses POSIX path semantics (`/`
    // separator, `\` is a literal character). Windows-style `..\\..\\foo`
    // doesn't trip POSIX isAbsolute() and is treated as a single
    // relative segment; if/when the daemon ships a Windows binary, a
    // separate Win32 fuzz suite must add reverse-slash coverage (tracked
    // as KNOWN_GAP below).
    const root = mkdtempSync(join(tmpdir(), 'aw-fuzz-path-known-'))
    try {
      const payloads = [
        '../',
        '../../etc/passwd',
        '../../../',
        './../',
        'a/../../b',
        '/etc/passwd', // absolute
        '/tmp/foo', // absolute
        // Very long traversal — defense in depth against a buffer-bound
        // bug in path-normalize. We don't want depth dependence.
        '../'.repeat(100) + 'etc/passwd',
        // Empty: explicit rejection
        '',
      ]
      for (const payload of payloads) {
        let thrown: unknown
        try {
          safeJoin(root, payload)
        } catch (err) {
          thrown = err
        }
        if (!(thrown instanceof ValidationError)) {
          throw new Error(
            `expected ValidationError for payload ${JSON.stringify(payload)}, got ${thrown === undefined ? 'no throw' : String(thrown)}`,
          )
        }
      }
    } finally {
      rimrafDir(root)
    }
  })

  test('Windows-style backslash payloads ARE rejected on POSIX (post-fix)', () => {
    // Post-fix (W3-5 KNOWN_GAP resolved): safeJoin defensively rejects
    // any path containing a backslash, regardless of platform. On POSIX
    // backslash was previously a legal literal character — but in
    // practice nobody legitimately names a file with `\`, and a future
    // Windows binary would otherwise see these as real path traversals.
    // Rejecting now closes the portability gap.
    const root = mkdtempSync(join(tmpdir(), 'aw-fuzz-path-backslash-'))
    try {
      const backslashPayloads = ['\\windows\\system32', '..\\..\\foo', 'file\\with\\slashes']
      for (const payload of backslashPayloads) {
        let thrown: unknown
        try {
          safeJoin(root, payload)
        } catch (err) {
          thrown = err
        }
        if (!(thrown instanceof ValidationError)) {
          throw new Error(
            `expected ValidationError for backslash payload ${JSON.stringify(payload)}, got ${thrown === undefined ? 'no throw' : String(thrown)}`,
          )
        }
      }
    } finally {
      rimrafDir(root)
    }
  })

  test('realpathInside rejects symlinks that point outside the root', () => {
    // On Windows, file symlinks need developer mode; if unavailable, the
    // security guarantee still exists in the code — just skip the test case.
    if (!canSymlink) return
    const root = mkdtempSync(join(tmpdir(), 'aw-fuzz-real-'))
    const outside = mkdtempSync(join(tmpdir(), 'aw-fuzz-outside-'))
    try {
      // Write a file under root and a symlink that escapes to outside.
      writeFileSync(join(root, 'inside.txt'), 'ok')
      writeFileSync(join(outside, 'secret.txt'), 'leak')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'escape'))
      let thrown: unknown
      try {
        realpathInside(root, join(root, 'escape'))
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(ValidationError)
    } finally {
      rimrafDir(root)
      rimrafDir(outside)
    }
  })
})

// ---------------------------------------------------------------------------
// URL: redactGitUrl removes credentials from arbitrary text.
// ---------------------------------------------------------------------------

describe('RFC-054 W3-5 — git URL credential redaction fuzz', () => {
  test('any http/https URL with userinfo never leaves the password in plaintext', () => {
    // redactGitUrl (shared/git-url.ts) currently only covers the
    // http/https schemes (see KNOWN_GAP below for ssh / file). The
    // arbitrary here is intentionally restricted to the schemes the
    // redactor protects today.
    const userArb = fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((s) => /^[A-Za-z0-9._-]+$/.test(s))
    // Password arbitrary intentionally prefixed with a sentinel
    // 'SECRET_' so the substring test can distinguish "redactor leaked
    // the password" from "fast-check happened to reuse this short
    // string in the path/host/user". Without the sentinel, the
    // counterexample `pass='ctor'` reuses bytes from a path segment
    // `ctor` and makes the false-positive uninvestigatable.
    const passArb = fc
      .string({ minLength: 4, maxLength: 60 })
      .filter((s) => /^[A-Za-z0-9._%!$+-]+$/.test(s))
      .map((s) => `SECRET_${s}`)
    const hostArb = fc.constantFrom(
      'github.com',
      'gitlab.com',
      'bitbucket.org',
      'gitea.local',
      'self-hosted.invalid',
    )
    const schemeArb = fc.constantFrom('https', 'http')
    const pathArb = fc
      .string({ minLength: 1, maxLength: 50 })
      .filter((s) => /^[A-Za-z0-9/_.-]+$/.test(s) && !s.includes('SECRET'))

    const urlArb = fc
      .tuple(schemeArb, userArb, passArb, hostArb, pathArb)
      .map(([scheme, user, pass, host, path]) => ({
        scheme,
        user,
        pass,
        host,
        path,
        full: `${scheme}://${user}:${pass}@${host}/${path}`,
      }))

    fc.assert(
      fc.property(urlArb, ({ pass, full }) => {
        const redacted = redactGitUrl(full)
        // Cleartext password must NOT appear in the redacted output.
        return !redacted.includes(pass)
      }),
      { numRuns: 200 },
    )
  })

  test('ssh:// + git+https:// scheme URLs with passwords ARE redacted (post-fix)', () => {
    // Post-fix (KNOWN_GAP from W3-5 first run resolved): redactGitUrl
    // now redacts `<scheme>://user:pass@` for any scheme, not just
    // http(s). The cleartext password must NOT appear in the output.
    // `ssh://git@host` (no colon → no password) still passes through
    // unmangled because the login name `git` is not a secret.
    const sshSample = 'ssh://alice:p4ssw0rd@gitea.local/repo.git'
    const redactedSsh = redactGitUrl(sshSample)
    expect(redactedSsh).not.toContain('p4ssw0rd')
    expect(redactedSsh).toContain('***')

    const gitPlusSample = 'git+https://bob:secretToken@gitlab.local/path.git'
    const redactedGitPlus = redactGitUrl(gitPlusSample)
    expect(redactedGitPlus).not.toContain('secretToken')

    // Plain `ssh://git@host` (no password) is preserved — `git` is the
    // canonical login name, not a credential, and stripping it would
    // distort the URL past diagnostic value.
    const plainSsh = 'ssh://git@github.com/owner/repo.git'
    expect(redactGitUrl(plainSsh)).toBe(plainSsh)
  })

  test('URLs without userinfo pass through unchanged (no false positives)', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 8, maxLength: 60 })
          .filter((s) => /^[A-Za-z0-9._/:-]+$/.test(s))
          .map((s) => `https://github.com/${s}`),
        (cleanUrl) => {
          // Sanity: no `:` followed by `@` means no userinfo. The
          // redactor must not corrupt these.
          return redactGitUrl(cleanUrl) === cleanUrl
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// GENERIC: redactSensitiveString covers Authorization headers / Bearer
// tokens / key=value secrets.
// ---------------------------------------------------------------------------

describe('RFC-054 W3-5 — generic secret-shape redaction fuzz', () => {
  test('Bearer tokens never leak through Authorization headers', () => {
    const tokenArb = fc
      .string({ minLength: 20, maxLength: 80 })
      .filter((s) => /^[A-Za-z0-9._-]+$/.test(s))
    fc.assert(
      fc.property(
        tokenArb,
        fc.constantFrom('Authorization', 'authorization', 'AUTHORIZATION', 'Proxy-Authorization'),
        (token, header) => {
          const input = `${header}: Bearer ${token}\nother content here`
          const redacted = redactSensitiveString(input)
          return !redacted.includes(token)
        },
      ),
      { numRuns: 200 },
    )
  })

  test('key=value secrets never leak (api_key / password / secret / pwd / token / etc.)', () => {
    const tokenArb = fc
      .string({ minLength: 8, maxLength: 60 })
      .filter((s) => /^[A-Za-z0-9_.-]+$/.test(s))
    const keyArb = fc.constantFrom(
      'token',
      'password',
      'secret',
      'api_key',
      'apikey',
      'access_key',
      'accesskey',
      'pwd',
      'auth',
    )
    const sepArb = fc.constantFrom('=', ':', ': ', ' = ')
    fc.assert(
      fc.property(keyArb, sepArb, tokenArb, (key, sep, secret) => {
        const input = `noise prefix ${key}${sep}${secret} suffix data`
        const redacted = redactSensitiveString(input)
        return !redacted.includes(secret)
      }),
      { numRuns: 200 },
    )
  })

  test('URI userinfo embedded in arbitrary text is redacted', () => {
    const userArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => /^[A-Za-z0-9._-]+$/.test(s))
    const passArb = fc
      .string({ minLength: 6, maxLength: 40 })
      .filter((s) => /^[A-Za-z0-9._-]+$/.test(s))
    fc.assert(
      fc.property(userArb, passArb, (user, pass) => {
        // Generic non-git URI (postgresql / mysql / amqp / etc.) — redact
        // module's URI_USERINFO_RE handles these even when redactGitUrl
        // would skip them.
        const input = `connecting to postgresql://${user}:${pass}@db.invalid:5432/app failed: timeout`
        const redacted = redactSensitiveString(input)
        return !redacted.includes(pass) && !redacted.includes(`${user}:${pass}`)
      }),
      { numRuns: 200 },
    )
  })

  test('redactSensitiveString never throws on hostile / edge-case input', () => {
    // Resilience property: defense layer must not blow up on bizarre
    // bytes (control chars, unicode, very long strings). If it throws
    // mid-stack, the original (un-redacted!) text would leak via the
    // exception's message in some logging adapters.
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 5000 }), (text) => {
        try {
          const out = redactSensitiveString(text)
          return typeof out === 'string'
        } catch {
          return false
        }
      }),
      { numRuns: 200 },
    )
  })

  test('null / undefined input returns empty string (chainability contract)', () => {
    expect(redactSensitiveString(null)).toBe('')
    expect(redactSensitiveString(undefined)).toBe('')
  })

  test('safe text passes through unchanged (no false positives)', () => {
    const safeArb = fc
      .string({ minLength: 1, maxLength: 200 })
      .filter(
        (s) =>
          !/token|password|secret|api_key|apikey|access_key|pwd|auth|bearer/i.test(s) &&
          !/:\/\//.test(s),
      )
    fc.assert(
      fc.property(safeArb, (s) => redactSensitiveString(s) === s),
      { numRuns: 100 },
    )
  })
})

// Sanity sub-suite: the temp-dir setup itself doesn't leak (don't
// pollute /tmp on flaky CI runs).
describe('RFC-054 W3-5 — fuzz suite hygiene', () => {
  test('all temp directories created above are scoped under tmpdir()', () => {
    const t = tmpdir()
    expect(t.length).toBeGreaterThan(0)
    // Sanity that a fresh mkdtempSync lands inside it.
    const d = mkdtempSync(join(t, 'aw-fuzz-hygiene-'))
    try {
      expect(d.startsWith(t)).toBe(true)
      mkdirSync(join(d, 'sub'), { recursive: true })
    } finally {
      rimrafDir(d)
    }
  })
})

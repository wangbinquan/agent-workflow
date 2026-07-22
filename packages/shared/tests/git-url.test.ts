// RFC-024: locks parseGitUrl / redactGitUrl / gitUrlCacheKeyWith behavior.

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  canonicalRepoKey,
  gitUrlCacheKey,
  gitUrlCacheKeyWith,
  hasQueryCredential,
  parseGitUrl,
  redactGitUrl,
} from '../src/git-url'

const sha1Hex = (s: string) => createHash('sha1').update(s).digest('hex')

describe('parseGitUrl', () => {
  test('ssh-scp: git@github.com:foo/bar.git', () => {
    const u = parseGitUrl('git@github.com:foo/bar.git')!
    expect(u.kind).toBe('ssh-scp')
    if (u.kind === 'ssh-scp') {
      expect(u.user).toBe('git')
      expect(u.host).toBe('github.com')
      expect(u.path).toBe('foo/bar.git')
    }
  })

  test('ssh-uri: ssh://git@github.com/foo/bar', () => {
    const u = parseGitUrl('ssh://git@github.com/foo/bar')!
    expect(u.kind).toBe('ssh-uri')
    if (u.kind === 'ssh-uri') {
      expect(u.user).toBe('git')
      expect(u.host).toBe('github.com')
      expect(u.path).toBe('foo/bar')
      expect(u.port).toBeNull()
    }
  })

  test('ssh-uri with port: ssh://git@example.com:2222/x/y.git', () => {
    const u = parseGitUrl('ssh://git@example.com:2222/x/y.git')!
    expect(u.kind).toBe('ssh-uri')
    if (u.kind === 'ssh-uri') expect(u.port).toBe(2222)
  })

  test('https: https://github.com/foo/bar.git', () => {
    const u = parseGitUrl('https://github.com/foo/bar.git')!
    expect(u.kind).toBe('https')
    if (u.kind === 'https') {
      expect(u.host).toBe('github.com')
      expect(u.path).toBe('foo/bar.git')
      expect(u.userInfo).toBeNull()
    }
  })

  test('http: http://example.com/x.git', () => {
    const u = parseGitUrl('http://example.com/x.git')!
    expect(u.kind).toBe('http')
  })

  test('https with userInfo: https://user:pass@host/x', () => {
    const u = parseGitUrl('https://user:tok@host.example/foo/bar.git')!
    expect(u.kind).toBe('https')
    if (u.kind === 'https') {
      expect(u.userInfo).toBe('user:tok')
      expect(u.host).toBe('host.example')
    }
  })

  test('https with port', () => {
    const u = parseGitUrl('https://host.example:8443/foo/bar.git')!
    expect(u.kind).toBe('https')
    if (u.kind === 'https') expect(u.port).toBe(8443)
  })

  test('file:// is accepted as a separate kind (local mirror / test fixture)', () => {
    const u = parseGitUrl('file:///srv/git/foo.git')!
    expect(u.kind).toBe('file')
    if (u.kind === 'file') expect(u.path).toBe('srv/git/foo.git')
  })

  test('rejects bare path / no scheme / no @', () => {
    expect(parseGitUrl('/srv/git/foo.git')).toBeNull()
    expect(parseGitUrl('foo/bar')).toBeNull()
    expect(parseGitUrl('github.com/foo/bar')).toBeNull()
  })

  test('rejects whitespace inside URL', () => {
    expect(parseGitUrl('git@github.com:foo bar/baz.git')).toBeNull()
    expect(parseGitUrl('https://host.example/ x')).toBeNull()
  })

  test('rejects empty / non-string', () => {
    expect(parseGitUrl('')).toBeNull()
    expect(parseGitUrl('   ')).toBeNull()
    // @ts-expect-error -- exercising runtime guard
    expect(parseGitUrl(null)).toBeNull()
  })

  test('rejects ssh-uri missing user or path', () => {
    expect(parseGitUrl('ssh://host.example/foo')).toBeNull()
    expect(parseGitUrl('ssh://git@host.example/')).toBeNull()
    expect(parseGitUrl('ssh://git@host.example')).toBeNull()
  })

  test('windows-style path is rejected (not ssh-scp)', () => {
    // `C:/Users/x` masquerades as user@host:path with host=`C` (no dot) — reject.
    expect(parseGitUrl('C:/Users/x/repo')).toBeNull()
  })
})

describe('redactGitUrl', () => {
  test('redacts user:pass in https URL', () => {
    expect(redactGitUrl('https://alice:tok@host.example/foo.git')).toBe(
      'https://***@host.example/foo.git',
    )
  })

  test('redacts x-token-auth pattern', () => {
    expect(redactGitUrl('https://x-token-auth:abc123@gitlab.com/me/proj.git')).toBe(
      'https://***@gitlab.com/me/proj.git',
    )
  })

  test('leaves credential-free https untouched', () => {
    expect(redactGitUrl('https://github.com/foo/bar.git')).toBe('https://github.com/foo/bar.git')
  })

  test('ssh:// form passes through (user is non-secret)', () => {
    expect(redactGitUrl('ssh://git@github.com/foo/bar')).toBe('ssh://git@github.com/foo/bar')
  })

  test('git@host:path form passes through', () => {
    expect(redactGitUrl('git@github.com:foo/bar.git')).toBe('git@github.com:foo/bar.git')
  })

  test('plain http with creds', () => {
    expect(redactGitUrl('http://u:p@h.example/x')).toBe('http://***@h.example/x')
  })

  test('regex fallback catches malformed creds-bearing scheme', () => {
    // Trailing whitespace makes parseGitUrl reject this, but redact still wins.
    expect(redactGitUrl('https://u:p@h.example/x ')).toBe('https://***@h.example/x ')
  })

  test('redacts port-bearing creds', () => {
    expect(redactGitUrl('https://u:p@h.example:8443/x.git')).toBe(
      'https://***@h.example:8443/x.git',
    )
  })

  // RFC-204 impl-gate (Codex 2026-07-22, P0-4): parseGitUrl splits the authority
  // at the LAST `@` (git-url.ts `authority.lastIndexOf('@')`), but pass-1 used
  // `[^/@\s]+@` which stopped at the FIRST `@` and left the rest of the userinfo
  // (a second credential segment) verbatim in the "redacted" output. Redaction
  // must consume through to the same last `@` the parser uses.
  test('multi-@ userinfo redacts fully — parity with parseGitUrl authority split', () => {
    expect(redactGitUrl('https://user:part1@part2@example.com/o/r.git')).toBe(
      'https://***@example.com/o/r.git',
    )
    // Sanity: the parser really does treat everything before the last @ as userinfo.
    const parsed = parseGitUrl('https://user:part1@part2@example.com/o/r.git')
    expect(parsed?.kind).toBe('https')
    if (parsed?.kind === 'https') expect(parsed.host).toBe('example.com')
  })

  test('ssh multi-@ user:pass redacts fully', () => {
    expect(redactGitUrl('ssh://alice:sec@ret@host.example/o/r.git')).toBe(
      'ssh://***:***@host.example/o/r.git',
    )
  })
})

describe('hasQueryCredential (RFC-204 launch gate)', () => {
  test('plain query credential is caught', () => {
    expect(hasQueryCredential('https://h.example/r.git?access_token=SECRET')).toBe(true)
    expect(hasQueryCredential('https://h.example/r.git?ref=main&private_token=x')).toBe(true)
  })

  // RFC-204 impl-gate (Codex 2026-07-22, P0-4): `%5F` percent-encodes the `_`
  // in `access_token`, so the literal `[?&]access_token=` regex missed it and
  // batch-import/retry would slug the token into cached_repos.local_path. The
  // gate must decode each query param NAME before matching the sensitive set.
  test('percent-encoded key bypass is caught (fail-closed)', () => {
    expect(hasQueryCredential('https://h.example/r.git?access%5Ftoken=SECRET')).toBe(true)
    expect(hasQueryCredential('https://h.example/r.git?access%5ftoken=SECRET')).toBe(true)
    expect(hasQueryCredential('https://h.example/r.git?a=1&personal%5Faccess%5Ftoken=z')).toBe(true)
  })

  test('non-credential query passes through', () => {
    expect(hasQueryCredential('https://h.example/r.git?ref=main&depth=1')).toBe(false)
    expect(hasQueryCredential('https://h.example/r.git')).toBe(false)
  })
})

describe('gitUrlCacheKeyWith', () => {
  test('different surface forms of the same repo collapse to same hash', () => {
    const forms = [
      'git@github.com:foo/bar.git',
      'git@github.com:foo/bar',
      'git@github.com:foo/bar/',
      'ssh://git@github.com/foo/bar.git',
      'ssh://git@github.com/foo/bar',
    ]
    const keys = forms.map((f) => gitUrlCacheKeyWith(parseGitUrl(f)!, sha1Hex))
    const first = keys[0]
    for (const k of keys) expect(k.hash).toBe(first.hash)
  })

  test('https with different user:pass for same repo collapse to same hash', () => {
    const a = gitUrlCacheKeyWith(parseGitUrl('https://github.com/foo/bar.git')!, sha1Hex)
    const b = gitUrlCacheKeyWith(parseGitUrl('https://u:p@github.com/foo/bar.git')!, sha1Hex)
    const c = gitUrlCacheKeyWith(parseGitUrl('https://x:y@github.com/foo/bar')!, sha1Hex)
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toBe(c.hash)
  })

  test('different repos produce different hashes', () => {
    const a = gitUrlCacheKeyWith(parseGitUrl('git@github.com:foo/bar.git')!, sha1Hex)
    const b = gitUrlCacheKeyWith(parseGitUrl('git@github.com:foo/baz.git')!, sha1Hex)
    expect(a.hash).not.toBe(b.hash)
  })

  test('slug uses last path segment without .git suffix', () => {
    const k = gitUrlCacheKeyWith(parseGitUrl('git@github.com:foo/my-cool-repo.git')!, sha1Hex)
    expect(k.slug).toBe('my-cool-repo')
  })

  test('slug strips unsafe chars', () => {
    // path component "weird name" itself would fail parseGitUrl (whitespace),
    // so use a tolerated char set: dots/underscores are kept.
    const k = gitUrlCacheKeyWith(parseGitUrl('git@host.example:org/abc.def_ghi.git')!, sha1Hex)
    expect(k.slug).toBe('abc.def_ghi')
  })

  test('canonical is lowercased', () => {
    const k = gitUrlCacheKeyWith(parseGitUrl('git@GitHub.com:Foo/Bar.git')!, sha1Hex)
    expect(k.canonical).toBe('ssh://git@github.com/foo/bar')
  })
})

describe('gitUrlCacheKey (Web Crypto)', () => {
  test('matches the injectable variant', async () => {
    const parsed = parseGitUrl('git@github.com:foo/bar.git')!
    const sync = gitUrlCacheKeyWith(parsed, sha1Hex)
    const async_ = await gitUrlCacheKey(parsed)
    expect(async_.hash).toBe(sync.hash)
    expect(async_.slug).toBe(sync.slug)
    expect(async_.canonical).toBe(sync.canonical)
  })
})

// RFC-110 — canonicalRepoKey: launcher-side URL→cache matching reuses the SAME
// canonicalization the cache key derives from, so a frontend "hit" lines up with
// the backend's cache bucket. Folds within a protocol; HTTPS and SSH are distinct.
describe('canonicalRepoKey (RFC-110)', () => {
  test('HTTPS variants collapse to one key (.git / trailing slash / creds / case / http→https)', () => {
    const base = canonicalRepoKey('https://github.com/foo/bar')
    expect(base).not.toBeNull()
    expect(canonicalRepoKey('https://github.com/foo/bar.git')).toBe(base)
    expect(canonicalRepoKey('https://github.com/foo/bar/')).toBe(base)
    expect(canonicalRepoKey('https://user:tok@github.com/foo/bar')).toBe(base)
    expect(canonicalRepoKey('https://GitHub.com/foo/bar')).toBe(base)
    // http and https collapse to https (mirrors backend cache-key semantics).
    expect(canonicalRepoKey('http://github.com/foo/bar')).toBe(base)
  })

  test('SSH variants (scp + uri) collapse to one key', () => {
    const ssh = canonicalRepoKey('git@github.com:foo/bar.git')
    expect(ssh).toBe('ssh://git@github.com/foo/bar')
    expect(canonicalRepoKey('git@github.com:foo/bar')).toBe(ssh)
    expect(canonicalRepoKey('ssh://git@github.com/foo/bar')).toBe(ssh)
    expect(canonicalRepoKey('ssh://git@github.com/foo/bar.git')).toBe(ssh)
  })

  test('cross-protocol does NOT match — HTTPS key !== SSH key (v1 no cross-match)', () => {
    expect(canonicalRepoKey('https://github.com/foo/bar')).not.toBe(
      canonicalRepoKey('git@github.com:foo/bar.git'),
    )
  })

  test('different repos → different keys', () => {
    expect(canonicalRepoKey('https://github.com/foo/bar')).not.toBe(
      canonicalRepoKey('https://github.com/foo/baz'),
    )
  })

  test('unparseable input → null', () => {
    expect(canonicalRepoKey('')).toBeNull()
    expect(canonicalRepoKey('   ')).toBeNull()
    expect(canonicalRepoKey('not a url')).toBeNull()
    expect(canonicalRepoKey('https://')).toBeNull()
  })

  test('equals the canonical string the cache key derives from (frontend↔backend parity)', () => {
    const parsed = parseGitUrl('https://github.com/foo/bar.git')!
    const { canonical } = gitUrlCacheKeyWith(parsed, sha1Hex)
    expect(canonicalRepoKey('https://github.com/foo/bar.git')).toBe(canonical)
  })
})

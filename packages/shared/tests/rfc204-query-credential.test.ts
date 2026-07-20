// RFC-204 T0 — query-string Git credentials.
//
// Why these tests exist (design gate round 3, RFC-204 design.md §3.1):
// `parseGitUrl` keeps the query inside `parsed.path`, so a URL like
// `https://host/o/r.git?access_token=TOKEN` leaked the token into the cache
// slug -> `cached_repos.local_path` (which IS on the wire) -> worktree paths,
// and into `url_hash`. Meanwhile `redactGitUrl` only masked URI *userinfo*, so
// the raw token also survived into `tasks.repo_url` / error columns / daemon
// logs. The adopted fix is the "light" route:
//   1. reject query-credential URLs at the launch/schedule door, and
//   2. mask them in `redactGitUrl` for everything already persisted.
//
// The third block below is the important one: it LOCKS `canonicalForHash` as
// still query-sensitive. Making canonical ignore the query looks like a
// tidy-up, but it would silently re-key every existing query-form cache row
// (cold-clone duplicates) and collapse token-specific rows onto one unique
// hash. Rejecting at the door is what makes leaving the hash alone safe.

import { describe, expect, test } from 'bun:test'

import {
  SENSITIVE_QUERY_KEYS,
  canonicalRepoKey,
  hasQueryCredential,
  redactGitUrl,
} from '../src/git-url.js'

describe('RFC-204 hasQueryCredential — the launch/schedule input gate', () => {
  test('flags each sensitive query key', () => {
    for (const key of SENSITIVE_QUERY_KEYS) {
      expect(hasQueryCredential(`https://host/o/r.git?${key}=SECRET`)).toBe(true)
    }
  })

  test('flags the key case-insensitively and when not the first param', () => {
    expect(hasQueryCredential('https://host/o/r.git?ACCESS_TOKEN=S')).toBe(true)
    expect(hasQueryCredential('https://host/o/r.git?ref=main&token=S')).toBe(true)
  })

  test('does NOT flag credential-free URLs (userinfo form stays supported)', () => {
    expect(hasQueryCredential('https://host/o/r.git?ref=main')).toBe(false)
    expect(hasQueryCredential('https://host/o/r.git')).toBe(false)
    expect(hasQueryCredential('ssh://git@host/o/r.git')).toBe(false)
    // userinfo credentials are sealed, not rejected — this gate must ignore them
    expect(hasQueryCredential('https://x-access-token:ghp_TOK@github.com/o/r.git')).toBe(false)
  })

  test('does not treat a longer key as its shorter suffix', () => {
    // `token` must not match inside `access_token` at the `?` anchor and vice
    // versa; both are sensitive, but a mis-anchored alternation would also
    // make redaction chop the wrong span.
    expect(redactGitUrl('https://host/o/r.git?access_token=S')).toBe(
      'https://host/o/r.git?access_token=***',
    )
  })
})

describe('RFC-204 redactGitUrl — query credentials are masked', () => {
  test('masks the credential value only, preserving other params and fragment', () => {
    expect(redactGitUrl('https://host/o/r.git?private_token=A&ref=main')).toBe(
      'https://host/o/r.git?private_token=***&ref=main',
    )
    expect(redactGitUrl('https://host/o/r.git?ACCESS_TOKEN=UP&x=1#frag')).toBe(
      'https://host/o/r.git?ACCESS_TOKEN=***&x=1#frag',
    )
  })

  test('masks userinfo AND query when both carry credentials', () => {
    expect(redactGitUrl('https://u:p@host/o/r.git?token=T')).toBe(
      'https://***@host/o/r.git?token=***',
    )
  })

  test('leaves non-sensitive query params untouched', () => {
    expect(redactGitUrl('https://host/o/r.git?ref=main')).toBe('https://host/o/r.git?ref=main')
  })

  test('is idempotent (re-redacting an already-redacted value is a no-op)', () => {
    // The backfill re-redacts historical columns; running the gate twice must
    // not corrupt already-masked rows.
    const once = redactGitUrl('https://host/o/r.git?token=T')
    expect(redactGitUrl(once)).toBe(once)
  })
})

describe('RFC-204 canonicalForHash stays query-sensitive (do NOT "fix" this)', () => {
  test('two URLs differing only in the token still canonicalize differently', () => {
    // LOCK: if this ever collapses to one key, every existing query-form cache
    // row silently re-keys (duplicate cold clones) and token-specific rows
    // collide on the unique url_hash. See design.md §3.1.3.
    const a = canonicalRepoKey('https://host/o/r.git?access_token=AAA')
    const b = canonicalRepoKey('https://host/o/r.git?access_token=BBB')
    expect(a).not.toBeNull()
    expect(a).not.toBe(b)
  })

  test('userinfo form: hash(redacted) === hash(plaintext) — the backfill premise', () => {
    // canonicalForHash drops userinfo, so the backfill can derive a cache row
    // from the ALREADY-REDACTED tasks.repo_url without ever seeing plaintext.
    const plain = 'https://x-access-token:ghp_TOK@github.com/o/r.git'
    expect(canonicalRepoKey(redactGitUrl(plain))).toBe(canonicalRepoKey(plain))
  })
})

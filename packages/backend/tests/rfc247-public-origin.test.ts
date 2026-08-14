// RFC-247 impl-gate P2 — the shared "what origin will the caller reach us on"
// rule, extracted from RFC-036's `resolveRedirectUri` so the documentation
// surfaces stop deriving it a second, wrong way.
//
// Why this file exists: `/api/docs/api` snippets and `/.well-known/mcp` used to
// parse `c.req.url`, which behind TLS termination or a host-rewriting proxy is
// the daemon's INTERNAL origin — so every snippet and the discovery `endpoint`
// pointed at an address the reader could not reach. The fix is only as good as
// the precedence it implements, hence a matrix over the pure function rather
// than one happy-path assertion.
//
// The precedence is RFC-036's, unchanged: config `publicBaseUrl` → forwarded
// headers → `Host` → request URL. If a future change reorders these, the OIDC
// callback moves with it, which is exactly why they must stay one function.

import { describe, expect, test } from 'bun:test'
import { derivePublicOrigin } from '../src/routes/publicOrigin'

const INTERNAL = 'http://127.0.0.1:7777/api/docs/api'

describe('RFC-247 — publicBaseUrl outranks everything', () => {
  test('config wins over forwarded headers and over the request URL', () => {
    expect(
      derivePublicOrigin({
        configuredBaseUrl: 'https://configured.example.com',
        forwardedProto: 'http',
        forwardedHost: 'header.example.com',
        hostHeader: 'header.example.com',
        requestUrl: INTERNAL,
      }),
    ).toBe('https://configured.example.com')
  })

  test('a trailing slash is normalised away, so callers can concatenate', () => {
    expect(
      derivePublicOrigin({ configuredBaseUrl: 'https://x.example.com/', requestUrl: INTERNAL }),
    ).toBe('https://x.example.com')
  })

  test('a sub-path deployment keeps its path — it is not reduced to the host', () => {
    // `publicBaseUrl` is documented as a base URL, and an operator serving the
    // daemon under /aw needs the snippets to say /aw.
    expect(
      derivePublicOrigin({ configuredBaseUrl: 'https://x.example.com/aw', requestUrl: INTERNAL }),
    ).toBe('https://x.example.com/aw')
  })

  test('an empty or whitespace-only value is treated as unset, not as an origin', () => {
    expect(
      derivePublicOrigin({
        configuredBaseUrl: '   ',
        forwardedProto: 'https',
        forwardedHost: 'aw.example.com',
        requestUrl: INTERNAL,
      }),
    ).toBe('https://aw.example.com')
  })
})

describe('RFC-247 — forwarded headers describe the reader’s origin', () => {
  test('proto and host both come from X-Forwarded-*', () => {
    expect(
      derivePublicOrigin({
        forwardedProto: 'https',
        forwardedHost: 'aw.example.com',
        hostHeader: '127.0.0.1:7777',
        requestUrl: INTERNAL,
      }),
    ).toBe('https://aw.example.com')
  })

  test('a proxy CHAIN resolves to the original client hop, not the last one', () => {
    // `X-Forwarded-For`-style chains append per hop; the first entry is the one
    // the client actually spoke to.
    expect(
      derivePublicOrigin({
        forwardedProto: 'https, http',
        forwardedHost: 'aw.example.com, internal.local',
        requestUrl: INTERNAL,
      }),
    ).toBe('https://aw.example.com')
  })

  test('a forwarded host with no forwarded proto keeps the request’s scheme', () => {
    expect(
      derivePublicOrigin({ forwardedHost: 'aw.example.com', requestUrl: 'https://internal/x' }),
    ).toBe('https://aw.example.com')
  })
})

describe('RFC-247 — direct connections and degenerate input', () => {
  test('no proxy at all: the Host header answers', () => {
    expect(derivePublicOrigin({ hostHeader: 'box.local:7777', requestUrl: INTERNAL })).toBe(
      'http://box.local:7777',
    )
  })

  test('no headers at all: the request URL answers', () => {
    expect(derivePublicOrigin({ requestUrl: INTERNAL })).toBe('http://127.0.0.1:7777')
  })

  test('a malformed request URL with no headers yields empty, never a broken URL', () => {
    // RFC-036's version emitted the literal `http://undefined/...` here, which
    // reads like a real redirect target right up until it fails.
    expect(derivePublicOrigin({ requestUrl: 'not a url' })).toBe('')
  })

  test('a malformed request URL still resolves when a proxy told us who we are', () => {
    expect(
      derivePublicOrigin({
        forwardedProto: 'https',
        forwardedHost: 'aw.example.com',
        requestUrl: 'not a url',
      }),
    ).toBe('https://aw.example.com')
  })

  test('a header that is present but BLANK falls through instead of winning', () => {
    // The failure this locks: an empty string is not `undefined`, so a naive
    // `?? ` chain accepts `''` as the answer and returns a truncated origin
    // (or `''`) even though the request URL could have answered.
    expect(derivePublicOrigin({ forwardedHost: '  ', hostHeader: '', requestUrl: INTERNAL })).toBe(
      'http://127.0.0.1:7777',
    )
    expect(
      derivePublicOrigin({ forwardedProto: '', hostHeader: 'box.local', requestUrl: INTERNAL }),
    ).toBe('http://box.local')
  })
})

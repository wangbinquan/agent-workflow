// The single answer to "what origin will the caller actually reach us on".
//
// Two surfaces need it and used to derive it two different ways:
//
//   - OIDC redirect URIs (RFC-036): config `publicBaseUrl` first, then
//     `X-Forwarded-*`, then the `Host` header — the correct precedence;
//   - the generated client snippets and `/.well-known/mcp` (RFC-247): just
//     `new URL(c.req.url)`, which behind TLS termination or a proxy that
//     rewrites host/proto yields the daemon's INTERNAL origin. Every snippet
//     and the discovery `endpoint` therefore pointed at an address the reader
//     could not reach (RFC-247 impl-gate P2).
//
// Rather than teach the second one the same rules — a second copy of a rule is
// how the two drift — the derivation lives here as a pure function and both
// call it.
//
// NOT the same rule as webhook ingress URLs, on purpose. `webhookEndpoints.ts`
// builds those from `publicBaseUrl` ALONE and returns null without it, because
// that URL gets pasted into a code host and has to keep working for months: a
// guess derived from whoever happened to call us is worse than an honest "the
// operator has not configured this yet". The URLs here are the opposite case —
// the reader is holding the connection right now and wants to paste what they
// are already talking to — so falling back to the forwarded/Host origin is the
// correct answer rather than a guess. Same config key, different failure cost.
//
// RFC-294 note: this is an inbound-HTTP transport concern, so its target home
// is `adapters/inbound/http/` (§2). It sits in `routes/` next to `registry.ts`
// (the other transport-owned shared module) and moves with the rest of the
// route layer in W4; it deliberately does not become a `services/` module,
// because a service reaching for request headers is the coupling W4 removes.

import type { Context } from 'hono'
import { loadConfig } from '@/config'

export interface PublicOriginInputs {
  /** `publicBaseUrl` from config.json, when the operator has set one. */
  configuredBaseUrl?: string | undefined
  /** `X-Forwarded-Proto`, verbatim (may be a comma-separated proxy chain). */
  forwardedProto?: string | undefined
  /** `X-Forwarded-Host`, verbatim (may be a comma-separated proxy chain). */
  forwardedHost?: string | undefined
  /** `Host` header. */
  hostHeader?: string | undefined
  /** Absolute request URL (`c.req.url`) — the direct-connection fallback. */
  requestUrl: string
}

/** Trimmed value, or undefined when absent/blank — a blank header is not an answer. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/** First entry of a comma-separated forwarded header — the ORIGINAL client hop. */
function firstHop(value: string | undefined): string | undefined {
  return nonEmpty(value?.split(',')[0])
}

function originOfUrl(url: string): { proto: string; host: string } | null {
  try {
    const parsed = new URL(url)
    return { proto: parsed.protocol.replace(/:$/, ''), host: parsed.host }
  } catch {
    return null
  }
}

/**
 * Pure — no Hono, no config loading, no I/O. Returns an origin with no trailing
 * slash, or `''` when nothing at all identifies us (malformed request URL and
 * no headers), which is what the previous `originOf` returned in that case.
 *
 * Precedence: explicit config → forwarded headers → Host header → request URL.
 * `publicBaseUrl` may carry a path (sub-path deployments), so it is returned
 * as-is minus a trailing slash rather than reduced to protocol+host.
 */
export function derivePublicOrigin(inputs: PublicOriginInputs): string {
  const configured = nonEmpty(inputs.configuredBaseUrl)
  if (configured !== undefined) return configured.replace(/\/$/, '')

  const fromUrl = originOfUrl(inputs.requestUrl)
  const proto = firstHop(inputs.forwardedProto) ?? fromUrl?.proto
  // The `Host` header is the direct-connection answer; the request URL's host
  // is the last resort. Every step goes through `nonEmpty`, so a header that is
  // present but blank falls through instead of winning with an empty string.
  // RFC-036's version could produce `http://undefined/...` when neither header
  // was present — reaching the request URL instead is the one behavioural
  // difference here, and it only fires where the old string was already
  // unusable.
  const host = firstHop(inputs.forwardedHost) ?? nonEmpty(inputs.hostHeader) ?? fromUrl?.host

  if (proto === undefined || host === undefined) return ''
  return `${proto}://${host}`
}

/** Request-bound wrapper: reads config (best-effort) and the forwarded headers. */
export function publicOriginOf(c: Context, configPath: string): string {
  let configuredBaseUrl: string | undefined
  try {
    const value = loadConfig(configPath).publicBaseUrl
    if (typeof value === 'string') configuredBaseUrl = value
  } catch {
    // A broken/absent config must not take down a documentation endpoint —
    // fall through to header derivation, same as RFC-036 does.
  }
  return derivePublicOrigin({
    configuredBaseUrl,
    forwardedProto: c.req.header('X-Forwarded-Proto'),
    forwardedHost: c.req.header('X-Forwarded-Host'),
    hostHeader: c.req.header('Host'),
    requestUrl: c.req.url,
  })
}

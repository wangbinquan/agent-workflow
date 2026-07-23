// RFC-036 — tiny HTML renderer for OIDC callback failure pages. Centralises
// the i18n-free friendly text so the callback route can `return c.html(...)`
// from one location without leaking internal details.

const REASON_TO_TEXT: Record<string, string> = {
  'oidc-not-configured': 'OIDC is not configured on this server.',
  'invalid-callback': 'OIDC callback is missing required parameters.',
  'state-expired': 'Your login session expired. Please try again.',
  'provider-disabled': 'The selected provider is currently disabled.',
  'discovery-failed': 'The identity provider is unreachable. Please try again later.',
  'client-secret-missing': 'Server configuration error. Contact your administrator.',
  'verify-failed': 'Could not verify the identity provider response.',
  'token-exchange-failed': 'Failed to exchange the authorization code.',
  'id-token-verify-failed': 'The id_token signature or claims could not be verified.',
  'nonce-mismatch': 'OIDC nonce check failed (possible replay).',
  'identity-already-linked':
    'That identity is already linked to a different user. Sign in with the other account first.',
  // RFC-220 — manual-endpoint fallback + userinfo identity source.
  'endpoints-unresolved':
    'The identity provider endpoints could not be resolved. Contact your administrator.',
  'userinfo-unavailable':
    'The identity provider returned no id_token and no userinfo endpoint is configured. Contact your administrator.',
  'jwks-unavailable':
    'The id_token cannot be verified (no JWKS available) and no userinfo endpoint is configured. Contact your administrator.',
  'userinfo-fetch-failed': 'Could not fetch identity information from the provider.',
  'userinfo-shape-invalid': 'The provider returned an unusable userinfo response.',
  'provider-config-changed': 'The provider configuration changed during sign-in. Please try again.',
  'email-domain-not-allowed':
    'Your email domain is not on the allowlist. Please contact your administrator.',
  'email-not-verified': 'Your identity provider has not verified your email.',
  'not-invited':
    'No invitation found for this email. Please ask your administrator to invite you first.',
  'bootstrap-admin-required':
    'Create the first administrator before using identity-provider login.',
}

export function friendly(code: string): string {
  const text = REASON_TO_TEXT[code] ?? 'OIDC login failed.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>Login failed</title></head><body><h1>Login failed</h1><p>${escape(text)}</p><p><a href="/auth">Back to sign in</a></p></body></html>`
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  )
}

/** Custom error subclass for the callback handler to coalesce verify-failed paths. */
export class BadRequestErrorOrFriendlyHtml extends Error {
  constructor(public readonly code: string) {
    super(code)
  }
}

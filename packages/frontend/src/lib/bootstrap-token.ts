// RFC-221 — daemon bootstrap links carry the one-time setup credential in a
// query parameter. Parse it once, then let the root route scrub it from the
// visible URL before any authenticated request is made.

export interface BootstrapTokenLocation {
  token: string | null
  sanitizedHref: string
  redirect: string
}

export function parseBootstrapTokenLocation(href: string): BootstrapTokenLocation | null {
  let url: URL
  try {
    url = new URL(href, 'http://agent-workflow.local')
  } catch {
    return null
  }
  if (!url.searchParams.has('token')) return null

  const token = url.searchParams.get('token')?.trim() || null
  url.searchParams.delete('token')
  const sanitizedHref = `${url.pathname}${url.search}${url.hash}`
  const explicitRedirect = url.searchParams.get('redirect')
  const redirect =
    url.pathname === '/auth' || url.pathname === '/setup/admin'
      ? explicitRedirect || '/agents'
      : sanitizedHref

  return { token, sanitizedHref, redirect }
}

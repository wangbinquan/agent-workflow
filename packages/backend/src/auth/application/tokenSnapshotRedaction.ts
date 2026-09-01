// RFC-349 — authentication-owned, pure redaction used before token audit
// persistence.  Keeping this leaf below services prevents the audit domain
// from depending upward on HTTP/MCP serialization code.

import { redactGitUrl } from '@agent-workflow/shared'

export const REDACTED = '***'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maskValues(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).map((key) => [key, REDACTED]))
}

export function redactMcpRecord<T>(record: T): T {
  if (!isPlainObject(record)) return record
  const config = record.config
  if (!isPlainObject(config)) return record
  const nextConfig: Record<string, unknown> = { ...config }
  if ('env' in nextConfig) nextConfig.env = maskValues(nextConfig.env)
  if ('headers' in nextConfig) nextConfig.headers = maskValues(nextConfig.headers)
  if (isPlainObject(nextConfig.oauth) && 'clientSecret' in nextConfig.oauth) {
    nextConfig.oauth = { ...nextConfig.oauth, clientSecret: REDACTED }
  }
  return { ...record, config: nextConfig } as T
}

export function redactRepoUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return null
  return redactGitUrl(url)
}

// Signature verification remains exclusive to the direct webhook transport.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CodeHostAdapter, HeaderBag } from './codeHostAdapter'
import { githubNormalize } from '@/modules/integration/domain/githubNormalization'
export { githubNormalize, githubApiBaseUrl } from '@/modules/integration/domain/githubNormalization'

export function githubVerify(
  headers: HeaderBag,
  rawBody: Uint8Array,
  secret: string,
): 'valid' | 'invalid' | 'missing' {
  const presented = headers['x-hub-signature-256']
  if (presented === undefined || presented.length === 0) return 'missing'
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return 'invalid'
  }
  return timingSafeEqual(a, b) ? 'valid' : 'invalid'
}

export const githubAdapter: CodeHostAdapter = {
  provider: 'github',
  headerAllowlist: ['x-hub-signature-256', 'x-github-delivery', 'x-github-event'],
  deliveryIdHeader: 'x-github-delivery',
  eventHeader: 'x-github-event',
  // GitHub 的判别符就是事件头（payload 无 object_kind 同位物）。
  summaryKindOf: (headers) => headers['x-github-event'] ?? null,
  verify: githubVerify,
  normalize: githubNormalize,
}

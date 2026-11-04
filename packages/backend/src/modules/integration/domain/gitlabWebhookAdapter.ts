// Signature verification remains exclusive to the direct webhook transport.
// RFC-437：自 services/webhook/gitlabAdapter.ts 迁入 integration domain。
import { timingSafeEqual } from 'node:crypto'
import type { CodeHostAdapter } from './codeHostAdapters'
import type { HeaderBag } from './codeHostNormalization'
import { gitlabNormalize, gitlabSummaryKindOf } from './gitlabNormalization'

export function gitlabVerify(
  headers: HeaderBag,
  _rawBody: Uint8Array,
  secret: string,
): 'valid' | 'invalid' | 'missing' {
  const presented = headers['x-gitlab-token']
  if (presented === undefined || presented.length === 0) return 'missing'
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(secret, 'utf8')
  if (a.length !== b.length) {
    // 仍执行一次同长比较，避免「长度不等即刻返回」的可测时序差。
    timingSafeEqual(a, a)
    return 'invalid'
  }
  return timingSafeEqual(a, b) ? 'valid' : 'invalid'
}

export const gitlabAdapter: CodeHostAdapter = {
  provider: 'gitlab',
  headerAllowlist: ['x-gitlab-token', 'x-gitlab-event-uuid', 'x-gitlab-event'],
  deliveryIdHeader: 'x-gitlab-event-uuid',
  eventHeader: 'x-gitlab-event',
  summaryKindOf: gitlabSummaryKindOf,
  verify: gitlabVerify,
  normalize: gitlabNormalize,
}

// RFC-269 — 「测试连接」（RFC-450 自 routes/codeHosts.ts 的测试端点原样迁入；路由只负责解析请求体）。
//
// 未传的字段回落到已保存的值，所以「先保存再测」与「边填边测」都成立；只有在「测的就是已保存的那套」时才回写结果。

import type { CodeHostProvider, CodeHostTestResult } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import { normalizeCodeHostRejectUnauthorized } from '../domain/codeHostTlsPolicy'
import type {
  CodeHostConnectionProbe,
  CodeHostConnectionsService,
  CodeHostConnectionTestDraft,
} from './ports/codeHostConnections'

export async function testCodeHostConnection(
  deps: {
    readonly service: Pick<CodeHostConnectionsService, 'resolve' | 'recordTest'>
    readonly probe: CodeHostConnectionProbe
  },
  provider: CodeHostProvider,
  body: CodeHostConnectionTestDraft,
): Promise<CodeHostTestResult> {
  const { service } = deps
  // 未传的字段回落到已保存的值，所以「先保存再测」与「边填边测」都成立。
  const stored = await service.resolve(provider)
  const baseUrl = body.baseUrl ?? stored?.baseUrl
  const token = body.token ?? stored?.token
  const rejectUnauthorized = normalizeCodeHostRejectUnauthorized(
    provider,
    body.rejectUnauthorized ?? stored?.rejectUnauthorized,
  )
  if (baseUrl === undefined || token === undefined) {
    throw new ValidationError(
      'code-host-not-configured',
      `${provider} has no stored credential; provide baseUrl and token to test`,
    )
  }
  const result = await deps.probe.probe({ provider, baseUrl, token, rejectUnauthorized })
  // 只有在「测的就是已保存的那套」时才回写结果 —— 否则一次对着草稿值的
  // 成功探活会给已保存的坏配置盖上绿勾。
  if (
    stored !== null &&
    baseUrl === stored.baseUrl &&
    token === stored.token &&
    rejectUnauthorized === stored.rejectUnauthorized
  ) {
    await service.recordTest(provider, result)
  }
  return result
}

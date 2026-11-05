// RFC-269 — 代码平台连接的 TLS 信任选项判据（RFC-450 自 services/codeHost/connections 原样迁入）。
// 连接服务保存时、Bun fetch 的 TLS 片段与「测试连接」用例共用这一份。

import type { CodeHostProvider } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

/**
 * TLS 信任策略的唯一 provider 判据。GitHub 当前没有该能力；静默接受 false
 * 会制造“保存成功但实际仍校验”的假配置，因此在服务边界明确拒绝。
 */
export function normalizeCodeHostRejectUnauthorized(
  provider: CodeHostProvider,
  value: boolean | undefined,
): boolean {
  if (provider !== 'gitlab' && value === false) {
    throw new ValidationError(
      'code-host-tls-option-unsupported',
      'disabling TLS certificate verification is supported only for GitLab connections',
      { provider },
    )
  }
  return provider === 'gitlab' ? (value ?? true) : true
}

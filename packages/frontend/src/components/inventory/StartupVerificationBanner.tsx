// RFC-280 T3 — 节点启动验证告警：平台声明注入了什么 × runtime 启动清单实际
// 报告了什么。任何缺口（MCP 未连接 / skill·subagent·tool 未加载 / disabled
// 引用 / 参数被丢弃 / 无法观测）都在这里持久可见——终结「agent 口头说找不到
// MCP、节点却显示成功」的静默降级（两起 2026-08 生产故障的教训）。
// 不改变节点成败；仅呈现。

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  startupVerificationHasFindings,
  type StartupVerificationResponse,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { NoticeBanner } from '@/components/NoticeBanner'

interface Props {
  taskId: string
  nodeRunId: string
  enabled: boolean
}

export function StartupVerificationBanner({ taskId, nodeRunId, enabled }: Props) {
  const { t } = useTranslation()
  const query = useQuery<StartupVerificationResponse>({
    queryKey: ['tasks', taskId, 'node-runs', nodeRunId, 'startup-verification'],
    enabled,
    queryFn: ({ signal }) =>
      api.get<StartupVerificationResponse>(
        `/api/tasks/${encodeURIComponent(taskId)}/node-runs/${encodeURIComponent(nodeRunId)}/startup-verification`,
        undefined,
        signal,
      ),
  })
  const data = query.data
  if (!enabled || data === undefined || !data.available) return null
  const { record } = data
  if (!startupVerificationHasFindings(record)) return null

  const v = record.verification
  const lines: Array<{ key: string; text: string }> = []
  if (v.mcpUnusable.length > 0) {
    lines.push({
      key: 'mcp',
      text: t('nodeDrawer.startupVerification.mcpUnusable', {
        items: v.mcpUnusable
          .map((s) => (s.hint ? `${s.name}（${s.status}: ${s.hint}）` : `${s.name}（${s.status}）`))
          .join('、'),
      }),
    })
  }
  if (v.skillsMissing.length > 0) {
    lines.push({
      key: 'skills',
      text: t('nodeDrawer.startupVerification.skillsMissing', {
        items: v.skillsMissing.join('、'),
      }),
    })
  }
  if (v.subagentsMissing.length > 0) {
    lines.push({
      key: 'subagents',
      text: t('nodeDrawer.startupVerification.subagentsMissing', {
        items: v.subagentsMissing.join('、'),
      }),
    })
  }
  if (v.toolsMissing.length > 0) {
    lines.push({
      key: 'tools',
      text: t('nodeDrawer.startupVerification.toolsMissing', { items: v.toolsMissing.join('、') }),
    })
  }
  if (record.declared.skippedDisabledMcps.length > 0) {
    lines.push({
      key: 'disabled',
      text: t('nodeDrawer.startupVerification.skippedDisabled', {
        items: record.declared.skippedDisabledMcps.join('、'),
      }),
    })
  }
  if (record.declared.droppedParams.length > 0) {
    lines.push({
      key: 'dropped',
      text: t('nodeDrawer.startupVerification.droppedParams', {
        items: record.declared.droppedParams.join('、'),
      }),
    })
  }
  if (record.declared.unsupported.length > 0) {
    lines.push({
      key: 'unsupported',
      text: t('nodeDrawer.startupVerification.unsupported', {
        items: record.declared.unsupported.join('、'),
      }),
    })
  }
  if (record.declared.unobservable.length > 0) {
    lines.push({
      key: 'unobservable',
      text: t('nodeDrawer.startupVerification.unobservable', {
        items: record.declared.unobservable.join('、'),
      }),
    })
  }
  if (record.outputTailTruncated === true) {
    lines.push({
      key: 'output-tail',
      text: t('nodeDrawer.startupVerification.outputTailTruncated'),
    })
  }
  if (v.observation !== 'verified') {
    lines.push({
      key: 'observation',
      text: t(
        v.observation === 'malformed'
          ? 'nodeDrawer.startupVerification.malformed'
          : 'nodeDrawer.startupVerification.unavailable',
        { reason: v.observationReason ?? '' },
      ),
    })
  }
  if (lines.length === 0) return null

  // 未连接的 MCP / 缺失面 = error（能力真丢了）；其余(声明性提示) = warning。
  const tone =
    v.mcpUnusable.length > 0 ||
    v.skillsMissing.length > 0 ||
    v.subagentsMissing.length > 0 ||
    v.toolsMissing.length > 0
      ? ('error' as const)
      : ('warning' as const)

  return (
    <NoticeBanner
      tone={tone}
      size="compact"
      title={t('nodeDrawer.startupVerification.title')}
      testid="startup-verification-banner"
    >
      {lines.map((line) => (
        <div key={line.key}>{line.text}</div>
      ))}
    </NoticeBanner>
  )
}

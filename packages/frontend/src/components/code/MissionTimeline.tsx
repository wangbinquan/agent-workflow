// RFC-310 PR-8 T91 —— Mission 时间线：decision trace + platform effects 按时间
// 倒序合并成一条可读叙事。每条 decision 摘要给 selected kind（block 附 reason、
// wait 附 reason），可展开完整 guard/rule trace（canonical JSON 原样示人——
// 可回放性是产品语义，不是调试残留）；effect 给 kind/state/结算时间。数据是
// 只读投影，组件不发写请求。

import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { StatusChip } from '@/components/StatusChip'

export interface TimelineDecision {
  id: string
  missionRevision: number
  policyId: string | null
  policyRevision: number | null
  factDigest: string
  guardTrace: unknown
  ruleTrace: unknown
  selected: unknown
  decidedAt: number
}

export interface TimelineEffect {
  id: string
  effectKind: string
  state: string
  createdAt: number
  settledAt: number | null
}

type TimelineEntry =
  | { kind: 'decision'; at: number; decision: TimelineDecision }
  | { kind: 'effect'; at: number; effect: TimelineEffect }

function selectedSummary(selected: unknown): string {
  if (selected === null || typeof selected !== 'object') return String(selected)
  const s = selected as { kind?: unknown; reason?: unknown; capabilityId?: unknown }
  const kind = typeof s.kind === 'string' ? s.kind : 'unknown'
  if (typeof s.reason === 'string') return `${kind}: ${s.reason}`
  if (typeof s.capabilityId === 'string') return `${kind}: ${s.capabilityId}`
  return kind
}

function effectChipKind(state: string): 'success' | 'danger' | 'info' {
  if (state === 'confirmed') return 'success'
  if (state === 'failed' || state === 'invalidated') return 'danger'
  return 'info'
}

export function MissionTimeline(props: {
  decisions: readonly TimelineDecision[]
  effects: readonly TimelineEffect[]
}): ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)

  const entries: TimelineEntry[] = [
    ...props.decisions.map(
      (decision): TimelineEntry => ({ kind: 'decision', at: decision.decidedAt, decision }),
    ),
    ...props.effects.map(
      (effect): TimelineEntry => ({ kind: 'effect', at: effect.createdAt, effect }),
    ),
  ].sort((a, b) => b.at - a.at)

  if (entries.length === 0) {
    return <p data-testid="mission-timeline-empty">{t('code.missions.timelineEmpty')}</p>
  }

  return (
    <ol className="mission-timeline" data-testid="mission-timeline">
      {entries.map((entry) =>
        entry.kind === 'decision' ? (
          <li key={`d-${entry.decision.id}`} className="mission-timeline__item">
            <div className="mission-timeline__row">
              <StatusChip size="sm" kind="neutral">
                {t('code.missions.timelineDecision')}
              </StatusChip>
              <span className="mission-timeline__summary">
                {selectedSummary(entry.decision.selected)}
              </span>
              <span className="mission-timeline__time">{new Date(entry.at).toLocaleString()}</span>
              <button
                type="button"
                className="btn btn--xs"
                onClick={() =>
                  setExpanded((prev) => (prev === entry.decision.id ? null : entry.decision.id))
                }
                data-testid={`timeline-expand-${entry.decision.id}`}
              >
                {expanded === entry.decision.id
                  ? t('code.missions.timelineCollapse')
                  : t('code.missions.timelineExpand')}
              </button>
            </div>
            {expanded === entry.decision.id ? (
              <pre className="mission-timeline__trace" data-testid="timeline-trace">
                {JSON.stringify(
                  {
                    selected: entry.decision.selected,
                    guardTrace: entry.decision.guardTrace,
                    ruleTrace: entry.decision.ruleTrace,
                    factDigest: entry.decision.factDigest,
                    policy:
                      entry.decision.policyId === null
                        ? null
                        : `${entry.decision.policyId}@${entry.decision.policyRevision}`,
                  },
                  null,
                  2,
                )}
              </pre>
            ) : null}
          </li>
        ) : (
          <li key={`e-${entry.effect.id}`} className="mission-timeline__item">
            <div className="mission-timeline__row">
              <StatusChip size="sm" kind={effectChipKind(entry.effect.state)}>
                {t('code.missions.timelineEffect')}
              </StatusChip>
              <span className="mission-timeline__summary">
                {entry.effect.effectKind} · {entry.effect.state}
              </span>
              <span className="mission-timeline__time">{new Date(entry.at).toLocaleString()}</span>
            </div>
          </li>
        ),
      )}
    </ol>
  )
}

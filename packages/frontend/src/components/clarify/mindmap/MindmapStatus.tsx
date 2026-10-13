import { useTranslation } from 'react-i18next'
import type { MindmapNodeStatus, MindmapStatusCounts } from '@/lib/clarify/mindmap/projection'

const symbols: Record<MindmapNodeStatus, string> = {
  done: '✓',
  needs_detail: '◇',
  needs_confirmation: '□',
}
export function MindmapStatus({
  status,
  count,
  compact = false,
}: {
  status: MindmapNodeStatus
  count?: number
  compact?: boolean
}) {
  const { t } = useTranslation()
  const label = t(`mindmap.status.${status}`)
  if (compact)
    return (
      <span
        className={`mindmap-status mindmap-status--${status} mindmap-status--compact`}
        title={label}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="8" cy="8" r="5.75" />
          {status === 'done' && (
            <path d="m5 8 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {status === 'needs_confirmation' && (
            <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
          )}
        </svg>
        <span className="sr-only">{label}</span>
        {count === undefined ? null : count}
      </span>
    )
  return (
    <span className={`mindmap-status mindmap-status--${status}`}>
      <span aria-hidden="true">{symbols[status]}</span> {label}
      {count === undefined ? '' : ` ${count}`}
    </span>
  )
}
export function MindmapCounts({ counts }: { counts: MindmapStatusCounts }) {
  return (
    <span className="mindmap-counts">
      {(Object.keys(symbols) as MindmapNodeStatus[])
        .filter((key) => counts[key] > 0)
        .map((key) => (
          <MindmapStatus key={key} status={key} count={counts[key]} />
        ))}
    </span>
  )
}

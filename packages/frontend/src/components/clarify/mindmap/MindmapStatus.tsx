import { useTranslation } from 'react-i18next'
import type { MindmapNodeStatus, MindmapStatusCounts } from '@/lib/clarify/mindmap/projection'

const symbols: Record<MindmapNodeStatus, string> = {
  done: '✓',
  needs_detail: '◇',
  needs_confirmation: '□',
}
export function MindmapStatus({ status, count }: { status: MindmapNodeStatus; count?: number }) {
  const { t } = useTranslation()
  return (
    <span className={`mindmap-status mindmap-status--${status}`}>
      <span aria-hidden="true">{symbols[status]}</span> {t(`mindmap.status.${status}`)}
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

// RFC-182 D1 — persistent turn card (message-turn / leader-round): live while
// running (pulse + ticking duration), settles IN PLACE at a terminal state
// (status + total duration + view-session) — it never vanishes from the
// stream. Assignment turns keep their DispatchCard (D4, no double card).
// (RFC-217 T10: extracted from WorkgroupRoom.tsx; status/duration line via the
// shared RunStatusRow.)

import { useTranslation } from 'react-i18next'
import type { NodeRun, WorkgroupRunEntry } from '@agent-workflow/shared'
import { RunStatusRow } from '@/components/workgroup/room/RunStatusRow'
import { formatTurnDuration, turnDurationMs } from '@/lib/workgroup-room'

export interface TurnCardProps {
  entry: WorkgroupRunEntry
  runs: readonly NodeRun[]
  now: number
  onViewRun: (nodeRunId: string) => void
}

export function TurnCard({ entry, runs, now, onViewRun }: TurnCardProps) {
  const { t } = useTranslation()
  // Status truth prefers the live node-run row (same source the drawer uses);
  // the history entry's snapshot is the fallback for the refetch gap.
  const live = runs.find((r) => r.id === entry.nodeRunId)
  const dur = turnDurationMs(entry, now)
  return (
    <div
      className="workgroup-room__card workgroup-room__card--turn"
      data-testid={`wg-turn-${entry.nodeRunId}`}
    >
      <div className="workgroup-room__card-head">
        <strong>
          {entry.displayName !== null
            ? `@${entry.displayName}`
            : t('workgroups.room.removedMember')}
        </strong>
        <RunStatusRow
          entry={entry}
          live={live}
          statusTestId={`wg-turn-status-${entry.nodeRunId}`}
          noteTestId={`wg-turn-note-${entry.nodeRunId}`}
        />
        <span className="workgroup-room__time">{dur === null ? '—' : formatTurnDuration(dur)}</span>
      </div>
      <div className="workgroup-room__card-actions">
        <button
          type="button"
          className="btn btn--xs"
          onClick={() => onViewRun(entry.nodeRunId)}
          data-testid={`wg-turn-view-${entry.nodeRunId}`}
        >
          {t('workgroups.room.viewRun')}
        </button>
      </div>
    </div>
  )
}

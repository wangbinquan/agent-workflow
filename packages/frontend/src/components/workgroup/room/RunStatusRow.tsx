// RFC-217 T10 — the shared "member run" status line: name + turn-kind chip +
// live status chip + ticking duration. Was implemented three times (the
// right-rail run log rows, TurnCard's head, and a near-copy in the dispatch
// card); the run log and TurnCard now render THIS row, so the live-status
// preference rule ("prefer the live node-run row, fall back to the history
// snapshot for the refetch gap") exists exactly once.

import { useTranslation } from 'react-i18next'
import type { NodeRun, WorkgroupRunEntry } from '@agent-workflow/shared'
import { StatusChip } from '@/components/StatusChip'
import {
  displayNoderunStatusKey,
  nodeRunStatusToKind,
  statusKeyForRawStatus,
} from '@/lib/noderun-status'
import type { NodeRunStatus } from '@agent-workflow/shared'

export function turnKindLabel(
  t: ReturnType<typeof useTranslation>['t'],
  kind: WorkgroupRunEntry['kind'],
): string {
  if (kind === 'leader-round') return t('workgroups.room.turnKindLeader')
  if (kind === 'assignment') return t('workgroups.room.turnKindAssignment')
  return t('workgroups.room.turnKindMessage')
}

export interface RunStatusRowProps {
  entry: WorkgroupRunEntry
  /** Live node-run row when the page query has it (status truth). */
  live: NodeRun | undefined
  /** Chip testid; omitted → no testid on the status chip. */
  statusTestId?: string
  /** Note chip testid prefix (TurnCard's clarify-suppressed note). */
  noteTestId?: string
}

/** Inline fragment: [kind chip][status chip][(note chip)]. The NAME and the
 *  DURATION stay caller-rendered (the run log's grid puts duration on the
 *  first line next to the name; TurnCard puts it after the chips) — layout
 *  differs, the live-status preference rule here is what must not fork. */
export function RunStatusRow({ entry, live, statusTestId, noteTestId }: RunStatusRowProps) {
  const { t } = useTranslation()
  const status = live?.status ?? entry.status
  return (
    <>
      <span className="chip chip--tight">{turnKindLabel(t, entry.kind)}</span>
      <StatusChip
        kind={live !== undefined ? nodeRunStatusToKind(live.status) : 'neutral'}
        size="sm"
        withDot={status === 'running'}
        {...(statusTestId !== undefined ? { 'data-testid': statusTestId } : {})}
      >
        {/* RFC-217 T11 i18n 缺口修复：refetch 间隙的 history 快照状态也走
            noderunStatus.* 键，不再裸出机器串。 */}
        {live !== undefined
          ? t(displayNoderunStatusKey(live))
          : t(statusKeyForRawStatus(status as NodeRunStatus))}
      </StatusChip>
      {entry.note === 'clarify-suppressed' && noteTestId !== undefined && (
        <StatusChip kind="warn" size="sm" data-testid={noteTestId}>
          {t('workgroups.room.clarifySuppressedNote')}
        </StatusChip>
      )}
    </>
  )
}

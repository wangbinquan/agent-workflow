// Tiny status pill used in task list rows + detail header. Internally renders
// the unified <StatusChip>; the TaskStatus → kind map lives in
// lib/task-status.ts so the homepage task-row picks up the exact same map.

import { useTranslation } from 'react-i18next'
import type { TaskStatus } from '@agent-workflow/shared'
import { StatusChip } from './StatusChip'
import { TASK_STATUS_KIND } from '@/lib/task-status'

/** RFC-192: `pulse` adds the live-activity dot (running rows on /tasks) —
 *  maps onto StatusChip's existing withDot + a `--pulse` animation class;
 *  `prefers-reduced-motion` freezes it (styles.css). */
export function TaskStatusChip({ status, pulse }: { status: TaskStatus; pulse?: boolean }) {
  const { t } = useTranslation()
  return (
    <StatusChip
      kind={TASK_STATUS_KIND[status]}
      withDot={pulse === true}
      className={pulse === true ? 'status-chip--pulse' : undefined}
    >
      {t(`tasks.status.${status}`)}
    </StatusChip>
  )
}

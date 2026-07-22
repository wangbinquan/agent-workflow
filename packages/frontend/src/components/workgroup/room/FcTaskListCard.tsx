// PR-5 fc 观测面 — the shared task list, three groups (open / in-flight /
// done). Open rows keep their cancel affordance (same CAS as the cards).
// (RFC-217 T10: extracted from WorkgroupRoom.tsx.)

import { useTranslation } from 'react-i18next'
import type { WorkgroupRuntimeMember } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { ConfirmButton } from '@/components/ConfirmButton'
import { groupFcAssignments, type WorkgroupRoomAssignment } from '@/lib/workgroup-room'

export interface FcTaskListCardProps {
  assignments: WorkgroupRoomAssignment[]
  members: Map<string, WorkgroupRuntimeMember>
  canceling: boolean
  onCancel: (assignmentId: string) => Promise<unknown>
}

export function FcTaskListCard({ assignments, members, canceling, onCancel }: FcTaskListCardProps) {
  const { t } = useTranslation()
  const groups = groupFcAssignments(assignments)
  // RFC-215 — 同批徽记：批量认领后多张卡共享一个 run（nodeRunId），按 run 分组
  // 计数,>1 的卡行挂「同批 ×N」chip,让"这几张是一个成员一次跑掉的"可见。
  const batchSizeByRun = new Map<string, number>()
  for (const a of assignments) {
    if (a.nodeRunId === null) continue
    batchSizeByRun.set(a.nodeRunId, (batchSizeByRun.get(a.nodeRunId) ?? 0) + 1)
  }
  const sections = [
    { key: 'open', label: t('workgroups.room.fcOpen'), rows: groups.open },
    { key: 'active', label: t('workgroups.room.fcActive'), rows: groups.active },
    { key: 'done', label: t('workgroups.room.fcDone'), rows: groups.done },
  ] as const
  return (
    <Card
      header={<h3 className="workgroup-room__side-title">{t('workgroups.room.fcListTitle')}</h3>}
      data-testid="workgroup-room-fc-list"
    >
      {assignments.length === 0 && (
        <p className="form-field__hint">{t('workgroups.room.fcEmpty')}</p>
      )}
      {sections.map((s) => (
        <div key={s.key} className="workgroup-room__fc-group" data-testid={`wg-fc-group-${s.key}`}>
          <div className="workgroup-room__fc-group-head">
            <span>{s.label}</span>
            <span className="chip chip--tight" data-testid={`wg-fc-count-${s.key}`}>
              {s.rows.length}
            </span>
          </div>
          <ul className="workgroup-room__fc-rows">
            {s.rows.map((a) => {
              const assignee =
                a.assigneeMemberId === null ? undefined : members.get(a.assigneeMemberId)
              return (
                <li key={a.id} data-testid={`wg-fc-row-${a.id}`}>
                  <span className="workgroup-room__fc-title" title={a.title}>
                    {a.title}
                  </span>
                  {assignee !== undefined && <span className="muted">@{assignee.displayName}</span>}
                  {a.nodeRunId !== null && (batchSizeByRun.get(a.nodeRunId) ?? 0) > 1 && (
                    <span className="chip chip--tight" data-testid={`wg-fc-batch-${a.id}`}>
                      {t('workgroups.room.fcBatch', {
                        count: batchSizeByRun.get(a.nodeRunId) ?? 0,
                      })}
                    </span>
                  )}
                  {a.status === 'open' && (
                    <ConfirmButton
                      label={t('workgroups.room.cancelCard')}
                      onConfirm={() => onCancel(a.id)}
                      variant="danger"
                      size="sm"
                      disabled={canceling}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </Card>
  )
}

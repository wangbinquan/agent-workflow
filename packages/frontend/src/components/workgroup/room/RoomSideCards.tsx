// RFC-217 T10 — the room's right rail: roster / run log / pause-reason /
// completion gate / fc task list / group info. Extracted from
// WorkgroupRoom.tsx; memoized so composer keystrokes never re-render the rail.
// The run-log rows render the shared RunStatusRow (one live-status rule).

import { memo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { NodeRun } from '@agent-workflow/shared'
import { resolveWorkgroupSwitches } from '@agent-workflow/shared'
import type { WorkgroupRuntimeMember } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { ClampedText } from '@/components/ClampedText'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { StatusChip } from '@/components/StatusChip'
import { FcTaskListCard } from '@/components/workgroup/room/FcTaskListCard'
import { RunStatusRow } from '@/components/workgroup/room/RunStatusRow'
import {
  countMemberActiveRuns,
  deriveMemberPresence,
  formatTurnDuration,
  pauseReasonCopyKey,
  turnDurationMs,
  type WorkgroupMemberPresence,
  type WorkgroupRoomResponse,
} from '@/lib/workgroup-room'

export interface RoomSideCardsProps {
  data: WorkgroupRoomResponse
  members: Map<string, WorkgroupRuntimeMember>
  runs: readonly NodeRun[]
  now: number
  canPost: boolean
  onViewRun: (nodeRunId: string) => void
  canceling: boolean
  onCancel: (assignmentId: string) => Promise<unknown>
  gate: {
    pending: boolean
    error: unknown
    onApprove: () => void
    onRejectOpen: () => void
  }
  resumeClarify: {
    pending: boolean
    onResume: (stop: { nodeId: string; askerKey: string }) => void
  }
  onConfigOpen: () => void
}

function RoomSideCardsInner({
  data,
  members,
  runs,
  now,
  canPost,
  onViewRun,
  canceling,
  onCancel,
  gate,
  resumeClarify,
  onConfigOpen,
}: RoomSideCardsProps) {
  const { t } = useTranslation()
  // RFC-217 T10 re-render isolation probe (see RoomTimeline).
  const renderCount = useRef(0)
  renderCount.current += 1
  return (
    <aside className="workgroup-room__side" data-render-count={renderCount.current}>
      <Card
        header={<h3 className="workgroup-room__side-title">{t('workgroups.room.membersTitle')}</h3>}
        data-testid="workgroup-room-members"
      >
        <ul className="workgroup-room__members">
          {data.config.members.map((m) => {
            // RFC-179 — click a member (leader included, as a peer) to open its
            // current session run in the right-hand drawer; null → not clickable.
            const currentRun = data.memberRuns[m.id] ?? null
            // RFC-182 D5 — four-state presence off the SAME data the pills
            // read (currentRun first, assignments as fallback). The chip
            // itself is clickable into the session (D9).
            const presence = deriveMemberPresence(m.id, data.assignments, currentRun)
            // RFC-185 — fan-out scale: single-value presence hides N
            // concurrent instances; show ×N (≥2 only). Assignments join the
            // count so merge-back-pending instances stay visible.
            const activeRuns = countMemberActiveRuns(data.runHistory, data.assignments, m.id)
            const presenceKind: Record<
              WorkgroupMemberPresence,
              'success' | 'warn' | 'info' | 'neutral'
            > = { working: 'success', awaiting: 'warn', queued: 'info', idle: 'neutral' }
            const presenceLabel: Record<WorkgroupMemberPresence, string> = {
              working: t('workgroups.room.working'),
              awaiting: t('workgroups.room.presenceAwaiting'),
              queued: t('workgroups.room.presenceQueued'),
              idle: t('workgroups.room.idle'),
            }
            return (
              <li key={m.id} data-testid={`wg-member-${m.displayName}`}>
                {currentRun !== null ? (
                  <button
                    type="button"
                    className="workgroup-room__member-name workgroup-room__member-open"
                    onClick={() => onViewRun(currentRun.nodeRunId)}
                    aria-label={t('workgroups.room.openMemberSession', {
                      name: m.displayName,
                    })}
                    data-testid={`wg-member-open-session-${m.displayName}`}
                  >
                    @{m.displayName}
                  </button>
                ) : (
                  <span className="workgroup-room__member-name">@{m.displayName}</span>
                )}
                {m.id === data.config.leaderMemberId && (
                  <StatusChip kind="info" size="sm">
                    {t('workgroups.leaderBadge')}
                  </StatusChip>
                )}
                <span className="chip chip--tight">
                  {m.memberType === 'agent'
                    ? t('workgroups.memberTypeAgent')
                    : t('workgroups.memberTypeHuman')}
                </span>
                <StatusChip
                  kind={presenceKind[presence]}
                  size="sm"
                  withDot={presence === 'working'}
                  data-testid={`wg-member-state-${m.displayName}`}
                  {...(currentRun !== null
                    ? { onClick: () => onViewRun(currentRun.nodeRunId) }
                    : {})}
                >
                  {presenceLabel[presence]}
                </StatusChip>
                {activeRuns >= 2 && (
                  <span
                    className="chip chip--tight"
                    data-testid={`wg-member-active-runs-${m.displayName}`}
                  >
                    {t('workgroups.room.activeRunsBadge', { count: activeRuns })}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </Card>

      <Card
        header={
          <h3 className="workgroup-room__side-title">
            {t('workgroups.room.runLogTitle', { count: data.runHistory.length })}
          </h3>
        }
        data-testid="workgroup-room-runlog"
      >
        {data.runHistory.length === 0 ? (
          <EmptyState
            size="compact"
            title={t('workgroups.room.runLogEmpty')}
            data-testid="wg-runlog-empty"
          />
        ) : (
          <ul className="workgroup-room__runlog">
            {[...data.runHistory].reverse().map((e) => {
              const live = runs.find((r) => r.id === e.nodeRunId)
              const dur = turnDurationMs(e, now)
              const name =
                e.displayName !== null ? `@${e.displayName}` : t('workgroups.room.removedMember')
              return (
                <li key={e.nodeRunId}>
                  {/* Two grid lines — identity then state. The rail is far
                      too narrow (220–280px) for one line to hold all four
                      fields; see the .workgroup-room__runlog-row comment in
                      styles.css for what the single-line version did to the
                      chips. */}
                  <button
                    type="button"
                    className="workgroup-room__runlog-row"
                    onClick={() => onViewRun(e.nodeRunId)}
                    data-testid={`wg-runlog-${e.nodeRunId}`}
                  >
                    <span
                      className="workgroup-room__member-name"
                      // The name is the only cell allowed to truncate, so it
                      // is also the only one that needs the full value back.
                      title={name}
                    >
                      {name}
                    </span>
                    <span className="workgroup-room__time">
                      {dur === null ? '—' : formatTurnDuration(dur)}
                    </span>
                    <span className="workgroup-room__runlog-meta">
                      <RunStatusRow entry={e} live={live} />
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* 2026-07-21 —— awaiting_human 成因说明：此前所有 awaiting_human 都被
          任务徽章渲染成「等待回答」，max-rounds wrap-up 停机被误读成有问题要答。
          徽章文案已中性化（等待人工），这里在认识成因时给精确说明与处置提示。 */}
      {data.taskStatus === 'awaiting_human' &&
        pauseReasonCopyKey(data.pauseReason ?? null) !== null && (
          <Card
            header={
              <h3 className="workgroup-room__side-title">{t('workgroups.room.pauseTitle')}</h3>
            }
            data-testid="workgroup-room-pause-reason"
          >
            <p className="workgroup-room__gate-state">
              {t(pauseReasonCopyKey(data.pauseReason ?? null) as string)}
            </p>
          </Card>
        )}

      {data.gate.awaitingConfirmation && (
        <Card
          header={<h3 className="workgroup-room__side-title">{t('workgroups.room.gateTitle')}</h3>}
          data-testid="workgroup-room-gate"
          footer={
            <div className="workgroup-room__card-actions">
              {/* PR-5: the gate is live — approve fires directly, reject
                  requires a comment (dialog owned by the shell). */}
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={gate.pending}
                onClick={gate.onApprove}
                data-testid="workgroup-room-gate-confirm"
              >
                {gate.pending ? t('common.saving') : t('workgroups.room.gateConfirm')}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                disabled={gate.pending}
                onClick={gate.onRejectOpen}
                data-testid="workgroup-room-gate-reject"
              >
                {t('workgroups.room.gateReject')}
              </button>
            </div>
          }
        >
          <p className="workgroup-room__gate-state">{t('workgroups.room.gateAwaiting')}</p>
          {data.gate.summary !== null && data.gate.summary !== '' && (
            <div className="workgroup-room__body">{data.gate.summary}</div>
          )}
          {gate.error !== null && gate.error !== undefined && (
            <ErrorBanner error={gate.error} testid="workgroup-room-gate-error" />
          )}
        </Card>
      )}

      {/* PR-5 fc 观测面 — the shared task list, grouped open / active / done. */}
      {data.config.mode === 'free_collab' && (
        <FcTaskListCard
          assignments={data.assignments}
          members={members}
          canceling={canceling}
          onCancel={onCancel}
        />
      )}

      <Card
        header={<h3 className="workgroup-room__side-title">{t('workgroups.room.infoTitle')}</h3>}
        data-testid="workgroup-room-info"
        footer={
          // PR-5: mid-run config edits (switches / rounds / gate / members)
          // — only while the task can still change course.
          canPost ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={onConfigOpen}
              data-testid="workgroup-room-config-btn"
            >
              {t('workgroups.room.configButton')}
            </button>
          ) : undefined
        }
      >
        {/* RFC-207 — askers a human silenced. Stopping ask-back is reversible;
            ordinary tasks un-stop from the canvas toggle, which a workgroup has
            no equivalent of, so without this row a stop would be permanent. */}
        {(data.clarifyStops ?? []).length > 0 && (
          <div className="workgroup-room__clarify-stops" data-testid="workgroup-room-clarify-stops">
            {(data.clarifyStops ?? []).map((stop) => (
              <span key={`${stop.nodeId}:${stop.askerKey}`} className="chip chip--tight">
                {t('workgroups.room.clarifyStopped', { asker: stop.askerKey })}
                <button
                  type="button"
                  className="btn btn--xs"
                  data-testid={`workgroup-room-clarify-resume-${stop.askerKey}`}
                  onClick={() => resumeClarify.onResume(stop)}
                  disabled={resumeClarify.pending}
                >
                  {t('workgroups.room.clarifyResume')}
                </button>
              </span>
            ))}
          </div>
        )}
        <dl className="workgroup-room__info">
          <dt>{t('workgroups.room.infoGoal')}</dt>
          <dd className="workgroup-room__goal">
            {/* Goals are free-form and routinely long; folding them keeps
                模式 / 最大轮数 / 协作开关 above the fold while leaving the
                whole text one click (and Ctrl-F) away. */}
            <ClampedText
              text={data.config.goal}
              data-testid="workgroup-room-goal"
              toggleTestId="workgroup-room-goal-toggle"
            />
          </dd>
          <dt>{t('workgroups.room.infoMode')}</dt>
          <dd>
            {data.config.mode === 'leader_worker'
              ? t('workgroups.modeLeaderWorker')
              : t('workgroups.modeFreeCollab')}
          </dd>
          {/* RFC-209 —— 自由协作的 max_rounds 计的是**成员 run 总数**，不是回合数；
              它不再以「第 X 回合」的形式出现在消息流里，就得在这里如实显示成预算
              进度，否则用户完全看不到任务什么时候会触顶。 */}
          {data.config.mode === 'free_collab' ? (
            <>
              <dt>{t('workgroups.room.infoMemberTurnBudget')}</dt>
              <dd data-testid="workgroup-room-turn-budget">
                {t('workgroups.room.memberTurnBudgetValue', {
                  used: data.budgetUsed,
                  max: data.config.maxRounds,
                })}
                {/* 复用 Field 的 hint 原语（font-size 12 + --muted），零新 CSS。 */}
                <div className="form-field__hint">{t('workgroups.room.memberTurnBudgetHint')}</div>
              </dd>
            </>
          ) : (
            <>
              <dt>{t('workgroups.room.infoMaxRounds')}</dt>
              <dd>{data.config.maxRounds}</dd>
            </>
          )}
          <dt>{t('workgroups.room.infoSwitches')}</dt>
          <dd>{switchesSummary(data.config.mode, data.config.switches, t)}</dd>
        </dl>
      </Card>
    </aside>
  )
}

/** memo: rail re-renders track room data + ticker, never composer keystrokes. */
export const RoomSideCards = memo(RoomSideCardsInner)

/** Effective switches (fc reads all-on) → localized "on" list, or an em dash. */
function switchesSummary(
  mode: WorkgroupRoomResponse['config']['mode'],
  stored: WorkgroupRoomResponse['config']['switches'],
  t: (key: string) => string,
): string {
  const resolved = resolveWorkgroupSwitches(mode, stored)
  const on: string[] = []
  if (resolved.shareOutputs) on.push(t('workgroups.fieldShareOutputs'))
  if (resolved.directMessages) on.push(t('workgroups.fieldDirectMessages'))
  if (resolved.blackboard) on.push(t('workgroups.fieldBlackboard'))
  return on.length > 0 ? on.join(' · ') : t('common.emDash')
}

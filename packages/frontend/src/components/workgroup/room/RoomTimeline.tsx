// RFC-217 T10 — the room's message log: round separators / persistent turn
// cards / message rows (with their attached dispatch + turn cards), plus the
// tail-follow scroll anchoring and the "back to latest" jump button.
// Extracted from WorkgroupRoom.tsx; memoized so composer keystrokes (state
// now local to RoomComposer) never re-render the log.

import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NodeRun, WorkgroupRunEntry, WorkgroupRuntimeMember } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { StatusChip } from '@/components/StatusChip'
import { DispatchCard } from '@/components/workgroup/room/DispatchCard'
import { TurnCard } from '@/components/workgroup/room/TurnCard'
import {
  assignmentsForMessage,
  formatRoomTimestamp,
  turnCardsForMessage,
  type RoomTimelineEntry,
  type WorkgroupDeliverInput,
  type WorkgroupRoomMessage,
  type WorkgroupRoomResponse,
} from '@/lib/workgroup-room'

export interface RoomTimelineProps {
  timeline: readonly RoomTimelineEntry[]
  runHistory: readonly WorkgroupRunEntry[]
  runIndex: ReadonlyMap<string, WorkgroupRunEntry>
  runs: readonly NodeRun[]
  now: number
  data: WorkgroupRoomResponse
  members: Map<string, WorkgroupRuntimeMember>
  executingPills: ReadonlyMap<string, readonly { displayName: string; nodeRunId: string }[]>
  resolveUser: (
    id: string | null | undefined,
  ) => { displayName: string; username: string } | undefined
  canceling: boolean
  onCancel: (assignmentId: string) => Promise<unknown>
  onViewRun: (nodeRunId: string) => void
  delivering: boolean
  onDeliver: (assignmentId: string, input: WorkgroupDeliverInput) => Promise<unknown>
}

function RoomTimelineInner({
  timeline,
  runHistory,
  runIndex,
  runs,
  now,
  data,
  members,
  executingPills,
  resolveUser,
  canceling,
  onCancel,
  onViewRun,
  delivering,
  onDeliver,
}: RoomTimelineProps) {
  const { t } = useTranslation()
  const logRef = useRef<HTMLDivElement | null>(null)
  // RFC-217 T10 re-render isolation probe: composer keystrokes must never
  // re-render the log (locked by rfc217-room-render-isolation.test.tsx).
  const renderCount = useRef(0)
  renderCount.current += 1

  // RFC-182 P1-1 — scroll anchoring: follow the tail only while the user IS at
  // the tail; scrolling up to read history must never be yanked back down.
  // Keyed on timeline + runHistory growth AND in-place card growth (a turn
  // flipping running→failed gains a note chip without changing any length),
  // so statuses+notes join the lengths (impl-gate P2).
  const [atBottom, setAtBottom] = useState(true)
  const followSig = `${timeline.length}:${runHistory
    .map((e) => `${e.status}${e.note ?? ''}`)
    .join(',')}`
  useEffect(() => {
    const el = logRef.current
    if (el !== null && atBottom) el.scrollTop = el.scrollHeight
  }, [followSig, atBottom])
  function onLogScroll(): void {
    const el = logRef.current
    if (el === null) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }

  return (
    <>
      <div
        className="workgroup-room__log"
        ref={logRef}
        onScroll={onLogScroll}
        data-testid="workgroup-room-log"
        data-render-count={renderCount.current}
      >
        {timeline.length === 0 && (
          <EmptyState
            size="compact"
            title={t('workgroups.room.empty')}
            data-testid="workgroup-room-empty"
          />
        )}
        {timeline.map((entry) =>
          entry.type === 'round' ? (
            <div
              key={`round-${entry.round}`}
              className="workgroup-room__round"
              role="separator"
              data-testid={`wg-round-${entry.round}`}
            >
              <span>{t('workgroups.room.roundDivider', { n: entry.round })}</span>
            </div>
          ) : entry.type === 'turn' ? (
            <TurnCard
              key={`turn-${entry.entry.nodeRunId}`}
              entry={entry.entry}
              runs={runs}
              now={now}
              onViewRun={onViewRun}
            />
          ) : (
            <RoomMessage
              key={entry.message.id}
              message={entry.message}
              executingPill={executingPills.get(entry.message.id)}
              runHistory={runHistory}
              runIndex={runIndex}
              runs={runs}
              now={now}
              data={data}
              members={members}
              resolveUser={resolveUser}
              canceling={canceling}
              onCancel={onCancel}
              onViewRun={onViewRun}
              delivering={delivering}
              onDeliver={onDeliver}
            />
          ),
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          className="btn btn--sm workgroup-room__jump"
          onClick={() => {
            const el = logRef.current
            if (el !== null) el.scrollTop = el.scrollHeight
            setAtBottom(true)
          }}
          data-testid="workgroup-room-jump-latest"
        >
          {t('workgroups.room.backToLatest')}
        </button>
      )}
    </>
  )
}

/** memo: the log re-renders on room data / ticker changes, never on composer
 *  keystrokes (RFC-217 T10 re-render isolation, locked by the vitest probe). */
export const RoomTimeline = memo(RoomTimelineInner)

// ---------------------------------------------------------------------------
// Message row (+ dispatch cards)
// ---------------------------------------------------------------------------

interface RoomMessageProps {
  message: WorkgroupRoomMessage
  /** RFC-179/182 — live message-turns this message woke (pill per member,
   *  clickable into the run's session — D9/G2). */
  executingPill?: readonly { displayName: string; nodeRunId: string }[]
  /** RFC-182 — full room history; message-turn cards attach under their
   *  trigger message (turnCardsForMessage). */
  runHistory: readonly WorkgroupRunEntry[]
  /** Memoized nodeRunId→entry index over runHistory (DispatchCard timer). */
  runIndex: ReadonlyMap<string, WorkgroupRunEntry>
  /** Live node-run rows (status truth for card chips) + room ticker. */
  runs: readonly NodeRun[]
  now: number
  data: WorkgroupRoomResponse
  members: Map<string, WorkgroupRuntimeMember>
  resolveUser: (
    id: string | null | undefined,
  ) => { displayName: string; username: string } | undefined
  canceling: boolean
  onCancel: (assignmentId: string) => Promise<unknown>
  onViewRun: (nodeRunId: string) => void
  delivering: boolean
  onDeliver: (assignmentId: string, input: WorkgroupDeliverInput) => Promise<unknown>
}

function RoomMessage({
  message,
  executingPill,
  runHistory,
  runIndex,
  runs,
  now,
  data,
  members,
  resolveUser,
  canceling,
  onCancel,
  onViewRun,
  delivering,
  onDeliver,
}: RoomMessageProps) {
  const { t } = useTranslation()
  const cards = assignmentsForMessage(message, data.assignments)
  // RFC-182 D1/D4 — persistent turn cards for the message-turns THIS message
  // woke (assignment turns keep their DispatchCard below; no double card).
  const turnCards = turnCardsForMessage(runHistory, message.id)
  const isSystem = message.authorKind === 'system'
  const member = message.authorMemberId === null ? undefined : members.get(message.authorMemberId)
  const isLeader =
    member !== undefined &&
    data.config.leaderMemberId !== null &&
    member.id === data.config.leaderMemberId

  let authorLabel: string
  if (isSystem) authorLabel = t('workgroups.room.authorSystem')
  else if (message.authorKind === 'member') authorLabel = `@${member?.displayName ?? '?'}`
  else {
    const u = resolveUser(message.authorUserId)
    authorLabel = u?.displayName ?? u?.username ?? message.authorUserId ?? '?'
  }

  // Speaker-role chat bubble — every non-system message renders as a bubble
  // whose color identifies who is talking: leader (accent) / agent member
  // (neutral) / human (success, right-aligned). System rows keep the muted
  // full-width meta-line look. The PR-6 decision accent layers ON TOP of the
  // role bubble (leader's convergence summary must still stand out).
  const role = isSystem
    ? 'system'
    : message.authorKind === 'human'
      ? 'human'
      : isLeader
        ? 'leader'
        : 'agent'
  const modifier =
    ` workgroup-room__msg--${role}` +
    (!isSystem && message.kind === 'decision' ? ' workgroup-room__msg--decision' : '')

  return (
    <div className={`workgroup-room__msg${modifier}`} data-testid={`wg-msg-${message.id}`}>
      <div className="workgroup-room__msg-head">
        <span className="workgroup-room__author">{authorLabel}</span>
        {executingPill !== undefined &&
          executingPill.map((p) => (
            <StatusChip
              key={p.nodeRunId}
              kind="info"
              size="sm"
              withDot
              data-testid={`wg-msg-executing-${message.id}`}
              aria-label={t('workgroups.room.openMemberSession', { name: p.displayName })}
              onClick={() => onViewRun(p.nodeRunId)}
            >
              {t('workgroups.room.executing')}
            </StatusChip>
          ))}
        {isLeader && (
          <StatusChip kind="info" size="sm" data-testid={`wg-msg-leader-${message.id}`}>
            {t('workgroups.leaderBadge')}
          </StatusChip>
        )}
        {message.authorKind === 'human' && (
          <span className="chip chip--tight">{t('workgroups.memberTypeHuman')}</span>
        )}
        <span className="workgroup-room__time">{formatRoomTimestamp(message.createdAt, now)}</span>
      </div>
      <div className="workgroup-room__body">{message.bodyMd}</div>
      {cards.length > 0 && (
        <div className="workgroup-room__cards">
          {cards.map((a) => (
            <DispatchCard
              key={a.id}
              assignment={a}
              data={data}
              members={members}
              runIndex={runIndex}
              now={now}
              canceling={canceling}
              onCancel={onCancel}
              onViewRun={onViewRun}
              delivering={delivering}
              onDeliver={onDeliver}
            />
          ))}
        </div>
      )}
      {turnCards.length > 0 && (
        <div className="workgroup-room__cards">
          {turnCards.map((e) => (
            <TurnCard key={e.nodeRunId} entry={e} runs={runs} now={now} onViewRun={onViewRun} />
          ))}
        </div>
      )}
    </div>
  )
}

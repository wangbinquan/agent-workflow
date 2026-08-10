// RFC-217 T10 — the room's message log: round separators / persistent turn
// cards / message rows (with their attached dispatch + turn cards), plus the
// tail-follow scroll anchoring and the "back to latest" jump button.
// Extracted from WorkgroupRoom.tsx; memoized so composer keystrokes (state
// now local to RoomComposer) never re-render the log.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NodeRun, WorkgroupRunEntry, WorkgroupRuntimeMember } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { MessageReference } from '@/components/MessageReference'
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
import { resolveWorkgroupMessageBody } from '@/lib/workgroup-system-message'

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

type ResolveUser = RoomTimelineProps['resolveUser']

function messageAuthorLabel(
  message: WorkgroupRoomMessage,
  members: ReadonlyMap<string, WorkgroupRuntimeMember>,
  resolveUser: ResolveUser,
  systemLabel: string,
): string {
  if (message.authorKind === 'system') return systemLabel
  if (message.authorKind === 'member') {
    const member = message.authorMemberId === null ? undefined : members.get(message.authorMemberId)
    return `@${member?.displayName ?? '?'}`
  }
  const user = resolveUser(message.authorUserId)
  return user?.displayName ?? user?.username ?? message.authorUserId ?? '?'
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
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>())
  const highlightTimerRef = useRef<number | null>(null)
  const quoteScrollTimerRef = useRef<number | null>(null)
  const quoteScrollTargetRef = useRef<number | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const messageById = useMemo(
    () => new Map(data.messages.map((message) => [message.id, message])),
    [data.messages],
  )
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
    if (el === null || !atBottom) return

    // A native smooth quote jump can deliver one last compositor scroll sample
    // after "back to latest" has synchronously taken the tail back. Reconcile
    // for two paint frames so that stale sample cannot leave the newest message
    // clipped just below the viewport. The loop is deliberately bounded: normal
    // wheel/touch scrolling remains user-owned once these frames complete.
    el.scrollTop = el.scrollHeight
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
      secondFrame = window.requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [followSig, atBottom])
  function onLogScroll(): void {
    const el = logRef.current
    if (el === null) return
    if (quoteScrollTargetRef.current !== null) {
      setAtBottom(false)
      return
    }
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }
  const cancelQuoteScroll = useCallback((): void => {
    quoteScrollTargetRef.current = null
    if (quoteScrollTimerRef.current !== null) {
      window.clearTimeout(quoteScrollTimerRef.current)
      quoteScrollTimerRef.current = null
    }
  }, [])
  const registerMessageElement = useCallback((id: string, node: HTMLDivElement | null): void => {
    if (node === null) messageElementsRef.current.delete(id)
    else messageElementsRef.current.set(id, node)
  }, [])
  const jumpToMessage = useCallback(
    (id: string): void => {
      const target = messageElementsRef.current.get(id)
      const log = logRef.current
      if (target === undefined || log === null) return
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      const targetRect = target.getBoundingClientRect()
      const logRect = log.getBoundingClientRect()
      const centeredTop =
        log.scrollTop + targetRect.top - logRect.top - (log.clientHeight - targetRect.height) / 2
      const maxScrollTop = Math.max(0, log.scrollHeight - log.clientHeight)
      const targetScrollTop = Math.min(Math.max(0, centeredTop), maxScrollTop)
      setAtBottom(false)
      cancelQuoteScroll()
      quoteScrollTargetRef.current = targetScrollTop
      log.scrollTo({
        top: targetScrollTop,
        behavior: reducedMotion ? 'auto' : 'smooth',
      })
      quoteScrollTimerRef.current = window.setTimeout(cancelQuoteScroll, reducedMotion ? 0 : 1000)
      target.focus({ preventScroll: true })
      setHighlightedMessageId(id)
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedMessageId(null)
        highlightTimerRef.current = null
      }, 1600)
    },
    [cancelQuoteScroll],
  )
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current)
      if (quoteScrollTimerRef.current !== null) window.clearTimeout(quoteScrollTimerRef.current)
    },
    [],
  )

  return (
    <>
      <div
        className="workgroup-room__log"
        ref={logRef}
        onScroll={onLogScroll}
        onWheel={cancelQuoteScroll}
        onTouchStart={cancelQuoteScroll}
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
              referencedMessage={
                entry.message.triggerMessageId === null
                  ? null
                  : (messageById.get(entry.message.triggerMessageId) ?? null)
              }
              referenceUnavailable={
                entry.message.triggerMessageId !== null &&
                !messageById.has(entry.message.triggerMessageId)
              }
              highlighted={highlightedMessageId === entry.message.id}
              registerMessageElement={registerMessageElement}
              onJumpToMessage={jumpToMessage}
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
            cancelQuoteScroll()
            const el = logRef.current
            if (el !== null) {
              // Setting the current position with `auto` explicitly cancels the
              // in-flight native smooth scroll before the tail-follow effect
              // performs its bounded post-paint reconciliation.
              el.scrollTo({ top: el.scrollTop, behavior: 'auto' })
              el.scrollTop = el.scrollHeight
            }
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
  referencedMessage: WorkgroupRoomMessage | null
  referenceUnavailable: boolean
  highlighted: boolean
  registerMessageElement: (id: string, node: HTMLDivElement | null) => void
  onJumpToMessage: (id: string) => void
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
  referencedMessage,
  referenceUnavailable,
  highlighted,
  registerMessageElement,
  onJumpToMessage,
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

  const systemLabel = t('workgroups.room.authorSystem')
  const authorLabel = messageAuthorLabel(message, members, resolveUser, systemLabel)
  const referencedAuthorLabel =
    referencedMessage === null
      ? null
      : messageAuthorLabel(referencedMessage, members, resolveUser, systemLabel)
  const body = resolveWorkgroupMessageBody(message, t)
  const referencedBody =
    referencedMessage === null ? null : resolveWorkgroupMessageBody(referencedMessage, t)

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
    (!isSystem && message.kind === 'decision' ? ' workgroup-room__msg--decision' : '') +
    (highlighted ? ' workgroup-room__msg--highlighted' : '')

  return (
    <div
      ref={(node) => registerMessageElement(message.id, node)}
      className={`workgroup-room__msg${modifier}`}
      data-testid={`wg-msg-${message.id}`}
      tabIndex={-1}
    >
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
      {referencedMessage !== null && referencedAuthorLabel !== null && referencedBody !== null && (
        <MessageReference
          author={t('workgroups.room.replyingTo', { author: referencedAuthorLabel })}
          body={referencedBody}
          ariaLabel={t('workgroups.room.openReferencedMessage', {
            author: referencedAuthorLabel,
          })}
          onActivate={() => onJumpToMessage(referencedMessage.id)}
          testId={`wg-msg-reference-${message.id}`}
        />
      )}
      {referenceUnavailable && (
        <MessageReference
          unavailable
          unavailableLabel={t('workgroups.room.referencedMessageUnavailable')}
          testId={`wg-msg-reference-${message.id}`}
        />
      )}
      <div className="workgroup-room__body">{body}</div>
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

// RFC-164 PR-4 — workgroup task chat room: THE primary view of a group task
// (用户拍板: dispatching work IS @-mentioning a member; execution is watched
// live from the room).
//
// Layout (.workgroup-room grid): message log + composer on the left, roster /
// completion-gate / group-info rail on the right, and — reusing the
// tasks.detail drawer mechanism — a third `<NodeDetailDrawer>` column that
// opens from a dispatch card's "view run" button (the node-runs query shares
// its key with the page, so the cache is one).
//
// Data: one GET /api/workgroup-tasks/:taskId/room aggregate, invalidated by
// the wg.* WS frames (useTaskSync rules) + a slow poll fallback. All pure
// logic (timeline rounds, card joins, mention completion) lives in
// lib/workgroup-room so tests hit it without rendering.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  NodeRun,
  TaskNodeRuns,
  TaskStatus,
  WorkgroupRunEntry,
  WorkgroupRuntimeMember,
} from '@agent-workflow/shared'
import { resolveWorkgroupSwitches } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { Field, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NodeDetailDrawer } from '@/components/NodeDetailDrawer'
import { StatusChip } from '@/components/StatusChip'
import { WorkgroupTaskConfigDialog } from '@/components/workgroup/WorkgroupTaskConfigDialog'
import { useUserLookup } from '@/hooks/useUserLookup'
import { describeApiError } from '@/i18n'
import { displayNoderunStatusKey, nodeRunStatusToKind } from '@/lib/noderun-status'
import {
  applyMention,
  assignmentStatusToKind,
  assignmentsForMessage,
  buildDeliverBody,
  buildRoomTimeline,
  canPostRoomMessage,
  countMemberActiveRuns,
  deriveMemberPresence,
  formatRoomTimestamp,
  formatTurnDuration,
  groupFcAssignments,
  isAssignmentCancelable,
  isHumanDeliveryCard,
  memberIndex,
  mentionExecutingPills,
  mentionCandidates,
  mentionQueryAt,
  resolveComposerKey,
  resultBodyFor,
  sendChordModLabel,
  standaloneTurnEntries,
  turnCardsForMessage,
  turnDurationMs,
  workgroupRoomKey,
  type MentionContext,
  type WorkgroupDeliverInput,
  type WorkgroupMemberPresence,
  type WorkgroupRoomAssignment,
  type WorkgroupRoomMessage,
  type WorkgroupRoomResponse,
} from '@/lib/workgroup-room'

export interface WorkgroupRoomProps {
  taskId: string
  /** Live task status from the page-level query (WS-refreshed). */
  taskStatus: TaskStatus
}

export function WorkgroupRoom({ taskId, taskStatus }: WorkgroupRoomProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const canPost = canPostRoomMessage(taskStatus)

  const room = useQuery<WorkgroupRoomResponse>({
    queryKey: workgroupRoomKey(taskId),
    queryFn: ({ signal }) =>
      api.get(`/api/workgroup-tasks/${encodeURIComponent(taskId)}/room`, undefined, signal),
    // WS wg.* frames carry the live updates; the interval is only the
    // no-WS fallback (same idiom as the tasks list page).
    refetchInterval: canPost ? 15_000 : false,
  })

  // Shares the page query's cache entry — needed by the run drawer.
  const nodeRuns = useQuery<TaskNodeRuns>({
    queryKey: ['tasks', taskId, 'node-runs'],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(taskId)}/node-runs`, undefined, signal),
  })

  // Human author names: audit columns carry user ids; the room UI resolves
  // them to platform display names (prompts never see either — RFC-099).
  const users = useUserLookup([
    ...(room.data?.messages ?? []).map((m) => m.authorUserId),
    ...(room.data?.assignments ?? []).map((a) => a.createdByUserId),
  ])

  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [drawerRunId, setDrawerRunId] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  // RFC-174 — @-mention keyboard nav + send-chord state.
  const [activeIndexRaw, setActiveIndexRaw] = useState(0)
  const [dismissed, setDismissed] = useState<MentionContext | null>(null)
  const [composerFocused, setComposerFocused] = useState(false)
  const sendFromKbdRef = useRef(false)
  const wasSendPendingRef = useRef(false)
  const pendingCaretRef = useRef<number | null>(null)
  const listboxId = useId()

  const send = useMutation({
    mutationFn: (body: string) =>
      api.post<{ messageId: string; assignmentIds: string[] }>(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/messages`,
        { body },
      ),
    onSuccess: () => {
      setDraft('')
      setCaret(0)
      setDismissed(null) // fresh draft: never inherit a stale Esc dismissal
      void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) })
    },
    // Focus restoration after a keyboard send happens in an effect that watches
    // send.isPending true→false — onSettled fires before the re-render that
    // re-enables the (disabled-while-pending) textarea, so .focus() would no-op.
  })

  const cancelCard = useMutation({
    mutationFn: (assignmentId: string) =>
      api.post(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/assignments/${encodeURIComponent(assignmentId)}/cancel`,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) }),
  })

  // PR-5 (拍板 #16) — human-member delivery, both shapes normalized by
  // buildDeliverBody. The room refresh flips the card to 'delivered'.
  const deliver = useMutation({
    mutationFn: ({ assignmentId, input }: { assignmentId: string; input: WorkgroupDeliverInput }) =>
      api.post<{ messageId: string }>(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/assignments/${encodeURIComponent(assignmentId)}/deliver`,
        buildDeliverBody(input),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) }),
  })

  // PR-5 (design §8.2) — completion-gate decision. approve fires directly;
  // reject goes through the comment dialog below (comment is REQUIRED).
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectComment, setRejectComment] = useState('')
  const confirmGate = useMutation({
    mutationFn: (input: { decision: 'approve' | 'reject'; comment?: string }) =>
      api.post<{ decision: string }>(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/confirm`,
        input,
      ),
    onSuccess: () => {
      setRejectOpen(false)
      setRejectComment('')
      void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) })
      // The decision also moves the task status (awaiting_review → running/done).
      void qc.invalidateQueries({ queryKey: ['tasks', taskId] })
    },
  })

  // PR-5 (design §8.4) — mid-run config dialog toggle.
  const [configOpen, setConfigOpen] = useState(false)

  // RFC-182 D1 — the timeline weaves persistent turn cards (leader rounds +
  // degraded message-turns) between the messages; @-mention message-turns
  // attach under their trigger message inside RoomMessage instead.
  const runHistory = useMemo(() => room.data?.runHistory ?? [], [room.data])
  const timeline = useMemo(
    () => buildRoomTimeline(room.data?.messages ?? [], standaloneTurnEntries(runHistory)),
    [room.data, runHistory],
  )
  // RFC-179 §2.3 — per-message「执行中」pill on the @-mention that woke a
  // member (render①); RFC-182 D8 replaced the vanish-on-done synthetic active
  // rows (render②) with the persistent turn cards above.
  const executingPills = useMemo(
    () => mentionExecutingPills(room.data?.config.members ?? [], room.data?.memberRuns ?? {}),
    [room.data],
  )
  const members = useMemo(
    () => memberIndex(room.data?.config ?? { members: [] }),
    [room.data?.config],
  )

  // RFC-182 — ONE room-level 1s ticker drives every live duration (turn cards
  // + run log); it only runs while something is actually pending/running.
  const hasLiveTurn = useMemo(
    () => runHistory.some((e) => e.status === 'running' || e.status === 'pending'),
    [runHistory],
  )
  const [roomNow, setRoomNow] = useState(() => Date.now())
  useEffect(() => {
    if (!hasLiveTurn) return
    const tick = setInterval(() => setRoomNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [hasLiveTurn])

  // RFC-182 P1-1 — scroll anchoring: follow the tail only while the user IS at
  // the tail; scrolling up to read history must never be yanked back down
  // (the old effect pinned unconditionally). Keyed on timeline + runHistory
  // length (impl-gate P2: an attached turn card grows the log without
  // changing the timeline length).
  const [atBottom, setAtBottom] = useState(true)
  // Impl-gate P2 — the follow signature must also cover IN-PLACE card growth
  // (a turn flipping running→failed gains a note chip without changing any
  // length), so statuses+notes join the lengths.
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

  // @-mention completion over the roster (design: 输入 @ 时按花名册补全).
  const mentionCtx = mentionQueryAt(draft, caret)
  const rawSuggestions =
    mentionCtx === null || room.data === undefined
      ? []
      : mentionCandidates(room.data.config, mentionCtx.query)
  // Token-session dismissal (Esc): keyed on {start,query} so typing more in the
  // same token reopens it, while moving to another @token is unaffected.
  const isDismissed =
    mentionCtx !== null &&
    dismissed !== null &&
    dismissed.start === mentionCtx.start &&
    dismissed.query === mentionCtx.query
  // Also gate on focus + postability + no send in flight (RFC-174 P1-3).
  const mentionOpen =
    rawSuggestions.length > 0 && !isDismissed && composerFocused && canPost && !send.isPending
  const suggestions = mentionOpen ? rawSuggestions : []
  // Derived clamp: a stale raw index can never deref out of range.
  const activeIndex =
    suggestions.length === 0 ? 0 : Math.min(Math.max(activeIndexRaw, 0), suggestions.length - 1)

  // Re-highlight the top match whenever the mention query changes.
  useEffect(() => {
    setActiveIndexRaw(0)
  }, [mentionCtx?.query])

  // Apply a post-commit caret AFTER the controlled value lands in the DOM —
  // setting selectionRange synchronously (before re-render) mis-places it.
  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return
    const pos = pendingCaretRef.current
    pendingCaretRef.current = null
    const el = inputRef.current
    if (el !== null) {
      el.focus()
      try {
        el.setSelectionRange(pos, pos)
      } catch {
        /* jsdom/happy-dom quirk tolerance */
      }
    }
  }, [draft])

  // Restore focus after a keyboard send: watch send.isPending fall true→false so
  // we re-focus AFTER the re-render that re-enables the textarea (focusing a
  // still-disabled element in onSettled is a no-op).
  useEffect(() => {
    if (wasSendPendingRef.current && !send.isPending && sendFromKbdRef.current) {
      sendFromKbdRef.current = false
      inputRef.current?.focus()
    }
    wasSendPendingRef.current = send.isPending
  }, [send.isPending])

  function commitMention(displayName: string): void {
    if (mentionCtx === null) return
    const next = applyMention(draft, caret, mentionCtx, displayName)
    setDraft(next.text)
    setCaret(next.caret)
    pendingCaretRef.current = next.caret // applied by the layout effect above
    setActiveIndexRaw(0)
    setDismissed(null) // committed token is gone; don't leave a stale dismissal
  }

  if (room.isLoading) return <LoadingState data-testid="workgroup-room-loading" />
  if (room.error !== null && room.error !== undefined) {
    return <div className="error-box">{describeApiError(room.error)}</div>
  }
  if (room.data === undefined) return null

  const data = room.data
  const drawerRun =
    drawerRunId === null ? undefined : nodeRuns.data?.runs.find((r) => r.id === drawerRunId)
  // RFC-182 G4-②/D7 — member-scoped drawer runs: the drawer's own history
  // merges by nodeId, and every member turn shares __wg_member__ — unscoped it
  // mixes EVERY member's rounds (cross-member bleed). Scope to the selected
  // run's member via runHistory (selected run always included; unclassified
  // run → full list, never a blank drawer).
  const drawerRuns = (() => {
    const all = nodeRuns.data?.runs ?? []
    if (drawerRunId === null) return all
    const owner = runHistory.find((e) => e.nodeRunId === drawerRunId)?.memberId
    if (owner === undefined) return all
    const ids = new Set(runHistory.filter((e) => e.memberId === owner).map((e) => e.nodeRunId))
    ids.add(drawerRunId)
    return all.filter((r) => ids.has(r.id))
  })()

  return (
    <div
      className={
        drawerRunId !== null ? 'workgroup-room workgroup-room--with-drawer' : 'workgroup-room'
      }
      data-testid="workgroup-room"
    >
      <section className="workgroup-room__main">
        <div
          className="workgroup-room__log"
          ref={logRef}
          onScroll={onLogScroll}
          data-testid="workgroup-room-log"
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
                runs={nodeRuns.data?.runs ?? []}
                now={roomNow}
                onViewRun={setDrawerRunId}
              />
            ) : (
              <RoomMessage
                key={entry.message.id}
                message={entry.message}
                executingPill={executingPills.get(entry.message.id)}
                runHistory={runHistory}
                runs={nodeRuns.data?.runs ?? []}
                now={roomNow}
                data={data}
                members={members}
                resolveUser={users.get}
                canceling={cancelCard.isPending}
                onCancel={(id) => cancelCard.mutateAsync(id)}
                onViewRun={setDrawerRunId}
                delivering={deliver.isPending}
                onDeliver={(assignmentId, input) => deliver.mutateAsync({ assignmentId, input })}
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

        {cancelCard.error !== null && cancelCard.error !== undefined && (
          <div className="error-box">{describeApiError(cancelCard.error)}</div>
        )}
        {deliver.error !== null && deliver.error !== undefined && (
          <div className="error-box" data-testid="workgroup-room-deliver-error">
            {describeApiError(deliver.error)}
          </div>
        )}

        <div className="workgroup-room__composer">
          {suggestions.length > 0 && (
            <ul
              className="workgroup-room__mentions"
              id={listboxId}
              role="listbox"
              aria-label={t('workgroups.room.mentionsAria')}
              data-testid="workgroup-room-mentions"
            >
              {suggestions.map((m, i) => (
                // The <li> IS the option (mirrors Select.tsx) — no inner button,
                // so nothing in the popup enters the Tab sequence under the
                // active-descendant model.
                <li
                  key={m.id}
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={i === activeIndex ? 'is-active' : undefined}
                  onMouseEnter={() => setActiveIndexRaw(i)}
                  // preventDefault keeps the textarea focused through the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitMention(m.displayName)}
                  data-testid={`wg-mention-${m.displayName}`}
                >
                  @{m.displayName}
                  {m.roleDesc !== '' && <span className="muted"> · {m.roleDesc}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="workgroup-room__composer-row">
            {/* Raw textarea (with the shared .form-input skin) instead of
                <TextArea>: mention completion needs caret tracking via
                onSelect/selectionStart, which the shared primitive does not
                expose — same precedent as the launcher's multiline input. */}
            <textarea
              ref={inputRef}
              className="form-input workgroup-room__input"
              rows={2}
              value={draft}
              placeholder={
                canPost
                  ? t('workgroups.room.composerPlaceholder')
                  : t('workgroups.room.terminalNotice')
              }
              disabled={!canPost || send.isPending}
              // Editable textbox with an associated listbox via active-descendant
              // (a multiline field can't be a combobox, so NO aria-expanded).
              aria-autocomplete="list"
              // Both references only point at the listbox while it is mounted —
              // a dangling aria-controls/activedescendant confuses screen readers.
              aria-controls={mentionOpen ? listboxId : undefined}
              aria-activedescendant={mentionOpen ? `${listboxId}-opt-${activeIndex}` : undefined}
              onChange={(e) => {
                setDraft(e.target.value)
                setCaret(e.target.selectionStart ?? e.target.value.length)
                // Any edit invalidates a prior Esc dismissal (so re-typing the
                // same @token after clearing/sending reopens the dropdown).
                setDismissed(null)
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              onKeyDown={(e) => {
                const action = resolveComposerKey({
                  key: e.key,
                  metaKey: e.metaKey,
                  ctrlKey: e.ctrlKey,
                  altKey: e.altKey,
                  shiftKey: e.shiftKey,
                  isComposing: e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229,
                  mentionOpen,
                  candidateCount: suggestions.length,
                  activeIndex,
                })
                switch (action.type) {
                  case 'send':
                    e.preventDefault() // unconditional — never leak a newline
                    if (canPost && !send.isPending && draft.trim().length > 0) {
                      sendFromKbdRef.current = true
                      send.mutate(draft.trim())
                    }
                    break
                  case 'mention-move':
                    e.preventDefault()
                    setActiveIndexRaw(action.index)
                    break
                  case 'mention-commit': {
                    e.preventDefault()
                    const target = suggestions[action.index] ?? suggestions[0]
                    if (target !== undefined) commitMention(target.displayName)
                    break
                  }
                  case 'mention-close':
                    e.preventDefault()
                    setDismissed(mentionCtx)
                    break
                  case 'default':
                    break
                }
              }}
              data-testid="workgroup-room-input"
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canPost || send.isPending || draft.trim().length === 0}
              onClick={() => send.mutate(draft.trim())}
              data-testid="workgroup-room-send"
            >
              {send.isPending ? t('workgroups.room.sending') : t('workgroups.room.send')}
            </button>
          </div>
          {canPost && (
            <div
              className="form-field__hint workgroup-room__composer-hint"
              data-testid="workgroup-room-shortcut-hint"
            >
              {t('workgroups.room.composerShortcutHint', { mod: sendChordModLabel() })}
            </div>
          )}
          {!canPost && (
            <div className="form-field__hint" data-testid="workgroup-room-terminal-notice">
              {t('workgroups.room.terminalNotice')}
            </div>
          )}
          {send.error !== null && send.error !== undefined && (
            <div className="error-box" data-testid="workgroup-room-send-error">
              {describeApiError(send.error)}
            </div>
          )}
        </div>
      </section>

      <aside className="workgroup-room__side">
        <Card
          header={
            <h3 className="workgroup-room__side-title">{t('workgroups.room.membersTitle')}</h3>
          }
          data-testid="workgroup-room-members"
        >
          <ul className="workgroup-room__members">
            {data.config.members.map((m) => {
              // RFC-179 — click a member (leader included, as a peer) to open its
              // current session run in the right-hand drawer; null → not clickable.
              const currentRun = data.memberRuns[m.id] ?? null
              // RFC-182 D5 — four-state presence off the SAME data the pills
              // read (currentRun first, assignments as fallback) — the old
              // assignments-only chip said「空闲」while a message-turn /
              // leader round was visibly executing on screen (user complaint
              // #2). The chip itself is clickable into the session (D9).
              const presence = deriveMemberPresence(m.id, data.assignments, currentRun)
              // RFC-185 — fan-out scale: single-value presence hides N
              // concurrent instances; show ×N off the same runHistory source
              // (≥2 only, so the everyday single-run roster stays noise-free).
              const activeRuns = countMemberActiveRuns(data.runHistory, m.id)
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
                      onClick={() => setDrawerRunId(currentRun.nodeRunId)}
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
                      ? { onClick: () => setDrawerRunId(currentRun.nodeRunId) }
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
                const live = nodeRuns.data?.runs.find((r) => r.id === e.nodeRunId)
                const status = live?.status ?? e.status
                const dur = turnDurationMs(e, roomNow)
                return (
                  <li key={e.nodeRunId}>
                    <button
                      type="button"
                      className="workgroup-room__runlog-row"
                      onClick={() => setDrawerRunId(e.nodeRunId)}
                      data-testid={`wg-runlog-${e.nodeRunId}`}
                    >
                      <span className="workgroup-room__member-name">
                        {e.displayName !== null
                          ? `@${e.displayName}`
                          : t('workgroups.room.removedMember')}
                      </span>
                      <span className="chip chip--tight">{turnKindLabel(t, e.kind)}</span>
                      <StatusChip
                        kind={live !== undefined ? nodeRunStatusToKind(live.status) : 'neutral'}
                        size="sm"
                        withDot={status === 'running'}
                      >
                        {live !== undefined ? t(displayNoderunStatusKey(live)) : status}
                      </StatusChip>
                      <span className="workgroup-room__time">
                        {dur === null ? '—' : formatTurnDuration(dur)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {data.gate.awaitingConfirmation && (
          <Card
            header={
              <h3 className="workgroup-room__side-title">{t('workgroups.room.gateTitle')}</h3>
            }
            data-testid="workgroup-room-gate"
            footer={
              <div className="workgroup-room__card-actions">
                {/* PR-5: the gate is live — approve fires directly, reject
                    requires a comment (dialog below). */}
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={confirmGate.isPending}
                  onClick={() => confirmGate.mutate({ decision: 'approve' })}
                  data-testid="workgroup-room-gate-confirm"
                >
                  {confirmGate.isPending ? t('common.saving') : t('workgroups.room.gateConfirm')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={confirmGate.isPending}
                  onClick={() => setRejectOpen(true)}
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
            {confirmGate.error !== null && confirmGate.error !== undefined && (
              <div className="error-box" data-testid="workgroup-room-gate-error">
                {describeApiError(confirmGate.error)}
              </div>
            )}
          </Card>
        )}

        {/* PR-5 fc 观测面 — the shared task list, grouped open / active / done. */}
        {data.config.mode === 'free_collab' && (
          <FcTaskListCard
            assignments={data.assignments}
            members={members}
            canceling={cancelCard.isPending}
            onCancel={(id) => cancelCard.mutateAsync(id)}
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
                onClick={() => setConfigOpen(true)}
                data-testid="workgroup-room-config-btn"
              >
                {t('workgroups.room.configButton')}
              </button>
            ) : undefined
          }
        >
          <dl className="workgroup-room__info">
            <dt>{t('workgroups.room.infoGoal')}</dt>
            <dd className="workgroup-room__goal">{data.config.goal}</dd>
            <dt>{t('workgroups.room.infoMode')}</dt>
            <dd>
              {data.config.mode === 'leader_worker'
                ? t('workgroups.modeLeaderWorker')
                : t('workgroups.modeFreeCollab')}
            </dd>
            <dt>{t('workgroups.room.infoMaxRounds')}</dt>
            <dd>{data.config.maxRounds}</dd>
            <dt>{t('workgroups.room.infoSwitches')}</dt>
            <dd>{switchesSummary(data.config.mode, data.config.switches, t)}</dd>
          </dl>
        </Card>
      </aside>

      {/* PR-5 — gate reject requires a comment (backend 422s without one). */}
      <Dialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={t('workgroups.room.gateRejectTitle')}
        size="sm"
        data-testid="workgroup-room-gate-reject-dialog"
        footer={
          <>
            {confirmGate.error !== null && confirmGate.error !== undefined && (
              <span className="form-actions__error">{describeApiError(confirmGate.error)}</span>
            )}
            <button type="button" className="btn" onClick={() => setRejectOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={confirmGate.isPending || rejectComment.trim().length === 0}
              onClick={() =>
                confirmGate.mutate({ decision: 'reject', comment: rejectComment.trim() })
              }
              data-testid="workgroup-room-gate-reject-submit"
            >
              {confirmGate.isPending ? t('common.saving') : t('workgroups.room.gateRejectSubmit')}
            </button>
          </>
        }
      >
        <Field
          label={t('workgroups.room.gateRejectCommentLabel')}
          required
          hint={t('workgroups.room.gateRejectCommentHint')}
        >
          <TextArea
            value={rejectComment}
            onChange={setRejectComment}
            rows={4}
            maxLength={65536}
            data-testid="workgroup-room-gate-reject-comment"
          />
        </Field>
      </Dialog>

      {configOpen && (
        <WorkgroupTaskConfigDialog
          taskId={taskId}
          config={data.config}
          onClose={() => setConfigOpen(false)}
        />
      )}

      {drawerRunId !== null && nodeRuns.data !== undefined && (
        <NodeDetailDrawer
          taskId={taskId}
          taskStatus={taskStatus}
          nodeRunId={drawerRunId}
          nodeId={drawerRun?.nodeId ?? null}
          // Member/leader turns are minted on the host graph's agent-single
          // nodes (__wg_leader__ / __wg_member__, services/workgroupLaunch.ts),
          // so the Session tab renders the run's opencode conversation.
          workflowNodeKind="agent-single"
          agentName={null}
          runs={drawerRuns}
          outputs={nodeRuns.data.outputs}
          onClose={() => setDrawerRunId(null)}
          onSelectRun={setDrawerRunId}
        />
      )}
    </div>
  )
}

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

  // PR-6 观测面: the leader's convergence summary (kind='decision') stands
  // out from plain chat — accent border via the modifier class.
  const modifier = isSystem
    ? ' workgroup-room__msg--system'
    : message.kind === 'decision'
      ? ' workgroup-room__msg--decision'
      : ''

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

// ---------------------------------------------------------------------------
// RFC-182 D1 — persistent turn card (message-turn / leader-round): live while
// running (pulse + ticking duration), settles IN PLACE at a terminal state
// (status + total duration + view-session) — it never vanishes from the
// stream. Assignment turns keep their DispatchCard (D4, no double card).
// ---------------------------------------------------------------------------

function turnKindLabel(
  t: ReturnType<typeof useTranslation>['t'],
  kind: WorkgroupRunEntry['kind'],
): string {
  if (kind === 'leader-round') return t('workgroups.room.turnKindLeader')
  if (kind === 'assignment') return t('workgroups.room.turnKindAssignment')
  return t('workgroups.room.turnKindMessage')
}

interface TurnCardProps {
  entry: WorkgroupRunEntry
  runs: readonly NodeRun[]
  now: number
  onViewRun: (nodeRunId: string) => void
}

function TurnCard({ entry, runs, now, onViewRun }: TurnCardProps) {
  const { t } = useTranslation()
  // Status truth prefers the live node-run row (same source the drawer uses,
  // 10-state display via the shared noderun-status mapping); the history
  // entry's snapshot is the fallback for the refetch gap.
  const live = runs.find((r) => r.id === entry.nodeRunId)
  const status = live?.status ?? entry.status
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
        <span className="chip chip--tight">{turnKindLabel(t, entry.kind)}</span>
        <StatusChip
          kind={live !== undefined ? nodeRunStatusToKind(live.status) : 'neutral'}
          size="sm"
          withDot={status === 'running'}
          data-testid={`wg-turn-status-${entry.nodeRunId}`}
        >
          {live !== undefined ? t(displayNoderunStatusKey(live)) : status}
        </StatusChip>
        {entry.note === 'clarify-suppressed' && (
          <StatusChip kind="warn" size="sm" data-testid={`wg-turn-note-${entry.nodeRunId}`}>
            {t('workgroups.room.clarifySuppressedNote')}
          </StatusChip>
        )}
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

function DispatchCard({
  assignment,
  data,
  members,
  canceling,
  onCancel,
  onViewRun,
  delivering,
  onDeliver,
}: {
  assignment: WorkgroupRoomAssignment
  data: WorkgroupRoomResponse
  members: Map<string, WorkgroupRuntimeMember>
  canceling: boolean
  onCancel: (assignmentId: string) => Promise<unknown>
  onViewRun: (nodeRunId: string) => void
  delivering: boolean
  onDeliver: (assignmentId: string, input: WorkgroupDeliverInput) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const assignee =
    assignment.assigneeMemberId === null ? undefined : members.get(assignment.assigneeMemberId)
  const resultBody = resultBodyFor(assignment, data.messages)
  // PR-5 (拍板 #16): a dispatched card assigned to a HUMAN member renders in
  // the to-do form — highlighted + the two delivery entries.
  const isTodo = isHumanDeliveryCard(assignment, members)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickText, setQuickText] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  // Quick-reply submit, shared by the button and the Cmd/Ctrl+Enter chord.
  // (No focus hand-off after delivery: a successful deliver flips the card to
  // 'delivered', which unmounts the whole to-do affordance — there is no stable
  // element to focus, so we let focus fall naturally.)
  function submitQuick(): void {
    if (delivering || quickText.trim().length === 0) return
    void onDeliver(assignment.id, { kind: 'quick', body: quickText }).then(() => {
      setQuickOpen(false)
      setQuickText('')
    })
  }

  return (
    <div
      className={`workgroup-room__card${isTodo ? ' workgroup-room__card--todo' : ''}`}
      data-testid={`wg-card-${assignment.id}`}
    >
      <div className="workgroup-room__card-head">
        <strong className="workgroup-room__card-title">{assignment.title}</strong>
        <StatusChip
          kind={assignmentStatusToKind(assignment.status)}
          size="sm"
          data-testid={`wg-card-status-${assignment.id}`}
        >
          {t(`workgroups.room.assignmentStatus.${assignment.status}`)}
        </StatusChip>
        <span className="chip chip--tight">{t(`workgroups.room.source.${assignment.source}`)}</span>
        {isTodo && (
          <StatusChip kind="warn" size="sm" data-testid={`wg-card-todo-${assignment.id}`}>
            {t('workgroups.room.deliverTodo')}
          </StatusChip>
        )}
      </div>
      <div className="workgroup-room__card-assignee">
        {t('workgroups.room.assignedTo')}{' '}
        <span className="workgroup-room__member-name">
          {assignee !== undefined ? `@${assignee.displayName}` : t('common.emDash')}
        </span>
      </div>
      {resultBody !== null && (
        <details
          className="workgroup-room__card-result"
          data-testid={`wg-card-result-${assignment.id}`}
        >
          <summary>{t('workgroups.room.resultSummary')}</summary>
          <div className="workgroup-room__body">{resultBody}</div>
        </details>
      )}
      {(assignment.nodeRunId !== null || isAssignmentCancelable(assignment.status) || isTodo) && (
        <div className="workgroup-room__card-actions">
          {isTodo && (
            <>
              <button
                type="button"
                className="btn btn--xs btn--primary"
                onClick={() => setQuickOpen((v) => !v)}
                disabled={delivering}
                data-testid={`wg-card-deliver-quick-${assignment.id}`}
              >
                {t('workgroups.room.deliverQuick')}
              </button>
              <button
                type="button"
                className="btn btn--xs"
                onClick={() => setFormOpen(true)}
                disabled={delivering}
                data-testid={`wg-card-deliver-form-${assignment.id}`}
              >
                {t('workgroups.room.deliverForm')}
              </button>
            </>
          )}
          {assignment.nodeRunId !== null && (
            <button
              type="button"
              className="btn btn--xs"
              onClick={() => onViewRun(assignment.nodeRunId!)}
              data-testid={`wg-card-run-${assignment.id}`}
            >
              {t('workgroups.room.viewRun')}
            </button>
          )}
          {isAssignmentCancelable(assignment.status) && (
            <ConfirmButton
              label={t('workgroups.room.cancelCard')}
              onConfirm={() => onCancel(assignment.id)}
              variant="danger"
              size="sm"
              disabled={canceling}
            />
          )}
        </div>
      )}
      {/* Quick reply — inline textarea, POSTs the chat-body shape. */}
      {isTodo && quickOpen && (
        <div className="workgroup-room__card-quick">
          <textarea
            className="form-input"
            rows={3}
            value={quickText}
            onChange={(e) => setQuickText(e.target.value)}
            onKeyDown={(e) => {
              const action = resolveComposerKey({
                key: e.key,
                metaKey: e.metaKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                isComposing: e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229,
                mentionOpen: false, // no @-completion in the delivery box
                candidateCount: 0,
                activeIndex: 0,
              })
              if (action.type === 'send') {
                e.preventDefault() // unconditional (never leak a newline)
                submitQuick()
              }
            }}
            placeholder={t('workgroups.room.deliverQuickPlaceholder')}
            disabled={delivering}
            data-testid={`wg-card-quick-input-${assignment.id}`}
          />
          <div className="form-field__hint workgroup-room__composer-hint">
            {t('workgroups.room.deliverShortcutHint', { mod: sendChordModLabel() })}
          </div>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={delivering || quickText.trim().length === 0}
            onClick={submitQuick}
            data-testid={`wg-card-quick-submit-${assignment.id}`}
          >
            {t('workgroups.room.deliverSubmit')}
          </button>
        </div>
      )}
      {/* Form delivery — structured {summary, detail?} via the shared Dialog. */}
      {isTodo && formOpen && (
        <DeliverFormDialog
          assignment={assignment}
          delivering={delivering}
          onClose={() => setFormOpen(false)}
          onDeliver={onDeliver}
        />
      )}
    </div>
  )
}

/** PR-5 结构化交付表单（拍板 #16 第二形态）。 */
function DeliverFormDialog({
  assignment,
  delivering,
  onClose,
  onDeliver,
}: {
  assignment: WorkgroupRoomAssignment
  delivering: boolean
  onClose: () => void
  onDeliver: (assignmentId: string, input: WorkgroupDeliverInput) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const [summary, setSummary] = useState('')
  const [detail, setDetail] = useState('')
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('workgroups.room.deliverFormTitle')}
      size="md"
      data-testid={`wg-deliver-form-dialog-${assignment.id}`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={delivering || summary.trim().length === 0}
            onClick={() =>
              void onDeliver(assignment.id, { kind: 'form', summary, detail }).then(onClose)
            }
            data-testid={`wg-deliver-form-submit-${assignment.id}`}
          >
            {t('workgroups.room.deliverSubmit')}
          </button>
        </>
      }
    >
      <Field label={t('workgroups.room.deliverSummaryLabel')} required>
        <TextInput
          value={summary}
          onChange={setSummary}
          maxLength={16384}
          data-testid={`wg-deliver-summary-${assignment.id}`}
        />
      </Field>
      <Field label={t('workgroups.room.deliverDetailLabel')}>
        <TextArea
          value={detail}
          onChange={setDetail}
          rows={6}
          maxLength={65536}
          data-testid={`wg-deliver-detail-${assignment.id}`}
        />
      </Field>
    </Dialog>
  )
}

/**
 * PR-5 fc 观测面 — the shared task list, three groups (open / in-flight /
 * done). Open rows keep their cancel affordance (same CAS as the cards).
 */
function FcTaskListCard({
  assignments,
  members,
  canceling,
  onCancel,
}: {
  assignments: WorkgroupRoomAssignment[]
  members: Map<string, WorkgroupRuntimeMember>
  canceling: boolean
  onCancel: (assignmentId: string) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const groups = groupFcAssignments(assignments)
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

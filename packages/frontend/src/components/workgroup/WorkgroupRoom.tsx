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
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskNodeRuns, TaskStatus, WorkgroupRuntimeMember } from '@agent-workflow/shared'
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
import {
  applyMention,
  assignmentStatusToKind,
  assignmentsForMessage,
  buildDeliverBody,
  buildRoomTimeline,
  canPostRoomMessage,
  groupFcAssignments,
  isAssignmentCancelable,
  isHumanDeliveryCard,
  memberIndex,
  memberIsWorking,
  mentionCandidates,
  mentionQueryAt,
  resultBodyFor,
  workgroupRoomKey,
  type WorkgroupDeliverInput,
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

  const send = useMutation({
    mutationFn: (body: string) =>
      api.post<{ messageId: string; assignmentIds: string[] }>(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/messages`,
        { body },
      ),
    onSuccess: () => {
      setDraft('')
      setCaret(0)
      void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) })
    },
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

  const timeline = useMemo(() => buildRoomTimeline(room.data?.messages ?? []), [room.data])
  const members = useMemo(
    () => memberIndex(room.data?.config ?? { members: [] }),
    [room.data?.config],
  )

  // Pin the log to the newest message whenever one lands.
  const messageCount = room.data?.messages.length ?? 0
  useEffect(() => {
    const el = logRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [messageCount])

  // @-mention completion over the roster (design: 输入 @ 时按花名册补全).
  const mentionCtx = mentionQueryAt(draft, caret)
  const suggestions =
    mentionCtx === null || room.data === undefined
      ? []
      : mentionCandidates(room.data.config, mentionCtx.query)

  function commitMention(displayName: string): void {
    if (mentionCtx === null) return
    const next = applyMention(draft, caret, mentionCtx, displayName)
    setDraft(next.text)
    setCaret(next.caret)
    const el = inputRef.current
    if (el !== null) {
      el.focus()
      try {
        el.setSelectionRange(next.caret, next.caret)
      } catch {
        /* jsdom/happy-dom quirk tolerance */
      }
    }
  }

  if (room.isLoading) return <LoadingState data-testid="workgroup-room-loading" />
  if (room.error !== null && room.error !== undefined) {
    return <div className="error-box">{describeApiError(room.error)}</div>
  }
  if (room.data === undefined) return null

  const data = room.data
  const drawerRun =
    drawerRunId === null ? undefined : nodeRuns.data?.runs.find((r) => r.id === drawerRunId)

  return (
    <div
      className={
        drawerRunId !== null ? 'workgroup-room workgroup-room--with-drawer' : 'workgroup-room'
      }
      data-testid="workgroup-room"
    >
      <section className="workgroup-room__main">
        <div className="workgroup-room__log" ref={logRef} data-testid="workgroup-room-log">
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
            ) : (
              <RoomMessage
                key={entry.message.id}
                message={entry.message}
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
              role="listbox"
              aria-label={t('workgroups.room.mentionsAria')}
              data-testid="workgroup-room-mentions"
            >
              {suggestions.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    // preventDefault keeps the textarea focused through the click.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitMention(m.displayName)}
                    data-testid={`wg-mention-${m.displayName}`}
                  >
                    @{m.displayName}
                    {m.roleDesc !== '' && <span className="muted"> · {m.roleDesc}</span>}
                  </button>
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
              onChange={(e) => {
                setDraft(e.target.value)
                setCaret(e.target.selectionStart ?? e.target.value.length)
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
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
              const working = memberIsWorking(m.id, data.assignments)
              return (
                <li key={m.id} data-testid={`wg-member-${m.displayName}`}>
                  <span className="workgroup-room__member-name">@{m.displayName}</span>
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
                    kind={working ? 'success' : 'neutral'}
                    size="sm"
                    withDot={working}
                    data-testid={`wg-member-state-${m.displayName}`}
                  >
                    {working ? t('workgroups.room.working') : t('workgroups.room.idle')}
                  </StatusChip>
                </li>
              )
            })}
          </ul>
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
          runs={nodeRuns.data.runs}
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
        {isLeader && (
          <StatusChip kind="info" size="sm" data-testid={`wg-msg-leader-${message.id}`}>
            {t('workgroups.leaderBadge')}
          </StatusChip>
        )}
        {message.authorKind === 'human' && (
          <span className="chip chip--tight">{t('workgroups.memberTypeHuman')}</span>
        )}
        <span className="workgroup-room__time">
          {new Date(message.createdAt).toLocaleTimeString()}
        </span>
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
            placeholder={t('workgroups.room.deliverQuickPlaceholder')}
            disabled={delivering}
            data-testid={`wg-card-quick-input-${assignment.id}`}
          />
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={delivering || quickText.trim().length === 0}
            onClick={() =>
              void onDeliver(assignment.id, { kind: 'quick', body: quickText }).then(() => {
                setQuickOpen(false)
                setQuickText('')
              })
            }
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

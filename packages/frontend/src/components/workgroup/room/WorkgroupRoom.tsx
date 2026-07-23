// RFC-164 PR-4 — workgroup task chat room: THE primary view of a group task
// (用户拍板: dispatching work IS @-mentioning a member; execution is watched
// live from the room).
//
// RFC-217 T10 — decomposed: this file is the SHELL (layout + data down-wiring
// + room-level mutations + drawer/dialog state, ≤400 lines). The pieces:
//   RoomTimeline   — log + scroll anchoring + message/turn/round rendering
//   RoomComposer   — draft/caret/@mention state (LOCAL: typing re-renders the
//                    composer alone) + the send mutation
//   RoomSideCards  — roster / run log / pause / gate / fc list / group info
//   DispatchCard / TurnCard / DeliverFormDialog / FcTaskListCard / RunStatusRow
//
// Data: ONE GET /api/workgroup-tasks/:taskId/room aggregate OWNED BY
// tasks.detail.tsx (the single workgroupRoomKey useQuery — G9) and passed in
// as a prop; invalidated by the wg.* WS frames (useTaskSync rules) + a slow
// poll fallback. All pure logic lives in lib/workgroup-room so tests hit it
// without rendering.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskNodeRuns, TaskStatus } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, TextArea } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NodeDetailDrawer } from '@/components/NodeDetailDrawer'
import { ErrorBanner } from '@/components/ErrorBanner'
import { WorkgroupTaskConfigDialog } from '@/components/workgroup/WorkgroupTaskConfigDialog'
import { RoomComposer } from '@/components/workgroup/room/RoomComposer'
import { RoomSideCards } from '@/components/workgroup/room/RoomSideCards'
import { RoomTimeline } from '@/components/workgroup/room/RoomTimeline'
import { useUserLookup } from '@/hooks/useUserLookup'
import { describeApiError } from '@/i18n'
import { roomShowsRoundDividers } from '@/lib/workgroup-mode'
import {
  buildDeliverBody,
  buildRoomTimeline,
  canPostRoomMessage,
  indexRunHistory,
  memberIndex,
  mentionExecutingPills,
  standaloneTurnEntries,
  workgroupRoomKey,
  type WorkgroupDeliverInput,
  type WorkgroupRoomResponse,
} from '@/lib/workgroup-room'

export interface WorkgroupRoomProps {
  taskId: string
  /** Live task status from the page-level query (WS-refreshed). */
  taskStatus: TaskStatus
  /** THE room aggregate query — owned by tasks.detail.tsx (single
   *  workgroupRoomKey declaration, RFC-217 T10 G9). */
  room: UseQueryResult<WorkgroupRoomResponse>
}

export function WorkgroupRoom({ taskId, taskStatus, room }: WorkgroupRoomProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const canPost = canPostRoomMessage(taskStatus)

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

  const [drawerRunId, setDrawerRunId] = useState<string | null>(null)

  const cancelCard = useMutation({
    mutationFn: (assignmentId: string) =>
      api.post(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/assignments/${encodeURIComponent(assignmentId)}/cancel`,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) }),
  })

  // RFC-207 — un-silence one asker. Reuses the ordinary per-node directive route
  // with the asker key as its shard, so there is exactly one write path for
  // stop/continue rather than a workgroup-only twin.
  const resumeClarify = useMutation({
    mutationFn: ({ nodeId, askerKey }: { nodeId: string; askerKey: string }) =>
      api.post(
        `/api/tasks/${encodeURIComponent(taskId)}/nodes/${encodeURIComponent(nodeId)}/clarify-directive`,
        { directive: 'continue', shardKey: askerKey },
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
  // RFC-209 —— 自由协作不画回合分隔线（无全局回合），预算改在右栏如实显示。
  const timeline = useMemo(
    () =>
      buildRoomTimeline(room.data?.messages ?? [], standaloneTurnEntries(runHistory), {
        dividers: room.data === undefined ? true : roomShowsRoundDividers(room.data.config.mode),
      }),
    [room.data, runHistory],
  )
  // RFC-179 §2.3 — per-message「执行中」pill on the @-mention that woke a
  // member; RFC-182 D8 replaced the vanish-on-done synthetic active rows with
  // the persistent turn cards.
  const executingPills = useMemo(
    () => mentionExecutingPills(room.data?.config.members ?? [], room.data?.memberRuns ?? {}),
    [room.data],
  )
  const members = useMemo(
    () => memberIndex(room.data?.config ?? { members: [] }),
    [room.data?.config],
  )
  // Codex impl-gate finding (450601b7): index once per refetch so the 1s
  // ticker's per-DispatchCard duration lookup is O(1).
  const runEntryById = useMemo(() => indexRunHistory(runHistory), [runHistory])

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

  if (room.isLoading) return <LoadingState data-testid="workgroup-room-loading" />
  if (room.error !== null && room.error !== undefined) {
    return <ErrorBanner error={room.error} />
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
        <RoomTimeline
          timeline={timeline}
          runHistory={runHistory}
          runIndex={runEntryById}
          runs={nodeRuns.data?.runs ?? []}
          now={roomNow}
          data={data}
          members={members}
          executingPills={executingPills}
          resolveUser={users.get}
          canceling={cancelCard.isPending}
          onCancel={(id) => cancelCard.mutateAsync(id)}
          onViewRun={setDrawerRunId}
          delivering={deliver.isPending}
          onDeliver={(assignmentId, input) => deliver.mutateAsync({ assignmentId, input })}
        />

        {cancelCard.error !== null && cancelCard.error !== undefined && (
          <ErrorBanner error={cancelCard.error} />
        )}
        {deliver.error !== null && deliver.error !== undefined && (
          <ErrorBanner error={deliver.error} testid="workgroup-room-deliver-error" />
        )}

        <RoomComposer taskId={taskId} canPost={canPost} config={room.data.config} />
      </section>

      <RoomSideCards
        data={data}
        members={members}
        runs={nodeRuns.data?.runs ?? []}
        now={roomNow}
        canPost={canPost}
        onViewRun={setDrawerRunId}
        canceling={cancelCard.isPending}
        onCancel={(id) => cancelCard.mutateAsync(id)}
        gate={{
          pending: confirmGate.isPending,
          error: confirmGate.error,
          onApprove: () => confirmGate.mutate({ decision: 'approve' }),
          onRejectOpen: () => setRejectOpen(true),
        }}
        resumeClarify={{
          pending: resumeClarify.isPending,
          onResume: (stop) => resumeClarify.mutate(stop),
        }}
        onConfigOpen={() => setConfigOpen(true)}
      />

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
          agentId={null}
          runs={drawerRuns}
          outputs={nodeRuns.data.outputs}
          onClose={() => setDrawerRunId(null)}
          onSelectRun={setDrawerRunId}
        />
      )}
    </div>
  )
}

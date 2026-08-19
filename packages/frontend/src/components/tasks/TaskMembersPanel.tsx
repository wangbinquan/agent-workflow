// RFC-099 (D10) — task members panel, hosted in a Dialog behind the
// TaskMembersDialogButton header button (uniform with AclDialogButton on the
// resource pages). Shows owner + task users to every member; owner/ACL-bypass
// holders add & remove users and transfer ownership. Task users hold the same
// operational rights as the owner (D13) — this panel is the only owner-gated
// surface besides task deletion.
//
// Like AclPanel, the panel renders without its own title/border chrome (the
// Dialog provides both) and ends in a footer action row; a successful save
// closes the dialog.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskMembers, UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { currentActorAtRequest, useActor, useAuthSessionRevision } from '@/hooks/useActor'
import { getAuthSessionRevision } from '@/stores/auth'
import { PresenceDot } from '@/components/PresenceDot'
import { usePresenceOf } from '@/hooks/usePresence'
import { Dialog } from '../Dialog'
import { UserPicker } from '../UserPicker'

interface TaskMembersPanelProps {
  taskId: string
  /** Called after a successful save — the hosting dialog closes itself. */
  onSaved?: () => void
  /** Called by the 取消/关闭 footer button. */
  onCancel?: () => void
}

interface MembersSaveRequest {
  session: number
  authRevision: number
  body: { userIds?: string[]; ownerUserId?: string }
}

/**
 * Uniform top-right entry point for task members: header button → Dialog →
 * panel. Hidden under the daemon token (single-user mode).
 */
export function TaskMembersDialogButton({ taskId }: { taskId: string }) {
  const { t } = useTranslation()
  const actor = useActor()
  const authRevision = useAuthSessionRevision()
  const [open, setOpen] = useState(false)
  const actorIsSettledHuman =
    actor.status === 'success' &&
    actor.fetchStatus === 'idle' &&
    actor.data !== null &&
    actor.data !== undefined &&
    actor.data.source !== 'daemon'
  useLayoutEffect(() => {
    if (!actorIsSettledHuman) setOpen(false)
  }, [actorIsSettledHuman])
  useLayoutEffect(() => {
    setOpen(false)
  }, [authRevision])
  if (!actorIsSettledHuman) {
    return null
  }
  return (
    <>
      <button
        type="button"
        className="btn"
        data-testid="task-members-dialog-button"
        onClick={() => setOpen(true)}
      >
        {t('members.title')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('members.title')} size="md">
        <TaskMembersPanel
          taskId={taskId}
          onSaved={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </Dialog>
    </>
  )
}

export function TaskMembersPanel({ taskId, onSaved, onCancel }: TaskMembersPanelProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const actor = useActor()
  const authRevision = useAuthSessionRevision()
  const url = `/api/tasks/${encodeURIComponent(taskId)}/members`
  const queryKey = ['tasks', taskId, 'members', authRevision] as const
  const actorIsSettledHuman =
    actor.status === 'success' &&
    actor.fetchStatus === 'idle' &&
    actor.data !== null &&
    actor.data !== undefined &&
    actor.data.source !== 'daemon'

  const query = useQuery<TaskMembers>({
    queryKey,
    queryFn: ({ signal }) => api.get(url, undefined, signal),
    enabled: actorIsSettledHuman,
  })

  const [members, setMembers] = useState<UserPublic[]>([])
  const [dirty, setDirty] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTo, setTransferTo] = useState<UserPublic[]>([])
  const manageSessionRef = useRef(0)
  const previousCanManageRef = useRef(false)
  const activeTaskIdRef = useRef(taskId)
  const activeAuthRevisionRef = useRef(authRevision)
  const responseTaskIdRef = useRef<string | null>(null)
  const resetSaveRef = useRef<() => void>(() => {})
  const liveCanManage =
    actorIsSettledHuman &&
    query.status === 'success' &&
    query.fetchStatus === 'idle' &&
    query.data?.taskId === taskId &&
    query.data?.canManage === true
  const hasCurrentManageAuthority = (expectedAuthRevision: number): boolean => {
    if (getAuthSessionRevision() !== expectedAuthRevision) return false
    const liveActor = currentActorAtRequest(qc)
    const expectedQueryKey = ['tasks', taskId, 'members', expectedAuthRevision] as const
    const membersState = qc.getQueryState(expectedQueryKey)
    const liveMembers = qc.getQueryData<TaskMembers>(expectedQueryKey)
    return (
      liveActor !== null &&
      liveActor !== undefined &&
      liveActor.source !== 'daemon' &&
      membersState?.status === 'success' &&
      membersState.fetchStatus === 'idle' &&
      liveMembers?.taskId === taskId &&
      liveMembers?.canManage === true
    )
  }

  const save = useMutation({
    mutationFn: ({ body, session, authRevision: requestAuthRevision }: MembersSaveRequest) => {
      if (!hasCurrentManageAuthority(requestAuthRevision) || session !== manageSessionRef.current) {
        throw new Error('Task member management session ended')
      }
      return api.put<TaskMembers>(url, body)
    },
    onSuccess: (next, request) => {
      if (
        !hasCurrentManageAuthority(request.authRevision) ||
        request.session !== manageSessionRef.current
      ) {
        return
      }
      qc.setQueryData(queryKey, next)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      if (request.body.ownerUserId === undefined) onSaved?.()
    },
  })
  resetSaveRef.current = save.reset

  useLayoutEffect(() => {
    const data = query.data
    const lostManage = previousCanManageRef.current && !liveCanManage
    previousCanManageRef.current = liveCanManage
    const taskChanged = activeTaskIdRef.current !== taskId
    activeTaskIdRef.current = taskId
    const authChanged = activeAuthRevisionRef.current !== authRevision
    activeAuthRevisionRef.current = authRevision
    const responseTaskChanged =
      data !== undefined &&
      responseTaskIdRef.current !== null &&
      responseTaskIdRef.current !== data.taskId
    if (data !== undefined) responseTaskIdRef.current = data.taskId
    if (lostManage || taskChanged || authChanged || responseTaskChanged) {
      manageSessionRef.current += 1
      if (data !== undefined) setMembers(data.users)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      resetSaveRef.current()
    }
    if (data === undefined) return
    if (!liveCanManage) {
      setMembers(data.users)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      return
    }
    if (!dirty && !transferOpen) setMembers(data.users)
  }, [authRevision, dirty, liveCanManage, query.data, taskId, transferOpen])

  if (!actorIsSettledHuman) {
    return null
  }
  if (query.data === undefined) return null
  const data = query.data
  const canManage = liveCanManage
  const manageSession = manageSessionRef.current
  const mutationBelongsToSession = save.variables?.session === manageSession
  const savePending = save.isPending && mutationBelongsToSession
  const sessionIsCurrent = (): boolean =>
    manageSession === manageSessionRef.current && hasCurrentManageAuthority(authRevision)

  return (
    <div className="acl-panel" data-testid="task-members-panel">
      <div className="acl-panel__row">
        <span className="acl-panel__label">{t('acl.owner')}</span>
        <span className="acl-panel__value">
          {data.owner !== null ? (
            <span className="chip">
              {data.owner.displayName}
              <span className="user-picker__username">@{data.owner.username}</span>
            </span>
          ) : (
            <span className="muted">{t('acl.systemOwner')}</span>
          )}
          {canManage && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                if (sessionIsCurrent()) setTransferOpen(true)
              }}
              data-testid="members-transfer-owner"
            >
              {t('acl.transferOwner')}
            </button>
          )}
        </span>
      </div>

      <div className="acl-panel__row acl-panel__row--members">
        <span className="acl-panel__label">{t('members.users')}</span>
        {canManage ? (
          <UserPicker
            value={members}
            onChange={(next) => {
              if (!sessionIsCurrent()) return
              setMembers(next)
              setDirty(true)
            }}
            excludeIds={data.ownerUserId !== null ? [data.ownerUserId] : []}
            testidPrefix="members-users"
            // RFC-312 —— 可管理分支的成员由 UserPicker 渲染，只接面板会让 owner 看不到点。
            renderAdornment={(userId) => <MemberPresenceDot userId={userId} />}
          />
        ) : data.users.length === 0 ? (
          <span className="muted">{t('members.noUsers')}</span>
        ) : (
          <span className="acl-panel__value">
            {data.users.map((u) => (
              <MemberChip key={u.id} userId={u.id} displayName={u.displayName} />
            ))}
          </span>
        )}
      </div>

      <p className="acl-panel__hint page__hint">{t('members.hint')}</p>

      {canManage && mutationBelongsToSession && save.error !== null && save.error !== undefined && (
        <p className="form-actions__error">{describeApiError(save.error)}</p>
      )}

      <div className="acl-panel__footer">
        <button type="button" className="btn" onClick={() => onCancel?.()}>
          {canManage ? t('common.cancel') : t('common.close')}
        </button>
        {canManage && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={!dirty || savePending}
            data-testid="members-save"
            onClick={() => {
              if (!sessionIsCurrent()) return
              save.mutate({
                session: manageSession,
                authRevision,
                body: { userIds: members.map((u) => u.id) },
              })
            }}
          >
            {savePending ? t('common.saving') : t('acl.save')}
          </button>
        )}
      </div>

      <Dialog
        open={canManage && transferOpen}
        onClose={() => setTransferOpen(false)}
        title={t('acl.transferTitle')}
        size="sm"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setTransferOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={transferTo.length === 0 || savePending}
              data-testid="members-transfer-confirm"
              onClick={() => {
                if (!sessionIsCurrent()) return
                const target = transferTo[0]
                if (target !== undefined) {
                  save.mutate({
                    session: manageSession,
                    authRevision,
                    body: { ownerUserId: target.id },
                  })
                }
              }}
            >
              {t('acl.transferConfirm')}
            </button>
          </>
        }
      >
        <p className="page__hint">{t('members.transferHint')}</p>
        <UserPicker
          value={transferTo}
          onChange={(next) => {
            if (sessionIsCurrent()) setTransferTo(next)
          }}
          single
          excludeIds={data.ownerUserId !== null ? [data.ownerUserId] : []}
          testidPrefix="members-transfer"
        />
      </Dialog>
    </div>
  )
}

/** RFC-312 —— 成员 chip 带在线点。单独抽出来是因为 hook 不能在 map 回调里调用。 */
function MemberChip({ userId, displayName }: { userId: string; displayName: string }) {
  return (
    <span className="chip">
      <PresenceDot online={usePresenceOf(userId)} />
      {displayName}
    </span>
  )
}

/** hook 不能在 render prop 的内联回调里直接调用，包一层组件。 */
function MemberPresenceDot({ userId }: { userId: string }) {
  return <PresenceDot online={usePresenceOf(userId)} />
}

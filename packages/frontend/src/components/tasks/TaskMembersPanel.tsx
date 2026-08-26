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
import type {
  AssignableTaskMemberRole,
  MembersBase,
  TaskMember,
  TaskMembers,
  UserPublic,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { currentActorAtRequest, useActor, useAuthSessionRevision } from '@/hooks/useActor'
import { getAuthSessionRevision } from '@/stores/auth'
import { TASK_QUERY_KEYS } from '@/lib/query-keys'
import { PresenceDot } from '@/components/PresenceDot'
import { usePresenceOf } from '@/hooks/usePresence'
import { Dialog } from '../Dialog'
import { Segmented } from '../Segmented'
import { UserPicker } from '../UserPicker'

/**
 * RFC-330 —— 成员面板的**资源适配器**：任务与数字员工案例共用同一个面板（wire 基础
 * `MembersBase` 相同），只有「这是哪个资源 / 打哪条 URL / 缓存键 / 响应里的 id 字段 /
 * 保存后要失效谁」五件事因资源而异。任务的默认适配器逐字保留今天的行为。
 */
export interface MembersPanelAdapter {
  readonly resourceId: string
  /** 任务：/api/tasks/:id/members；案例：/api/employee-cases/:id/members。 */
  readonly membersUrl: string
  queryKey(authRevision: number): readonly unknown[]
  /** 响应里标识资源的 id（任务 taskId / 案例 caseId）——用于串线检测。 */
  responseId(data: MembersBase): string
  readonly invalidateKeys: ReadonlyArray<readonly unknown[]>
}

export function taskMembersAdapter(taskId: string): MembersPanelAdapter {
  return {
    resourceId: taskId,
    membersUrl: `/api/tasks/${encodeURIComponent(taskId)}/members`,
    queryKey: (authRevision) => TASK_QUERY_KEYS.members(taskId, authRevision),
    responseId: (data) => (data as TaskMembers).taskId,
    invalidateKeys: [['tasks']],
  }
}

interface MembersPanelProps {
  adapter: MembersPanelAdapter
  /** Called after a successful save — the hosting dialog closes itself. */
  onSaved?: () => void
  /** Called by the 取消/关闭 footer button. */
  onCancel?: () => void
}

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
  body: {
    members?: Array<{ userId: string; role: AssignableTaskMemberRole }>
    ownerUserId?: string
  }
}

/**
 * Uniform top-right entry point for task members: header button → Dialog →
 * panel. Hidden under the daemon token (single-user mode).
 */
export function TaskMembersDialogButton({ taskId }: { taskId: string }) {
  return (
    <MembersDialogButton adapter={taskMembersAdapter(taskId)} testid="task-members-dialog-button" />
  )
}

/** RFC-330 —— 资源中立的入口：header 按钮 → Dialog → 面板；任务 / 案例各给适配器。 */
export function MembersDialogButton({
  adapter,
  testid,
}: {
  adapter: MembersPanelAdapter
  testid: string
}) {
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
      <button type="button" className="btn" data-testid={testid} onClick={() => setOpen(true)}>
        {t('members.title')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('members.title')} size="md">
        <MembersPanel
          adapter={adapter}
          onSaved={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </Dialog>
    </>
  )
}

export function TaskMembersPanel({ taskId, onSaved, onCancel }: TaskMembersPanelProps) {
  return <MembersPanel adapter={taskMembersAdapter(taskId)} onSaved={onSaved} onCancel={onCancel} />
}

export function MembersPanel({ adapter, onSaved, onCancel }: MembersPanelProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const actor = useActor()
  const authRevision = useAuthSessionRevision()
  const resourceId = adapter.resourceId
  const url = adapter.membersUrl
  // 编辑快照的 key 刻意不在 `['tasks', taskId]` 之下——理由见 TASK_QUERY_KEYS.members 的注释
  // （useTaskSync 的 reconcile 前缀会把它打成 fetching，下面的 liveCanManage 就会误判「失去
  // 管理权」并把草稿整体重置；task-members-manage-loss.test.tsx 锁着这两面）。
  const queryKey = adapter.queryKey(authRevision)
  const actorIsSettledHuman =
    actor.status === 'success' &&
    actor.fetchStatus === 'idle' &&
    actor.data !== null &&
    actor.data !== undefined &&
    actor.data.source !== 'daemon'

  const query = useQuery<MembersBase>({
    queryKey,
    queryFn: ({ signal }) => api.get(url, undefined, signal),
    enabled: actorIsSettledHuman,
    // RFC-330 —— 每次打开弹窗都取一次新鲜的判定：这是一个权限承载面（canManage /
    // canOperate），全局 5s staleTime 会让「刚被转移为 owner 又立刻重开面板」的人看到
    // 上一次的只读态；面板的管理会话从首次 idle 起算，多一次 refetch 不影响它。
    refetchOnMount: 'always',
  })

  // RFC-324 —— 成员带档位：collaborator 与 owner 同权（cancel / resume / 回答评审），
  // observer 只能看。新加的人默认 collaborator——这是 RFC-324 之前加人的唯一含义，
  // 保持它意味着既有操作习惯不变，想要只读的人显式选 observer。
  const [members, setMembers] = useState<TaskMember[]>([])
  const [dirty, setDirty] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTo, setTransferTo] = useState<UserPublic[]>([])
  const manageSessionRef = useRef(0)
  const previousCanManageRef = useRef(false)
  const activeResourceIdRef = useRef(resourceId)
  const activeAuthRevisionRef = useRef(authRevision)
  const responseResourceIdRef = useRef<string | null>(null)
  const resetSaveRef = useRef<() => void>(() => {})
  const liveCanManage =
    actorIsSettledHuman &&
    query.status === 'success' &&
    query.fetchStatus === 'idle' &&
    query.data !== undefined &&
    adapter.responseId(query.data) === resourceId &&
    query.data.canManage === true
  const hasCurrentManageAuthority = (expectedAuthRevision: number): boolean => {
    if (getAuthSessionRevision() !== expectedAuthRevision) return false
    const liveActor = currentActorAtRequest(qc)
    const expectedQueryKey = adapter.queryKey(expectedAuthRevision)
    const membersState = qc.getQueryState(expectedQueryKey)
    const liveMembers = qc.getQueryData<MembersBase>(expectedQueryKey)
    return (
      liveActor !== null &&
      liveActor !== undefined &&
      liveActor.source !== 'daemon' &&
      membersState?.status === 'success' &&
      membersState.fetchStatus === 'idle' &&
      liveMembers !== undefined &&
      adapter.responseId(liveMembers) === resourceId &&
      liveMembers.canManage === true
    )
  }

  const save = useMutation({
    mutationFn: ({ body, session, authRevision: requestAuthRevision }: MembersSaveRequest) => {
      if (!hasCurrentManageAuthority(requestAuthRevision) || session !== manageSessionRef.current) {
        throw new Error('Task member management session ended')
      }
      return api.put<MembersBase>(url, body)
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
      for (const key of adapter.invalidateKeys) {
        void qc.invalidateQueries({ queryKey: [...key] })
      }
      if (request.body.ownerUserId === undefined) onSaved?.()
    },
  })
  resetSaveRef.current = save.reset

  useLayoutEffect(() => {
    const data = query.data
    const lostManage = previousCanManageRef.current && !liveCanManage
    previousCanManageRef.current = liveCanManage
    const taskChanged = activeResourceIdRef.current !== resourceId
    activeResourceIdRef.current = resourceId
    const authChanged = activeAuthRevisionRef.current !== authRevision
    activeAuthRevisionRef.current = authRevision
    const responseTaskChanged =
      data !== undefined &&
      responseResourceIdRef.current !== null &&
      responseResourceIdRef.current !== adapter.responseId(data)
    if (data !== undefined) responseResourceIdRef.current = adapter.responseId(data)
    if (lostManage || taskChanged || authChanged || responseTaskChanged) {
      manageSessionRef.current += 1
      if (data !== undefined) setMembers(data.members)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      resetSaveRef.current()
    }
    if (data === undefined) return
    if (!liveCanManage) {
      setMembers(data.members)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      return
    }
    if (!dirty && !transferOpen) setMembers(data.members)
  }, [adapter, authRevision, dirty, liveCanManage, query.data, resourceId, transferOpen])

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
            value={members.map((m) => m.user)}
            onChange={(next) => {
              if (!sessionIsCurrent()) return
              const byId = new Map(members.map((m) => [m.user.id, m]))
              setMembers(
                next.map((u) => byId.get(u.id) ?? { user: u, role: 'collaborator' as const }),
              )
              setDirty(true)
            }}
            excludeIds={data.ownerUserId !== null ? [data.ownerUserId] : []}
            testidPrefix="members-users"
            // RFC-312 —— 可管理分支的成员由 UserPicker 渲染，只接面板会让 owner 看不到点。
            // RFC-324 —— 档位控件与在线点共用这个装饰槽：另起一份成员名单会让同一个人
            // 在面板里出现两次，两份还各自跟着 dirty 状态走。
            renderAdornment={(userId) => {
              const member = members.find((m) => m.user.id === userId)
              return (
                <>
                  <MemberPresenceDot userId={userId} />
                  {member !== undefined && (
                    <Segmented<AssignableTaskMemberRole>
                      className="segmented--compact"
                      value={member.role}
                      onChange={(role) => {
                        if (!sessionIsCurrent()) return
                        setMembers((prev) =>
                          prev.map((x) => (x.user.id === userId ? { ...x, role } : x)),
                        )
                        setDirty(true)
                      }}
                      options={(['collaborator', 'observer'] as const).map((v) => ({
                        value: v,
                        label: t(`members.roleValue.${v}`),
                        testid: `member-role-${v}-${userId}`,
                      }))}
                      ariaLabel={t('members.role')}
                    />
                  )}
                </>
              )
            }}
          />
        ) : data.members.length === 0 ? (
          <span className="muted">{t('members.noUsers')}</span>
        ) : (
          <span className="acl-panel__value">
            {data.members.map((m) => (
              <MemberChip
                key={m.user.id}
                userId={m.user.id}
                displayName={`${m.user.displayName} · ${t(`members.roleValue.${m.role}`)}`}
              />
            ))}
          </span>
        )}
      </div>

      {canManage && members.length > 0 && (
        <p className="acl-panel__hint page__hint">{t('members.roleHint')}</p>
      )}

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
                body: { members: members.map((m) => ({ userId: m.user.id, role: m.role })) },
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
          // 同 AclPanel 的转让弹窗：这个 Dialog 里除了这个 picker 什么都没有，
          // 展开就是它要做的事。（对照：MemberFields 里的 picker 是大编辑器中的一个
          // 字段，不能自动展开——会盖住它下面的别名 / 角色描述。）
          openOnMount
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

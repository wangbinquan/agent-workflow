// RFC-099/RFC-164 — shared permissions panel for the six ACL'd resource types
// (agents / skills / mcps / plugins / workflows / workgroups).
//
// The ONE sanctioned entry point is AclDialogButton: a header button that
// opens the panel inside a Dialog — every surface looks identical. The panel
// itself renders WITHOUT its own title/border chrome (the Dialog provides
// both) and ends in a footer-styled action row: 取消 closes, 保存权限 saves
// AND closes on success (user feedback: the dialog must not linger after a
// successful save).
//
// Visibility rules: owner + visibility + member list are readable by every
// viewer (D16); only the owner and admins edit (D9). Hidden entirely under
// the daemon token (single-user mode — D19).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ResourceAcl,
  ResourceGrant,
  ResourceGrantLevel,
  ResourceVisibility,
  UserPublic,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { meQueryOptions, useActor, useAuthSessionRevision, type MeResponse } from '@/hooks/useActor'
import { getAuthSessionRevision, getToken } from '@/stores/auth'
import { Dialog } from './Dialog'
import { Segmented } from './Segmented'
import { UserPicker } from './UserPicker'

interface AclPanelProps {
  /** e.g. '/api/agents/01JAGENTID' — the panel appends '/acl'. */
  resourceBaseUrl: string
  /** Query key segment to invalidate the parent resource on changes. */
  invalidateKey: readonly unknown[]
  /** Called after a successful save — the hosting dialog closes itself. */
  onSaved?: () => void
  /** Called by the 取消/关闭 footer button. */
  onCancel?: () => void
  /**
   * RFC-170 §8 (G3-2) — when false, the owner-transfer control is hidden
   * (external skills: the backend 403-rejects the transfer since the on-disk
   * content controller ≠ the ACL owner). Grant / visibility edits stay
   * available. Defaults to true (unrestricted — every other resource type).
   */
  canTransferOwner?: boolean
}

type AclSaveBody = {
  visibility?: ResourceVisibility
  grants?: Array<{ userId: string; level: ResourceGrantLevel }>
  ownerUserId?: string
}

interface AclSaveRequest {
  /** Permission/edit-session generation captured by the rendered control. */
  session: number
  authRevision: number
  body: AclSaveBody
}

/**
 * Uniform top-right entry point: header button → Dialog → AclPanel.
 * `size` matches the neighboring header buttons (detail pages use full-size
 * buttons, the workflows editor header uses `sm`).
 */
export function AclDialogButton({
  resourceBaseUrl,
  invalidateKey,
  canTransferOwner,
  size,
}: Pick<AclPanelProps, 'resourceBaseUrl' | 'invalidateKey' | 'canTransferOwner'> & {
  size?: 'sm' | 'md'
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
      <button
        type="button"
        className={size === 'sm' ? 'btn btn--sm' : 'btn'}
        data-testid="acl-dialog-button"
        onClick={() => setOpen(true)}
      >
        {t('acl.title')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('acl.title')} size="md">
        <AclPanel
          resourceBaseUrl={resourceBaseUrl}
          invalidateKey={invalidateKey}
          canTransferOwner={canTransferOwner}
          onSaved={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </Dialog>
    </>
  )
}

export function AclPanel({
  resourceBaseUrl,
  invalidateKey,
  onSaved,
  onCancel,
  canTransferOwner = true,
}: AclPanelProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const actor = useActor()
  const authRevision = useAuthSessionRevision()
  const aclUrl = `${resourceBaseUrl}/acl`
  const aclQueryKey = ['acl', aclUrl, authRevision] as const

  const query = useQuery<ResourceAcl>({
    queryKey: aclQueryKey,
    queryFn: ({ signal }) => api.get(aclUrl, undefined, signal),
    // Single-user daemon mode (D19): no humans, no panel, no fetch.
    enabled:
      actor.status === 'success' &&
      actor.fetchStatus === 'idle' &&
      actor.data !== null &&
      actor.data !== undefined &&
      actor.data.source !== 'daemon',
  })

  const [visibility, setVisibility] = useState<ResourceVisibility>('public')
  // RFC-324 —— 授权名单带档位。新加的人一律落 `read`：安全默认，且与本 RFC 之前
  // 「授权 = 可见可用」的语义逐字相同，所以给既有资源加人不会悄悄多发编辑权。
  const [grants, setGrants] = useState<ResourceGrant[]>([])
  const [dirty, setDirty] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTo, setTransferTo] = useState<UserPublic[]>([])
  // The mutation fence belongs to the snapshot the user started editing,
  // not whichever revision React Query happens to hold when they click Save.
  // Keep it frozen while either ACL editor is open/dirty so a background
  // refetch cannot silently rebase a stale full-replace draft.
  const draftBaselineRef = useRef<Pick<ResourceAcl, 'resourceId' | 'aclRevision'> | null>(null)
  // `canManage` is live authorization, not a mount-time UI choice. Every
  // true→false transition ends the current editing generation so detached DOM
  // handlers and already-started mutations cannot act on a later session.
  const manageSessionRef = useRef(0)
  const previousCanManageRef = useRef(false)
  const activeAclUrlRef = useRef(aclUrl)
  const activeAuthRevisionRef = useRef(authRevision)
  const editSessionIdentityRef = useRef<string | null>(null)
  const resetSaveRef = useRef<() => void>(() => {})
  const liveCanManage =
    actor.status === 'success' &&
    actor.fetchStatus === 'idle' &&
    query.status === 'success' &&
    query.fetchStatus === 'idle' &&
    actor.data !== null &&
    actor.data !== undefined &&
    actor.data.source !== 'daemon' &&
    query.data?.canManage === true
  const hasCurrentManageAuthority = (expectedAuthRevision: number): boolean => {
    if (getAuthSessionRevision() !== expectedAuthRevision) return false
    const actorKey = meQueryOptions(getToken()).queryKey
    const actorState = qc.getQueryState(actorKey)
    const liveActor = qc.getQueryData<MeResponse | null>(actorKey)
    const aclKey = ['acl', aclUrl, expectedAuthRevision] as const
    const aclState = qc.getQueryState(aclKey)
    const liveAcl = qc.getQueryData<ResourceAcl>(aclKey)
    return (
      actorState?.status === 'success' &&
      actorState.fetchStatus === 'idle' &&
      aclState?.status === 'success' &&
      aclState.fetchStatus === 'idle' &&
      liveActor !== null &&
      liveActor !== undefined &&
      liveActor.source !== 'daemon' &&
      liveAcl?.canManage === true
    )
  }
  // WebKit doesn't focus a <button> on mouse click, so the transfer Dialog's
  // auto-captured `document.activeElement` at open time is <body> and its
  // close-time focus-restore becomes a no-op. Hand the Dialog this explicit
  // trigger ref so focus lands back on the transfer button on close (the
  // Dialog contract for this exact case — see Dialog.tsx triggerRef doc).
  // Locked by e2e/rfc099-ownership-acl.spec.ts (Escape→focus-restore, webkit).
  const transferBtnRef = useRef<HTMLButtonElement | null>(null)

  const save = useMutation({
    mutationFn: ({ body, session, authRevision: requestAuthRevision }: AclSaveRequest) => {
      // A stale rendered handler may outlive the control that created it. The
      // backend remains authoritative, but fail closed before issuing a PUT.
      if (!hasCurrentManageAuthority(requestAuthRevision) || session !== manageSessionRef.current) {
        throw new Error('ACL management session ended; reload before saving')
      }
      // RFC-170 §8: echo the composite OCC precondition the panel currently holds
      // so the server CAS-rejects (409) a write racing another writer's change.
      const baseline = draftBaselineRef.current
      if (baseline === null) {
        throw new Error('ACL snapshot unavailable; reload before saving')
      }
      return api.put<ResourceAcl>(aclUrl, {
        ...body,
        expectedResourceId: baseline.resourceId,
        expectedAclRevision: baseline.aclRevision,
      })
    },
    onSuccess: (next, request) => {
      // A request can already be on the wire when access is revoked. Never let
      // its late result overwrite the authoritative downgrade cache, resurrect
      // a draft, or close a newly restored clean session.
      if (
        !hasCurrentManageAuthority(request.authRevision) ||
        request.session !== manageSessionRef.current
      ) {
        return
      }
      qc.setQueryData(['acl', aclUrl, request.authRevision], next)
      draftBaselineRef.current = {
        resourceId: next.resourceId,
        aclRevision: next.aclRevision,
      }
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      void qc.invalidateQueries({ queryKey: invalidateKey })
      // Owner transfer keeps the main dialog open (the panel just changed
      // under you and is worth a glance); a plain save closes it.
      if (request.body.ownerUserId === undefined) onSaved?.()
    },
    onError: (_error, request) => {
      if (
        !hasCurrentManageAuthority(request.authRevision) ||
        request.session !== manageSessionRef.current
      ) {
        return
      }
      // RFC-170 §8: a failed save (esp. a 409 revision conflict) means the panel's
      // held revision is stale — refetch the authoritative owner/grants/revision.
      // The draft fence deliberately stays frozen: retrying the same stale draft
      // must keep conflicting until the user closes/reopens and reviews a fresh
      // snapshot. The error text shows via describeApiError.
      void qc.invalidateQueries({ queryKey: ['acl', aclUrl, request.authRevision] })
    },
  })
  resetSaveRef.current = save.reset

  useLayoutEffect(() => {
    const acl = query.data
    const lostManage = previousCanManageRef.current && !liveCanManage
    previousCanManageRef.current = liveCanManage
    const aclUrlChanged = activeAclUrlRef.current !== aclUrl
    activeAclUrlRef.current = aclUrl
    const authChanged = activeAuthRevisionRef.current !== authRevision
    activeAuthRevisionRef.current = authRevision
    const nextIdentity = acl === undefined ? null : acl.resourceId
    const resourceChanged =
      nextIdentity !== null &&
      editSessionIdentityRef.current !== null &&
      editSessionIdentityRef.current !== nextIdentity
    if (nextIdentity !== null) editSessionIdentityRef.current = nextIdentity

    if (lostManage || aclUrlChanged || authChanged || resourceChanged) {
      // Permission loss and resource identity changes are hard edit-session
      // boundaries. Clear every mutable surface and the frozen OCC baseline
      // before a later grant or cached sibling resource can render.
      manageSessionRef.current += 1
      draftBaselineRef.current = null
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      resetSaveRef.current()
    }

    if (acl === undefined) return
    if (!liveCanManage) {
      // Keep the hidden draft state authoritative too, so false→true cannot
      // flash or revive the values from the ended manager session.
      draftBaselineRef.current = null
      setVisibility(acl.visibility)
      setGrants(acl.grants)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      return
    }
    if (!dirty && !transferOpen) {
      setVisibility(acl.visibility)
      setGrants(acl.grants)
      draftBaselineRef.current = {
        resourceId: acl.resourceId,
        aclRevision: acl.aclRevision,
      }
    }
  }, [aclUrl, authRevision, dirty, liveCanManage, query.data, transferOpen])

  if (
    actor.status !== 'success' ||
    actor.fetchStatus !== 'idle' ||
    actor.data === null ||
    actor.data === undefined ||
    actor.data.source === 'daemon'
  ) {
    return null
  }
  if (query.isLoading) return null
  if (query.error !== null && query.error !== undefined) return null
  const acl = query.data
  if (acl === undefined) return null

  const canManage = liveCanManage
  const manageSession = manageSessionRef.current
  const mutationBelongsToSession = save.variables?.session === manageSession
  const savePending = save.isPending && mutationBelongsToSession
  const sessionIsCurrent = (): boolean =>
    hasCurrentManageAuthority(authRevision) && manageSessionRef.current === manageSession
  const beginManagedDraft = (): boolean => {
    if (!sessionIsCurrent()) return false
    if (!dirty) {
      draftBaselineRef.current = {
        resourceId: acl.resourceId,
        aclRevision: acl.aclRevision,
      }
    }
    return true
  }

  return (
    <div className="acl-panel" data-testid="acl-panel">
      <div className="acl-panel__row">
        <span className="acl-panel__label">{t('acl.owner')}</span>
        <span className="acl-panel__value">
          {acl.owner !== null ? (
            <span className="chip">
              {acl.owner.displayName}
              <span className="user-picker__username">@{acl.owner.username}</span>
            </span>
          ) : (
            <span className="muted">{t('acl.systemOwner')}</span>
          )}
          {canManage && canTransferOwner && (
            <button
              ref={transferBtnRef}
              type="button"
              className="btn btn--sm"
              onClick={() => {
                if (!beginManagedDraft()) return
                setTransferOpen(true)
              }}
              data-testid="acl-transfer-owner"
            >
              {t('acl.transferOwner')}
            </button>
          )}
        </span>
      </div>

      <div className="acl-panel__row">
        <span className="acl-panel__label">{t('acl.visibility')}</span>
        {canManage ? (
          // RFC-150: migrating to <Segmented> also fixes the a11y drift this
          // site had (role="group" without aria-checked → radiogroup/radio).
          <Segmented<ResourceVisibility>
            value={visibility}
            onChange={(v) => {
              if (!beginManagedDraft()) return
              setVisibility(v)
              setDirty(true)
            }}
            options={(['public', 'private'] as const).map((v) => ({
              value: v,
              label: t(`acl.visibilityValue.${v}`),
              testid: `acl-visibility-${v}`,
            }))}
            ariaLabel={t('acl.visibility')}
          />
        ) : (
          <span className="acl-panel__value">{t(`acl.visibilityValue.${acl.visibility}`)}</span>
        )}
      </div>

      <div className="acl-panel__row acl-panel__row--members">
        <span className="acl-panel__label">{t('acl.members')}</span>
        {canManage ? (
          <div className="acl-panel__grants">
            <UserPicker
              value={grants.map((g) => g.user)}
              onChange={(next) => {
                if (!beginManagedDraft()) return
                // Keep the level of anyone already in the list; a newly picked
                // user starts read-only.
                const byId = new Map(grants.map((g) => [g.user.id, g]))
                setGrants(next.map((u) => byId.get(u.id) ?? { user: u, level: 'read' }))
                setDirty(true)
              }}
              excludeIds={acl.ownerUserId !== null ? [acl.ownerUserId] : []}
              testidPrefix="acl-members"
              // RFC-324 —— 档位控件挂进已选 chip 自己的装饰槽（RFC-312 为在线点
              // 开的那个）。做成 chip 外的第二份名单会让同一个人在面板里出现两次，
              // 而这两份还得各自跟着 dirty 状态走。
              renderAdornment={(userId) => {
                const grant = grants.find((g) => g.user.id === userId)
                if (grant === undefined) return null
                return (
                  <>
                    <Segmented<ResourceGrantLevel>
                      className="segmented--compact"
                      value={grant.level}
                      onChange={(level) => {
                        if (!beginManagedDraft()) return
                        setGrants((prev) =>
                          prev.map((x) => (x.user.id === userId ? { ...x, level } : x)),
                        )
                        setDirty(true)
                      }}
                      options={(['read', 'write'] as const).map((v) => ({
                        value: v,
                        label: t(`acl.levelValue.${v}`),
                        testid: `acl-level-${v}-${userId}`,
                      }))}
                      ariaLabel={t('acl.level')}
                    />
                    {(grant.user.role === 'admin' || grant.user.role === 'manager') && (
                      <span
                        className="acl-panel__grant-note muted"
                        title={t('acl.levelAdminHint')}
                        data-testid={`acl-level-admin-note-${userId}`}
                      >
                        ⚠
                      </span>
                    )}
                  </>
                )
              }}
            />
            {grants.length > 0 && (
              <p className="acl-panel__hint page__hint">{t('acl.levelHint')}</p>
            )}
          </div>
        ) : acl.grants.length === 0 ? (
          <span className="muted">{t('acl.noMembers')}</span>
        ) : (
          <span className="acl-panel__value">
            {acl.grants.map((g) => (
              <span key={g.user.id} className="chip">
                {g.user.displayName}
                <span className="user-picker__username">{t(`acl.levelValue.${g.level}`)}</span>
              </span>
            ))}
          </span>
        )}
      </div>

      {(canManage ? visibility : acl.visibility) === 'private' && (
        <p className="acl-panel__hint page__hint">{t('acl.privateHint')}</p>
      )}

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
            data-testid="acl-save"
            onClick={() => {
              if (!sessionIsCurrent()) return
              save.mutate({
                session: manageSession,
                authRevision,
                body: {
                  visibility,
                  grants: grants.map((g) => ({ userId: g.user.id, level: g.level })),
                },
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
        data-testid="acl-transfer-dialog"
        triggerRef={transferBtnRef}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setTransferOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={transferTo.length === 0 || savePending}
              data-testid="acl-transfer-confirm"
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
        <p className="page__hint">{t('acl.transferHint')}</p>
        <UserPicker
          value={transferTo}
          onChange={(next) => {
            if (sessionIsCurrent()) setTransferTo(next)
          }}
          single
          excludeIds={acl.ownerUserId !== null ? [acl.ownerUserId] : []}
          testidPrefix="acl-transfer"
        />
      </Dialog>
    </div>
  )
}

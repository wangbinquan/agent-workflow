// RFC-099/RFC-164/RFC-324 — shared resource ACL panel. Frontend surfaces that
// expose the standard resource `/acl` contract reuse this body, either directly
// in their own Dialog or through AclDialogButton. Some backend ACL resource
// types do not yet have a user-facing permission entry. Account roles, task
// membership and token scopes are separate permission systems by design.
//
// The panel renders WITHOUT its own title/border chrome (the Dialog provides
// both) and ends in a footer-styled action row: 取消 closes, 保存权限 saves AND
// closes on success (user feedback: the dialog must not linger after save).
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
import { accountInitials } from '@/lib/account-user-presentation'
import { getAuthSessionRevision, getToken } from '@/stores/auth'
import { Dialog } from './Dialog'
import { EmptyState } from './EmptyState'
import { ErrorBanner } from './ErrorBanner'
import { LoadingState } from './LoadingState'
import { NoticeBanner } from './NoticeBanner'
import { Segmented } from './Segmented'
import { StatusChip } from './StatusChip'
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

function aclInitials(user: Pick<UserPublic, 'displayName' | 'username'>): string {
  // Parenthetical qualifiers such as "Bob (mock)" should not turn into the
  // punctuation avatar "B(". Keep letters/numbers from the display label and
  // let the shared account helper handle scripts, words and username fallback.
  const displayName = user.displayName.replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim()
  return accountInitials(displayName, user.username)
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
  if (query.data === undefined) {
    if (query.error !== null && query.error !== undefined) {
      return (
        <div className="acl-panel acl-panel--state">
          <ErrorBanner
            error={query.error}
            onRetry={() => void query.refetch()}
            testid="acl-load-error"
          />
          <div className="acl-panel__footer">
            <button type="button" className="btn" onClick={() => onCancel?.()}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )
    }
    if (query.isLoading) {
      return (
        <div className="acl-panel acl-panel--state">
          <LoadingState size="compact" data-testid="acl-loading" />
        </div>
      )
    }
    return null
  }
  const acl = query.data

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
  const renderedVisibility = canManage ? visibility : acl.visibility
  const renderedGrants = canManage ? grants : acl.grants
  const hasExecutionRisk =
    (acl.resourceType === 'mcp' || acl.resourceType === 'development_adapter') &&
    renderedGrants.some((grant) => grant.level === 'write')

  return (
    <div className="acl-panel" data-testid="acl-panel">
      <p className="acl-panel__intro">{t('acl.description')}</p>

      <section className="acl-panel__section">
        <div className="acl-panel__section-header">
          <div>
            <h3>{t('acl.members')}</h3>
            <p>{t('acl.membersHint')}</p>
          </div>
        </div>

        {canManage && (
          <div className="acl-panel__add-member">
            <span className="acl-panel__field-label">{t('acl.addMember')}</span>
            <UserPicker
              value={[]}
              onChange={(next) => {
                const picked = next[0]
                if (picked === undefined || grants.some((grant) => grant.user.id === picked.id)) {
                  return
                }
                if (!beginManagedDraft()) return
                // Adding a member is a single, complete action. Keep selected
                // people out of the search field and default every new grant
                // to the safe read-only level.
                setGrants((prev) => [...prev, { user: picked, level: 'read' }])
                setDirty(true)
              }}
              single
              activeOnly
              excludeIds={[
                ...(acl.ownerUserId !== null ? [acl.ownerUserId] : []),
                ...grants.map((grant) => grant.user.id),
              ]}
              placeholder={t('acl.addMemberPlaceholder')}
              aria-label={t('acl.addMember')}
              testidPrefix="acl-members"
            />
          </div>
        )}

        <div className="acl-panel__people-list">
          <div
            className="acl-panel__person-row acl-panel__person-row--owner"
            data-testid="acl-owner-row"
          >
            <div className="acl-panel__person-identity">
              <span className="acl-panel__avatar" aria-hidden="true">
                {acl.owner !== null ? aclInitials(acl.owner) : 'S'}
              </span>
              <span className="acl-panel__person-copy">
                <span className="acl-panel__person-name">
                  {acl.owner?.displayName ?? t('acl.systemOwner')}
                  <StatusChip kind="info" size="sm">
                    {t('acl.ownerBadge')}
                  </StatusChip>
                </span>
                {acl.owner !== null && (
                  <span className="acl-panel__person-username">@{acl.owner.username}</span>
                )}
              </span>
            </div>
            {canManage && canTransferOwner && (
              <div className="acl-panel__person-actions">
                <button
                  ref={transferBtnRef}
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => {
                    if (!beginManagedDraft()) return
                    setTransferOpen(true)
                  }}
                  data-testid="acl-transfer-owner"
                >
                  {t('acl.transferOwner')}
                </button>
              </div>
            )}
          </div>

          {renderedGrants.length === 0 ? (
            <EmptyState
              title={t('acl.noMembers')}
              description={t('acl.noMembersDescription')}
              size="compact"
              data-testid="acl-members-empty"
            />
          ) : (
            renderedGrants.map((grant) => (
              <div
                key={grant.user.id}
                className="acl-panel__person-row"
                data-testid={`acl-grant-${grant.user.id}`}
              >
                <div className="acl-panel__person-main">
                  <div className="acl-panel__person-identity">
                    <span className="acl-panel__avatar" aria-hidden="true">
                      {aclInitials(grant.user)}
                    </span>
                    <span className="acl-panel__person-copy">
                      <span className="acl-panel__person-name">{grant.user.displayName}</span>
                      <span className="acl-panel__person-username">@{grant.user.username}</span>
                    </span>
                  </div>
                  {(grant.user.role === 'admin' || grant.user.role === 'manager') && (
                    <p
                      className="acl-panel__grant-warning"
                      data-testid={`acl-level-admin-note-${grant.user.id}`}
                    >
                      {t('acl.levelAdminHint')}
                    </p>
                  )}
                </div>
                <div className="acl-panel__person-actions">
                  {canManage ? (
                    <>
                      <Segmented<ResourceGrantLevel>
                        className="segmented--compact"
                        value={grant.level}
                        onChange={(level) => {
                          if (!beginManagedDraft()) return
                          setGrants((prev) =>
                            prev.map((current) =>
                              current.user.id === grant.user.id ? { ...current, level } : current,
                            ),
                          )
                          setDirty(true)
                        }}
                        options={(['read', 'write'] as const).map((level) => ({
                          value: level,
                          label: t(`acl.levelValue.${level}`),
                          testid: `acl-level-${level}-${grant.user.id}`,
                        }))}
                        ariaLabel={`${grant.user.displayName} · ${t('acl.level')}`}
                      />
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost btn--danger"
                        aria-label={t('userPicker.remove', { name: grant.user.displayName })}
                        data-testid={`acl-members-remove-${grant.user.username}`}
                        onClick={() => {
                          if (!beginManagedDraft()) return
                          setGrants((prev) =>
                            prev.filter((current) => current.user.id !== grant.user.id),
                          )
                          setDirty(true)
                        }}
                      >
                        {t('common.remove')}
                      </button>
                    </>
                  ) : (
                    <StatusChip kind={grant.level === 'write' ? 'info' : 'neutral'} size="sm">
                      {t(`acl.levelValue.${grant.level}`)}
                    </StatusChip>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="acl-panel__level-guide">
          {(['read', 'write'] as const).map((level) => (
            <div key={level} className="acl-panel__level-guide-item">
              <strong>{t(`acl.levelValue.${level}`)}</strong>
              <span>{t(`acl.levelDescription.${level}`)}</span>
            </div>
          ))}
          <p>{t('acl.levelHint')}</p>
        </div>
      </section>

      {hasExecutionRisk && (
        <NoticeBanner
          tone="warning"
          size="compact"
          title={t('acl.executionRiskTitle')}
          testid="acl-execution-risk"
        >
          {t('acl.executionRiskHint')}
        </NoticeBanner>
      )}

      <section className="acl-panel__section">
        <div className="acl-panel__section-header">
          <h3>{t('acl.visibility')}</h3>
          {canManage ? (
            // RFC-150: radiogroup semantics make arrow-key selection and the
            // current value explicit to assistive technology.
            <Segmented<ResourceVisibility>
              value={visibility}
              onChange={(nextVisibility) => {
                if (!beginManagedDraft()) return
                setVisibility(nextVisibility)
                setDirty(true)
              }}
              options={(['public', 'private'] as const).map((value) => ({
                value,
                label: t(`acl.visibilityValue.${value}`),
                testid: `acl-visibility-${value}`,
              }))}
              ariaLabel={t('acl.visibility')}
            />
          ) : (
            <StatusChip kind={acl.visibility === 'public' ? 'info' : 'neutral'} size="sm">
              {t(`acl.visibilityValue.${acl.visibility}`)}
            </StatusChip>
          )}
        </div>
        <p className="acl-panel__visibility-hint">
          {t(`acl.visibilityHint.${renderedVisibility}`)}
        </p>
      </section>

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
          // 这个弹窗除了这个 picker 什么都没有，展开就是它要做的事；`rfc099-ownership-acl`
          // 的两段式 Escape（第一下关列表、第二下关内层弹窗）也依赖它一开始就是展开的。
          openOnMount
          excludeIds={acl.ownerUserId !== null ? [acl.ownerUserId] : []}
          testidPrefix="acl-transfer"
        />
      </Dialog>
    </div>
  )
}

// RFC-099 — shared permissions panel for the five ACL'd resource types
// (agents / skills / mcps / plugins / workflows).
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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ResourceAcl, ResourceVisibility, UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { useActor } from '@/hooks/useActor'
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
  const [open, setOpen] = useState(false)
  if (actor.data === null || actor.data === undefined || actor.data.source === 'daemon') {
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
  const aclUrl = `${resourceBaseUrl}/acl`

  const query = useQuery<ResourceAcl>({
    queryKey: ['acl', aclUrl],
    queryFn: ({ signal }) => api.get(aclUrl, undefined, signal),
    // Single-user daemon mode (D19): no humans, no panel, no fetch.
    enabled: actor.data !== null && actor.data !== undefined && actor.data.source !== 'daemon',
  })

  const [visibility, setVisibility] = useState<ResourceVisibility>('public')
  const [members, setMembers] = useState<UserPublic[]>([])
  const [dirty, setDirty] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTo, setTransferTo] = useState<UserPublic[]>([])
  // WebKit doesn't focus a <button> on mouse click, so the transfer Dialog's
  // auto-captured `document.activeElement` at open time is <body> and its
  // close-time focus-restore becomes a no-op. Hand the Dialog this explicit
  // trigger ref so focus lands back on the transfer button on close (the
  // Dialog contract for this exact case — see Dialog.tsx triggerRef doc).
  // Locked by e2e/rfc099-ownership-acl.spec.ts (Escape→focus-restore, webkit).
  const transferBtnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (query.data !== undefined && !dirty) {
      setVisibility(query.data.visibility)
      setMembers(query.data.users)
    }
  }, [query.data, dirty])

  const save = useMutation({
    mutationFn: (body: {
      visibility?: ResourceVisibility
      userIds?: string[]
      ownerUserId?: string
    }) => {
      // RFC-170 §8: echo the composite OCC precondition the panel currently holds
      // so the server CAS-rejects (409) a write racing another writer's change.
      const current = qc.getQueryData<ResourceAcl>(['acl', aclUrl])
      return api.put<ResourceAcl>(aclUrl, {
        ...body,
        ...(current !== undefined
          ? { expectedResourceId: current.resourceId, expectedAclRevision: current.aclRevision }
          : {}),
      })
    },
    onSuccess: (next, body) => {
      qc.setQueryData(['acl', aclUrl], next)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      void qc.invalidateQueries({ queryKey: invalidateKey })
      // Owner transfer keeps the main dialog open (the panel just changed
      // under you and is worth a glance); a plain save closes it.
      if (body.ownerUserId === undefined) onSaved?.()
    },
    onError: () => {
      // RFC-170 §8: a failed save (esp. a 409 revision conflict) means the panel's
      // held revision is stale — refetch so it shows the current owner/grants/
      // revision (and a retry uses the fresh revision). The draft stays dirty so
      // the user can review + re-apply; the error text shows via describeApiError.
      void qc.invalidateQueries({ queryKey: ['acl', aclUrl] })
    },
  })

  if (actor.data === null || actor.data === undefined || actor.data.source === 'daemon') {
    return null
  }
  if (query.isLoading) return null
  if (query.error !== null && query.error !== undefined) return null
  const acl = query.data
  if (acl === undefined) return null

  const canManage = acl.canManage

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
              onClick={() => setTransferOpen(true)}
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
          <UserPicker
            value={members}
            onChange={(next) => {
              setMembers(next)
              setDirty(true)
            }}
            excludeIds={acl.ownerUserId !== null ? [acl.ownerUserId] : []}
            testidPrefix="acl-members"
          />
        ) : members.length === 0 ? (
          <span className="muted">{t('acl.noMembers')}</span>
        ) : (
          <span className="acl-panel__value">
            {members.map((u) => (
              <span key={u.id} className="chip">
                {u.displayName}
              </span>
            ))}
          </span>
        )}
      </div>

      {visibility === 'private' && (
        <p className="acl-panel__hint page__hint">{t('acl.privateHint')}</p>
      )}

      {save.error !== null && save.error !== undefined && (
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
            disabled={!dirty || save.isPending}
            data-testid="acl-save"
            onClick={() => save.mutate({ visibility, userIds: members.map((u) => u.id) })}
          >
            {save.isPending ? t('common.saving') : t('acl.save')}
          </button>
        )}
      </div>

      <Dialog
        open={transferOpen}
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
              disabled={transferTo.length === 0 || save.isPending}
              data-testid="acl-transfer-confirm"
              onClick={() => {
                const target = transferTo[0]
                if (target !== undefined) save.mutate({ ownerUserId: target.id })
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
          onChange={setTransferTo}
          single
          excludeIds={acl.ownerUserId !== null ? [acl.ownerUserId] : []}
          testidPrefix="acl-transfer"
        />
      </Dialog>
    </div>
  )
}

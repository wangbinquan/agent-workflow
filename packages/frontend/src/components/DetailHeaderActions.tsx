// RFC-151 PR-4 — detail-page header frame, single-sourced.
//
// The editable resource detail pages share the PageHeader skeleton whose
// `page__actions` cluster keeps page-specific extras → Save → More. Secondary
// resource administration (export / ACL / delete) lives in that shared More
// surface. Mutation feedback remains OUTSIDE the flex header, so long errors
// never get squeezed into the top-right corner (plugins-page-wiring lock) —
// by one <ErrorBanner> block per failed mutation channel (RFC-203 T5a: the
// delete-refused errors carry principal-aware reference lists that only the
// rich ErrorDetails path can render; the old string-shell span dropped them).
//
// Contract notes (RFC-151 design gate revision):
//   - `save` is fully caller-owned: label (incl. pending switching), onClick
//     (validation, multi-mutation fan-out), disabled gating. The shell only
//     renders the primary button.
//   - `errors` is an array so multi-channel pages (skills: saveMeta /
//     saveContent / del) surface every failure independently — a single
//     `save.error` slot could not represent two failed channels at once.
//   - `title` / `headingLevel` delegate the semantic outline to PageHeader;
//     the error row remains its sibling (one flex row for title + actions,
//     errors on their own row below).

import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AclPanel } from '@/components/AclPanel'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { PageHeader } from '@/components/PageHeader'
import { ResourceActionItem, ResourceActionList } from '@/components/ResourceActionList'
import { useActor } from '@/hooks/useActor'

export interface DetailHeaderActionsProps {
  /** Resource name rendered by the shared PageHeader heading. */
  title: ReactNode
  /** Split-detail routes use h2 because their mounted rail already owns h1. */
  headingLevel?: 1 | 2
  acl?: {
    /** e.g. '/api/agents/01JAGENTID' — AclDialogButton appends '/acl'. */
    resourceBaseUrl: string
    invalidateKey: readonly unknown[]
    /** RFC-170 §8 — false hides the owner-transfer control (external skills). */
    canTransferOwner?: boolean
  }
  /** Omit on autosave-owned detail pages. */
  save?: {
    /** Button text — caller switches pending/idle labels itself.
     *  Defaults to the plain common.save copy. */
    label?: string
    onClick: () => void
    disabled: boolean
    /** Hover tooltip — RFC-168: explains WHY save is disabled (e.g. a mode /
     *  member compatibility error) so the button is never mutely inert. */
    title?: string
    testid?: string
  }
  del?: {
    label: string
    /**
     * RFC-222 (D5): receives the user's typed confirmation text. The caller
     * MUST forward `ctx.typedConfirm` into the DELETE body (never the known
     * name constant) so the server-side check is authoritative.
     */
    onConfirm: (ctx?: { typedConfirm?: string }) => unknown | Promise<unknown>
    /** Typically del.isPending — blocks double-fire while in flight. */
    disabled?: boolean
    /** RFC-222 (D5): the exact current name the user must type to confirm. */
    confirmName: string
    /** Resource-type slug for the dialog copy (agent / skill / workflow …). */
    resourceType: string
  }
  /** Page-specific leading actions (e.g. skills' Fuse button). */
  extra?: ReactNode
  /** Resource-specific secondary actions rendered inside the shared More dialog. */
  moreActions?: ReactNode
  /** Mutation error channels; each non-nullish entry renders its own
   *  <ErrorBanner> block (localized title + structured details + raw fold). */
  errors: ReadonlyArray<unknown>
}

export function DetailHeaderActions(props: DetailHeaderActionsProps) {
  const { t } = useTranslation()
  const actor = useActor()
  const present = props.errors.filter((e) => e !== null && e !== undefined)
  const [surface, setSurface] = useState<'actions' | 'acl' | 'delete' | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const hasAcl =
    props.acl !== undefined &&
    actor.data !== null &&
    actor.data !== undefined &&
    actor.data.source !== 'daemon'
  const hasMoreActions =
    (props.moreActions !== null &&
      props.moreActions !== undefined &&
      props.moreActions !== false) ||
    hasAcl ||
    props.del !== undefined
  return (
    <>
      <PageHeader
        title={props.title}
        headingLevel={props.headingLevel}
        actions={
          <>
            {props.extra}
            {props.save !== undefined && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={props.save.disabled}
                onClick={props.save.onClick}
                title={props.save.title}
                data-testid={props.save.testid}
              >
                {props.save.label ?? t('common.save')}
              </button>
            )}
            {hasMoreActions && (
              <button
                ref={moreTriggerRef}
                type="button"
                className="btn"
                onClick={() => setSurface('actions')}
                data-testid="detail-more-actions"
              >
                {t('common.more')}
              </button>
            )}
          </>
        }
      />
      <Dialog
        open={surface === 'actions'}
        onClose={() => setSurface(null)}
        title={t('common.moreActions')}
        triggerRef={moreTriggerRef}
        dismissDisabled={moreBusy}
        data-testid="detail-actions-dialog"
      >
        <ResourceActionList onBusyChange={setMoreBusy}>
          {props.moreActions}
          {hasAcl ? (
            <ResourceActionItem
              label={t('acl.title')}
              description={t('editor.aclActionHint')}
              onClick={() => setSurface('acl')}
              data-testid="acl-dialog-button"
            />
          ) : null}
          {props.del !== undefined && (
            <ResourceActionItem
              label={props.del.label}
              description={t('common.deleteResourceActionHint')}
              tone="danger"
              disabled={props.del.disabled}
              onClick={() => setSurface('delete')}
              data-testid="detail-delete-button"
            />
          )}
        </ResourceActionList>
      </Dialog>
      {props.acl !== undefined && (
        <Dialog
          open={surface === 'acl'}
          onClose={() => setSurface(null)}
          title={t('acl.title')}
          triggerRef={moreTriggerRef}
          data-testid="detail-acl-dialog"
        >
          <AclPanel
            resourceBaseUrl={props.acl.resourceBaseUrl}
            invalidateKey={props.acl.invalidateKey}
            canTransferOwner={props.acl.canTransferOwner}
            onSaved={() => setSurface(null)}
            onCancel={() => setSurface(null)}
          />
        </Dialog>
      )}
      {props.del !== undefined && (
        <ConfirmDialog
          open={surface === 'delete'}
          title={t('common.deleteConfirm.title', { name: props.del.confirmName })}
          description={t('common.deleteConfirm.body')}
          confirmLabel={props.del.label}
          tone="danger"
          confirmInput={{
            expected: props.del.confirmName,
            label: t('common.deleteConfirm.inputLabel', { name: props.del.confirmName }),
            placeholder: props.del.confirmName,
          }}
          onConfirm={async (ctx) => {
            await props.del?.onConfirm(ctx)
          }}
          onClose={() => setSurface(null)}
          triggerRef={moreTriggerRef}
        />
      )}
      <FeedbackStack variant="section">
        {present.map((e, i) => (
          <ErrorBanner error={e} key={i} />
        ))}
      </FeedbackStack>
    </>
  )
}

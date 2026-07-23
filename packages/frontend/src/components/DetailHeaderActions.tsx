// RFC-151 PR-4 — detail-page header frame, single-sourced.
//
// The editable resource detail pages share the PageHeader skeleton whose
// `page__actions` cluster keeps page-specific extras → AclDialogButton → Save →
// delete ConfirmButton, followed — OUTSIDE the flex header, so long errors
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

import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AclDialogButton } from '@/components/AclPanel'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { PageHeader } from '@/components/PageHeader'

export interface DetailHeaderActionsProps {
  /** Resource name rendered by the shared PageHeader heading. */
  title: ReactNode
  /** Split-detail routes use h2 because their mounted rail already owns h1. */
  headingLevel?: 1 | 2
  acl: {
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
  del: {
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
  /** Mutation error channels; each non-nullish entry renders its own
   *  <ErrorBanner> block (localized title + structured details + raw fold). */
  errors: ReadonlyArray<unknown>
}

export function DetailHeaderActions(props: DetailHeaderActionsProps) {
  const { t } = useTranslation()
  const present = props.errors.filter((e) => e !== null && e !== undefined)
  // RFC-222 (D5): destructive delete now opens a type-to-confirm modal.
  const [confirmOpen, setConfirmOpen] = useState(false)
  return (
    <>
      <PageHeader
        title={props.title}
        headingLevel={props.headingLevel}
        actions={
          <>
            {props.extra}
            <AclDialogButton
              resourceBaseUrl={props.acl.resourceBaseUrl}
              invalidateKey={props.acl.invalidateKey}
              canTransferOwner={props.acl.canTransferOwner}
            />
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
            <button
              type="button"
              className="btn btn--danger"
              disabled={props.del.disabled}
              onClick={() => setConfirmOpen(true)}
              data-testid="detail-delete-button"
            >
              {props.del.label}
            </button>
          </>
        }
      />
      <ConfirmDialog
        open={confirmOpen}
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
          await props.del.onConfirm(ctx)
        }}
        onClose={() => setConfirmOpen(false)}
      />
      {present.map((e, i) => (
        <ErrorBanner error={e} key={i} />
      ))}
    </>
  )
}

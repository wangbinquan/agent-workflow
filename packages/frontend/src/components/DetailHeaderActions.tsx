// RFC-151 PR-4 — detail-page header frame, single-sourced.
//
// The four resource detail pages (agents / mcps / plugins / skills) shared a
// byte-identical skeleton: `page__header--row` header whose right side is a
// `page__actions` cluster (page-specific extras → AclDialogButton → Save →
// delete ConfirmButton), followed — OUTSIDE the flex header, so long errors
// never get squeezed into the top-right corner (plugins-page-wiring lock) —
// by a `.form-actions` row rendering one `form-actions__error` span per
// failed mutation channel.
//
// Contract notes (RFC-151 design gate revision):
//   - `save` is fully caller-owned: label (incl. pending switching), onClick
//     (validation, multi-mutation fan-out), disabled gating. The shell only
//     renders the primary button.
//   - `errors` is an array so multi-channel pages (skills: saveMeta /
//     saveContent / del) surface every failure independently — a single
//     `save.error` slot could not represent two failed channels at once.
//   - The page title block is the `children` slot; the component owns the
//     header element so the error row can render as its sibling (one flex
//     row for title + actions, errors on their own row below).

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AclDialogButton } from '@/components/AclPanel'
import { ConfirmButton } from '@/components/ConfirmButton'
import { describeApiError } from '@/i18n'

export interface DetailHeaderActionsProps {
  acl: {
    /** e.g. '/api/agents/my-agent' — AclDialogButton appends '/acl'. */
    resourceBaseUrl: string
    invalidateKey: readonly unknown[]
    /** RFC-170 §8 — false hides the owner-transfer control (external skills). */
    canTransferOwner?: boolean
  }
  save: {
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
    onConfirm: () => unknown | Promise<unknown>
    /** Typically del.isPending — blocks double-fire while in flight. */
    disabled?: boolean
  }
  /** Page-specific leading actions (e.g. skills' Fuse button). */
  extra?: ReactNode
  /** Mutation error channels; each non-nullish entry renders its own
   *  form-actions__error span through describeApiError. */
  errors: ReadonlyArray<unknown>
  /** The header's title block (`<div><h1>…</h1><p className="page__hint">…</p></div>`). */
  children: ReactNode
}

export function DetailHeaderActions(props: DetailHeaderActionsProps) {
  const { t } = useTranslation()
  const present = props.errors.filter((e) => e !== null && e !== undefined)
  return (
    <>
      <header className="page__header page__header--row">
        {props.children}
        <div className="page__actions">
          {props.extra}
          <AclDialogButton
            resourceBaseUrl={props.acl.resourceBaseUrl}
            invalidateKey={props.acl.invalidateKey}
            canTransferOwner={props.acl.canTransferOwner}
          />
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
          <ConfirmButton
            label={props.del.label}
            onConfirm={props.del.onConfirm}
            variant="danger"
            disabled={props.del.disabled}
          />
        </div>
      </header>
      {present.length > 0 && (
        <div className="form-actions">
          {present.map((e, i) => (
            <span className="form-actions__error" key={i}>
              {describeApiError(e)}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

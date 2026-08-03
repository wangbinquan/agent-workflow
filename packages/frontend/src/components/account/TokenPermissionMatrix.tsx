// RFC-247 D3 / D4 / C10 — the token authorization matrix.
//
// A grid of (resource × verb) checkboxes. The derivation lives in
// `lib/token-matrix.ts` so it can be asserted without a DOM; this file is the
// rendering only.
//
// Two rules the layout encodes rather than states:
//
//  · Reads are not on the grid. A token always carries the read points its
//    owner's role has, so a read column would be four hundred ticked boxes the
//    user cannot untick — a control that only ever lies about being a control.
//  · A verb the role cannot grant leaves its grid slot EMPTY instead of
//    rendering a disabled box. The columns stay aligned either way, and an
//    empty slot says "not a thing you have" where a disabled box would say
//    "a thing you have, switched off" (AC-23).

import { useTranslation } from 'react-i18next'
import { MATRIX_VERBS, type Permission, type Role } from '@agent-workflow/shared'
import { Checkbox } from '@/components/Form'
import { buildMatrix } from '@/lib/token-matrix'

export interface TokenPermissionMatrixProps {
  role: Role
  selected: ReadonlySet<Permission>
  onToggle: (permission: Permission, next: boolean) => void
  disabled?: boolean
  /** `${prefix}-cell-${permission}` on every checkbox. */
  testidPrefix?: string
}

export function TokenPermissionMatrix({
  role,
  selected,
  onToggle,
  disabled,
  testidPrefix,
}: TokenPermissionMatrixProps) {
  const { t } = useTranslation()
  const rows = buildMatrix(role)
  return (
    <div className="token-matrix" role="group" aria-label={t('account.token.matrixLabel')}>
      <div className="token-matrix__head" aria-hidden="true">
        <span />
        {MATRIX_VERBS.map((verb) => (
          <span key={verb} className="token-matrix__verb">
            {t(`account.token.verb.${verb}`)}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.resource} className="token-matrix__row">
          <span className="token-matrix__resource">
            {t(`account.token.resource.${row.resource}`)}
          </span>
          {MATRIX_VERBS.map((verb) => {
            const cell = row.cells.find((c) => c.verb === verb)
            if (cell === undefined) return <span key={verb} className="token-matrix__cell" />
            return (
              <span
                key={verb}
                className={
                  'token-matrix__cell' + (cell.isDelete ? ' token-matrix__cell--delete' : '')
                }
              >
                <span className="token-matrix__cell-verb" aria-hidden="true">
                  {t(`account.token.verb.${verb}`)}
                </span>
                <Checkbox
                  checked={selected.has(cell.permission)}
                  onChange={(next) => onToggle(cell.permission, next)}
                  disabled={disabled}
                  // The accessible name has to carry BOTH axes: a screen reader
                  // moving down the grid hears "delete, delete, delete…" if the
                  // name is only the column header, and the row label is
                  // visually adjacent but not programmatically associated.
                  aria-label={t('account.token.cellLabel', {
                    verb: t(`account.token.verb.${verb}` as const),
                    resource: t(`account.token.resource.${row.resource}` as const),
                  })}
                  data-testid={
                    testidPrefix === undefined
                      ? undefined
                      : `${testidPrefix}-cell-${cell.permission}`
                  }
                />
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}

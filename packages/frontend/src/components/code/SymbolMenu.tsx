// RFC-258 §4.3 — the definitions/references menu behind an identifier click.
// A light in-container popover (namespaced .symbol-menu chrome; entries are
// real buttons → native keyboard). Honesty rules from the gate:
//  - F-07: the actual engine + degradedReason are always visible.
//  - F-08: baseline references are labelled as GUESSES (may miss AND
//    over-report), inferred entries carry a per-row badge.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { CodePosition, SymbolResolution } from '@agent-workflow/shared'

export interface SymbolMenuProps {
  resolution: SymbolResolution | null
  loading: boolean
  /** Query failure — render an honest error line, not an empty box (P2-1). */
  error?: boolean
  /** Container-relative anchor for the popover. */
  anchor: { x: number; y: number }
  onSelect: (pos: CodePosition) => void
  onClose: () => void
}

function rowLabel(pos: CodePosition): string {
  const file = pos.filePath.split('/').pop() ?? pos.filePath
  return `${file}:${pos.startLine}`
}

export function SymbolMenu({
  resolution,
  loading,
  error = false,
  anchor,
  onSelect,
  onClose,
}: SymbolMenuProps) {
  const { t } = useTranslation()
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const empty =
    resolution !== null && resolution.definitions.length === 0 && resolution.references.length === 0

  return (
    <div
      className="symbol-menu"
      role="menu"
      aria-label={t('tasks.codeIntelMenuLabel')}
      style={{ left: anchor.x, top: anchor.y }}
    >
      {loading && <div className="symbol-menu__note">{t('tasks.codeIntelLoading')}</div>}
      {!loading && error && resolution === null && (
        <div className="symbol-menu__note">{t('tasks.codeIntelError')}</div>
      )}
      {resolution !== null && (
        <>
          <div className="symbol-menu__head">
            <span className="structure__tag">
              {resolution.engine === 'deep'
                ? t('tasks.codeIntelEngineDeep')
                : t('tasks.codeIntelEngineBaseline')}
            </span>
            {resolution.degradedReason !== undefined && (
              <span className="symbol-menu__reason" title={resolution.degradedReason}>
                {t('tasks.codeIntelDegraded')}
              </span>
            )}
          </div>
          {empty && <div className="symbol-menu__note">{t('tasks.codeIntelNoResult')}</div>}
          {resolution.definitions.length > 0 && (
            <div className="symbol-menu__group">
              <div className="symbol-menu__group-title">
                {t('tasks.codeIntelDefinitions', { n: resolution.definitions.length })}
              </div>
              {resolution.definitions.map((d, i) => (
                <button
                  key={`d-${i}`}
                  type="button"
                  role="menuitem"
                  className="symbol-menu__item"
                  onClick={() => onSelect(d)}
                >
                  <span className="symbol-menu__loc">{rowLabel(d)}</span>
                  {d.preview !== undefined && (
                    <span className="symbol-menu__preview">{d.preview}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {resolution.references.length > 0 && (
            <div className="symbol-menu__group">
              <div className="symbol-menu__group-title">
                {t('tasks.codeIntelReferences', { n: resolution.references.length })}
                {resolution.engine === 'baseline' && (
                  <span className="symbol-menu__caveat">{t('tasks.codeIntelRefsGuessed')}</span>
                )}
              </div>
              {resolution.references.map((r, i) => (
                <button
                  key={`r-${i}`}
                  type="button"
                  role="menuitem"
                  className="symbol-menu__item"
                  onClick={() => onSelect(r)}
                >
                  <span className="symbol-menu__loc">{rowLabel(r)}</span>
                  {r.confidence === 'inferred' && (
                    <span className="structure__tag">{t('tasks.codeIntelInferred')}</span>
                  )}
                </button>
              ))}
              {resolution.truncated === true && (
                <div className="symbol-menu__note">{t('tasks.codeIntelTruncated')}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

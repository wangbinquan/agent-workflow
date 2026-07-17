// RFC-203 T2 — structured rendering for the known `ApiError.details` shapes.
//
// The backend attaches actionable payloads to 247 error sites (zod issues,
// referencing-resource lists, available git refs, OCC version pairs, git
// stderr) that the UI used to drop on the floor. <ErrorBanner> feeds every
// error through here; unknown shapes render nothing (fail-safe), and the raw
// backend message always lands in a collapsible block so no diagnostic is
// lost.
//
// ACL iron rule (Codex design-gate P1): reference lists may only be rendered
// BY NAME when the payload is principal-aware (`visibleScheduled` +
// `hiddenCount`, the RFC-202 deleteWorkflow shape). The legacy unfiltered
// array shapes (`referencedBy` / `scheduledTaskIds` / `workflows` /
// `agents`) render as aggregate counts only — they may contain other users'
// private resource names; the emitters upgrade to principal-aware shapes in
// RFC-203 T6.

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { describeValidationIssue } from '@/i18n/errors'

const RAW_MAX = 4096

interface ErrorDetailsProps {
  details?: unknown
  /** Raw backend/exception message — rendered as a collapsible block. */
  raw?: string
  /** Localized next-step hint from the resolver. */
  hint?: string
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null
}

function namedArray(v: unknown): Array<{ id?: string; name: string }> | null {
  if (!Array.isArray(v)) return null
  const out: Array<{ id?: string; name: string }> = []
  for (const item of v) {
    const r = asRecord(item)
    if (r === null || typeof r.name !== 'string') return null
    out.push({ name: r.name, ...(typeof r.id === 'string' ? { id: r.id } : {}) })
  }
  return out
}

const ZOD_ISSUE_LIMIT = 5

export function ErrorDetails({ details, raw, hint }: ErrorDetailsProps): ReactElement | null {
  const { t } = useTranslation()
  const rows: ReactElement[] = []
  const d = asRecord(details)

  if (d !== null) {
    // ---- zod / workflow-validation issues ------------------------------
    if (Array.isArray(d.issues) && d.issues.length > 0) {
      const issues = d.issues as Array<Record<string, unknown>>
      const shown = issues.slice(0, ZOD_ISSUE_LIMIT)
      rows.push(
        <ul className="error-details__issues" key="issues">
          {shown.map((iss, i) => {
            const path = Array.isArray(iss.path) ? iss.path.join('.') : ''
            const msg = typeof iss.message === 'string' ? iss.message : String(iss.code ?? '')
            // RFC-203 T3c: workflow-validation issues ({code, message}) get
            // the shared localizer; the raw message (node/edge locator) moves
            // to the hover title. Zod issues and unknown shapes fall through
            // to the localizer's fallback ONLY on a real validation code, so
            // gate on an exact/family match instead of shape sniffing.
            if (typeof iss.code === 'string' && msg !== '') {
              const v = describeValidationIssue({ code: iss.code, message: msg })
              if (v.matched !== 'fallback') {
                return (
                  <li key={i} title={v.raw}>
                    {v.title}
                  </li>
                )
              }
            }
            return <li key={i}>{path !== '' ? `${path}: ${msg}` : msg}</li>
          })}
          {issues.length > ZOD_ISSUE_LIMIT && (
            <li className="muted">
              {t('errorDetails.moreIssues', { count: issues.length - ZOD_ISSUE_LIMIT })}
            </li>
          )}
        </ul>,
      )
    }

    // ---- principal-aware reference list (RFC-202 deleteWorkflow shape) --
    const visible = namedArray(d.visibleScheduled) ?? namedArray(d.visible)
    const hiddenCount = typeof d.hiddenCount === 'number' ? d.hiddenCount : 0
    if (visible !== null && (visible.length > 0 || hiddenCount > 0)) {
      rows.push(
        <p className="error-details__refs" key="visible-refs">
          {visible.length > 0 &&
            t('errorDetails.referencedByNames', { names: visible.map((v) => v.name).join('、') })}
          {hiddenCount > 0 && ` ${t('errorDetails.referencedByHidden', { count: hiddenCount })}`}
        </p>,
      )
    }

    // ---- legacy UNFILTERED reference arrays: counts only (ACL rule) -----
    for (const key of ['referencedBy', 'scheduledTaskIds', 'workflows', 'agents', 'taskIds']) {
      const arr = d[key]
      if (Array.isArray(arr) && arr.length > 0 && visible === null) {
        rows.push(
          <p className="error-details__refs" key={`count-${key}`}>
            {t('errorDetails.referencedByCount', { count: arr.length })}
          </p>,
        )
        break
      }
    }

    // ---- available git refs ---------------------------------------------
    const refs = stringArray(d.availableRefs)
    if (refs !== null && refs.length > 0) {
      rows.push(
        <p className="error-details__refs" key="available-refs">
          {t('errorDetails.availableRefs', { refs: refs.slice(0, 20).join('、') })}
        </p>,
      )
    }

    // ---- OCC version pair -----------------------------------------------
    if (typeof d.expectedVersion === 'number' && typeof d.currentVersion === 'number') {
      rows.push(
        <p className="error-details__refs" key="occ">
          {t('errorDetails.versionConflict', {
            expected: d.expectedVersion,
            current: d.currentVersion,
          })}
        </p>,
      )
    }

    // ---- git stderr -------------------------------------------------------
    if (typeof d.stderr === 'string' && d.stderr.trim() !== '') {
      rows.push(
        <details className="error-details__raw" key="stderr">
          <summary>{t('errorDetails.stderrSummary')}</summary>
          <pre>{d.stderr.slice(0, RAW_MAX)}</pre>
        </details>,
      )
    }
  }

  if (hint !== undefined && hint !== '') {
    rows.unshift(
      <p className="error-details__hint" key="hint">
        {hint}
      </p>,
    )
  }

  if (raw !== undefined && raw.trim() !== '') {
    rows.push(
      <details className="error-details__raw" key="raw">
        <summary>{t('errorDetails.rawSummary')}</summary>
        <pre>{raw.slice(0, RAW_MAX)}</pre>
      </details>,
    )
  }

  if (rows.length === 0) return null
  return <div className="error-details">{rows}</div>
}

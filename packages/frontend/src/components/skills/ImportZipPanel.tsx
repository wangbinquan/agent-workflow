// RFC-019: Upload ZIP tab body for /skills/new. Two-phase flow:
//   1. user picks file → Parse → backend returns candidate list + per-row
//      conflict info, this panel shows a decision table.
//   2. user picks Skip / Overwrite / Rename per conflicting row → Import →
//      backend writes accepted skills under ~/.agent-workflow/skills/...

import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CommitSkillZipResponse, ParseSkillZipResponse, Skill } from '@agent-workflow/shared'
import { Select } from '@/components/Select'
import { getBaseUrl, getToken } from '@/stores/auth'
import {
  availableActionsFor,
  buildDecisionMap,
  rowsFromParseResponse,
  summarizeRows,
  validateRenameTarget,
  type DecisionAction,
  type RowState,
} from '@/lib/skill-zip-import'

interface PhaseIdle {
  kind: 'idle'
}
interface PhaseParseError {
  kind: 'parse-error'
  message: string
  code: string
}
interface PhaseReview {
  kind: 'review'
  parse: ParseSkillZipResponse
  rows: RowState[]
}
type Phase = PhaseIdle | PhaseParseError | PhaseReview

export function ImportZipPanel() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [busy, setBusy] = useState<'parse' | 'commit' | null>(null)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [summary, setSummary] = useState<CommitSkillZipResponse | null>(null)

  // We need the existing skill names so the rename inline-validation can flag
  // collisions client-side without waiting for a server round-trip.
  const skillsList = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: async () => {
      const res = await authedFetch('/api/skills', { method: 'GET' })
      if (!res.ok) throw new Error(`failed to list skills: ${res.status}`)
      return (await res.json()) as Skill[]
    },
  })
  const existingNames = useMemo(
    () => new Set((skillsList.data ?? []).map((s) => s.name)),
    [skillsList.data],
  )

  async function onParse() {
    if (!file) return
    setBusy('parse')
    setCommitError(null)
    setSummary(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await authedFetch('/api/skills/import-zip/parse', {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>)
        const code = typeof body.code === 'string' ? body.code : `http-${res.status}`
        const message =
          typeof body.message === 'string' ? body.message : t('skills.zipParseFailedFallback')
        setPhase({ kind: 'parse-error', code, message })
        return
      }
      const parse = (await res.json()) as ParseSkillZipResponse
      setPhase({ kind: 'review', parse, rows: rowsFromParseResponse(parse) })
    } finally {
      setBusy(null)
    }
  }

  async function onCommit() {
    if (phase.kind !== 'review' || !file) return
    setBusy('commit')
    setCommitError(null)
    try {
      const decisions = buildDecisionMap(phase.rows)
      const fd = new FormData()
      fd.append('file', file)
      fd.append('decisions', JSON.stringify(decisions))
      const res = await authedFetch('/api/skills/import-zip/commit', {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>)
        const message =
          typeof body.message === 'string'
            ? body.message
            : t('skills.zipCommitFailedFallback', { status: res.status })
        setCommitError(message)
        return
      }
      const out = (await res.json()) as CommitSkillZipResponse
      setSummary(out)
      await qc.invalidateQueries({ queryKey: ['skills'] })
      // If everything succeeded jump back to the list; otherwise stay so the
      // user can read the failure list.
      if (out.failed.length === 0) {
        navigate({ to: '/skills' })
      }
    } finally {
      setBusy(null)
    }
  }

  function updateRow(idx: number, patch: Partial<RowState['decision']>) {
    if (phase.kind !== 'review') return
    const next = phase.rows.map((row, i) =>
      i === idx ? { ...row, decision: { ...row.decision, ...patch } } : row,
    )
    setPhase({ ...phase, rows: next })
  }

  const rowsSummary = phase.kind === 'review' ? summarizeRows(phase.rows) : null
  const allowedSubmit =
    phase.kind === 'review' &&
    rowsSummary !== null &&
    rowsSummary.importing + rowsSummary.overwriting + rowsSummary.renaming > 0 &&
    phase.rows.every((row) => {
      if (row.decision.action !== 'rename') return true
      return validateRenameTarget(
        row.decision.newName,
        row.candidate.name,
        phase.rows,
        existingNames,
      ).ok
    })

  return (
    <div className="zip-import">
      <div className="zip-import__file">
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null
            setFile(f)
            setPhase({ kind: 'idle' })
            setSummary(null)
            setCommitError(null)
          }}
          data-testid="zip-file-input"
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!file || busy !== null}
          onClick={onParse}
          data-testid="zip-parse-button"
        >
          {busy === 'parse' ? t('skills.zipParsing') : t('skills.zipParse')}
        </button>
      </div>

      {phase.kind === 'idle' && summary === null && (
        <p className="zip-import__hint">{t('skills.zipEmptyHint')}</p>
      )}

      {phase.kind === 'parse-error' && (
        <div className="zip-import__error" data-testid="zip-parse-error">
          <strong>{phase.code}</strong>: {phase.message}
        </div>
      )}

      {phase.kind === 'review' && phase.parse.errors.length > 0 && (
        <div className="zip-import__errors-banner">
          <p>{t('skills.zipErrorBanner')}</p>
          <ul>
            {phase.parse.errors.map((err, i) => (
              <li key={i}>
                <code>{err.path === '' ? t('skills.zipErrorWholeArchiveLabel') : err.path}</code> —{' '}
                {err.code}: {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {phase.kind === 'review' && phase.rows.length > 0 && (
        <table className="zip-import__table" data-testid="zip-candidate-table">
          <thead>
            <tr>
              <th>{t('skills.zipColCandidate')}</th>
              <th>{t('skills.zipColDescription')}</th>
              <th>{t('skills.zipColFiles')}</th>
              <th>{t('skills.zipColConflict')}</th>
              <th>{t('skills.zipColAction')}</th>
            </tr>
          </thead>
          <tbody>
            {phase.rows.map((row, idx) => (
              <CandidateRow
                key={row.candidate.name}
                row={row}
                idx={idx}
                allRows={phase.rows}
                existingNames={existingNames}
                onUpdate={updateRow}
              />
            ))}
          </tbody>
        </table>
      )}

      {phase.kind === 'review' && phase.rows.length === 0 && (
        <p className="zip-import__hint">{t('skills.zipNoCandidates')}</p>
      )}

      {phase.kind === 'review' && rowsSummary !== null && (
        <div className="zip-import__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!allowedSubmit || busy !== null}
            onClick={onCommit}
            data-testid="zip-commit-button"
          >
            {busy === 'commit'
              ? t('skills.zipImporting')
              : t('skills.zipImportButton', {
                  n: rowsSummary.importing + rowsSummary.overwriting + rowsSummary.renaming,
                  s: rowsSummary.skipping,
                })}
          </button>
          {commitError !== null && <span className="zip-import__commit-error">{commitError}</span>}
        </div>
      )}

      {summary !== null && (
        <div className="zip-import__summary" data-testid="zip-import-summary">
          <p>
            {t('skills.zipImportSummary', {
              c: summary.created.length,
              u: summary.updated.length,
              s: summary.skipped.length,
              f: summary.failed.length,
            })}
          </p>
          {summary.failed.length > 0 && (
            <ul className="zip-import__failures">
              {summary.failed.map((f) => (
                <li key={f.name}>
                  <code>{f.name}</code> — {f.code}: {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

interface CandidateRowProps {
  row: RowState
  idx: number
  allRows: RowState[]
  existingNames: ReadonlySet<string>
  onUpdate: (idx: number, patch: Partial<RowState['decision']>) => void
}

function CandidateRow({ row, idx, allRows, existingNames, onUpdate }: CandidateRowProps) {
  const { t } = useTranslation()
  const isManagedConflict = row.candidate.conflict === 'managed'

  const renameStatus =
    row.decision.action === 'rename'
      ? validateRenameTarget(row.decision.newName, row.candidate.name, allRows, existingNames)
      : null

  // RFC-102: actions are gated by conflict kind + write permission (canOverwrite).
  const availableActions: DecisionAction[] = availableActionsFor(row.candidate)

  return (
    <tr data-testid={`zip-row-${row.candidate.name}`}>
      <td>
        <code>{row.candidate.name}</code>
      </td>
      <td className="zip-import__desc">
        {row.candidate.description === '' ? (
          <span className="zip-import__muted">—</span>
        ) : (
          row.candidate.description
        )}
        {row.candidate.warnings.length > 0 && (
          <ul className="zip-import__warnings">
            {row.candidate.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </td>
      <td>{row.candidate.fileCount}</td>
      <td>
        {isManagedConflict ? (
          <span className="zip-import__conflict zip-import__conflict--managed">
            {row.candidate.canOverwrite === true
              ? t('skills.zipConflictManaged')
              : t('skills.zipConflictManagedReadonly')}
          </span>
        ) : (
          <span className="zip-import__muted">—</span>
        )}
      </td>
      <td>
        <Select<DecisionAction>
          value={row.decision.action}
          onChange={(action) => onUpdate(idx, { action })}
          disabled={availableActions.length <= 1}
          data-testid={`zip-action-${row.candidate.name}`}
          options={availableActions.map((a) => ({ value: a, label: labelForAction(t, a) }))}
        />
        {row.decision.action === 'rename' && (
          <span className="zip-import__rename">
            <input
              type="text"
              value={row.decision.newName}
              onChange={(e) => onUpdate(idx, { newName: e.target.value })}
              placeholder={t('skills.zipRenameTo')}
              data-testid={`zip-rename-${row.candidate.name}`}
            />
            {renameStatus !== null && !renameStatus.ok && (
              <span
                className="zip-import__rename-error"
                data-testid={`zip-rename-error-${row.candidate.name}`}
              >
                {labelForRenameError(t, renameStatus.reason!)}
              </span>
            )}
          </span>
        )}
      </td>
    </tr>
  )
}

function labelForAction(t: (k: string) => string, a: DecisionAction): string {
  switch (a) {
    case 'import':
      return t('skills.zipActionImport')
    case 'skip':
      return t('skills.zipActionSkip')
    case 'overwrite':
      return t('skills.zipActionOverwrite')
    case 'rename':
      return t('skills.zipActionRename')
  }
}

function labelForRenameError(
  t: (k: string) => string,
  reason: NonNullable<ReturnType<typeof validateRenameTarget>['reason']>,
): string {
  switch (reason) {
    case 'empty':
      return t('skills.zipRenameEmpty')
    case 'invalid':
      return t('skills.zipRenameInvalid')
    case 'duplicate-in-batch':
      return t('skills.zipRenameDup')
    case 'conflict-with-db':
      return t('skills.zipRenameConflict')
  }
}

async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  const token = getToken()
  const headers = new Headers(init.headers)
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const url = new URL(path.startsWith('/') ? path : `/${path}`, getBaseUrl()).toString()
  return fetch(url, { ...init, headers })
}

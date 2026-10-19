// Git-object picker for kind=git inputs (P-2-10 stage 2).
//
// Supports three sub-kinds via the passthrough `gitKind` field:
//   - branch        → /api/repos/refs branches dropdown
//   - commit-range  → 2 inputs (from..to)
//   - pr            → raw text input (no GitHub probing yet)
//
// Packed value is a JSON object so downstream agents can route per sub-kind.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoRefsResponse, WorkflowInput } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'

interface Props {
  def: WorkflowInput
  /** The registered repository to list refs of ('' → none matched). */
  cachedRepoId: string
  value: string
  onChange: (next: string) => void
  /**
   * RFC-110: repo-source mode. In 'url' mode, a branch sub-kind with no cached
   * repo (empty cachedRepoId) or a failed ref listing falls back to a free-text
   * branch input so the form stays launchable. Defaults to 'path' so existing
   * callers stay byte-baseline.
   */
  sourceKind?: 'path' | 'url'
}

type GitKind = 'branch' | 'commit-range' | 'pr'

interface BranchValue {
  kind: 'branch'
  ref: string
}
interface CommitRangeValue {
  kind: 'commit-range'
  from: string
  to: string
}
interface PrValue {
  kind: 'pr'
  number: string
}

type GitValue = BranchValue | CommitRangeValue | PrValue

export function GitPicker({ def, cachedRepoId, value, onChange, sourceKind = 'path' }: Props) {
  const { t } = useTranslation()
  const urlMode = sourceKind === 'url'
  const gitKind = ((def as Record<string, unknown>).gitKind as GitKind | undefined) ?? 'branch'
  const refs = useQuery<RepoRefsResponse>({
    queryKey: ['repos', 'refs', cachedRepoId],
    queryFn: ({ signal }) => api.get('/api/repos/refs', { cachedRepoId }, signal),
    enabled: cachedRepoId !== '' && gitKind === 'branch',
  })

  const parsed = useMemo<GitValue | null>(() => {
    if (value === '') return null
    try {
      const v = JSON.parse(value)
      if (typeof v !== 'object' || v === null) return null
      return v as GitValue
    } catch {
      return null
    }
  }, [value])

  function emit(next: GitValue) {
    onChange(JSON.stringify(next))
  }

  if (gitKind === 'branch') {
    const current = parsed?.kind === 'branch' ? parsed.ref : ''
    // RFC-110: url mode without a cached repo (no cachedRepoId) or a failed ref
    // listing → free-text fallback so a branch can still be entered manually.
    const noRefs = cachedRepoId === '' || (refs.error !== null && refs.error !== undefined)
    if (urlMode && noRefs) {
      return (
        <Field
          label={t('launch.gitPicker.branchLabel')}
          required
          hint={t('launch.gitPicker.urlFallbackHint')}
        >
          <TextInput
            value={current}
            onChange={(ref) => emit({ kind: 'branch', ref })}
            data-testid="git-picker-branch-fallback"
          />
        </Field>
      )
    }
    const branches = refs.data?.branches ?? []
    // RFC-110: surface a stored ref that isn't in the (cached) branch list as an
    // explicit option, so it stays visible/selected instead of the Select
    // silently falling back to the placeholder while the value still submits
    // (Codex design gate P2).
    const extraOption =
      current !== '' && !branches.includes(current)
        ? [{ value: current, label: t('launch.gitPicker.currentRefOption', { ref: current }) }]
        : []
    return (
      <Field label={t('launch.gitPicker.branchLabel')} required>
        <Select<string>
          value={current}
          ariaLabel={t('launch.gitPicker.branchLabel')}
          placeholder={t('launch.pickBranchPlaceholder')}
          onChange={(ref) => emit({ kind: 'branch', ref })}
          options={[
            { value: '', label: t('launch.pickBranchPlaceholder') },
            ...extraOption,
            ...branches.map((b) => ({ value: b, label: b })),
          ]}
        />
      </Field>
    )
  }
  if (gitKind === 'commit-range') {
    const current: CommitRangeValue =
      parsed?.kind === 'commit-range' ? parsed : { kind: 'commit-range', from: '', to: '' }
    return (
      <div className="form-grid form-grid--cols-2">
        <Field label={t('launch.gitPicker.fromLabel')} required>
          <TextInput
            value={current.from}
            onChange={(v) => emit({ ...current, from: v })}
            placeholder="origin/main"
          />
        </Field>
        <Field label={t('launch.gitPicker.toLabel')} required>
          <TextInput
            value={current.to}
            onChange={(v) => emit({ ...current, to: v })}
            placeholder="HEAD"
          />
        </Field>
      </div>
    )
  }
  // pr
  const current: PrValue = parsed?.kind === 'pr' ? parsed : { kind: 'pr', number: '' }
  return (
    <Field label={t('launch.gitPicker.prLabel')} required>
      <TextInput
        value={current.number}
        onChange={(v) => emit({ kind: 'pr', number: v })}
        placeholder="123"
      />
    </Field>
  )
}

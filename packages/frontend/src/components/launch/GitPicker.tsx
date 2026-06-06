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
import type { RepoRefsResponse, WorkflowInput } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'

interface Props {
  def: WorkflowInput
  repoPath: string
  value: string
  onChange: (next: string) => void
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

export function GitPicker({ def, repoPath, value, onChange }: Props) {
  const gitKind = ((def as Record<string, unknown>).gitKind as GitKind | undefined) ?? 'branch'
  const refs = useQuery<RepoRefsResponse>({
    queryKey: ['repos', 'refs', repoPath],
    queryFn: ({ signal }) => api.get('/api/repos/refs', { path: repoPath }, signal),
    enabled: repoPath !== '' && gitKind === 'branch',
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
    return (
      <Field label="Branch" required>
        <Select<string>
          value={current}
          ariaLabel="Branch"
          placeholder="— pick a branch —"
          onChange={(ref) => emit({ kind: 'branch', ref })}
          options={[
            { value: '', label: '— pick a branch —' },
            ...(refs.data?.branches ?? []).map((b) => ({ value: b, label: b })),
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
        <Field label="From (sha / ref)" required>
          <TextInput
            value={current.from}
            onChange={(v) => emit({ ...current, from: v })}
            placeholder="origin/main"
          />
        </Field>
        <Field label="To (sha / ref)" required>
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
    <Field label="Pull request #" required>
      <TextInput
        value={current.number}
        onChange={(v) => emit({ kind: 'pr', number: v })}
        placeholder="123"
      />
    </Field>
  )
}

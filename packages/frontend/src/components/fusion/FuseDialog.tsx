// RFC-101 — fusion launch dialog. Shared by both entry points:
//   - /skills/:name  → entry {kind:'from-skill'}, user picks memories
//   - /memory        → entry {kind:'from-memories'}, user picks the target skill
// RFC-151 PR-1 — the two entry points used to be encoded as a pair of
// optional props (locked skill name / preset memory ids) whose undefined-ness
// implied the mode; `entry` is now an explicit discriminated union.
// Reuses Dialog / Select / Field / TextArea; navigates to the fusion detail.

import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Fusion, MemorySummary, Skill } from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea } from '@/components/Form'
import { Select } from '@/components/Select'

interface ListResponse {
  items: MemorySummary[]
}

export type FuseDialogEntry =
  | { kind: 'from-skill'; skillName: string }
  | { kind: 'from-memories'; memoryIds: string[] }

export function FuseDialog({
  open,
  onClose,
  entry,
}: {
  open: boolean
  onClose: () => void
  entry: FuseDialogEntry
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [skillName, setSkillName] = useState(entry.kind === 'from-skill' ? entry.skillName : '')
  const [picked, setPicked] = useState<Set<string>>(
    new Set(entry.kind === 'from-memories' ? entry.memoryIds : []),
  )
  const [intent, setIntent] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  // The dialog stays mounted while closed (parents toggle `open`), so re-seed
  // from the current entry each time it opens — otherwise a /memory bulk
  // selection made after first mount never reaches `picked` (Codex P2).
  useEffect(() => {
    if (open) {
      setSkillName(entry.kind === 'from-skill' ? entry.skillName : '')
      setPicked(new Set(entry.kind === 'from-memories' ? entry.memoryIds : []))
      setIntent('')
      setLocalError(null)
    }
    // entry is a fresh object each render; key off open + its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry.kind, entry.kind === 'from-skill' ? entry.skillName : entry.memoryIds.join(',')])

  // Managed skills the user can write (the list endpoint already filters by
  // visibility; ownership is re-checked server-side at launch).
  const skills = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
    enabled: open && entry.kind === 'from-memories',
  })
  const managed = useMemo(
    () => (skills.data ?? []).filter((s) => s.sourceKind === 'managed'),
    [skills.data],
  )

  // Approved, manageable memories (for the picker when entering from a skill).
  const memories = useQuery<ListResponse>({
    queryKey: ['memories', 'all', 'approved'],
    queryFn: ({ signal }) => api.get('/api/memories', { status: 'approved' }, signal),
    enabled: open && entry.kind === 'from-skill',
  })
  const selectable = useMemo(
    () => (memories.data?.items ?? []).filter((m) => m.canManage !== false),
    [memories.data],
  )

  const launch = useMutation<Fusion, ApiError>({
    mutationFn: () =>
      api.post('/api/fusions', {
        skillName,
        memoryIds: Array.from(picked),
        intent,
      }),
    onSuccess: (f) => {
      onClose()
      void navigate({ to: '/fusions/$id', params: { id: f.id } })
    },
  })

  function submit() {
    setLocalError(null)
    if (skillName === '') {
      setLocalError(t('fusion.needSkill'))
      return
    }
    if (picked.size === 0) {
      setLocalError(t('fusion.needMemories'))
      return
    }
    launch.mutate()
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('fusion.launchTitle')}
      size="lg"
      panelClassName="fuse-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={launch.isPending}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={launch.isPending}
          >
            {launch.isPending ? t('fusion.submitting') : t('fusion.submit')}
          </button>
        </>
      }
    >
      {launch.error ? <ErrorBanner error={launch.error} /> : null}
      {localError !== null ? <div className="error-box">⚠ {localError}</div> : null}

      {entry.kind === 'from-memories' && (
        <Field label={t('fusion.fieldSkill')} hint={t('fusion.fieldSkillHint')} required>
          {managed.length === 0 ? (
            <p className="muted">{t('fusion.noManagedSkills')}</p>
          ) : (
            <Select
              value={skillName}
              onChange={setSkillName}
              options={[
                { value: '', label: t('fusion.pickSkillPlaceholder') },
                ...managed.map((s) => ({ value: s.name, label: s.name })),
              ]}
            />
          )}
        </Field>
      )}

      {entry.kind === 'from-skill' ? (
        <Field
          label={`${t('fusion.fieldMemories')} · ${t('fusion.selectedCount', { n: picked.size })}`}
          hint={t('fusion.fieldMemoriesHint')}
          required
        >
          {selectable.length === 0 ? (
            <p className="muted">{t('fusion.noSelectableMemories')}</p>
          ) : (
            <ul className="fusion-picker" data-testid="fusion-memory-picker">
              {selectable.map((m) => (
                <li key={m.id}>
                  <label className="fusion-picker__row">
                    <input
                      type="checkbox"
                      checked={picked.has(m.id)}
                      onChange={() => toggle(m.id)}
                    />
                    <span className={`memory-row__scope memory-row__scope--${m.scopeType}`}>
                      {t(`memory.scope.${m.scopeType}`)}
                    </span>
                    <span className="fusion-picker__title">{m.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Field>
      ) : (
        <p className="muted">{t('fusion.selectedCount', { n: picked.size })}</p>
      )}

      <Field label={t('fusion.fieldIntent')} hint={t('fusion.fieldIntentHint')}>
        <TextArea
          value={intent}
          onChange={setIntent}
          rows={4}
          placeholder={t('fusion.intentPlaceholder')}
          data-testid="fusion-intent"
        />
      </Field>
    </Dialog>
  )
}

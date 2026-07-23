// RFC-101 — fusion launch dialog. Shared by both entry points:
//   - /skills/:name  → entry {kind:'from-skill', skillId, skillName}, user picks memories
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
import { useUserLookup } from '@/hooks/useUserLookup'

interface ListResponse {
  items: MemorySummary[]
}

export type FuseDialogEntry =
  | { kind: 'from-skill'; skillId: string; skillName: string }
  | { kind: 'from-memories'; memoryIds: string[] }

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`
}

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

  const [skillId, setSkillId] = useState(entry.kind === 'from-skill' ? entry.skillId : '')
  const [picked, setPicked] = useState<Set<string>>(
    new Set(entry.kind === 'from-memories' ? entry.memoryIds : []),
  )
  const [intent, setIntent] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const seededSkillId = entry.kind === 'from-skill' ? entry.skillId : ''
  const seededMemoryIds = entry.kind === 'from-memories' ? entry.memoryIds.join('\u0000') : ''

  // The dialog stays mounted while closed (parents toggle `open`), so re-seed
  // from the current entry each time it opens — otherwise a /memory bulk
  // selection made after first mount never reaches `picked` (Codex P2).
  useEffect(() => {
    if (open) {
      setSkillId(seededSkillId)
      setPicked(new Set(seededMemoryIds === '' ? [] : seededMemoryIds.split('\u0000')))
      setIntent('')
      setLocalError(null)
    }
  }, [open, seededMemoryIds, seededSkillId])

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
  const owners = useUserLookup(managed.map((s) => s.ownerUserId))
  const duplicateSkillNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const skill of managed) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1)
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    )
  }, [managed])

  // Approved, manageable memories (for the picker when entering from a skill).
  const memories = useQuery<ListResponse>({
    queryKey: ['memories', 'all', 'approved'],
    queryFn: ({ signal }) => api.get('/api/memories', { status: 'approved' }, signal),
    enabled: open && entry.kind === 'from-skill',
  })
  const selectable = useMemo(
    () => (memories.data?.items ?? []).filter((m) => m.canManage === true),
    [memories.data],
  )

  const launch = useMutation<Fusion, ApiError>({
    mutationFn: () =>
      api.post('/api/fusions', {
        skillId,
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
    if (skillId === '') {
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
      {localError !== null ? <ErrorBanner error={localError} /> : null}

      {entry.kind === 'from-memories' && (
        <Field label={t('fusion.fieldSkill')} hint={t('fusion.fieldSkillHint')} required>
          {managed.length === 0 ? (
            <p className="muted">{t('fusion.noManagedSkills')}</p>
          ) : (
            <Select
              value={skillId}
              onChange={setSkillId}
              options={[
                { value: '', label: t('fusion.pickSkillPlaceholder') },
                ...managed.map((s) => {
                  const owner =
                    owners.get(s.ownerUserId)?.displayName ??
                    (s.ownerUserId == null || s.ownerUserId === '__system__'
                      ? t('acl.systemOwner')
                      : shortId(s.ownerUserId))
                  return {
                    value: s.id,
                    label: `${s.name} · ${owner}${
                      duplicateSkillNames.has(s.name) ? ` · ${shortId(s.id)}` : ''
                    }`,
                  }
                }),
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

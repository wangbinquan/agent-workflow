// Skill detail page: metadata (description) + SKILL.md content + file tree.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Skill, SkillContent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { Field, TextInput } from '@/components/Form'
import { FuseDialog } from '@/components/fusion/FuseDialog'
import { LoadingState } from '@/components/LoadingState'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { SkillFileTree } from '@/components/SkillFileTree'
import { SkillVersionHistory } from '@/components/skill/SkillVersionHistory'
import { describeApiError } from '@/i18n'
import { skillCapabilities } from '@/lib/skill-capabilities'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills/$name',
  component: SkillDetailPage,
})

function SkillDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const meta = useQuery<Skill>({
    queryKey: ['skills', name],
    queryFn: ({ signal }) => api.get(`/api/skills/${encodeURIComponent(name)}`, undefined, signal),
  })
  const content = useQuery<SkillContent>({
    queryKey: ['skills', name, 'content'],
    queryFn: ({ signal }) =>
      api.get(`/api/skills/${encodeURIComponent(name)}/content`, undefined, signal),
  })

  const [fuseOpen, setFuseOpen] = useState(false)

  // RFC-151 PR-4 — hydrate-once draft over TWO sources: seed only when the
  // content query has also settled (`ready`), with `map` closing over it.
  // Stale-race contract: both save mutations below eagerly setQueryData
  // their fresh responses (see useDraftFromQuery docstring).
  const { draft, setDraft, loaded } = useDraftFromQuery(
    meta.data,
    (m) => ({ description: m.description, bodyMd: content.data?.bodyMd ?? '' }),
    { ready: content.data !== undefined },
  )
  const description = draft?.description ?? ''
  const bodyMd = draft?.bodyMd ?? ''
  const setDescription = (v: string) =>
    setDraft((d) => (d === undefined ? d : { ...d, description: v }))
  const setBodyMd = (v: string) => setDraft((d) => (d === undefined ? d : { ...d, bodyMd: v }))

  // RFC-151 PR-1 — read named capability bits instead of re-deriving
  // `sourceKind === 'managed'` at every consumption site. While the query is
  // still loading the page renders the (all-false) external capability set;
  // the early returns below keep that state invisible.
  const caps = skillCapabilities(meta.data?.sourceKind ?? 'external')

  const saveMeta = useMutation({
    mutationFn: () => api.put<Skill>(`/api/skills/${encodeURIComponent(name)}`, { description }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      qc.setQueryData(['skills', name], s)
    },
  })
  const saveContent = useMutation({
    mutationFn: () =>
      api.put<SkillContent>(`/api/skills/${encodeURIComponent(name)}/content`, { bodyMd }),
    onSuccess: (next) => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      qc.setQueryData(['skills', name, 'content'], next)
    },
  })
  // Navigation is a whole-save outcome, NOT a per-channel one: when each
  // mutation navigated on its own success, the first fulfilled PUT unmounted
  // the page and the sibling's later failure had nowhere to render — the user
  // returned to the list as if Save succeeded while one channel was never
  // persisted. Leave the page only when ALL required channels fulfil; any
  // failure keeps the page mounted with its per-channel error visible.
  const handleSave = async () => {
    const channels: Promise<unknown>[] = [saveMeta.mutateAsync()]
    if (caps.canEditContent) channels.push(saveContent.mutateAsync())
    const results = await Promise.allSettled(channels)
    if (results.every((r) => r.status === 'fulfilled')) navigate({ to: '/skills' })
  }
  const del = useMutation({
    mutationFn: () => api.delete(`/api/skills/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      navigate({ to: '/skills' })
    },
  })

  if (meta.isLoading || content.isLoading)
    return (
      <div className="page">
        <LoadingState />
      </div>
    )
  // RFC-151 PR-4: aligned to the shared describeApiError (the other detail
  // pages already used it). Delta vs the old local describeError: ApiErrors
  // with an untranslated code now render "<errors.fallback>: <message>"
  // instead of "<code>: <message>" — localized codes gain a proper message.
  if (meta.error !== null && meta.error !== undefined)
    return <div className="page error-box">{describeApiError(meta.error)}</div>
  if (content.error !== null && content.error !== undefined)
    return <div className="page error-box">{describeApiError(content.error)}</div>
  if (meta.data === undefined) return null

  return (
    <div className="page page--wide">
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/skills/${encodeURIComponent(name)}`,
          invalidateKey: ['skills'],
        }}
        save={{
          // Dual-mutation pending/label composition stays caller-owned.
          label:
            saveMeta.isPending || saveContent.isPending ? t('common.saving') : t('common.save'),
          onClick: () => {
            void handleSave()
          },
          disabled: saveMeta.isPending || saveContent.isPending || !loaded,
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        extra={
          caps.canFuse && (
            <button type="button" className="btn" onClick={() => setFuseOpen(true)}>
              {t('fusion.launchFromSkillButton')}
            </button>
          )
        }
        // Three independent channels — a failed meta save must not mask a
        // failed content save (and vice versa); del failures now surface too.
        errors={[saveMeta.error, saveContent.error, del.error]}
      >
        <div>
          <h1>{name}</h1>
          <p className="page__hint">
            <span className={`chip chip--tight chip--${meta.data.sourceKind}`}>
              {t(meta.data.sourceKind === 'managed' ? 'skills.tabManaged' : 'skills.tabExternal')}
            </span>{' '}
            <code>{meta.data.managedPath ?? meta.data.externalPath ?? ''}</code>
          </p>
        </div>
      </DetailHeaderActions>

      <section className="form-grid">
        <Field
          label={t('skills.fieldDescription')}
          hint={caps.showManagedHint ? t('skills.descHintManaged') : t('skills.descHintExternal')}
        >
          <TextInput value={description} onChange={setDescription} />
        </Field>
      </section>

      <section className="page__section">
        <h2>{t('skills.bodySection')}</h2>
        {caps.canEditContent ? (
          <MarkdownEditor value={bodyMd} onChange={setBodyMd} rows={16} />
        ) : (
          <pre className="readonly-pre">{bodyMd || t('skills.emptyBody')}</pre>
        )}
      </section>

      <section className="page__section">
        <h2>{t('skills.filesSection')}</h2>
        <SkillFileTree skillName={name} readonly={!caps.canBrowseFilesWritable} />
      </section>

      {caps.showVersionHistory && (
        <SkillVersionHistory skillName={name} currentVersion={meta.data.contentVersion} />
      )}

      <FuseDialog
        open={fuseOpen}
        onClose={() => setFuseOpen(false)}
        entry={{ kind: 'from-skill', skillName: name }}
      />
    </div>
  )
}

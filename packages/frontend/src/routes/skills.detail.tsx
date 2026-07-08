// Skill detail page: metadata (description) + SKILL.md content + file tree.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Skill, SkillContent } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { AclDialogButton } from '@/components/AclPanel'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Field, TextInput } from '@/components/Form'
import { FuseDialog } from '@/components/fusion/FuseDialog'
import { LoadingState } from '@/components/LoadingState'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { SkillFileTree } from '@/components/SkillFileTree'
import { SkillVersionHistory } from '@/components/skill/SkillVersionHistory'
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

  const [description, setDescription] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [fuseOpen, setFuseOpen] = useState(false)

  useEffect(() => {
    if (!loaded && meta.data !== undefined && content.data !== undefined) {
      setDescription(meta.data.description)
      setBodyMd(content.data.bodyMd)
      setLoaded(true)
    }
  }, [loaded, meta.data, content.data])

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
      navigate({ to: '/skills' })
    },
  })
  const saveContent = useMutation({
    mutationFn: () =>
      api.put<SkillContent>(`/api/skills/${encodeURIComponent(name)}/content`, { bodyMd }),
    onSuccess: (next) => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      qc.setQueryData(['skills', name, 'content'], next)
      navigate({ to: '/skills' })
    },
  })
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
  if (meta.error !== null && meta.error !== undefined)
    return <div className="page error-box">{describeError(meta.error)}</div>
  if (content.error !== null && content.error !== undefined)
    return <div className="page error-box">{describeError(content.error)}</div>
  if (meta.data === undefined) return null

  return (
    <div className="page page--wide">
      <header className="page__header page__header--row">
        <div>
          <h1>{name}</h1>
          <p className="page__hint">
            <span className={`chip chip--tight chip--${meta.data.sourceKind}`}>
              {t(meta.data.sourceKind === 'managed' ? 'skills.tabManaged' : 'skills.tabExternal')}
            </span>{' '}
            <code>{meta.data.managedPath ?? meta.data.externalPath ?? ''}</code>
          </p>
        </div>
        <div className="page__actions">
          {caps.canFuse && (
            <button type="button" className="btn" onClick={() => setFuseOpen(true)}>
              {t('fusion.launchFromSkillButton')}
            </button>
          )}
          <AclDialogButton
            resourceBaseUrl={`/api/skills/${encodeURIComponent(name)}`}
            invalidateKey={['skills']}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={saveMeta.isPending || saveContent.isPending || !loaded}
            onClick={() => {
              saveMeta.mutate()
              if (caps.canEditContent) saveContent.mutate()
            }}
          >
            {saveMeta.isPending || saveContent.isPending ? t('common.saving') : t('common.save')}
          </button>
          <ConfirmButton
            label={t('common.delete')}
            onConfirm={() => del.mutateAsync()}
            variant="danger"
            disabled={del.isPending}
          />
        </div>
      </header>
      {(saveMeta.error !== null && saveMeta.error !== undefined) ||
      (saveContent.error !== null && saveContent.error !== undefined) ? (
        <div className="form-actions">
          {saveMeta.error !== null && saveMeta.error !== undefined && (
            <span className="form-actions__error">{describeError(saveMeta.error)}</span>
          )}
          {saveContent.error !== null && saveContent.error !== undefined && (
            <span className="form-actions__error">{describeError(saveContent.error)}</span>
          )}
        </div>
      ) : null}

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

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

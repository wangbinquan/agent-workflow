// Skill detail page: metadata (description) + SKILL.md content + file tree.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { Skill, SkillContent } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Field, TextInput } from '@/components/Form'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { SkillFileTree } from '@/components/SkillFileTree'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills/$name',
  component: SkillDetailPage,
})

function SkillDetailPage() {
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

  useEffect(() => {
    if (!loaded && meta.data !== undefined && content.data !== undefined) {
      setDescription(meta.data.description)
      setBodyMd(content.data.bodyMd)
      setLoaded(true)
    }
  }, [loaded, meta.data, content.data])

  const isManaged = meta.data?.sourceKind === 'managed'

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
      qc.setQueryData(['skills', name, 'content'], next)
    },
  })
  const del = useMutation({
    mutationFn: () => api.delete(`/api/skills/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      navigate({ to: '/skills' })
    },
  })

  if (meta.isLoading || content.isLoading) return <div className="page muted">Loading…</div>
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
              {meta.data.sourceKind}
            </span>{' '}
            <code>{meta.data.managedPath ?? meta.data.externalPath ?? ''}</code>
          </p>
        </div>
        <div className="page__actions">
          <ConfirmButton
            label="Delete skill"
            onConfirm={() => del.mutateAsync()}
            danger
            disabled={del.isPending}
          />
        </div>
      </header>

      <section className="form-grid">
        <Field
          label="Description"
          hint={
            isManaged
              ? 'Editable; persisted into SKILL.md frontmatter.'
              : 'External skill description (DB only).'
          }
        >
          <TextInput value={description} onChange={setDescription} />
        </Field>
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={saveMeta.isPending || !loaded}
            onClick={() => saveMeta.mutate()}
          >
            {saveMeta.isPending ? 'Saving…' : 'Save description'}
          </button>
          {saveMeta.error !== null && saveMeta.error !== undefined && (
            <span className="form-actions__error">{describeError(saveMeta.error)}</span>
          )}
        </div>
      </section>

      <section className="page__section">
        <h2>SKILL.md body</h2>
        {isManaged ? (
          <>
            <MarkdownEditor value={bodyMd} onChange={setBodyMd} rows={16} />
            <div className="form-actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={saveContent.isPending || !loaded}
                onClick={() => saveContent.mutate()}
              >
                {saveContent.isPending ? 'Saving…' : 'Save body'}
              </button>
              {saveContent.error !== null && saveContent.error !== undefined && (
                <span className="form-actions__error">{describeError(saveContent.error)}</span>
              )}
            </div>
          </>
        ) : (
          <pre className="readonly-pre">{bodyMd || '(empty)'}</pre>
        )}
      </section>

      <section className="page__section">
        <h2>Files</h2>
        <SkillFileTree skillName={name} readonly={!isManaged} />
      </section>
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

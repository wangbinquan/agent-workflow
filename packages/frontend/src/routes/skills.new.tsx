// Skill create page. Two tabs:
//   * Managed — POST /api/skills (the framework owns the dir).
//   * External — POST /api/skills/import-external (point at an existing dir).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { Skill } from '@agent-workflow/shared'
import { SKILL_NAME_RE } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Field, TextArea, TextInput } from '@/components/Form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills/new',
  component: SkillCreatePage,
})

type Tab = 'managed' | 'external'

function SkillCreatePage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('managed')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [externalPath, setExternalPath] = useState('')

  const create = useMutation({
    mutationFn: (): Promise<Skill> => {
      if (tab === 'managed') {
        return api.post<Skill>('/api/skills', { name, description, bodyMd })
      }
      return api.post<Skill>('/api/skills/import-external', { name, description, externalPath })
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      navigate({ to: '/skills/$name', params: { name: s.name } })
    },
  })

  const disabled =
    name === '' ||
    create.isPending ||
    (tab === 'external' && externalPath === '') ||
    !SKILL_NAME_RE.test(name)

  return (
    <div className="page">
      <header className="page__header">
        <h1>New skill</h1>
        <p className="page__hint">
          Pick <code>managed</code> for skills the framework owns end-to-end, or{' '}
          <code>external</code> to register an existing on-disk skill directory.
        </p>
      </header>

      <div className="tabs">
        <button
          type="button"
          className={`tabs__tab ${tab === 'managed' ? 'tabs__tab--active' : ''}`}
          onClick={() => setTab('managed')}
        >
          Managed
        </button>
        <button
          type="button"
          className={`tabs__tab ${tab === 'external' ? 'tabs__tab--active' : ''}`}
          onClick={() => setTab('external')}
        >
          External
        </button>
      </div>

      <div className="form-grid">
        <Field label="Name" required hint="kebab-case; matches /skills/:name URL.">
          <TextInput value={name} onChange={setName} required pattern={SKILL_NAME_RE.source} />
        </Field>
        <Field label="Description">
          <TextInput value={description} onChange={setDescription} />
        </Field>
        {tab === 'managed' ? (
          <Field label="SKILL.md body (Markdown)">
            <TextArea value={bodyMd} onChange={setBodyMd} rows={10} monospace />
          </Field>
        ) : (
          <Field
            label="External path"
            required
            hint="Absolute path to an existing skill directory."
          >
            <TextInput
              value={externalPath}
              onChange={setExternalPath}
              placeholder="/abs/path/to/skill-dir"
              required
            />
          </Field>
        )}
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => create.mutate()}
          disabled={disabled}
        >
          {create.isPending ? 'Creating…' : 'Create skill'}
        </button>
        {create.error !== null && create.error !== undefined && (
          <span className="form-actions__error">{describeError(create.error)}</span>
        )}
      </div>
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

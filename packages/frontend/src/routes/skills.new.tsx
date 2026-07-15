// Skill create page — the inline "new" view of the /skills split page.
//
// RFC-169 (T13): child route under the /skills layout (path '/new'). RFC-178:
// skills are managed-only, so there are two creation modes (managed / zip) in a
// TabBar; the ZIP panel is kept mounted (hidden, not unmounted) so its staged
// selection survives a tab switch.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Skill } from '@agent-workflow/shared'
import { SKILL_NAME_RE } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, TextArea, TextInput } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ImportZipPanel } from '@/components/skills/ImportZipPanel'
import { NEW_CARD_KEY, useReportSplitDirty, useSplitDirty } from '@/components/split/splitDirty'
import { TabPanels } from '@/components/split/TabPanels'
import { TabBar } from '@/components/TabBar'
import { useDirtyBaseline } from '@/hooks/useDraftFromQuery'
import { Route as skillsRoute } from './skills'

export const Route = createRoute({
  getParentRoute: () => skillsRoute,
  path: '/new',
  component: SkillCreatePage,
})

type Tab = 'managed' | 'zip'

const EMPTY_FORM = {
  name: '',
  description: '',
  bodyMd: '',
}

function SkillCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { report } = useSplitDirty()
  const [tab, setTab] = useState<Tab>('managed')
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  // Dirty = the form fields differ from empty (the ZIP panel's staged selection
  // is best-effort local state, not tracked — §3.4 three-times-final).
  const { dirty } = useDirtyBaseline(form, EMPTY_FORM)
  useReportSplitDirty(NEW_CARD_KEY, dirty)

  const create = useMutation({
    mutationFn: (): Promise<Skill> =>
      api.post<Skill>('/api/skills', {
        name: form.name,
        description: form.description,
        bodyMd: form.bodyMd,
      }),
    onSuccess: (s) => {
      report(NEW_CARD_KEY, false) // sync-clear before navigating
      void qc.invalidateQueries({ queryKey: ['skills'] })
      navigate({ to: '/skills/$name', params: { name: s.name } })
    },
  })

  const disabled = form.name === '' || create.isPending || !SKILL_NAME_RE.test(form.name)

  return (
    <div className="agent-new">
      <header className="page__header page__header--row">
        <div>
          <h2>{tab === 'zip' ? t('skills.importTitle') : t('skills.newTitle')}</h2>
          {tab === 'zip' && <p className="page__hint">{t('skills.importSubtitle')}</p>}
        </div>
        {tab !== 'zip' && (
          <div className="page__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => create.mutate()}
              disabled={disabled}
              data-testid="skill-create-button"
            >
              {create.isPending ? t('common.creating') : t('skills.createButton')}
            </button>
          </div>
        )}
      </header>

      <TabBar<Tab>
        tabs={[
          { key: 'managed', label: t('skills.tabManaged') },
          { key: 'zip', label: t('skills.tabZip'), testid: 'skills-tab-zip' },
        ]}
        active={tab}
        onSelect={setTab}
        idPrefix="skills-new"
      />

      {/* ZIP panel kept mounted so its staged selection survives tab switches. */}
      <TabPanels<Tab>
        active={tab}
        idPrefix="skills-new"
        className="split__detail-body"
        panels={[
          { key: 'zip', content: <ImportZipPanel /> },
          {
            key: 'managed',
            content: (
              <>
                <div className="form-grid">
                  <Field label={t('skills.fieldName')} required hint={t('skills.fieldNameHint')}>
                    <TextInput
                      value={form.name}
                      onChange={(v) => set('name', v)}
                      required
                      pattern={SKILL_NAME_RE.source}
                    />
                  </Field>
                  <Field label={t('skills.fieldDescription')}>
                    <TextInput value={form.description} onChange={(v) => set('description', v)} />
                  </Field>
                  <Field label={t('skills.fieldBody')}>
                    <TextArea
                      value={form.bodyMd}
                      onChange={(v) => set('bodyMd', v)}
                      rows={10}
                      monospace
                    />
                  </Field>
                </div>
                {create.error !== null && create.error !== undefined && (
                  <ErrorBanner error={create.error} />
                )}
              </>
            ),
          },
        ]}
      />
    </div>
  )
}

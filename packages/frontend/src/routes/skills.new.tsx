// Skill create page — the inline "new" view of the /skills split page.
//
// RFC-169 (T13): child route under the /skills layout (path '/new'). Four
// creation modes (managed / external / folder / zip) stay as a TabBar; the ZIP
// panel is kept mounted (hidden, not unmounted) so its staged selection
// survives a tab switch. Folder registration lands on the empty pane (where the
// SkillSourcesCard shows the freshly registered source).

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
import { TabBar } from '@/components/TabBar'
import { useDirtyBaseline } from '@/hooks/useDraftFromQuery'
import { Route as skillsRoute } from './skills'

export const Route = createRoute({
  getParentRoute: () => skillsRoute,
  path: '/new',
  component: SkillCreatePage,
})

type Tab = 'managed' | 'external' | 'folder' | 'zip'

interface RegisterSourceResponse {
  source: { id: string; label: string; childCount: number }
  imported: Array<{ name: string }>
  skipped: Array<{ proposedName?: string; reason: string }>
}

const EMPTY_FORM = {
  name: '',
  description: '',
  bodyMd: '',
  externalPath: '',
  folderPath: '',
  folderLabel: '',
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
    mutationFn: (): Promise<Skill> => {
      if (tab === 'managed') {
        return api.post<Skill>('/api/skills', {
          name: form.name,
          description: form.description,
          bodyMd: form.bodyMd,
        })
      }
      return api.post<Skill>('/api/skills/import-external', {
        name: form.name,
        description: form.description,
        externalPath: form.externalPath,
      })
    },
    onSuccess: (s) => {
      report(NEW_CARD_KEY, false) // sync-clear before navigating
      void qc.invalidateQueries({ queryKey: ['skills'] })
      navigate({ to: '/skills/$name', params: { name: s.name } })
    },
  })

  const registerFolder = useMutation({
    mutationFn: (): Promise<RegisterSourceResponse> =>
      api.post<RegisterSourceResponse>('/api/skill-sources', {
        path: form.folderPath,
        ...(form.folderLabel ? { label: form.folderLabel } : {}),
      }),
    onSuccess: () => {
      report(NEW_CARD_KEY, false)
      void qc.invalidateQueries({ queryKey: ['skills'] })
      void qc.invalidateQueries({ queryKey: ['skill-sources'] })
      navigate({ to: '/skills' })
    },
  })

  const disabled =
    tab === 'folder'
      ? form.folderPath === '' || registerFolder.isPending
      : form.name === '' ||
        create.isPending ||
        (tab === 'external' && form.externalPath === '') ||
        !SKILL_NAME_RE.test(form.name)

  return (
    <div className="agent-new">
      <header className="page__header page__header--row">
        <div>
          <h2>{t('skills.newTitle')}</h2>
        </div>
        {tab !== 'zip' && (
          <div className="page__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => (tab === 'folder' ? registerFolder.mutate() : create.mutate())}
              disabled={disabled}
              data-testid="skill-create-button"
            >
              {tab === 'folder'
                ? registerFolder.isPending
                  ? t('common.creating')
                  : t('skills.createFolderButton')
                : create.isPending
                  ? t('common.creating')
                  : t('skills.createButton')}
            </button>
          </div>
        )}
      </header>

      <TabBar<Tab>
        tabs={[
          { key: 'managed', label: t('skills.tabManaged') },
          { key: 'external', label: t('skills.tabExternal') },
          { key: 'folder', label: t('skills.tabFolder') },
          { key: 'zip', label: t('skills.tabZip'), testid: 'skills-tab-zip' },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {/* ZIP panel kept mounted so its staged selection survives tab switches. */}
      <div role="tabpanel" hidden={tab !== 'zip'} className="split__detail-body">
        <ImportZipPanel />
      </div>

      <div role="tabpanel" hidden={tab === 'zip'} className="split__detail-body">
        <div className="form-grid">
          {tab === 'folder' ? (
            <>
              <Field
                label={t('skills.fieldFolderPath')}
                required
                hint={t('skills.fieldFolderPathHint')}
              >
                <TextInput
                  value={form.folderPath}
                  onChange={(v) => set('folderPath', v)}
                  placeholder={t('skills.folderPathPlaceholder')}
                  required
                />
              </Field>
              <Field label={t('skills.fieldFolderLabel')} hint={t('skills.fieldFolderLabelHint')}>
                <TextInput value={form.folderLabel} onChange={(v) => set('folderLabel', v)} />
              </Field>
            </>
          ) : (
            <>
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
              {tab === 'managed' ? (
                <Field label={t('skills.fieldBody')}>
                  <TextArea
                    value={form.bodyMd}
                    onChange={(v) => set('bodyMd', v)}
                    rows={10}
                    monospace
                  />
                </Field>
              ) : (
                <Field
                  label={t('skills.fieldExternalPath')}
                  required
                  hint={t('skills.fieldExternalPathHint')}
                >
                  <TextInput
                    value={form.externalPath}
                    onChange={(v) => set('externalPath', v)}
                    placeholder={t('skills.externalPathPlaceholder')}
                    required
                  />
                </Field>
              )}
            </>
          )}
        </div>
        {tab === 'folder'
          ? registerFolder.error !== null &&
            registerFolder.error !== undefined && <ErrorBanner error={registerFolder.error} />
          : create.error !== null &&
            create.error !== undefined && <ErrorBanner error={create.error} />}
      </div>
    </div>
  )
}

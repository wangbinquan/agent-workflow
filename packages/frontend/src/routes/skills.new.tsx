// Skill create page — the inline "new" view of the /skills split page.
//
// RFC-169 (T13): child route under the /skills layout (path '/new'). RFC-178:
// skills are managed-only, so there are two creation modes (managed / zip) in a
// TabBar; the ZIP panel is kept mounted (hidden, not unmounted) so its staged
// selection survives a tab switch.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Skill } from '@agent-workflow/shared'
import { SKILL_NAME_RE } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, TextArea, TextInput } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { ImportZipPanel, type ImportZipPanelHandle } from '@/components/skills/ImportZipPanel'
import { PageHeader } from '@/components/PageHeader'
import {
  ResourcePackageImportPanel,
  type ResourcePackageImportPanelHandle,
} from '@/components/ResourcePackageImportDialog'
import {
  NEW_CARD_KEY,
  useRegisterSplitDiscard,
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
} from '@/components/split/splitDirty'
import { TabPanels } from '@/components/split/TabPanels'
import { TabBar } from '@/components/TabBar'
import { useDirtyBaseline } from '@/hooks/useDraftFromQuery'
import { Route as skillsRoute } from './skills'

export const Route = createRoute({
  getParentRoute: () => skillsRoute,
  path: '/new',
  component: SkillCreatePage,
})

type Tab = 'managed' | 'zip' | 'package'

const EMPTY_FORM = {
  name: '',
  description: '',
  bodyMd: '',
}

interface CreateSkillInput {
  draft: typeof EMPTY_FORM
  release: SplitBusyRelease
}

function SkillCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { beginBusy, report } = useSplitDirty()
  const [tab, setTab] = useState<Tab>('managed')
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [zipDirty, setZipDirty] = useState(false)
  const [packageDirty, setPackageDirty] = useState(false)
  const [packageBusy, setPackageBusy] = useState(false)
  const [packageOutcomeUnknown, setPackageOutcomeUnknown] = useState(false)
  const zipPanelRef = useRef<ImportZipPanelHandle | null>(null)
  const packagePanelRef = useRef<ResourcePackageImportPanelHandle | null>(null)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  // The route owns one composite create draft. A selected/reviewed archive is
  // just as unsafe to lose as typed manual fields; a committed result is clean.
  const { dirty } = useDirtyBaseline(form, EMPTY_FORM)
  useReportSplitDirty(NEW_CARD_KEY, dirty || zipDirty || packageDirty)

  const discardAll = useCallback(() => {
    if (zipPanelRef.current?.discard() === false) return false
    if (packagePanelRef.current?.discard() === false) return false
    setForm({ ...EMPTY_FORM })
    setZipDirty(false)
    setPackageDirty(false)
    report(NEW_CARD_KEY, false)
    return true
  }, [report])
  useRegisterSplitDiscard(NEW_CARD_KEY, discardAll)

  const create = useMutation({
    mutationFn: ({ draft }: CreateSkillInput): Promise<Skill> =>
      api.post<Skill>('/api/skills', {
        name: draft.name,
        description: draft.description,
        bodyMd: draft.bodyMd,
      }),
    onSuccess: (s, { release }) => {
      report(NEW_CARD_KEY, false) // sync-clear before navigating
      release()
      void qc.invalidateQueries({ queryKey: ['skills'] })
      qc.setQueryData(['skills', s.id], s)
      navigate({ to: '/skills/$id', params: { id: s.id } })
    },
    onSettled: (_skill, _error, { release }) => release(),
  })

  const disabled =
    form.name === '' ||
    create.isPending ||
    packageBusy ||
    packageOutcomeUnknown ||
    !SKILL_NAME_RE.test(form.name)

  return (
    <fieldset className="agent-new detail-freeze" disabled={create.isPending || packageBusy}>
      <PageHeader
        title={
          tab === 'zip'
            ? t('skills.importTitle')
            : tab === 'package'
              ? t('resourcePackage.importTitle')
              : t('skills.newTitle')
        }
        headingLevel={2}
        actions={
          tab === 'managed' && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                if (!packageBusy && !packageOutcomeUnknown) {
                  create.mutate({ draft: { ...form }, release: beginBusy(NEW_CARD_KEY) })
                }
              }}
              disabled={disabled}
              data-testid="skill-create-button"
            >
              {create.isPending ? t('common.creating') : t('skills.createButton')}
            </button>
          )
        }
      >
        {tab === 'zip' && <p className="page__hint">{t('skills.importSubtitle')}</p>}
        {tab === 'package' && <p className="page__hint">{t('resourcePackage.createMethodHint')}</p>}
      </PageHeader>

      <TabBar<Tab>
        tabs={[
          {
            key: 'managed',
            label: t('skills.tabManaged'),
            disabled: packageBusy || packageOutcomeUnknown,
            ...(create.error !== null && create.error !== undefined
              ? {
                  badge: '!',
                  badgeTone: 'danger' as const,
                  badgeAriaLabel: t('editor.draftStatus.phase.error'),
                }
              : dirty
                ? {
                    badge: '•',
                    badgeTone: 'neutral' as const,
                    badgeAriaLabel: t('editor.statusUnsaved'),
                  }
                : {}),
          },
          {
            key: 'zip',
            label: t('skills.tabZip'),
            testid: 'skills-tab-zip',
            disabled: packageBusy || packageOutcomeUnknown,
            ...(zipDirty
              ? {
                  badge: '•',
                  badgeTone: 'neutral' as const,
                  badgeAriaLabel: t('editor.statusUnsaved'),
                }
              : {}),
          },
          {
            key: 'package',
            label: t('resourcePackage.importTitle'),
            testid: 'skills-tab-package',
            disabled: packageBusy,
            ...(packageDirty
              ? {
                  badge: '•',
                  badgeTone: 'neutral' as const,
                  badgeAriaLabel: t('editor.statusUnsaved'),
                }
              : {}),
          },
        ]}
        active={tab}
        onSelect={(nextTab) => {
          if (!packageBusy && (!packageOutcomeUnknown || nextTab === 'package')) setTab(nextTab)
        }}
        ariaLabel={t('skills.title')}
        idPrefix="skills-new"
      />

      {/* ZIP panel kept mounted so its staged selection survives tab switches. */}
      <TabPanels<Tab>
        active={tab}
        idPrefix="skills-new"
        className="split__detail-body"
        panels={[
          {
            key: 'zip',
            content: (
              <ImportZipPanel
                ref={zipPanelRef}
                onDirtyChange={setZipDirty}
                beginCommitBusy={() => beginBusy(NEW_CARD_KEY)}
              />
            ),
          },
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
                <FeedbackStack className="stack-top--sm">
                  {create.error !== null && create.error !== undefined && (
                    <ErrorBanner error={create.error} />
                  )}
                </FeedbackStack>
              </>
            ),
          },
          {
            key: 'package',
            content: (
              <ResourcePackageImportPanel
                expectedRootType="skill"
                ref={packagePanelRef}
                onDirtyChange={setPackageDirty}
                onBusyChange={setPackageBusy}
                onOutcomeUnknownChange={setPackageOutcomeUnknown}
                prepareAutoOpen={() => {
                  setPackageDirty(false)
                  const otherDirty = dirty || zipDirty
                  report(NEW_CARD_KEY, otherDirty)
                  return !otherDirty
                }}
                beginCommitBusy={() => {
                  setPackageBusy(true)
                  const release = beginBusy(NEW_CARD_KEY)
                  return () => {
                    release()
                    setPackageBusy(false)
                  }
                }}
              />
            ),
          },
        ]}
      />
    </fieldset>
  )
}

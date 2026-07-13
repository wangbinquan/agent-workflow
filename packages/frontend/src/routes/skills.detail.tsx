// Skill detail / edit page — the right rail of the /skills split page.
//
// RFC-169 (T12): child route under the /skills layout (path '/$name'), with
// remountDeps so switching skills reseeds cleanly. Four tabs — Overview /
// Content / Files / History. RFC-178: skills are managed-only, so every skill is
// fully editable (description + body + files + version history + fusion); the
// three-state authority capability gating was removed. Save goes through the
// RFC-170 combined-save funnel (composite-token OCC) and stays in place.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Skill, SkillContent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { useReportSplitDirty, useSplitDirty } from '@/components/split/splitDirty'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { FuseDialog } from '@/components/fusion/FuseDialog'
import { LoadingState } from '@/components/LoadingState'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { SkillFileTree } from '@/components/SkillFileTree'
import { SkillVersionHistory } from '@/components/skill/SkillVersionHistory'
import { TabBar, type TabDef } from '@/components/TabBar'
import { TabPanels } from '@/components/split/TabPanels'
import { Route as skillsRoute } from './skills'

export const Route = createRoute({
  getParentRoute: () => skillsRoute,
  path: '/$name',
  component: SkillDetailPage,
  remountDeps: ({ params }) => params,
})

type SkillTab = 'overview' | 'content' | 'files' | 'history'

interface SkillDraft {
  description: string
  bodyMd: string
}

function SkillDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { report } = useSplitDirty()

  const meta = useQuery<Skill>({
    queryKey: ['skills', name],
    queryFn: ({ signal }) => api.get(`/api/skills/${encodeURIComponent(name)}`, undefined, signal),
  })
  const content = useQuery<SkillContent>({
    queryKey: ['skills', name, 'content'],
    queryFn: ({ signal }) =>
      api.get(`/api/skills/${encodeURIComponent(name)}/content`, undefined, signal),
  })

  const [tab, setTab] = useState<SkillTab>('overview')
  const [fuseOpen, setFuseOpen] = useState(false)
  const [restorePending, setRestorePending] = useState(false)

  // RFC-170 T-BSAFE③ (Codex F2-review / §2 "双查询播种退役"): seed BOTH editable
  // fields from the ONE fenced content read. SKILL.md's frontmatter description is
  // the authority (design §267) and it rides the SAME response as the body + the
  // precondition token, so description + body + token are a single consistent
  // snapshot. Seeding description from the separate metadata query let a stale
  // description ride a fresh token and silently roll back a concurrent edit on
  // save. `ready` waits for meta (header) so the page still hydrates whole;
  // clean-follow rebases the draft (description AND body) when a restore/save
  // refetches content.
  const { draft, setDraft, loaded, dirty, commitSaved } = useDraftFromQuery<
    SkillContent,
    SkillDraft
  >(content.data, (c) => ({ description: c.description, bodyMd: c.bodyMd }), {
    ready: meta.data !== undefined,
    followWhenClean: true,
  })
  useReportSplitDirty(name, dirty)
  const description = draft?.description ?? ''
  const bodyMd = draft?.bodyMd ?? ''
  const setDescription = (v: string) =>
    setDraft((d) => (d === undefined ? d : { ...d, description: v }))
  const setBodyMd = (v: string) => setDraft((d) => (d === undefined ? d : { ...d, bodyMd: v }))

  // RFC-170 T4/T-BSAFE③ — combined description+body save under composite-token OCC
  // is the SINGLE save funnel (the old double-PUT metadata/content writers are
  // retired → 410). The response carries a FRESH token the QueryClient becomes the
  // sole owner of (setQueryData); a 409 conflict refetches so the next save uses
  // the current token instead of silently overwriting a concurrent change.
  const combinedSave = useMutation({
    mutationFn: (payload: { description?: string; bodyMd?: string; expectedToken: string }) =>
      api.post<SkillContent>(`/api/skills/${encodeURIComponent(name)}/save`, payload),
    onSuccess: (next) => {
      qc.setQueryData(['skills', name, 'content'], next)
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: ['skills', name, 'content'] })
    },
  })

  const saving = combinedSave.isPending
  const operationBusy = saving || restorePending

  // RFC-178: managed-only, so description + body are always editable and written
  // atomically under token OCC. A 409 (concurrent change / delete-recreate ABA) is
  // surfaced, not silently clobbered; a success reseeds the draft ONCE and
  // best-effort refetches so the history panel shows the authoritative version.
  const handleSave = async () => {
    if (draft === undefined) return
    const token = content.data?.token
    if (token === undefined) return // content still loading — no token to fence on
    const submitted: SkillDraft = { description, bodyMd }
    try {
      await combinedSave.mutateAsync({ description, bodyMd, expectedToken: token })
    } catch {
      return // stays dirty; onError refetched a fresh token, error surfaces below
    }
    commitSaved(submitted, submitted)
    void qc.invalidateQueries({ queryKey: ['skills', name] })
    void qc.invalidateQueries({ queryKey: ['skills', name, 'versions'] })
    void qc.invalidateQueries({ queryKey: ['skills'], exact: true })
  }

  const del = useMutation({
    mutationFn: () => api.delete(`/api/skills/${encodeURIComponent(name)}`),
    onSuccess: async () => {
      report(name, false) // sync-clear so the guard doesn't block this navigation
      await qc.cancelQueries({ queryKey: ['skills'], exact: true })
      qc.setQueryData<Skill[]>(['skills'], (rows) =>
        rows === undefined ? rows : rows.filter((r) => r.name !== name),
      )
      void qc.invalidateQueries({ queryKey: ['skills'], exact: true })
      navigate({ to: '/skills' })
    },
  })

  if (draft === undefined) {
    if (meta.isLoading || content.isLoading)
      return <LoadingState data-testid="skill-detail-loading" />
    if (meta.error !== null && meta.error !== undefined) return <ErrorBanner error={meta.error} />
    if (content.error !== null && content.error !== undefined)
      return <ErrorBanner error={content.error} />
    if (meta.data === undefined) return null
  }

  const overview = (
    <>
      <div className="skill-detail__meta">
        <code>{meta.data?.managedPath ?? ''}</code>
      </div>
      <Field label={t('skills.fieldDescription')} hint={t('skills.descHintManaged')}>
        <TextInput
          value={description}
          onChange={setDescription}
          data-testid="skill-description-input"
        />
      </Field>
    </>
  )

  const contentPanel = <MarkdownEditor value={bodyMd} onChange={setBodyMd} fill />

  const tabs: Array<TabDef<SkillTab>> = [
    { key: 'overview', label: t('skills.detailTabOverview'), testid: 'skill-tab-overview' },
    { key: 'content', label: t('skills.detailTabContent'), testid: 'skill-tab-content' },
    { key: 'files', label: t('skills.detailTabFiles'), testid: 'skill-tab-files' },
    { key: 'history', label: t('skills.detailTabHistory'), testid: 'skill-tab-history' },
  ]

  return (
    <fieldset className="detail-freeze skill-detail" disabled={del.isPending}>
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/skills/${encodeURIComponent(name)}`,
          invalidateKey: ['skills'],
          canTransferOwner: true,
        }}
        save={{
          label: saving ? t('common.saving') : t('common.save'),
          onClick: () => {
            void handleSave()
          },
          disabled: operationBusy || !loaded,
          testid: 'skill-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        extra={
          <button type="button" className="btn" onClick={() => setFuseOpen(true)}>
            {t('fusion.launchFromSkillButton')}
          </button>
        }
        errors={[combinedSave.error, del.error]}
      >
        <div>
          <h2>{name}</h2>
        </div>
      </DetailHeaderActions>

      <div className="agent-form">
        <TabBar tabs={tabs} active={tab} onSelect={setTab} ariaLabel={t('skills.title')} />
        <TabPanels
          active={tab}
          className="split__detail-body agent-form__panel"
          panels={[
            { key: 'overview', testid: 'skill-panel-overview', content: overview },
            {
              key: 'content',
              testid: 'skill-panel-content',
              className: 'agent-form__panel--prompt',
              content: contentPanel,
            },
            {
              key: 'files',
              testid: 'skill-panel-files',
              content: (
                <SkillFileTree skillName={name} readonly={false} readonlyPaths={['SKILL.md']} />
              ),
            },
            {
              key: 'history',
              testid: 'skill-panel-history',
              content: (
                <SkillVersionHistory
                  skillName={name}
                  currentVersion={meta.data?.contentVersion ?? 0}
                  busy={operationBusy || dirty}
                  onPendingChange={setRestorePending}
                />
              ),
            },
          ]}
        />
      </div>

      <FuseDialog
        open={fuseOpen}
        onClose={() => setFuseOpen(false)}
        entry={{ kind: 'from-skill', skillName: name }}
      />
    </fieldset>
  )
}

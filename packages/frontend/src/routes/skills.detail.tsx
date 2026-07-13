// Skill detail / edit page — the right rail of the /skills split page.
//
// RFC-169 (T12): child route under the /skills layout (path '/$name'), with
// remountDeps so switching skills reseeds cleanly. Four tabs — Overview /
// Content / Files / History. Save stays in place (double-PUT LWW as today, but
// reseeds the draft via commitSaved and best-effort refetches content+versions
// instead of navigating away). The deeper version-consistency work (combined
// save / composite-token CAS / snapshot authority) is RFC-170; 169 keeps the
// current double-PUT and adds only stay-in-place + simple mutual exclusion.

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
import { skillCapabilities, skillCapabilitiesOf } from '@/lib/skill-capabilities'
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

  // Hydrate-once draft over TWO sources (meta + content), with clean-follow so a
  // restore (which invalidates content) rebases the clean draft to the restored
  // body. Save reseeds via commitSaved rather than navigating away.
  const { draft, setDraft, loaded, dirty, commitSaved } = useDraftFromQuery<Skill, SkillDraft>(
    meta.data,
    (m) => ({ description: m.description, bodyMd: content.data?.bodyMd ?? '' }),
    { ready: content.data !== undefined, followWhenClean: true },
  )
  useReportSplitDirty(name, dirty)
  const description = draft?.description ?? ''
  const bodyMd = draft?.bodyMd ?? ''
  const setDescription = (v: string) =>
    setDraft((d) => (d === undefined ? d : { ...d, description: v }))
  const setBodyMd = (v: string) => setDraft((d) => (d === undefined ? d : { ...d, bodyMd: v }))

  // RFC-170 (G5-P2): capabilities key off `authorityKind` (three-state). Before
  // meta loads, the page renders LoadingState (draft is undefined), so the
  // source-external fallback here is inert — the least-privileged safe default.
  const caps = meta.data ? skillCapabilitiesOf(meta.data) : skillCapabilities('source-external')

  const saveMeta = useMutation({
    mutationFn: (payload: { description: string }) =>
      api.put<Skill>(`/api/skills/${encodeURIComponent(name)}`, payload),
    onSuccess: (s) => {
      qc.setQueryData(['skills', name], s)
    },
  })
  const saveContent = useMutation({
    mutationFn: (payload: { bodyMd: string }) =>
      api.put<SkillContent>(`/api/skills/${encodeURIComponent(name)}/content`, payload),
    onSuccess: (next) => {
      qc.setQueryData(['skills', name, 'content'], next)
    },
  })
  // RFC-170 T4 — combined description+body save under composite-token OCC (managed
  // skills). The response carries a FRESH token the QueryClient becomes the sole
  // owner of (setQueryData); a 409 conflict refetches so the next save uses the
  // current token instead of silently overwriting a concurrent change.
  const combinedSave = useMutation({
    mutationFn: (payload: { description: string; bodyMd: string; expectedToken: string }) =>
      api.post<SkillContent>(`/api/skills/${encodeURIComponent(name)}/save`, payload),
    onSuccess: (next) => {
      qc.setQueryData(['skills', name, 'content'], next)
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: ['skills', name, 'content'] })
    },
  })

  const saving = saveMeta.isPending || saveContent.isPending || combinedSave.isPending
  const operationBusy = saving || restorePending

  // RFC-169 §5.2 (skills special, F1/F2): keep the current double-PUT LWW but
  // reseed in place. Only when ALL required channels fulfil do we commitSaved
  // ONCE and best-effort refetch content+versions so the history panel shows the
  // authoritative latest version (the two PUTs aren't a single snapshot, so we
  // don't apply the generic "don't refetch after write" rule).
  const handleSave = async () => {
    if (draft === undefined) return
    const submitted: SkillDraft = { description, bodyMd }
    const token = content.data?.token

    // RFC-170 T4: managed skill + a precondition token → ONE atomic combined-save
    // under token OCC (no more double-PUT LWW; a concurrent change / delete-recreate
    // ABA is 409-rejected, not silently clobbered).
    if (caps.canEditContent && token !== undefined) {
      try {
        await combinedSave.mutateAsync({ description, bodyMd, expectedToken: token })
      } catch {
        return // stays dirty; onError refetched a fresh token, error surfaces below
      }
      commitSaved(submitted, submitted)
      void qc.invalidateQueries({ queryKey: ['skills', name] })
      void qc.invalidateQueries({ queryKey: ['skills', name, 'versions'] })
      void qc.invalidateQueries({ queryKey: ['skills'], exact: true })
      return
    }

    // External / legacy (no token): keep the RFC-169 double-PUT LWW + reseed.
    const channels: Promise<unknown>[] = [saveMeta.mutateAsync({ description })]
    if (caps.canEditContent) channels.push(saveContent.mutateAsync({ bodyMd }))
    const results = await Promise.allSettled(channels)
    if (results.every((r) => r.status === 'fulfilled')) {
      commitSaved(submitted, submitted)
      // best-effort refresh (authoritative version history / content version)
      void qc.invalidateQueries({ queryKey: ['skills', name] })
      void qc.invalidateQueries({ queryKey: ['skills', name, 'content'] })
      void qc.invalidateQueries({ queryKey: ['skills', name, 'versions'] })
      void qc.invalidateQueries({ queryKey: ['skills'], exact: true })
    }
    // partial failure → stays dirty, per-channel errors surface below.
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
        <span className={`chip chip--tight chip--${meta.data?.sourceKind ?? 'external'}`}>
          {t(meta.data?.sourceKind === 'managed' ? 'skills.tabManaged' : 'skills.tabExternal')}
        </span>{' '}
        <code>{meta.data?.managedPath ?? meta.data?.externalPath ?? ''}</code>
      </div>
      <Field
        label={t('skills.fieldDescription')}
        hint={caps.showManagedHint ? t('skills.descHintManaged') : t('skills.descHintExternal')}
      >
        <TextInput value={description} onChange={setDescription} />
      </Field>
    </>
  )

  const contentPanel = caps.canEditContent ? (
    <MarkdownEditor value={bodyMd} onChange={setBodyMd} fill />
  ) : (
    <pre className="readonly-pre">{bodyMd || t('skills.emptyBody')}</pre>
  )

  const tabs: Array<TabDef<SkillTab>> = [
    { key: 'overview', label: t('skills.detailTabOverview'), testid: 'skill-tab-overview' },
    { key: 'content', label: t('skills.detailTabContent'), testid: 'skill-tab-content' },
    { key: 'files', label: t('skills.detailTabFiles'), testid: 'skill-tab-files' },
  ]
  if (caps.showVersionHistory) {
    tabs.push({ key: 'history', label: t('skills.detailTabHistory'), testid: 'skill-tab-history' })
  }

  return (
    <fieldset className="detail-freeze skill-detail" disabled={del.isPending}>
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/skills/${encodeURIComponent(name)}`,
          invalidateKey: ['skills'],
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
          caps.canFuse && (
            <button type="button" className="btn" onClick={() => setFuseOpen(true)}>
              {t('fusion.launchFromSkillButton')}
            </button>
          )
        }
        errors={[combinedSave.error, saveMeta.error, saveContent.error, del.error]}
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
                <SkillFileTree
                  skillName={name}
                  readonly={!caps.canBrowseFilesWritable}
                  readonlyPaths={['SKILL.md']}
                />
              ),
            },
            ...(caps.showVersionHistory
              ? [
                  {
                    key: 'history' as const,
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
                ]
              : []),
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

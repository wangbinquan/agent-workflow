// MCP detail / edit page — the right rail of the /mcps split page.
//
// RFC-169 (T15): child route under the /mcps layout (path '/$name'), two tabs
// (Config / Tools & probe). Save stays in place and invalidates the probe cache
// (a config change makes the persisted probe stale). The inventory panel + its
// re-probe move from "stacked above the form" into the Tools & probe tab.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { useReportSplitDirty, useSplitDirty } from '@/components/split/splitDirty'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { McpFields } from '@/components/McpFields'
import { McpInventoryPanel } from '@/components/mcps/McpInventoryPanel'
import { TabBar, type TabDef } from '@/components/TabBar'
import { TabPanels } from '@/components/split/TabPanels'
import { MCP_PROBES_KEY } from '@/lib/mcp-probe-query'
import { buildCreatePayload, EMPTY_LOCAL_FORM, mcpToForm, type McpFormState } from '@/lib/mcp-form'
import { Route as mcpsRoute } from './mcps'

export const Route = createRoute({
  getParentRoute: () => mcpsRoute,
  path: '/$name',
  component: McpDetailPage,
  remountDeps: ({ params }) => params,
})

type McpTab = 'config' | 'probe'

function McpDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { report } = useSplitDirty()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<McpTab>('config')

  const query = useQuery<Mcp>({
    queryKey: ['mcps', name],
    queryFn: ({ signal }) => api.get(`/api/mcps/${encodeURIComponent(name)}`, undefined, signal),
  })

  const {
    draft: form,
    setDraft: setForm,
    loaded,
    dirty,
    commitSaved,
  } = useDraftFromQuery(query.data, mcpToForm, { followWhenClean: true })
  useReportSplitDirty(name, dirty)

  const save = useMutation({
    mutationFn: (snapshot: McpFormState): Promise<Mcp> => {
      const built = buildCreatePayload(snapshot)
      if (!built.ok) return Promise.reject(new Error('invalid form'))
      const { name: _drop, ...patch } = built.payload
      return api.put<Mcp>(`/api/mcps/${encodeURIComponent(name)}`, patch)
    },
    onSuccess: async (m, snapshot) => {
      await qc.cancelQueries({ queryKey: ['mcps', name], exact: true })
      qc.setQueryData(['mcps', name], m)
      await qc.cancelQueries({ queryKey: ['mcps'], exact: true })
      qc.setQueryData<Mcp[]>(['mcps'], (rows) =>
        rows === undefined ? rows : rows.map((r) => (r.name === name ? m : r)),
      )
      void qc.invalidateQueries({ queryKey: ['mcps'], exact: true })
      // A config change makes the persisted probe stale.
      void qc.invalidateQueries({ queryKey: MCP_PROBES_KEY })
      commitSaved(snapshot, mcpToForm(m))
    },
  })

  function submitSave() {
    if (form === undefined) return
    const built = buildCreatePayload(form)
    if (!built.ok) {
      setErrors(built.errors)
      save.reset()
      return
    }
    setErrors({})
    save.mutate(form)
  }

  const del = useMutation({
    mutationFn: () => api.delete(`/api/mcps/${encodeURIComponent(name)}`),
    onSuccess: async () => {
      report(name, false)
      await qc.cancelQueries({ queryKey: ['mcps'], exact: true })
      qc.setQueryData<Mcp[]>(['mcps'], (rows) =>
        rows === undefined ? rows : rows.filter((r) => r.name !== name),
      )
      void qc.invalidateQueries({ queryKey: ['mcps'], exact: true })
      navigate({ to: '/mcps' })
    },
  })

  if (form === undefined) {
    if (query.isLoading) return <LoadingState data-testid="mcp-detail-loading" />
    if (query.error !== null && query.error !== undefined)
      return <ErrorBanner error={query.error} />
    return null
  }

  const tabs: Array<TabDef<McpTab>> = [
    { key: 'config', label: t('mcps.detailTabConfig'), testid: 'mcp-tab-config' },
    { key: 'probe', label: t('mcps.detailTabProbe'), testid: 'mcp-tab-probe' },
  ]

  return (
    <fieldset className="detail-freeze" disabled={del.isPending}>
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/mcps/${encodeURIComponent(name)}`,
          invalidateKey: ['mcps'],
        }}
        save={{
          label: save.isPending ? t('common.saving') : t('common.save'),
          onClick: submitSave,
          disabled: save.isPending || !loaded,
          testid: 'mcp-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        errors={[save.error, del.error]}
      >
        <div>
          <h2>{name}</h2>
        </div>
      </DetailHeaderActions>

      <div className="agent-form">
        <TabBar tabs={tabs} active={tab} onSelect={setTab} ariaLabel={t('mcps.title')} />
        <TabPanels
          active={tab}
          className="split__detail-body agent-form__panel"
          panels={[
            {
              key: 'config',
              testid: 'mcp-panel-config',
              content: (
                <McpFields
                  value={form ?? EMPTY_LOCAL_FORM}
                  onChange={setForm}
                  nameLocked
                  errors={errors}
                />
              ),
            },
            {
              key: 'probe',
              testid: 'mcp-panel-probe',
              content: <McpInventoryPanel mcpName={name} />,
            },
          ]}
        />
      </div>
    </fieldset>
  )
}

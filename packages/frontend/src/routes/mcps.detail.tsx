// MCP detail / edit page — the right rail of the /mcps split page.
//
// RFC-169 / RFC-223: child route under the /mcps layout (path '/$id'), two tabs
// (Config / Tools & probe). Save stays in place and invalidates the probe cache
// (a config change makes the persisted probe stale). The inventory panel + its
// re-probe move from "stacked above the form" into the Tools & probe tab.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Mcp, McpOperationResource } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import {
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
} from '@/components/split/splitDirty'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { McpFields } from '@/components/McpFields'
import { McpInventoryPanel } from '@/components/mcps/McpInventoryPanel'
import { TabBar, type TabDef } from '@/components/TabBar'
import { TabPanels } from '@/components/split/TabPanels'
import { MCP_PROBES_KEY, mcpProbeKey } from '@/lib/mcp-probe-query'
import { buildCreatePayload, EMPTY_LOCAL_FORM, mcpToForm, type McpFormState } from '@/lib/mcp-form'
import { stableStringify } from '@/lib/stable-stringify'
import { Route as mcpsRoute } from './mcps'

export const Route = createRoute({
  getParentRoute: () => mcpsRoute,
  path: '/$id',
  component: McpDetailPage,
  remountDeps: ({ params }) => params,
})

type McpTab = 'config' | 'probe'

function McpDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { beginBusy, report } = useSplitDirty()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<McpTab>('config')

  const query = useQuery<McpOperationResource>({
    queryKey: ['mcps', id],
    queryFn: ({ signal }) => api.get(`/api/mcps/${encodeURIComponent(id)}`, undefined, signal),
  })

  const {
    draft: form,
    setDraft: setForm,
    loaded,
    dirty,
    commitSaved,
  } = useDraftFromQuery(query.data, mcpToForm, { followWhenClean: true })
  const formRef = useRef(form)
  formRef.current = form
  useReportSplitDirty(id, dirty)

  const save = useMutation({
    mutationFn: ({
      snapshot,
    }: {
      snapshot: McpFormState
      release: SplitBusyRelease
    }): Promise<McpOperationResource> => {
      const built = buildCreatePayload(snapshot)
      if (!built.ok) return Promise.reject(new Error('invalid form'))
      const { name: _drop, ...patch } = built.payload
      const revision = query.data
      if (revision === undefined) return Promise.reject(new Error('MCP revision is unavailable'))
      return api.put<McpOperationResource>(`/api/mcps/${encodeURIComponent(id)}`, {
        ...patch,
        expectedConfigHash: revision.operationConfigHash,
      })
    },
    onSuccess: async (m, { snapshot }) => {
      await qc.cancelQueries({ queryKey: ['mcps', id], exact: true })
      qc.setQueryData(['mcps', id], m)
      await qc.cancelQueries({ queryKey: ['mcps'], exact: true })
      qc.setQueryData<Mcp[]>(['mcps'], (rows) =>
        rows === undefined ? rows : rows.map((r) => (r.id === id ? m : r)),
      )
      void qc.invalidateQueries({ queryKey: ['mcps'], exact: true })
      // A config change makes the persisted probe stale.
      void qc.invalidateQueries({ queryKey: MCP_PROBES_KEY })
      void qc.invalidateQueries({ queryKey: mcpProbeKey(id), exact: true })
      commitSaved(snapshot, mcpToForm(m))
    },
    onSettled: (_mcp, _error, { release }) => release(),
  })

  function showValidationErrors(nextErrors: Record<string, string>): void {
    setErrors(nextErrors)
    save.reset()
    setTab('config')
    const first = ['name', 'command', 'url', 'timeoutMs'].find(
      (field) => nextErrors[field] !== undefined,
    )
    if (first !== undefined) {
      const id = first === 'timeoutMs' ? 'mcp-field-timeout' : `mcp-field-${first}`
      setTimeout(() => document.getElementById(id)?.focus(), 0)
    }
  }

  function submitSave() {
    if (form === undefined) return
    const built = buildCreatePayload(form)
    if (!built.ok) {
      showValidationErrors(built.errors)
      return
    }
    setErrors({})
    if (save.isPending || del.isPending) return
    save.mutate({ snapshot: form, release: beginBusy(id) })
  }

  async function saveForProbe(): Promise<string | null> {
    const snapshot = formRef.current
    if (snapshot === undefined || save.isPending || del.isPending) return null
    const built = buildCreatePayload(snapshot)
    if (!built.ok) {
      showValidationErrors(built.errors)
      return null
    }
    setErrors({})
    const receipt = await save.mutateAsync({ snapshot, release: beginBusy(id) })
    if (stableStringify(formRef.current) !== stableStringify(snapshot)) {
      throw new Error(t('mcps.probe.draftChangedDuringSave'))
    }
    return receipt.operationConfigHash
  }

  const del = useMutation({
    mutationFn: ({ confirm, release: _release }: { confirm: string; release: SplitBusyRelease }) =>
      query.data === undefined
        ? Promise.reject(new Error('MCP revision is unavailable'))
        : api.deleteJson(`/api/mcps/${encodeURIComponent(id)}`, {
            confirm,
            expectedConfigHash: query.data.operationConfigHash,
          }),
    onSuccess: async (_deleted, { release }) => {
      report(id, false)
      await qc.cancelQueries({ queryKey: ['mcps'], exact: true })
      qc.setQueryData<Mcp[]>(['mcps'], (rows) =>
        rows === undefined ? rows : rows.filter((r) => r.id !== id),
      )
      void qc.invalidateQueries({ queryKey: ['mcps'], exact: true })
      release()
      navigate({ to: '/mcps' })
    },
    onSettled: (_deleted, _error, { release }) => release(),
  })

  if (form === undefined) {
    if (query.isLoading) return <LoadingState data-testid="mcp-detail-loading" />
    if (query.error !== null && query.error !== undefined)
      return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
    return null
  }

  const tabs: Array<TabDef<McpTab>> = [
    { key: 'config', label: t('mcps.detailTabConfig'), testid: 'mcp-tab-config' },
    { key: 'probe', label: t('mcps.detailTabProbe'), testid: 'mcp-tab-probe' },
  ]

  return (
    <fieldset className="detail-freeze" disabled={del.isPending}>
      <DetailHeaderActions
        title={query.data?.name ?? id}
        headingLevel={2}
        acl={{
          resourceBaseUrl: `/api/mcps/${encodeURIComponent(id)}`,
          invalidateKey: ['mcps'],
        }}
        save={{
          label: save.isPending ? t('common.saving') : t('common.save'),
          onClick: submitSave,
          disabled: save.isPending || del.isPending || !loaded,
          testid: 'mcp-save-button',
        }}
        del={{
          label: t('common.delete'),
          confirmName: query.data?.name ?? id,
          resourceType: 'mcp',
          onConfirm: (ctx) => {
            if (save.isPending || del.isPending) return Promise.resolve()
            return del.mutateAsync({ confirm: ctx?.typedConfirm ?? '', release: beginBusy(id) })
          },
          disabled: del.isPending || save.isPending,
        }}
        errors={[save.error, del.error]}
      />

      {query.error !== null && query.error !== undefined && (
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      )}

      <div className="agent-form">
        <TabBar
          tabs={tabs}
          active={tab}
          onSelect={setTab}
          ariaLabel={t('mcps.title')}
          idPrefix="mcps-detail"
        />
        <TabPanels
          active={tab}
          idPrefix="mcps-detail"
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
              content: (
                <McpInventoryPanel
                  mcpId={id}
                  operationConfigHash={query.data?.operationConfigHash}
                  mcpUpdatedAt={query.data?.updatedAt}
                  dirty={dirty}
                  saving={save.isPending}
                  onSaveForProbe={saveForProbe}
                  beginBusy={() => beginBusy(id)}
                />
              ),
            },
          ]}
        />
      </div>
    </fieldset>
  )
}

// RFC-031 — /plugins list + inline editor. Keeps the v1 surface tight:
// single route (no /plugins/new sub-route), table of registered plugins on
// top, and an "Add plugin" / "Edit plugin" panel below that flips between
// create and edit modes based on the row the user clicks.
//
// Two operator-facing actions are bound directly on each row:
//   - "Check for update" → POST /api/plugins/:id/check-update — does not
//     mutate cache; reports `{ current, latest, available }`.
//   - "Upgrade"          → POST /api/plugins/:id/upgrade — re-installs the
//     current spec, swapping the cached path / version atomically.
//
// The runner injects `file://<cachedPath>` at spawn time (see
// services/runner.ts buildInlineConfig), so a successful upgrade reflects on
// the next task spawn without restarting the daemon. In-flight tasks keep
// the old cachedPath until they exit (process isolation guarantee).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreatePlugin, Plugin, UpdatePlugin } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/plugins',
  component: PluginsPage,
})

interface PluginFormState {
  name: string
  spec: string
  optionsJson: string
  description: string
  enabled: boolean
}

const EMPTY_FORM: PluginFormState = {
  name: '',
  spec: '',
  optionsJson: '{}',
  description: '',
  enabled: true,
}

function PluginsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Plugin[]>({
    queryKey: ['plugins'],
    queryFn: ({ signal }) => api.get('/api/plugins', undefined, signal),
  })

  // editingId === null → create mode. Otherwise the plugin row's id.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PluginFormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<Record<string, { latest: string | null }>>({})

  // Sync the form state when the user toggles between rows / "new".
  useEffect(() => {
    if (editingId === null) {
      setForm(EMPTY_FORM)
      setFormError(null)
      return
    }
    const found = (data ?? []).find((p) => p.id === editingId)
    if (found !== undefined) {
      setForm({
        name: found.name,
        spec: found.spec,
        optionsJson: JSON.stringify(found.options ?? {}, null, 2),
        description: found.description,
        enabled: found.enabled,
      })
      setFormError(null)
    }
  }, [editingId, data])

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/plugins/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })

  const create = useMutation({
    mutationFn: async (): Promise<Plugin> => {
      const payload = parseFormToCreate(form)
      if (payload === null) {
        setFormError(t('plugins.errorOptionsJson'))
        throw new Error('invalid')
      }
      return api.post<Plugin>('/api/plugins', payload)
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      setEditingId(p.id)
    },
  })

  const update = useMutation({
    mutationFn: async (id: string): Promise<Plugin> => {
      const patch = parseFormToUpdate(form, data?.find((p) => p.id === id))
      if (patch === null) {
        setFormError(t('plugins.errorOptionsJson'))
        throw new Error('invalid')
      }
      return api.put<Plugin>(`/api/plugins/${encodeURIComponent(id)}`, patch)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })

  const checkUpdate = useMutation({
    mutationFn: async (id: string): Promise<{ available: boolean; latest: string | null }> =>
      api.post<{ available: boolean; latest: string | null; current: string | null }>(
        `/api/plugins/${encodeURIComponent(id)}/check-update`,
      ),
    onSuccess: (result, id) =>
      setUpdateInfo((s) => ({ ...s, [id]: { latest: result.latest } })),
  })

  const upgrade = useMutation({
    mutationFn: async (id: string): Promise<Plugin> =>
      api.post<Plugin>(`/api/plugins/${encodeURIComponent(id)}/upgrade`),
    onSuccess: (_p, id) => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      setUpdateInfo((s) => {
        const next = { ...s }
        delete next[id]
        return next
      })
    },
  })

  const submitForm = (): void => {
    if (editingId === null) create.mutate()
    else update.mutate(editingId)
  }

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('plugins.title')}</h1>
          <p className="page__hint">{t('plugins.hint')}</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setEditingId(null)}
          data-testid="plugins-new-button"
        >
          {t('plugins.newButton')}
        </button>
      </header>

      {isLoading && <div className="muted">{t('common.loading')}</div>}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && del.error !== undefined && <ErrorBanner error={del.error} />}
      {checkUpdate.error !== null && checkUpdate.error !== undefined && (
        <ErrorBanner error={checkUpdate.error} />
      )}
      {upgrade.error !== null && upgrade.error !== undefined && <ErrorBanner error={upgrade.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <div className="muted">{t('plugins.emptyList')}</div>
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('plugins.colName')}</th>
              <th>{t('plugins.colSpec')}</th>
              <th>{t('plugins.colSource')}</th>
              <th>{t('plugins.colVersion')}</th>
              <th>{t('plugins.colEnabled')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((p) => {
              const upd = updateInfo[p.id]
              const isCheckingThis = checkUpdate.isPending && checkUpdate.variables === p.id
              const isUpgradingThis = upgrade.isPending && upgrade.variables === p.id
              const updateAvailable =
                upd !== undefined && upd.latest !== null && upd.latest !== p.resolvedVersion
              return (
                <tr key={p.id} data-testid={`plugin-row-${p.name}`}>
                  <td className="data-table__nowrap">
                    <button
                      type="button"
                      className="data-table__link"
                      onClick={() => setEditingId(p.id)}
                    >
                      {p.name}
                    </button>
                  </td>
                  <td className="data-table__truncate" title={p.spec}>
                    <code className="muted">{p.spec}</code>
                  </td>
                  <td className="data-table__nowrap">
                    <span className="chip chip--tight">{p.sourceKind}</span>
                  </td>
                  <td className="data-table__nowrap">
                    {p.resolvedVersion ?? t('common.emDash')}
                    {updateAvailable && (
                      <span className="chip chip--tight" data-testid={`plugin-update-${p.name}`}>
                        {' '}
                        → {upd.latest}
                      </span>
                    )}
                  </td>
                  <td>{p.enabled ? t('common.yes') : t('common.no')}</td>
                  <td className="data-table__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => checkUpdate.mutate(p.id)}
                      disabled={isCheckingThis}
                      data-testid={`plugin-check-update-${p.name}`}
                    >
                      {isCheckingThis ? t('plugins.checking') : t('plugins.checkUpdateButton')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => upgrade.mutate(p.id)}
                      disabled={isUpgradingThis || !updateAvailable}
                      data-testid={`plugin-upgrade-${p.name}`}
                    >
                      {isUpgradingThis ? t('plugins.upgrading') : t('plugins.upgradeButton')}
                    </button>
                    <ConfirmButton
                      label={t('common.delete')}
                      onConfirm={() => del.mutateAsync(p.id)}
                      danger
                      disabled={del.isPending}
                      size="sm"
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <section className="page__section">
        <h2>{editingId === null ? t('plugins.formTitleNew') : t('plugins.formTitleEdit')}</h2>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault()
            submitForm()
          }}
        >
          <label className="form-field">
            <span>{t('plugins.fieldName')}</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={editingId !== null}
              data-testid="plugin-form-name"
            />
          </label>
          <label className="form-field">
            <span>{t('plugins.fieldSpec')}</span>
            <input
              type="text"
              value={form.spec}
              onChange={(e) => setForm({ ...form, spec: e.target.value })}
              data-testid="plugin-form-spec"
            />
            <small className="muted">{t('plugins.fieldSpecHint')}</small>
          </label>
          <label className="form-field">
            <span>{t('plugins.fieldDescription')}</span>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label className="form-field">
            <span>{t('plugins.fieldOptions')}</span>
            <textarea
              value={form.optionsJson}
              onChange={(e) => setForm({ ...form, optionsJson: e.target.value })}
              rows={4}
              data-testid="plugin-form-options"
            />
            <small className="muted">{t('plugins.fieldOptionsHint')}</small>
          </label>
          <label className="form-field form-field--inline">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span>{t('plugins.fieldEnabled')}</span>
          </label>
          {formError !== null && <ErrorBanner error={new Error(formError)} />}
          {create.error !== null && create.error !== undefined && (
            <ErrorBanner error={create.error} />
          )}
          {update.error !== null && update.error !== undefined && (
            <ErrorBanner error={update.error} />
          )}
          <div className="form-actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={create.isPending || update.isPending}
              data-testid="plugin-form-submit"
            >
              {editingId === null
                ? create.isPending
                  ? t('plugins.creating')
                  : t('plugins.createButton')
                : update.isPending
                  ? t('plugins.saving')
                  : t('plugins.saveButton')}
            </button>
            {editingId !== null && (
              <button type="button" className="btn" onClick={() => setEditingId(null)}>
                {t('plugins.cancelEdit')}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  )
}

/** Try to parse the editor's `optionsJson` text field into a plain object. */
function tryParseOptions(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text === '' ? '{}' : text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function parseFormToCreate(form: PluginFormState): CreatePlugin | null {
  const opts = tryParseOptions(form.optionsJson)
  if (opts === null) return null
  return {
    name: form.name,
    spec: form.spec,
    options: opts,
    description: form.description,
    enabled: form.enabled,
  }
}

function parseFormToUpdate(form: PluginFormState, existing: Plugin | undefined): UpdatePlugin | null {
  const opts = tryParseOptions(form.optionsJson)
  if (opts === null) return null
  const patch: UpdatePlugin = {}
  if (existing === undefined) return null
  if (form.spec !== existing.spec) patch.spec = form.spec
  if (form.description !== existing.description) patch.description = form.description
  if (form.enabled !== existing.enabled) patch.enabled = form.enabled
  const existingOptions = JSON.stringify(existing.options ?? {})
  if (JSON.stringify(opts) !== existingOptions) patch.options = opts
  return patch
}

// ApiError import kept to surface backend error codes verbatim when needed.
void ApiError

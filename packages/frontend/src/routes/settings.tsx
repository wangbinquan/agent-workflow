// /settings — Config editor with 4 sections (Runtime / Limits / GC / Network).
// Auth section moved to /settings/connection so the daemon URL + token live
// next to the sign-out button.
//
// Each section owns a draft slice of the config, posts ConfigPatch via PUT,
// shows a "saved" toast, and labels fields that need a daemon restart.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Config, ConfigPatch } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Field, NumberInput, Switch, TextInput } from '@/components/Form'
import { describeApiError } from '@/i18n'
import { clearToken, getBaseUrl, getToken } from '@/stores/auth'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/settings',
  component: SettingsPage,
})

type Tab = 'runtime' | 'limits' | 'gc' | 'network' | 'appearance' | 'connection'

function SettingsPage() {
  const [tab, setTab] = useState<Tab>('runtime')
  const { t } = useTranslation()
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
  })

  return (
    <div className="page">
      <header className="page__header">
        <h1>{t('settings.title')}</h1>
        <p className="page__hint">
          {t('settings.hintBacked')}
          <code>~/.agent-workflow/config.json</code>
          {t('settings.hintPatched')}
          <code>PUT /api/config</code>
          {t('settings.hintRestart')}
        </p>
      </header>

      <div className="tabs">
        {(
          [
            ['runtime', t('settings.tabRuntime')],
            ['limits', t('settings.tabLimits')],
            ['gc', t('settings.tabGc')],
            ['network', t('settings.tabNetwork')],
            ['appearance', t('settings.tabAppearance')],
            ['connection', t('settings.tabConnection')],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`tabs__tab ${tab === k ? 'tabs__tab--active' : ''}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {config.isLoading && <div className="muted">{t('settings.loading')}</div>}
      {config.error !== null && config.error !== undefined && (
        <div className="error-box">{describeError(config.error)}</div>
      )}
      {config.data !== undefined && (
        <>
          {tab === 'runtime' && <RuntimeTab config={config.data} />}
          {tab === 'limits' && <LimitsTab config={config.data} />}
          {tab === 'gc' && <GcTab config={config.data} />}
          {tab === 'network' && <NetworkTab config={config.data} />}
          {tab === 'appearance' && <AppearanceTab config={config.data} />}
          {tab === 'connection' && <ConnectionTab />}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

interface TabProps {
  config: Config
}

function RuntimeTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, [
    'opencodePath',
    'defaultModel',
    'defaultVariant',
    'defaultTemperature',
    'maxConcurrentNodes',
    'multiProcessSubprocessConcurrency',
    'logLevel',
  ])
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Field label={t('settingsForm.opencodePath')} hint={t('settingsForm.opencodePathHint')}>
        <TextInput
          value={state.opencodePath ?? ''}
          onChange={(v) => setState({ ...state, opencodePath: v === '' ? undefined : v })}
        />
      </Field>
      <Field label={t('settingsForm.defaultModel')} hint={t('settingsForm.defaultModelHint')}>
        <TextInput
          value={state.defaultModel ?? ''}
          onChange={(v) => setState({ ...state, defaultModel: v === '' ? undefined : v })}
          placeholder="anthropic/claude-sonnet-4-6"
        />
      </Field>
      <Field label={t('settingsForm.defaultVariant')}>
        <TextInput
          value={state.defaultVariant ?? ''}
          onChange={(v) => setState({ ...state, defaultVariant: v === '' ? undefined : v })}
        />
      </Field>
      <Field label={t('settingsForm.defaultTemperature')}>
        <NumberInput
          value={state.defaultTemperature}
          onChange={(v) => setState({ ...state, defaultTemperature: v })}
          min={0}
          max={2}
          step={0.1}
        />
      </Field>
      <div className="form-grid form-grid--cols-2">
        <Field label={t('settingsForm.maxConcurrentNodes')} required>
          <NumberInput
            value={state.maxConcurrentNodes}
            onChange={(v) => setState({ ...state, maxConcurrentNodes: v ?? 1 })}
            min={1}
          />
        </Field>
        <Field label={t('settingsForm.multiProcessConc')} required>
          <NumberInput
            value={state.multiProcessSubprocessConcurrency}
            onChange={(v) => setState({ ...state, multiProcessSubprocessConcurrency: v ?? 1 })}
            min={1}
          />
        </Field>
      </div>
      <Field label={t('settingsForm.logLevel')}>
        <select
          className="form-input"
          value={state.logLevel}
          onChange={(e) => setState({ ...state, logLevel: e.target.value as Config['logLevel'] })}
        >
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </Field>
    </SectionForm>
  )
}

function LimitsTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, [
    'defaultPerTaskMaxDurationMs',
    'defaultPerTaskMaxTotalTokens',
    'defaultPerNodeTimeoutMs',
    'largeOutputThresholdBytes',
  ])
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Field
        label={t('settingsForm.perTaskDuration')}
        required
        hint={t('settingsForm.zeroUnlimited')}
      >
        <NumberInput
          value={state.defaultPerTaskMaxDurationMs}
          onChange={(v) => setState({ ...state, defaultPerTaskMaxDurationMs: v ?? 0 })}
          min={0}
          step={60_000}
        />
      </Field>
      <Field
        label={t('settingsForm.perTaskTokens')}
        required
        hint={t('settingsForm.zeroUnlimited')}
      >
        <NumberInput
          value={state.defaultPerTaskMaxTotalTokens}
          onChange={(v) => setState({ ...state, defaultPerTaskMaxTotalTokens: v ?? 0 })}
          min={0}
        />
      </Field>
      <Field label={t('settingsForm.perNodeTimeout')} required>
        <NumberInput
          value={state.defaultPerNodeTimeoutMs}
          onChange={(v) => setState({ ...state, defaultPerNodeTimeoutMs: v ?? 60_000 })}
          min={1000}
          step={60_000}
        />
      </Field>
      <Field label={t('settingsForm.largeOutputThreshold')} required>
        <NumberInput
          value={state.largeOutputThresholdBytes}
          onChange={(v) => setState({ ...state, largeOutputThresholdBytes: v ?? 1_048_576 })}
          min={1024}
          step={1024}
        />
      </Field>
    </SectionForm>
  )
}

function GcTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, [
    'worktreeAutoGc',
    'eventsArchiveThresholds',
  ])
  const gc = state.worktreeAutoGc
  const thresholds = state.eventsArchiveThresholds
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Switch
        checked={gc?.enabled === true}
        onChange={(v) => setState({ ...state, worktreeAutoGc: { ...(gc ?? {}), enabled: v } })}
        label={t('settingsForm.autoGcLabel')}
        hint={t('settingsForm.autoGcHint')}
      />
      <div className="form-grid form-grid--cols-2">
        <Field label={t('settingsForm.olderThanDays')}>
          <NumberInput
            value={gc?.olderThanDays}
            onChange={(v) =>
              setState({
                ...state,
                worktreeAutoGc: { ...(gc ?? { enabled: false }), olderThanDays: v },
              })
            }
            min={1}
          />
        </Field>
        <Switch
          checked={gc?.onlyMerged === true}
          onChange={(v) =>
            setState({
              ...state,
              worktreeAutoGc: { ...(gc ?? { enabled: false }), onlyMerged: v },
            })
          }
          label={t('settingsForm.onlyMerged')}
        />
      </div>
      <Field
        label={t('settingsForm.archivePerNodeRun')}
        required
        hint={t('settingsForm.archivePerNodeRunHint')}
      >
        <NumberInput
          value={thresholds?.perNodeRunRows}
          onChange={(v) =>
            setState({
              ...state,
              eventsArchiveThresholds: { ...thresholds!, perNodeRunRows: v ?? 50_000 },
            })
          }
          min={1000}
        />
      </Field>
      <Field
        label={t('settingsForm.archiveGlobal')}
        required
        hint={t('settingsForm.archiveGlobalHint')}
      >
        <NumberInput
          value={thresholds?.globalRows}
          onChange={(v) =>
            setState({
              ...state,
              eventsArchiveThresholds: { ...thresholds!, globalRows: v ?? 1_000_000 },
            })
          }
          min={10_000}
        />
      </Field>
      <BackupCard />
    </SectionForm>
  )
}

function BackupCard() {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ path: string; sizeBytes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runBackup = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await api.post<{ path: string; sizeBytes: number }>('/api/backup', {})
      setResult({ path: r.path, sizeBytes: r.sizeBytes })
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="info-box-muted" style={{ marginTop: 16 }}>
      <strong>{t('settings.backupTitle')}</strong>
      <p style={{ marginTop: 4, marginBottom: 8, fontSize: 13 }}>{t('settings.backupHint')}</p>
      <button type="button" className="btn" onClick={runBackup} disabled={busy}>
        {busy ? t('settings.backupRunning') : t('settings.backupCreate')}
      </button>
      {result !== null && (
        <p style={{ marginTop: 8, fontSize: 13 }} className="muted">
          {t('settings.backupSavedAs')}
          <code>{result.path}</code> ({(result.sizeBytes / 1024 / 1024).toFixed(2)} MB)
        </p>
      )}
      {error !== null && (
        <p style={{ marginTop: 8, fontSize: 13 }} className="error-box">
          {error}
        </p>
      )}
    </div>
  )
}

function NetworkTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save, restartRequired } = useTabState(config, ['bindHost', 'bindPort'])
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
      restartRequired={restartRequired}
    >
      <Field label={t('settingsForm.bindHost')} required hint={t('settingsForm.bindHostHint')}>
        <TextInput
          value={state.bindHost ?? '127.0.0.1'}
          onChange={(v) => setState({ ...state, bindHost: v })}
        />
      </Field>
      <Field label={t('settingsForm.bindPort')} hint={t('settingsForm.bindPortHint')}>
        <NumberInput
          value={state.bindPort}
          onChange={(v) => setState({ ...state, bindPort: v })}
          min={0}
          max={65535}
        />
      </Field>
    </SectionForm>
  )
}

function AppearanceTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, ['theme'])
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Field label={t('settings.themeLabel')} hint={t('settings.themeHint')}>
        <select
          className="form-input"
          value={state.theme ?? 'system'}
          onChange={(e) => setState({ ...state, theme: e.target.value as Config['theme'] })}
        >
          <option value="system">{t('settings.themeSystem')}</option>
          <option value="light">{t('settings.themeLight')}</option>
          <option value="dark">{t('settings.themeDark')}</option>
        </select>
      </Field>
    </SectionForm>
  )
}

function ConnectionTab() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const token = getToken()
  const baseUrl = getBaseUrl()
  function signOut() {
    clearToken()
    navigate({ to: '/auth' })
  }
  return (
    <div className="form-grid">
      <Field label={t('settingsForm.daemonUrl')}>
        <div>
          <code>{baseUrl}</code>
        </div>
      </Field>
      <Field label={t('settingsForm.tokenLabel')}>
        <div>
          {token === null ? (
            <em>{t('settingsForm.tokenNone')}</em>
          ) : (
            <code>{maskToken(token, t)}</code>
          )}
        </div>
      </Field>
      <div>
        <button type="button" onClick={signOut} className="btn btn--danger">
          {t('settingsForm.signOut')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * P-5-09: config keys whose new value only takes effect on the next daemon
 * start. After a successful PUT we compare these against the pre-save snapshot
 * and surface a restart banner in `<SectionForm>` whenever one of them moved.
 */
export const RESTART_REQUIRED_KEYS: ReadonlySet<keyof ConfigPatch> = new Set([
  'bindHost',
  'bindPort',
])

/**
 * Returns true iff at least one of `keys` is a restart-required key AND its
 * value differs between `before` and `after`. Exported for unit tests.
 */
export function hasRestartRequiredChange(
  keys: readonly (keyof ConfigPatch)[],
  before: Partial<Record<keyof ConfigPatch, unknown>>,
  after: Partial<Record<keyof ConfigPatch, unknown>>,
): boolean {
  return keys.some((k) => {
    if (!RESTART_REQUIRED_KEYS.has(k)) return false
    return after[k] !== before[k]
  })
}

function useTabState<K extends keyof ConfigPatch>(config: Config, keys: K[]) {
  const qc = useQueryClient()
  const initial: ConfigPatch = {}
  for (const k of keys) {
    ;(initial as Record<string, unknown>)[k] = (config as Record<string, unknown>)[k]
  }
  const [state, setState] = useState<ConfigPatch>(initial)
  const [restartRequired, setRestartRequired] = useState(false)

  // Re-seed when the config re-fetches (e.g. after save).
  useEffect(() => {
    const next: ConfigPatch = {}
    for (const k of keys) {
      ;(next as Record<string, unknown>)[k] = (config as Record<string, unknown>)[k]
    }
    setState(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  const save = useMutation({
    mutationFn: () => api.put<Config>('/api/config', state),
    onSuccess: (next) => {
      // Restart banner fires whenever any restart-required key handled by this
      // tab actually changed value. Comparing to `config` (the pre-save query
      // snapshot) rather than `state` avoids false positives when the user
      // saved without editing those fields.
      setRestartRequired(hasRestartRequiredChange(keys, config, next))
      qc.setQueryData(['config'], next)
    },
    onMutate: () => {
      setRestartRequired(false)
    },
  })
  return { state, setState, save, restartRequired }
}

interface SectionFormProps {
  onSave: () => void
  busy: boolean
  error: unknown
  success: string | null
  restartRequired?: boolean
  children: React.ReactNode
}

function SectionForm({
  onSave,
  busy,
  error,
  success,
  restartRequired,
  children,
}: SectionFormProps) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="form-grid">{children}</div>
      <div className="form-actions">
        <button type="button" className="btn btn--primary" onClick={() => onSave()} disabled={busy}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
        {success !== null && <span className="form-actions__ok">{t('common.saved')}</span>}
        {error !== null && error !== undefined && (
          <span className="form-actions__error">{describeError(error)}</span>
        )}
      </div>
      {restartRequired === true && (
        <div className="info-box" role="status" aria-live="polite" style={{ marginTop: 12 }}>
          <strong>{t('settings.restartRequiredTitle')}</strong>
          <p style={{ marginTop: 4, marginBottom: 0, fontSize: 13 }}>
            {t('settings.restartRequiredHint')}
          </p>
        </div>
      )}
    </div>
  )
}

function maskToken(
  token: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (token.length <= 8) return '••••'
  return t('settingsForm.tokenMask', {
    prefix: token.slice(0, 4),
    suffix: token.slice(-4),
    len: token.length,
  })
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

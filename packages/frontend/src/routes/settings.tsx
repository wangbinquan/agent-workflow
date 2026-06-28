// /settings — config editor split into per-concern tabs (Runtime / Limits /
// Recovery / GC / Network / Appearance / Memory / Rendering / Authentication).
//
// Each section owns a draft slice of the config, posts ConfigPatch via PUT,
// shows a "saved" toast, and labels fields that need a daemon restart.
//
// Sign-out + the daemon URL / token readout used to live here in a "Connection"
// tab; that was removed. Sign-out is the UserMenu's job (it also invalidates the
// server session via /api/auth/logout, which this tab never did), and active
// sessions / tokens are managed on /account.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Config, ConfigPatch } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, NumberInput, Switch, TextInput } from '@/components/Form'
import { RuntimeSelect } from '@/components/RuntimeSelect'
import { Select } from '@/components/Select'
import { RuntimeList } from '@/components/RuntimeList'
import { describeApiError, setLanguage, type SupportedLanguage } from '@/i18n'
import { isSupportedLanguage } from '@/hooks/useLanguage'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/settings',
  component: SettingsPage,
})

type Tab =
  | 'runtime'
  | 'limits'
  | 'recovery'
  | 'gc'
  | 'network'
  | 'appearance'
  | 'memory'
  | 'rendering'
  | 'authentication'

function SettingsPage() {
  const [tab, setTab] = useState<Tab>('runtime')
  const [runtimeFlashKey, setRuntimeFlashKey] = useState(0)
  const { t } = useTranslation()
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
  })

  // RFC-032: when the sidebar's runtime nav row navigates here it lands on
  // `/settings#runtime`. Force the runtime tab + bump a key the RuntimeTab
  // uses to re-trigger its flash animation. We also re-trigger the flash on
  // every navigation to the same hash (router updates that don't unmount).
  const hash = useRouterState({ select: (s) => s.location.hash })
  useEffect(() => {
    if (hash === 'runtime') {
      setTab('runtime')
      setRuntimeFlashKey((k) => k + 1)
    }
  }, [hash])

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
            ['recovery', t('settings.tabRecovery')],
            ['gc', t('settings.tabGc')],
            ['network', t('settings.tabNetwork')],
            ['appearance', t('settings.tabAppearance')],
            ['memory', t('settings.tabMemory')],
            ['rendering', t('settings.tabRendering')],
            ['authentication', t('settings.tabAuthentication')],
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
          {tab === 'runtime' && <RuntimeTab flashKey={runtimeFlashKey} />}
          {tab === 'limits' && <LimitsTab config={config.data} />}
          {tab === 'recovery' && <RecoveryTab config={config.data} />}
          {tab === 'gc' && <GcTab config={config.data} />}
          {tab === 'network' && <NetworkTab config={config.data} />}
          {tab === 'appearance' && <AppearanceTab config={config.data} />}
          {tab === 'memory' && <MemoryTab config={config.data} />}
          {tab === 'rendering' && <RenderingTab config={config.data} />}
          {tab === 'authentication' && <AuthenticationTab />}
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

function RuntimeTab({ flashKey = 0 }: { flashKey?: number }) {
  const runtimeRef = useRef<HTMLDivElement | null>(null)
  const [flashing, setFlashing] = useState(false)

  // RFC-032: scroll + flash the runtime block when the sidebar runtime row
  // navigates here (location.hash === '#runtime' bumps flashKey).
  useEffect(() => {
    if (flashKey === 0) return
    setFlashing(true)
    runtimeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const id = window.setTimeout(() => setFlashing(false), 2000)
    return () => window.clearTimeout(id)
  }, [flashKey])

  // RFC-113: the Runtime tab is JUST the runtimes table. Every runtime/model
  // setting (binary, model, variant, temperature, steps + the in-table default
  // marker) lives on the rows now; the global execution knobs (concurrency / log
  // level / auto commit&push) moved to the Limits tab.
  return (
    <div
      ref={runtimeRef}
      className={`runtime-status-anchor${flashing ? ' runtime-status-anchor--flash' : ''}`}
      data-flash={flashing ? '1' : '0'}
    >
      <RuntimeList />
    </div>
  )
}

function LimitsTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, [
    'defaultPerTaskMaxDurationMs',
    'defaultPerTaskMaxTotalTokens',
    'defaultPerNodeTimeoutMs',
    'defaultNodeRetries',
    'largeOutputThresholdBytes',
    // RFC-113: global execution knobs relocated here from the Runtime tab (which
    // is now just the runtimes table).
    'maxConcurrentNodes',
    'multiProcessSubprocessConcurrency',
    'logLevel',
    'commitPushRuntime',
    'commitPushMaxRepairRetries',
    'commitPushDiffMaxBytes',
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
      <Field
        label={t('settingsForm.nodeRetries')}
        required
        hint={t('settingsForm.nodeRetriesHint')}
      >
        <NumberInput
          value={state.defaultNodeRetries}
          onChange={(v) => setState({ ...state, defaultNodeRetries: v ?? 0 })}
          min={0}
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
      {/* RFC-113: global execution knobs relocated from the Runtime tab. */}
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
        <Select<NonNullable<Config['logLevel']>>
          value={state.logLevel ?? config.logLevel}
          ariaLabel={t('settingsForm.logLevel')}
          onChange={(v) => setState({ ...state, logLevel: v })}
          options={[
            { value: 'debug', label: 'debug' },
            { value: 'info', label: 'info' },
            { value: 'warn', label: 'warn' },
            { value: 'error', label: 'error' },
          ]}
        />
      </Field>
      <Field
        label={t('settingsForm.commitPushRuntime')}
        hint={t('settingsForm.commitPushRuntimeHint')}
      >
        <RuntimeSelect
          value={state.commitPushRuntime}
          ariaLabel={t('settingsForm.commitPushRuntime')}
          onChange={(v) => setState({ ...state, commitPushRuntime: v })}
        />
      </Field>
      <div className="form-grid form-grid--cols-2">
        <Field
          label={t('settingsForm.commitPushMaxRepairRetries')}
          hint={t('settingsForm.commitPushMaxRepairRetriesHint')}
        >
          <NumberInput
            value={state.commitPushMaxRepairRetries}
            onChange={(v) => setState({ ...state, commitPushMaxRepairRetries: v })}
            min={0}
            max={10}
          />
        </Field>
        <Field
          label={t('settingsForm.commitPushDiffMaxBytes')}
          hint={t('settingsForm.commitPushDiffMaxBytesHint')}
        >
          <NumberInput
            value={state.commitPushDiffMaxBytes}
            onChange={(v) => setState({ ...state, commitPushDiffMaxBytes: v })}
            min={0}
            max={262144}
          />
        </Field>
      </div>
    </SectionForm>
  )
}

// RFC-108 T24 (AR-config) — auto-recovery knobs. Every auto-execution toggle
// defaults OFF (decision D1); this tab is where an operator opts in + tunes the
// circuit-breaker. Reuses the shared Switch / Field / NumberInput primitives.
function RecoveryTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, [
    'autoResumeOnBoot',
    'autoRepair',
    'autoKillStalledChild',
    'heartbeatStallMs',
    'maxAutoRecoveriesPerWindow',
    'autoRecoveryWindowMs',
    'periodicOrphanReconcileMs',
  ])
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Switch
        checked={state.autoResumeOnBoot ?? false}
        onChange={(v) => setState({ ...state, autoResumeOnBoot: v })}
        label={t('settingsForm.autoResumeOnBoot')}
        hint={t('settingsForm.autoResumeOnBootHint')}
      />
      <Switch
        checked={(state.autoRepair ?? {}).S4 === true}
        onChange={(v) => setState({ ...state, autoRepair: { ...(state.autoRepair ?? {}), S4: v } })}
        label={t('settingsForm.autoRepairS4')}
        hint={t('settingsForm.autoRepairS4Hint')}
      />
      <Switch
        checked={state.autoKillStalledChild ?? false}
        onChange={(v) => setState({ ...state, autoKillStalledChild: v })}
        label={t('settingsForm.autoKillStalledChild')}
        hint={t('settingsForm.autoKillStalledChildHint')}
      />
      <Field label={t('settingsForm.heartbeatStallMs')} required>
        <NumberInput
          value={state.heartbeatStallMs}
          onChange={(v) => setState({ ...state, heartbeatStallMs: v ?? 1_800_000 })}
          min={1000}
          step={60_000}
        />
      </Field>
      <Field label={t('settingsForm.maxAutoRecoveriesPerWindow')} required>
        <NumberInput
          value={state.maxAutoRecoveriesPerWindow}
          onChange={(v) => setState({ ...state, maxAutoRecoveriesPerWindow: v ?? 3 })}
          min={1}
        />
      </Field>
      <Field label={t('settingsForm.autoRecoveryWindowMs')} required>
        <NumberInput
          value={state.autoRecoveryWindowMs}
          onChange={(v) => setState({ ...state, autoRecoveryWindowMs: v ?? 3_600_000 })}
          min={1000}
          step={60_000}
        />
      </Field>
      <Field
        label={t('settingsForm.periodicOrphanReconcileMs')}
        hint={t('settingsForm.zeroDisabled')}
      >
        <NumberInput
          value={state.periodicOrphanReconcileMs}
          onChange={(v) => setState({ ...state, periodicOrphanReconcileMs: v ?? 0 })}
          min={0}
          step={60_000}
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
    <div className="info-box-muted stack-top--md">
      <strong>{t('settings.backupTitle')}</strong>
      <p className="settings-hint">{t('settings.backupHint')}</p>
      <button type="button" className="btn" onClick={runBackup} disabled={busy}>
        {busy ? t('settings.backupRunning') : t('settings.backupCreate')}
      </button>
      {result !== null && (
        <p className="muted settings-hint settings-hint--tight stack-top--sm">
          {t('settings.backupSavedAs')}
          <code>{result.path}</code> ({(result.sizeBytes / 1024 / 1024).toFixed(2)} MB)
        </p>
      )}
      {error !== null && (
        <p className="error-box settings-hint settings-hint--tight stack-top--sm">{error}</p>
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

export function AppearanceTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, ['theme', 'language'], {
    onSaved: (next) => {
      if (isSupportedLanguage(next.language)) setLanguage(next.language as SupportedLanguage)
    },
  })
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Field label={t('settings.themeLabel')} hint={t('settings.themeHint')}>
        <Select<NonNullable<Config['theme']>>
          value={state.theme ?? 'system'}
          ariaLabel={t('settings.themeLabel')}
          onChange={(v) => setState({ ...state, theme: v })}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') },
          ]}
        />
      </Field>
      <Field label={t('settings.languageLabel')} hint={t('settings.languageHint')}>
        <Select<SupportedLanguage>
          value={state.language ?? 'zh-CN'}
          ariaLabel={t('settings.languageLabel')}
          data-testid="settings-language-select"
          onChange={(v) => setState({ ...state, language: v })}
          options={[
            { value: 'zh-CN', label: t('settings.languageZhCN') },
            { value: 'en-US', label: t('settings.languageEnUS') },
          ]}
        />
      </Field>
    </SectionForm>
  )
}

// RFC-050 — Memory tab. Hosts the distill output language + the distiller
// model override (RFC-041 T5.3). Future distiller knobs
// (e.g. memoryDistillerEnabled / per-scope inject budgets) can move here in
// follow-ups so the JSON-only config surface gets a visible home.
export function MemoryTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, [
    'memoryDistillLang',
    'memoryDistillRuntime',
  ])
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Field
        label={t('settings.memoryDistillRuntimeLabel')}
        hint={t('settings.memoryDistillRuntimeHint')}
      >
        <RuntimeSelect
          value={state.memoryDistillRuntime}
          ariaLabel={t('settings.memoryDistillRuntimeLabel')}
          onChange={(v) => setState({ ...state, memoryDistillRuntime: v })}
        />
      </Field>
      <Field
        label={t('settings.memoryDistillLangLabel')}
        hint={t('settings.memoryDistillLangHint')}
      >
        <Select<'' | NonNullable<Config['memoryDistillLang']>>
          data-testid="settings-memory-distill-lang-select"
          ariaLabel={t('settings.memoryDistillLangLabel')}
          value={state.memoryDistillLang ?? ''}
          onChange={(v) => setState({ ...state, memoryDistillLang: v === '' ? undefined : v })}
          options={[
            { value: '', label: t('settings.memoryDistillLangDefault') },
            { value: 'en-US', label: t('settings.memoryDistillLangEnUS') },
            { value: 'zh-CN', label: t('settings.memoryDistillLangZhCN') },
          ]}
        />
      </Field>
    </SectionForm>
  )
}

function RenderingTab({ config }: TabProps) {
  const { t } = useTranslation()
  const { state, setState, save } = useTabState(config, ['plantumlEndpoint', 'plantumlAuthHeader'])
  const [testState, setTestState] = useState<{
    kind: 'idle' | 'running' | 'success' | 'failure'
    msg?: string
  }>({ kind: 'idle' })

  async function runConnectivityTest() {
    const endpoint = (state.plantumlEndpoint ?? '').trim()
    if (endpoint.length === 0) {
      setTestState({ kind: 'failure', msg: t('settings.renderingTestEmptyEndpoint') })
      return
    }
    setTestState({ kind: 'running' })
    const { PlantUmlBlock } = await import('@/components/review/PlantUmlBlock')
    const mount = document.createElement('div')
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', endpoint, state.plantumlAuthHeader)
    // The PlantUmlBlock helper hands off to fetch + DOM mutation. Watch the
    // mount node for a state change for up to 10s.
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      if (mount.querySelector('.review-diagram__svg') !== null) {
        setTestState({ kind: 'success', msg: t('settings.renderingTestSuccess') })
        return
      }
      if (mount.querySelector('.review-diagram__error') !== null) {
        const errText =
          mount.querySelector('.review-diagram__error')?.textContent ??
          t('settings.renderingTestUnknownError')
        setTestState({ kind: 'failure', msg: t('settings.renderingTestFailure') + errText })
        return
      }
    }
    setTestState({
      kind: 'failure',
      msg: t('settings.renderingTestFailure') + t('settings.renderingTestTimeout'),
    })
  }

  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Field
        label={t('settings.renderingPlantumlEndpointLabel')}
        hint={t('settings.renderingPlantumlEndpointHint')}
      >
        <TextInput
          value={state.plantumlEndpoint ?? ''}
          onChange={(v) => setState({ ...state, plantumlEndpoint: v })}
          placeholder={t('settings.renderingPlantumlEndpointPlaceholder')}
        />
      </Field>
      <Field
        label={t('settings.renderingPlantumlAuthLabel')}
        hint={t('settings.renderingPlantumlAuthHint')}
      >
        <TextInput
          value={state.plantumlAuthHeader ?? ''}
          onChange={(v) => setState({ ...state, plantumlAuthHeader: v })}
          placeholder={t('settings.renderingPlantumlAuthPlaceholder')}
        />
      </Field>
      <div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void runConnectivityTest()
          }}
          disabled={testState.kind === 'running'}
        >
          {testState.kind === 'running'
            ? t('settings.renderingTestRunning')
            : t('settings.renderingTestButton')}
        </button>
        {testState.kind === 'success' && (
          <div className="muted" role="status" aria-live="polite">
            {testState.msg}
          </div>
        )}
        {testState.kind === 'failure' && (
          <div className="error-box" role="alert">
            {testState.msg}
          </div>
        )}
      </div>
    </SectionForm>
  )
}

// RFC-036 — OIDC providers admin tab. CRUD + connection test for the
// /api/oidc/providers endpoint. clientSecret is never readable from the
// API (only re-writable); empty clientSecret on PATCH leaves the stored
// value unchanged.
function AuthenticationTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<OidcProviderRow | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const list = useQuery<OidcProviderRow[]>({
    queryKey: ['oidc-providers'],
    queryFn: () => api.get('/api/oidc/providers'),
  })

  const remove = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) =>
      api.delete(`/api/oidc/providers/${id}${force ? '?force=true' : ''}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['oidc-providers'] }),
  })

  return (
    <div className="auth-tab">
      <header className="auth-tab__header">
        <div>
          <h2 className="auth-tab__title">
            {t('settings.auth.providersTitle', { defaultValue: 'OIDC providers' })}
          </h2>
          <p className="auth-tab__hint">
            {t('settings.auth.providersHint', {
              defaultValue:
                'Configure identity providers users can sign in with. Each provider stores its OAuth 2.0 / OIDC client_id + client_secret + scopes. The client_secret is AES-256-GCM-sealed at rest.',
            })}
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setShowCreate(true)}>
          {t('settings.auth.add', { defaultValue: 'Add provider' })}
        </button>
      </header>

      {list.isLoading && <div className="muted">{t('settings.loading')}</div>}
      {list.error && <div className="auth-form__error">{(list.error as Error).message}</div>}

      {list.data && list.data.length === 0 && (
        <p className="account-empty">
          {t('settings.auth.empty', {
            defaultValue: 'No providers yet. Add one to enable single sign-on.',
          })}
        </p>
      )}

      {list.data && list.data.length > 0 && (
        <table className="account-table">
          <thead>
            <tr>
              <th>{t('settings.auth.colSlug', { defaultValue: 'Slug' })}</th>
              <th>{t('settings.auth.colName', { defaultValue: 'Name' })}</th>
              <th>{t('settings.auth.colIssuer', { defaultValue: 'Issuer' })}</th>
              <th>{t('settings.auth.colProvisioning', { defaultValue: 'Provisioning' })}</th>
              <th>{t('settings.auth.colEnabled', { defaultValue: 'Enabled' })}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((p) => (
              <tr key={p.id}>
                <td>
                  <code>{p.slug}</code>
                </td>
                <td>{p.displayName}</td>
                <td className="account-table__ua">{p.issuerUrl}</td>
                <td>{p.provisioning}</td>
                <td>
                  <span
                    className={`account-dot account-dot--status-${p.enabled ? 'active' : 'disabled'}`}
                    aria-hidden
                  />{' '}
                  {p.enabled
                    ? t('settings.auth.enabled', { defaultValue: 'enabled' })
                    : t('settings.auth.disabled', { defaultValue: 'disabled' })}
                </td>
                <td>
                  <button className="btn btn--ghost btn--xs" onClick={() => setEditing(p)}>
                    {t('settings.auth.edit', { defaultValue: 'Edit' })}
                  </button>
                  <button
                    className="btn btn--ghost btn--xs btn--danger"
                    onClick={() => {
                      if (
                        window.confirm(
                          t('settings.auth.deleteConfirm', {
                            defaultValue: `Delete provider "${p.displayName}"?`,
                            name: p.displayName,
                          }),
                        )
                      ) {
                        remove.mutate({ id: p.id, force: false })
                      }
                    }}
                  >
                    {t('settings.auth.delete', { defaultValue: 'Delete' })}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <OidcProviderDialog
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false)
            qc.invalidateQueries({ queryKey: ['oidc-providers'] })
          }}
        />
      )}
      {editing && (
        <OidcProviderDialog
          mode="edit"
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            qc.invalidateQueries({ queryKey: ['oidc-providers'] })
          }}
        />
      )}
    </div>
  )
}

interface OidcProviderRow {
  id: string
  slug: string
  displayName: string
  issuerUrl: string
  clientId: string
  scopes: string
  provisioning: 'auto' | 'allowlist' | 'invite'
  allowedEmailDomains: string[]
  iconUrl: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

function OidcProviderDialog(props: {
  mode: 'create' | 'edit'
  initial?: OidcProviderRow
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const initial = props.initial
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '')
  const [issuerUrl, setIssuerUrl] = useState(initial?.issuerUrl ?? '')
  const [clientId, setClientId] = useState(initial?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [scopes, setScopes] = useState(initial?.scopes ?? 'openid profile email')
  const [provisioning, setProvisioning] = useState<'auto' | 'allowlist' | 'invite'>(
    initial?.provisioning ?? 'invite',
  )
  const [allowedDomains, setAllowedDomains] = useState(
    (initial?.allowedEmailDomains ?? []).join(', '),
  )
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [testResult, setTestResult] = useState<
    | null
    | { ok: true; issuer: string; tokenEndpoint: string; jwksUri: string }
    | { ok: false; error: string }
  >(null)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        slug,
        displayName,
        issuerUrl,
        clientId,
        ...(clientSecret ? { clientSecret } : props.mode === 'create' ? { clientSecret: '' } : {}),
        scopes,
        provisioning,
        allowedEmailDomains: allowedDomains
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        iconUrl: null,
        enabled,
      }
      if (props.mode === 'create') {
        return api.post('/api/oidc/providers', body)
      }
      return api.patch(`/api/oidc/providers/${initial!.id}`, body)
    },
    onSuccess: () => props.onSaved(),
    onError: (e: unknown) => setError(e instanceof ApiError ? e.message : (e as Error).message),
  })

  const testConnection = useMutation({
    mutationFn: async () => {
      // For new providers we don't have an id yet — use the issuer URL directly.
      // For edit we hit the per-id /test endpoint so the daemon resolves the row.
      if (props.mode === 'edit' && initial) {
        return api.post<
          | { ok: true; issuer: string; tokenEndpoint: string; jwksUri: string }
          | { ok: false; error: string }
        >(`/api/oidc/providers/${initial.id}/test`)
      }
      // Mode='create' — ask the daemon to probe the URL by saving a temp,
      // but the simpler path is just letting the user save first. Until
      // then test is unavailable for new providers.
      throw new Error(t('settings.auth.testSaveFirst'))
    },
    onSuccess: (r) => setTestResult(r),
    onError: (e: unknown) =>
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  })

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={
        props.mode === 'create'
          ? t('settings.auth.addTitle', { defaultValue: 'Add OIDC provider' })
          : t('settings.auth.editTitle', { defaultValue: 'Edit OIDC provider' })
      }
      size="lg"
      footer={
        <>
          {props.mode === 'edit' && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={testConnection.isPending}
              onClick={() => testConnection.mutate()}
            >
              {testConnection.isPending
                ? '…'
                : t('settings.auth.testConnection', { defaultValue: 'Test connection' })}
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={props.onClose}>
            {t('settings.auth.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="submit"
            form="oidc-provider-form"
            className="btn btn--primary"
            disabled={save.isPending}
          >
            {save.isPending ? '…' : t('settings.auth.save', { defaultValue: 'Save' })}
          </button>
        </>
      }
    >
      <form
        id="oidc-provider-form"
        className="oidc-form"
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          save.mutate()
        }}
      >
        <fieldset className="oidc-form__group">
          <legend className="oidc-form__group-title">
            {t('settings.auth.groupProvider', { defaultValue: 'Provider' })}
          </legend>
          <p className="oidc-form__group-hint">
            {t('settings.auth.groupProviderHint', {
              defaultValue:
                'Identifies this IdP in the URL and on the login page button. The issuer URL is what the daemon points OIDC discovery at.',
            })}
          </p>
          <div className="oidc-form__row oidc-form__row--cols-2">
            <label className="oidc-form__field">
              <span className="oidc-form__label">
                {t('settings.auth.slug', { defaultValue: 'Slug' })}
              </span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                pattern="[a-z0-9][a-z0-9-]{0,63}"
                required
                placeholder="github-enterprise"
              />
              <span className="oidc-form__hint">
                {t('settings.auth.slugHint', {
                  defaultValue: 'Used in /api/auth/oidc/<slug>/callback',
                })}
              </span>
            </label>
            <label className="oidc-form__field">
              <span className="oidc-form__label">
                {t('settings.auth.displayName', { defaultValue: 'Display name' })}
              </span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                placeholder="GitHub Enterprise"
              />
              <span className="oidc-form__hint">
                {t('settings.auth.displayNameHint', {
                  defaultValue: 'Shown on the login page button.',
                })}
              </span>
            </label>
          </div>
          <label className="oidc-form__field">
            <span className="oidc-form__label">
              {t('settings.auth.issuerUrl', { defaultValue: 'Issuer URL' })}
            </span>
            <input
              type="url"
              value={issuerUrl}
              onChange={(e) => setIssuerUrl(e.target.value)}
              required
              placeholder="https://github.corp.com"
            />
            <span className="oidc-form__hint">
              {t('settings.auth.issuerUrlHint', {
                defaultValue: 'Daemon fetches <issuer>/.well-known/openid-configuration.',
              })}
            </span>
          </label>
        </fieldset>

        <fieldset className="oidc-form__group">
          <legend className="oidc-form__group-title">
            {t('settings.auth.groupCreds', { defaultValue: 'Credentials' })}
          </legend>
          <p className="oidc-form__group-hint">
            {t('settings.auth.groupCredsHint', {
              defaultValue:
                'OAuth 2.0 client your daemon impersonates against the IdP. Secret is AES-256-GCM-sealed at rest.',
            })}
          </p>
          <div className="oidc-form__row oidc-form__row--cols-2">
            <label className="oidc-form__field">
              <span className="oidc-form__label">
                {t('settings.auth.clientId', { defaultValue: 'Client ID' })}
              </span>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
            </label>
            <label className="oidc-form__field">
              <span className="oidc-form__label">
                {t('settings.auth.clientSecret', { defaultValue: 'Client secret' })}
              </span>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                required={props.mode === 'create'}
                placeholder={
                  props.mode === 'edit'
                    ? t('settings.auth.clientSecretEditHint', {
                        defaultValue: 'leave blank to keep current',
                      })
                    : ''
                }
              />
            </label>
          </div>
          <label className="oidc-form__field">
            <span className="oidc-form__label">
              {t('settings.auth.scopes', { defaultValue: 'Scopes' })}
            </span>
            <input value={scopes} onChange={(e) => setScopes(e.target.value)} required />
            <span className="oidc-form__hint">
              {t('settings.auth.scopesHint', {
                defaultValue: 'Space-separated. openid is required; profile + email recommended.',
              })}
            </span>
          </label>
        </fieldset>

        <fieldset className="oidc-form__group">
          <legend className="oidc-form__group-title">
            {t('settings.auth.groupBehavior', { defaultValue: 'Behavior' })}
          </legend>
          <label className="oidc-form__field">
            <span className="oidc-form__label">
              {t('settings.auth.provisioning', { defaultValue: 'Provisioning policy' })}
            </span>
            <Select<'auto' | 'allowlist' | 'invite'>
              value={provisioning}
              onChange={setProvisioning}
              ariaLabel={t('settings.auth.provisioning', { defaultValue: 'Provisioning' })}
              options={[
                {
                  value: 'invite',
                  label: t('settings.auth.optInvite', { defaultValue: 'invite (recommended)' }),
                  description: t('settings.auth.inviteDesc', {
                    defaultValue:
                      'Only pre-created users with matching verified email may sign in.',
                  }),
                },
                {
                  value: 'allowlist',
                  label: t('settings.auth.optAllowlist', { defaultValue: 'allowlist' }),
                  description: t('settings.auth.allowlistDesc', {
                    defaultValue:
                      'Auto-provision users whose verified email matches an allowed domain.',
                  }),
                },
                {
                  value: 'auto',
                  label: t('settings.auth.optAuto', { defaultValue: 'auto' }),
                  description: t('settings.auth.autoDesc', {
                    defaultValue:
                      'Auto-provision any successful IdP login. Use only with a trusted IdP.',
                  }),
                },
              ]}
              renderOption={(opt) => (
                <span className="select__option-stack">
                  <span className="select__option-title">{opt.label}</span>
                  {opt.description && <span className="select__option-sub">{opt.description}</span>}
                </span>
              )}
            />
          </label>
          {provisioning === 'allowlist' && (
            <label className="oidc-form__field">
              <span className="oidc-form__label">
                {t('settings.auth.allowedDomains', { defaultValue: 'Allowed email domains' })}
              </span>
              <input
                value={allowedDomains}
                onChange={(e) => setAllowedDomains(e.target.value)}
                placeholder="@corp.com, @subsidiary.com"
              />
              <span className="oidc-form__hint">
                {t('settings.auth.allowedDomainsHint', {
                  defaultValue:
                    'Comma-separated, each prefixed with @. email_verified=true is also required.',
                })}
              </span>
            </label>
          )}
          <label className="oidc-form__toggle">
            <span className="oidc-form__toggle-body">
              <span className="oidc-form__toggle-title">
                {t('settings.auth.enabledLabel', { defaultValue: 'Enabled' })}
              </span>
              <span className="oidc-form__hint">
                {t('settings.auth.enabledHint', {
                  defaultValue: 'Visible on the login page when on; hidden when off.',
                })}
              </span>
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              aria-label={t('settings.auth.enabledLabel', { defaultValue: 'Enabled' })}
            />
          </label>
        </fieldset>

        {testResult && (
          <div
            className={`oidc-form__test-result oidc-form__test-result--${
              testResult.ok ? 'ok' : 'err'
            }`}
          >
            {testResult.ok ? (
              <>
                <strong>
                  ✓ {t('settings.auth.testOk', { defaultValue: 'Connection successful' })}
                </strong>
                <span className="oidc-form__test-detail">
                  {t('settings.auth.testDetailIssuer')} <code>{testResult.issuer}</code>
                  <br />
                  {t('settings.auth.testDetailToken')}{' '}
                  <code>{new URL(testResult.tokenEndpoint).host}</code>
                  <br />
                  {t('settings.auth.testDetailJwks')}{' '}
                  <code>{new URL(testResult.jwksUri).host}</code>
                </span>
              </>
            ) : (
              <>
                <strong>
                  ✗ {t('settings.auth.testFail', { defaultValue: 'Connection failed' })}
                </strong>
                <span className="oidc-form__test-detail">{testResult.error}</span>
              </>
            )}
          </div>
        )}
        {error && <div className="oidc-form__error">{error}</div>}
      </form>
    </Dialog>
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

interface UseTabStateOptions {
  onSaved?: (next: Config) => void
}

function useTabState<K extends keyof ConfigPatch>(
  config: Config,
  keys: K[],
  options?: UseTabStateOptions,
) {
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
      options?.onSaved?.(next)
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
        <div className="info-box stack-top--sm" role="status" aria-live="polite">
          <strong>{t('settings.restartRequiredTitle')}</strong>
          <p className="settings-hint settings-hint--tight">{t('settings.restartRequiredHint')}</p>
        </div>
      )}
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

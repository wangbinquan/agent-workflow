// /settings — Config editor with 4 sections (Runtime / Limits / GC / Network).
// Auth section moved to /settings/connection so the daemon URL + token live
// next to the sign-out button.
//
// Each section owns a draft slice of the config, posts ConfigPatch via PUT,
// shows a "saved" toast, and labels fields that need a daemon restart.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { Config, ConfigPatch } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Field, NumberInput, Switch, TextInput } from '@/components/Form'
import { clearToken, getBaseUrl, getToken } from '@/stores/auth'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/settings',
  component: SettingsPage,
})

type Tab = 'runtime' | 'limits' | 'gc' | 'network' | 'connection'

function SettingsPage() {
  const [tab, setTab] = useState<Tab>('runtime')
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
  })

  return (
    <div className="page">
      <header className="page__header">
        <h1>Settings</h1>
        <p className="page__hint">
          Backed by <code>~/.agent-workflow/config.json</code>. Patches via{' '}
          <code>PUT /api/config</code>. Fields marked <em>restart</em> only apply on the next daemon
          start.
        </p>
      </header>

      <div className="tabs">
        {(
          [
            ['runtime', 'Runtime'],
            ['limits', 'Limits'],
            ['gc', 'GC'],
            ['network', 'Network'],
            ['connection', 'Connection'],
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

      {config.isLoading && <div className="muted">Loading…</div>}
      {config.error !== null && config.error !== undefined && (
        <div className="error-box">{describeError(config.error)}</div>
      )}
      {config.data !== undefined && (
        <>
          {tab === 'runtime' && <RuntimeTab config={config.data} />}
          {tab === 'limits' && <LimitsTab config={config.data} />}
          {tab === 'gc' && <GcTab config={config.data} />}
          {tab === 'network' && <NetworkTab config={config.data} />}
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
      <Field label="opencode path" hint="Defaults to `which opencode` from PATH.">
        <TextInput
          value={state.opencodePath ?? ''}
          onChange={(v) => setState({ ...state, opencodePath: v === '' ? undefined : v })}
        />
      </Field>
      <Field label="Default model" hint="Used by agents without an explicit `model`.">
        <TextInput
          value={state.defaultModel ?? ''}
          onChange={(v) => setState({ ...state, defaultModel: v === '' ? undefined : v })}
          placeholder="anthropic/claude-sonnet-4-6"
        />
      </Field>
      <Field label="Default variant">
        <TextInput
          value={state.defaultVariant ?? ''}
          onChange={(v) => setState({ ...state, defaultVariant: v === '' ? undefined : v })}
        />
      </Field>
      <Field label="Default temperature">
        <NumberInput
          value={state.defaultTemperature}
          onChange={(v) => setState({ ...state, defaultTemperature: v })}
          min={0}
          max={2}
          step={0.1}
        />
      </Field>
      <div className="form-grid form-grid--cols-2">
        <Field label="Max concurrent nodes" required>
          <NumberInput
            value={state.maxConcurrentNodes}
            onChange={(v) => setState({ ...state, maxConcurrentNodes: v ?? 1 })}
            min={1}
          />
        </Field>
        <Field label="Multi-process subprocess concurrency" required>
          <NumberInput
            value={state.multiProcessSubprocessConcurrency}
            onChange={(v) => setState({ ...state, multiProcessSubprocessConcurrency: v ?? 1 })}
            min={1}
          />
        </Field>
      </div>
      <Field label="Log level">
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
      <Field label="Per-task max duration (ms)" required hint="0 = unlimited.">
        <NumberInput
          value={state.defaultPerTaskMaxDurationMs}
          onChange={(v) => setState({ ...state, defaultPerTaskMaxDurationMs: v ?? 0 })}
          min={0}
          step={60_000}
        />
      </Field>
      <Field label="Per-task max total tokens" required hint="0 = unlimited.">
        <NumberInput
          value={state.defaultPerTaskMaxTotalTokens}
          onChange={(v) => setState({ ...state, defaultPerTaskMaxTotalTokens: v ?? 0 })}
          min={0}
        />
      </Field>
      <Field label="Per-node timeout (ms)" required>
        <NumberInput
          value={state.defaultPerNodeTimeoutMs}
          onChange={(v) => setState({ ...state, defaultPerNodeTimeoutMs: v ?? 60_000 })}
          min={1000}
          step={60_000}
        />
      </Field>
      <Field label="Large output threshold (bytes)" required>
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
        label="Auto-GC merged worktrees"
        hint="Periodic background job; safe to leave off in v1."
      />
      <div className="form-grid form-grid--cols-2">
        <Field label="GC older-than (days)">
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
          label="Only GC merged branches"
        />
      </div>
      <Field
        label="Events archive — per-node-run rows"
        required
        hint="When a node_run accumulates this many event rows, archive to JSONL."
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
        label="Events archive — global rows"
        required
        hint="DB-wide event row cap before background archival runs."
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
    </SectionForm>
  )
}

function NetworkTab({ config }: TabProps) {
  const { state, setState, save } = useTabState(config, ['bindHost', 'bindPort'])
  return (
    <SectionForm
      onSave={save.mutate}
      busy={save.isPending}
      error={save.error}
      success={save.isSuccess && save.error === null ? 'saved' : null}
    >
      <Field
        label="Bind host"
        required
        hint="Restart required. Default 127.0.0.1 keeps the daemon local-only."
      >
        <TextInput
          value={state.bindHost ?? '127.0.0.1'}
          onChange={(v) => setState({ ...state, bindHost: v })}
        />
      </Field>
      <Field label="Bind port" hint="Restart required. Leave 0 to pick a free port at start time.">
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

function ConnectionTab() {
  const navigate = useNavigate()
  const token = getToken()
  const baseUrl = getBaseUrl()
  function signOut() {
    clearToken()
    navigate({ to: '/auth' })
  }
  return (
    <div className="form-grid">
      <Field label="Daemon URL">
        <div>
          <code>{baseUrl}</code>
        </div>
      </Field>
      <Field label="Token">
        <div>{token === null ? <em>none</em> : <code>{maskToken(token)}</code>}</div>
      </Field>
      <div>
        <button type="button" onClick={signOut} className="btn btn--danger">
          Sign out / re-enter token
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useTabState<K extends keyof ConfigPatch>(config: Config, keys: K[]) {
  const qc = useQueryClient()
  const initial: ConfigPatch = {}
  for (const k of keys) {
    ;(initial as Record<string, unknown>)[k] = (config as Record<string, unknown>)[k]
  }
  const [state, setState] = useState<ConfigPatch>(initial)

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
      qc.setQueryData(['config'], next)
    },
  })
  return { state, setState, save }
}

interface SectionFormProps {
  onSave: () => void
  busy: boolean
  error: unknown
  success: string | null
  children: React.ReactNode
}

function SectionForm({ onSave, busy, error, success, children }: SectionFormProps) {
  return (
    <div>
      <div className="form-grid">{children}</div>
      <div className="form-actions">
        <button type="button" className="btn btn--primary" onClick={() => onSave()} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {success !== null && <span className="form-actions__ok">Saved.</span>}
        {error !== null && error !== undefined && (
          <span className="form-actions__error">{describeError(error)}</span>
        )}
      </div>
    </div>
  )
}

function maskToken(t: string): string {
  if (t.length <= 8) return '••••'
  return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}

// RFC-112 / RFC-113 — runtime registry list (replaces the two stacked
// RuntimeStatusCards in Settings → Runtime, and now carries the whole Runtime
// tab). Each row is a registered runtime: name + protocol + the in-table default
// marker + deep-smoke conformance chip + binary path + the execution profile
// (model / variant / temperature / steps), with Test / Set-default / Edit /
// Delete actions. RFC-153: opencode / claude-code are ORDINARY rows (no built-in
// badge, deletable like any other) — only their name + protocol identity is locked
// on edit. "Add runtime" + Edit open a Dialog that
// deep-smokes the binary before saving. Admin-only writes are enforced
// server-side; non-admins still see the list (the agent / settings pickers read
// it).
//
// Reuses the shared primitives only: Dialog, Form Field/TextInput, Select,
// StatusChip, ErrorBanner/LoadingState — no native modal chrome / inputs.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, NumberInput, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { ModelSelect } from '@/components/ModelSelect'
import { StatusChip } from '@/components/StatusChip'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'

export const RUNTIMES_QUERY_KEY = ['runtimes'] as const

type RuntimeProtocol = 'opencode' | 'claude-code'

interface SmokeResult {
  outcome:
    | 'conforms'
    | 'spawn-failed'
    | 'auth-missing'
    | 'network-blocked'
    | 'model-call-failed'
    | 'stream-nonconforming'
  conforms: boolean
  detail: string
  sawNonce?: boolean
  sawEnvelope?: boolean
  exitCode?: number | null
}

interface RuntimeView {
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  // RFC-118: false = disabled (filtered from agent/default pickers, kept in list).
  enabled: boolean
  isDefault: boolean
  // RFC-113: the execution profile (variant/temperature/steps are opencode-only).
  model: string | null
  variant: string | null
  temperature: number | null
  steps: number | null
  maxSteps: number | null
  lastProbe: SmokeResult | null
  createdAt: number
  updatedAt: number
}

/** Map a smoke outcome to a StatusChip kind (green/amber/red/neutral). */
function smokeChipKind(probe: SmokeResult | null): 'success' | 'warn' | 'danger' | 'neutral' {
  if (probe === null) return 'neutral'
  if (probe.conforms) return 'success'
  if (
    probe.outcome === 'auth-missing' ||
    probe.outcome === 'network-blocked' ||
    probe.outcome === 'model-call-failed'
  )
    return 'warn'
  return 'danger'
}

export function RuntimeList() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<RuntimeView | 'new' | null>(null)

  const list = useQuery<{ runtimes: RuntimeView[] }>({
    queryKey: RUNTIMES_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
    staleTime: 30_000,
  })

  const probe = useMutation({
    mutationFn: (name: string) =>
      api.post<{ smoke: SmokeResult }>(`/api/runtimes/${encodeURIComponent(name)}/probe`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: RUNTIMES_QUERY_KEY }),
  })

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/runtimes/${encodeURIComponent(name)}`),
    onSuccess: (_data, name) => {
      void qc.invalidateQueries({ queryKey: RUNTIMES_QUERY_KEY })
      // RFC-114 Codex P2-2: the deleted runtime's cached model list (?runtime=name)
      // is now stale — drop it so a same-name re-create re-fetches the new binary.
      void qc.invalidateQueries({ queryKey: ['runtime', 'models', 'rt', name] })
    },
  })

  // RFC-113 D3: the in-table "set as default" marker writes config.defaultRuntime.
  const setDefault = useMutation({
    mutationFn: (name: string) => api.put('/api/config', { defaultRuntime: name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: RUNTIMES_QUERY_KEY })
      void qc.invalidateQueries({ queryKey: ['config'] })
    },
  })

  // RFC-118: enable/disable toggle. A disabled runtime stays in the list but drops
  // out of the agent / default pickers. The effective default can't be disabled
  // (server 409 guard); its button is also disabled client-side.
  const toggleEnabled = useMutation({
    mutationFn: (v: { name: string; enabled: boolean }) =>
      api.post(`/api/runtimes/${encodeURIComponent(v.name)}/enabled`, { enabled: v.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: RUNTIMES_QUERY_KEY }),
  })

  const runtimes = list.data?.runtimes ?? []

  return (
    <div className="page__section" style={{ marginBottom: 16 }}>
      <div className="page__header--row" style={{ marginBottom: 8 }}>
        <strong>{t('runtimes.title')}</strong>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => setEditing('new')}
        >
          {t('runtimes.add')}
        </button>
      </div>
      <p className="muted" style={{ margin: '0 0 12px 0', fontSize: 13 }}>
        {t('runtimes.subtitle')}
      </p>

      {list.isLoading ? (
        <LoadingState />
      ) : list.error !== null && list.error !== undefined ? (
        <ErrorBanner error={list.error} />
      ) : (
        <ul className="runtime-list" role="list">
          {runtimes.map((rt) => (
            <li
              key={rt.name}
              className={`runtime-list__row${rt.isDefault ? ' runtime-list__row--default' : ''}${
                rt.enabled ? '' : ' runtime-list__row--disabled'
              }`}
              role="listitem"
            >
              <div className="runtime-list__main">
                <span className="runtime-list__name">{rt.name}</span>
                {/* a11y: a `success` chip (green text on translucent green) misses
                    the WCAG contrast floor (axe-core /settings gate). The default
                    row is already accented by the green left border (.row--default);
                    a neutral chip labels it without the low-contrast green-on-green. */}
                {rt.isDefault && (
                  <StatusChip kind="neutral" size="sm">
                    {t('runtimes.isDefault')}
                  </StatusChip>
                )}
                <StatusChip kind="neutral" size="sm">
                  {rt.protocol === 'claude-code'
                    ? t('runtimes.protocolClaude')
                    : t('runtimes.protocolOpencode')}
                </StatusChip>
                {!rt.enabled && (
                  <StatusChip kind="neutral" size="sm">
                    {t('runtimes.disabled')}
                  </StatusChip>
                )}
                <StatusChip kind={smokeChipKind(rt.lastProbe)} size="sm" withDot>
                  {rt.lastProbe === null
                    ? t('runtimes.smokeUntested')
                    : t(`runtimes.smoke.${rt.lastProbe.outcome}`)}
                </StatusChip>
              </div>
              <div className="runtime-list__meta">
                <code className="runtime-list__binary">
                  {rt.binaryPath ?? t('runtimes.defaultBinary')}
                </code>
              </div>
              <div className="runtime-list__actions">
                {/* RFC-118: a disabled runtime can't be made the default (server
                    rejects it too) — hide Set-default on disabled rows. */}
                {!rt.isDefault && rt.enabled && (
                  <button
                    type="button"
                    className="btn btn--xs"
                    disabled={setDefault.isPending}
                    onClick={() => setDefault.mutate(rt.name)}
                  >
                    {t('runtimes.setDefault')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={probe.isPending}
                  onClick={() => probe.mutate(rt.name)}
                >
                  {t('runtimes.test')}
                </button>
                {/* RFC-153: every runtime is editable + deletable; opencode /
                    claude-code are no different (name + protocol identity stay
                    locked in the dialog). Delete is blocked server-side only while
                    the row is the effective default or referenced by an agent. */}
                <button type="button" className="btn btn--xs" onClick={() => setEditing(rt)}>
                  {t('runtimes.edit')}
                </button>
                {/* RFC-118: enable/disable (incl. built-ins). The effective-default
                    row can't be disabled (server 409) — shown disabled + hint. */}
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={toggleEnabled.isPending || rt.isDefault}
                  title={rt.isDefault ? t('runtimes.defaultCannotDisable') : undefined}
                  onClick={() => toggleEnabled.mutate({ name: rt.name, enabled: !rt.enabled })}
                >
                  {rt.enabled ? t('runtimes.disable') : t('runtimes.enable')}
                </button>
                <button
                  type="button"
                  className="btn btn--xs btn--danger"
                  disabled={del.isPending}
                  onClick={() => del.mutate(rt.name)}
                >
                  {t('runtimes.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {del.error !== null && del.error !== undefined && <ErrorBanner error={del.error} />}

      {editing !== null && (
        <RuntimeFormDialog
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void qc.invalidateQueries({ queryKey: RUNTIMES_QUERY_KEY })
          }}
        />
      )}
    </div>
  )
}

function RuntimeFormDialog(props: {
  existing: RuntimeView | null
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const isEdit = props.existing !== null
  const [name, setName] = useState(props.existing?.name ?? '')
  const [protocol, setProtocol] = useState<RuntimeProtocol>(props.existing?.protocol ?? 'opencode')
  const [binaryPath, setBinaryPath] = useState(props.existing?.binaryPath ?? '')
  const [smoke, setSmoke] = useState<SmokeResult | null>(props.existing?.lastProbe ?? null)
  // RFC-113: the runtime IS the execution profile.
  const [model, setModel] = useState<string | undefined>(props.existing?.model ?? undefined)
  const [variant, setVariant] = useState(props.existing?.variant ?? '')
  const [temperature, setTemperature] = useState<number | undefined>(
    props.existing?.temperature ?? undefined,
  )
  const [steps, setSteps] = useState<number | undefined>(props.existing?.steps ?? undefined)
  const [maxSteps, setMaxSteps] = useState<number | undefined>(
    props.existing?.maxSteps ?? undefined,
  )
  const isOpencode = protocol === 'opencode'
  // Codex P3: the claude spawn path consumes ONLY `model` — variant / temperature
  // / steps / maxSteps are all opencode-only, so null them out for claude (else a
  // user could save a Claude runtime param that never affects execution).
  const profileBody = () => ({
    model: model ?? null,
    variant: isOpencode && variant.trim() !== '' ? variant.trim() : null,
    temperature: isOpencode ? (temperature ?? null) : null,
    steps: isOpencode ? (steps ?? null) : null,
    maxSteps: isOpencode ? (maxSteps ?? null) : null,
  })

  const test = useMutation({
    mutationFn: () =>
      api.post<{ smoke: SmokeResult }>('/api/runtimes/probe', {
        protocol,
        binaryPath: binaryPath.trim(),
      }),
    onSuccess: (r) => setSmoke(r.smoke),
  })

  const save = useMutation({
    mutationFn: () => {
      const trimmed = binaryPath.trim()
      if (isEdit) {
        return api.put(`/api/runtimes/${encodeURIComponent(name)}`, {
          binaryPath: trimmed === '' ? null : trimmed,
          ...profileBody(),
        })
      }
      return api.post('/api/runtimes', {
        name: name.trim(),
        protocol,
        ...(trimmed === '' ? {} : { binaryPath: trimmed }),
        probe: trimmed !== '',
        ...profileBody(),
      })
    },
    onSuccess: () => {
      // RFC-114 Codex P2-2: a saved binary change means this runtime's cached
      // model list (?runtime=name, staleTime Infinity) is stale — invalidate it so
      // re-opening the dialog re-fetches the new binary's models.
      void qc.invalidateQueries({ queryKey: ['runtime', 'models', 'rt', name.trim()] })
      props.onSaved()
    },
  })

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={isEdit ? t('runtimes.editTitle') : t('runtimes.addTitle')}
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={test.isPending || binaryPath.trim() === ''}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t('runtimes.testing') : t('runtimes.testBinary')}
          </button>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || (!isEdit && name.trim() === '')}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <Field label={t('runtimes.fieldName')} hint={t('runtimes.fieldNameHint')} required>
        <TextInput value={name} onChange={setName} disabled={isEdit} data-testid="runtime-name" />
      </Field>
      <Field label={t('runtimes.fieldProtocol')} hint={t('runtimes.fieldProtocolHint')}>
        <Select<RuntimeProtocol>
          value={protocol}
          ariaLabel={t('runtimes.fieldProtocol')}
          onChange={setProtocol}
          disabled={isEdit}
          options={[
            { value: 'opencode', label: t('runtimes.protocolOpencode') },
            { value: 'claude-code', label: t('runtimes.protocolClaude') },
          ]}
        />
      </Field>
      <Field label={t('runtimes.fieldBinary')} hint={t('runtimes.fieldBinaryHint')}>
        <TextInput
          value={binaryPath}
          onChange={setBinaryPath}
          placeholder={t('runtimes.defaultBinary')}
          data-testid="runtime-binary"
        />
      </Field>
      {/* RFC-113: the runtime's execution profile. variant/temperature/steps are
          opencode-only (claude has none) — shown only for the opencode protocol. */}
      {/* RFC-114: editing an existing runtime lists ITS binary's models
          (?runtime=<name>); a NEW custom binary can't be listed before it's saved
          (O1(a)) so the model is free-text + a "save first" hint — showing the
          DEFAULT opencode list there would invite saving a model the fork doesn't
          have. claude (incl. forks) is a static list → a "not probed" note. */}
      <Field label={t('runtimes.fieldModel')} hint={t('runtimes.fieldModelHint')}>
        {isEdit ? (
          <ModelSelect value={model} onChange={setModel} runtimeName={name} />
        ) : (
          <>
            <TextInput
              value={model ?? ''}
              onChange={(v) => setModel(v === '' ? undefined : v)}
              placeholder="anthropic/claude-sonnet-4-6"
            />
            <p className="muted" style={{ margin: '4px 0 0 0', fontSize: 13 }}>
              {t('runtimes.newRuntimeModelHint')}
            </p>
          </>
        )}
        {isEdit && !isOpencode && (
          <p className="muted" style={{ margin: '4px 0 0 0', fontSize: 13 }}>
            {t('runtimes.claudeStaticModelHint')}
          </p>
        )}
      </Field>
      {isOpencode && (
        <div className="form-grid form-grid--cols-2">
          <Field label={t('runtimes.fieldVariant')}>
            <TextInput
              value={variant}
              onChange={setVariant}
              placeholder={t('common.optionalPlaceholder')}
            />
          </Field>
          <Field label={t('runtimes.fieldTemperature')}>
            <NumberInput value={temperature} onChange={setTemperature} min={0} max={2} step={0.1} />
          </Field>
          <Field label={t('runtimes.fieldSteps')}>
            <NumberInput value={steps} onChange={setSteps} min={1} />
          </Field>
          <Field label={t('runtimes.fieldMaxSteps')}>
            <NumberInput value={maxSteps} onChange={setMaxSteps} min={1} />
          </Field>
        </div>
      )}
      {!isOpencode && (
        <p className="muted" style={{ margin: '4px 0 0 0', fontSize: 13 }}>
          {t('runtimes.claudeModelOnlyHint')}
        </p>
      )}
      {smoke !== null && (
        <div style={{ marginTop: 8 }}>
          <StatusChip kind={smokeChipKind(smoke)} size="sm" withDot>
            {t(`runtimes.smoke.${smoke.outcome}`)}
          </StatusChip>
          <p className="muted" style={{ margin: '4px 0 0 0', fontSize: 12 }}>
            {smoke.detail}
          </p>
        </div>
      )}
      {test.error !== null && test.error !== undefined && <ErrorBanner error={test.error} />}
      {save.error !== null && save.error !== undefined && <ErrorBanner error={save.error} />}
    </Dialog>
  )
}

// RFC-255 — Settings → Runtime: administrator-managed OpenAI-compatible
// gateways (one-api / new-api / vLLM / any private relay).
//
// This card is the ONLY way to configure one. The credential is sealed by the
// daemon before it touches disk, so there is no hand-editable equivalent, and
// `config set customProviders` is refused for the same reason.
//
// The mask ("••••••••") is what the API returns in place of a stored key, and
// sending it back means "keep the stored one". That is why the key field starts
// empty on edit and only sends a value when the administrator types one — an
// edit of the endpoint must not require re-entering the secret.
//
// Shared primitives only: Dialog, Field/TextInput/Switch, ChipsInput,
// ConfirmDialog, ErrorBanner — no bespoke modal chrome or inputs.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CUSTOM_PROVIDER_API_KEY_MASK,
  CUSTOM_PROVIDER_NPM,
  isValidCustomProviderBaseURL,
  isReservedProviderId,
  CUSTOM_PROVIDER_ID_RE,
  type Config,
  type CustomProviderEntryWire,
} from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Field, TextInput } from '@/components/Form'
import { Switch } from '@/components/Form'
import { ChipsInput } from '@/components/ChipsInput'
import { ErrorBanner } from '@/components/ErrorBanner'
import { QueryState } from '@/components/QueryState'
import { getConfigQueryKey, queryConfig, writeConfigPatch } from '@/lib/config-resource'

interface DraftState {
  /** The id being edited; empty when creating. */
  originalId: string
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: string[]
  enabled: boolean
}

const emptyDraft: DraftState = {
  originalId: '',
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  models: [],
  enabled: true,
}

function draftFromEntry(entry: CustomProviderEntryWire): DraftState {
  return {
    originalId: entry.id,
    id: entry.id,
    name: entry.name ?? '',
    baseURL: entry.baseURL,
    // Deliberately blank: the stored key is never shown, and leaving this empty
    // is how the administrator says "do not change it".
    apiKey: '',
    models: entry.models.map((model) => model.id),
    enabled: entry.enabled,
  }
}

export function CustomProviderCard(): React.ReactElement {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CustomProviderEntryWire | null>(null)
  const [error, setError] = useState<string | null>(null)

  const configQuery = useQuery({
    queryKey: getConfigQueryKey(),
    queryFn: ({ signal }) => queryConfig(signal),
  })
  const providers: CustomProviderEntryWire[] = configQuery.data?.customProviders ?? []

  const save = useMutation({
    mutationFn: async (next: CustomProviderEntryWire[]) => {
      await writeConfigPatch({ customProviders: next } as Partial<Config>)
    },
    onSuccess: async () => {
      setError(null)
      setDraft(null)
      setPendingDelete(null)
      await client.invalidateQueries({ queryKey: getConfigQueryKey() })
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    },
  })

  const draftProblem = (value: DraftState): string | null => {
    if (!CUSTOM_PROVIDER_ID_RE.test(value.id)) return t('settings.customProviders.errors.id')
    if (isReservedProviderId(value.id)) return t('settings.customProviders.errors.idReserved')
    if (providers.some((entry) => entry.id === value.id && entry.id !== value.originalId)) {
      return t('settings.customProviders.errors.idDuplicate')
    }
    if (!isValidCustomProviderBaseURL(value.baseURL)) {
      return t('settings.customProviders.errors.baseURL')
    }
    if (value.models.length === 0) return t('settings.customProviders.errors.models')
    // A brand-new entry (or a renamed one) has no stored secret to fall back on.
    if (value.apiKey.trim() === '' && value.originalId !== value.id) {
      return t('settings.customProviders.errors.apiKeyRequired')
    }
    return null
  }

  const submitDraft = (): void => {
    if (draft === null) return
    const problem = draftProblem(draft)
    if (problem !== null) {
      setError(problem)
      return
    }
    const entry: CustomProviderEntryWire = {
      id: draft.id,
      npm: CUSTOM_PROVIDER_NPM,
      baseURL: draft.baseURL,
      models: draft.models.map((id) => ({ id })),
      enabled: draft.enabled,
      ...(draft.name.trim() === '' ? {} : { name: draft.name.trim() }),
      // Empty means "keep whatever is stored"; the daemon reads the mask the
      // same way, so an untouched key field never rewrites the secret.
      apiKey: draft.apiKey.trim() === '' ? CUSTOM_PROVIDER_API_KEY_MASK : draft.apiKey.trim(),
    }
    const next =
      draft.originalId === ''
        ? [...providers, entry]
        : providers.map((existing) => (existing.id === draft.originalId ? entry : existing))
    save.mutate(next)
  }

  const toggleEnabled = (entry: CustomProviderEntryWire, enabled: boolean): void => {
    save.mutate(
      providers.map((existing) =>
        existing.id === entry.id
          ? { ...existing, enabled, apiKey: CUSTOM_PROVIDER_API_KEY_MASK }
          : existing,
      ),
    )
  }

  return (
    <section className="page__section" data-testid="custom-providers">
      <div className="page__header--row">
        <h3>{t('settings.customProviders.title')}</h3>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => {
              setError(null)
              setDraft({ ...emptyDraft })
            }}
            data-testid="custom-provider-add"
          >
            {t('settings.customProviders.add')}
          </button>
        </div>
      </div>
      <p className="muted">{t('settings.customProviders.hint')}</p>
      {error !== null && <ErrorBanner error={error} />}
      <QueryState
        query={configQuery}
        data={providers}
        emptyText={t('settings.customProviders.empty')}
      >
        {(rows) => (
          <ul className="stack-top--md">
            {rows.map((entry) => (
              <li
                key={entry.id}
                className="page__section"
                data-testid={`custom-provider-${entry.id}`}
              >
                <div className="page__header--row">
                  <div>
                    <strong>{entry.name ?? entry.id}</strong>{' '}
                    <span className="muted">{entry.id}</span>
                    <div className="muted">{entry.baseURL}</div>
                    <div className="muted">
                      {t('settings.customProviders.modelCount', { count: entry.models.length })}
                    </div>
                  </div>
                  <div className="page__actions">
                    <Switch
                      checked={entry.enabled}
                      onChange={(checked) => toggleEnabled(entry, checked)}
                      label={t('settings.customProviders.enabled')}
                    />
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        setError(null)
                        setDraft(draftFromEntry(entry))
                      }}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      onClick={() => setPendingDelete(entry)}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>

      {draft !== null && (
        <Dialog
          open
          onClose={() => setDraft(null)}
          title={
            draft.originalId === ''
              ? t('settings.customProviders.dialogCreate')
              : t('settings.customProviders.dialogEdit')
          }
          footer={
            <>
              <button type="button" className="btn btn--sm" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={submitDraft}
                disabled={save.isPending}
                data-testid="custom-provider-save"
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <Field label={t('settings.customProviders.fields.id')} required>
            <TextInput
              value={draft.id}
              onChange={(id) => setDraft({ ...draft, id })}
              data-testid="custom-provider-id"
            />
          </Field>
          <Field label={t('settings.customProviders.fields.name')}>
            <TextInput value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          </Field>
          <Field
            label={t('settings.customProviders.fields.baseURL')}
            hint={t('settings.customProviders.fields.baseURLHint')}
            required
          >
            <TextInput
              value={draft.baseURL}
              onChange={(baseURL) => setDraft({ ...draft, baseURL })}
              data-testid="custom-provider-baseurl"
            />
          </Field>
          <Field
            label={t('settings.customProviders.fields.apiKey')}
            hint={
              draft.originalId === ''
                ? t('settings.customProviders.fields.apiKeyHint')
                : t('settings.customProviders.fields.apiKeyKeepHint')
            }
            required={draft.originalId === ''}
          >
            <TextInput
              value={draft.apiKey}
              onChange={(apiKey) => setDraft({ ...draft, apiKey })}
              data-testid="custom-provider-apikey"
            />
          </Field>
          <Field
            label={t('settings.customProviders.fields.models')}
            hint={t('settings.customProviders.fields.modelsHint')}
            required
          >
            <ChipsInput
              value={draft.models}
              onChange={(models) => setDraft({ ...draft, models })}
              testidPrefix="custom-provider-models"
            />
          </Field>
        </Dialog>
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          open
          title={t('settings.customProviders.deleteTitle')}
          description={t('settings.customProviders.deleteMessage', { id: pendingDelete.id })}
          confirmLabel={t('common.delete')}
          tone="danger"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => save.mutate(providers.filter((entry) => entry.id !== pendingDelete.id))}
        />
      )}
    </section>
  )
}

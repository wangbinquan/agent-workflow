// RFC-269 — 设置页的「代码平台」分区：两家各一组 base URL + token + 测试连接。
//
// 不套 `SectionForm`（那套状态机服务的是 config.json 的 patch 流），因为凭据
// **不进 config.json** —— 它是明文文件且 `GET /api/config` 整份回传。凭据走
// 独立的 REST 端点并密封在 DB 里（design D2），所以这里用自己的本地草稿 + 保存。
// 公共表单原语（Field / TextInput / ErrorBanner）与按钮 class 照常复用。
//
// token 的三形态在 UI 上的呈现：输入框永远是**空的**（后端从不回传明文），
// 旁边显示 `••••1234` 说明「已存了一个以 1234 结尾的 token」。留空保存 = 只改
// base URL、保留原 token（design D4）。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  normalizeGitLabRepositoryUrlPrefix,
  normalizeRepositoryTransportMappings,
  type CodeHostConnectionWire,
  type CodeHostProvider,
  type CodeHostTestResult,
  type RepositoryTransportMappingV1,
} from '@agent-workflow/shared'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { ChipsInput } from '@/components/ChipsInput'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, NumberInput, Switch, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { SettingsCard } from '@/components/settings/SettingsCard'

const PROVIDERS: readonly CodeHostProvider[] = ['gitlab', 'github']

interface Draft {
  baseUrl: string
  repositoryUrlPrefixes: string[]
  transportMappings: RepositoryTransportMappingV1[]
  token: string
  rejectUnauthorized: boolean
}

interface CredentialRevocationImpact {
  personalPushCredentialCount: number
  expectedConnectionGeneration: string
  confirmCredentialRevocationDigest: string
}

function revocationImpactOf(error: unknown): CredentialRevocationImpact | null {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('details' in error)) {
    return null
  }
  if (error.code !== 'code-host-transport-rebind-confirmation-required') return null
  const details = error.details
  if (typeof details !== 'object' || details === null) return null
  if (
    !('personalPushCredentialCount' in details) ||
    !('expectedConnectionGeneration' in details) ||
    !('confirmCredentialRevocationDigest' in details) ||
    typeof details.personalPushCredentialCount !== 'number' ||
    typeof details.expectedConnectionGeneration !== 'string' ||
    typeof details.confirmCredentialRevocationDigest !== 'string'
  ) {
    return null
  }
  return {
    personalPushCredentialCount: details.personalPushCredentialCount,
    expectedConnectionGeneration: details.expectedConnectionGeneration,
    confirmCredentialRevocationDigest: details.confirmCredentialRevocationDigest,
  }
}

function isCredentialBindingStale(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'code-host-push-credential-stale'
  )
}

function transportMappingPreview(mapping: RepositoryTransportMappingV1): string | null {
  const normalized = normalizeRepositoryTransportMappings([mapping])
  if (!normalized.ok) return null
  const value = normalized.value[0]
  if (value === undefined) return null
  const exampleProject = 'namespace/repository'
  const prefixedProject =
    value.sshPathPrefix === '' ? exampleProject : `${value.sshPathPrefix}/${exampleProject}`
  const ssh =
    value.sshPort === 22
      ? `git@${value.sshHost}:${prefixedProject}.git`
      : `ssh://git@${value.sshHost}:${value.sshPort}/${prefixedProject}.git`
  return `${ssh} → ${value.httpBaseUrl}/${exampleProject}.git`
}

function TransportMappingsEditor({
  provider,
  value,
  disabled,
  onChange,
}: {
  provider: CodeHostProvider
  value: RepositoryTransportMappingV1[]
  disabled: boolean
  onChange: (next: RepositoryTransportMappingV1[]) => void
}) {
  const { t } = useTranslation()
  const update = (index: number, next: RepositoryTransportMappingV1): void => {
    onChange(value.map((item, itemIndex) => (itemIndex === index ? next : item)))
  }

  return (
    <Field
      label={t('codeHostSettings.transportMappings')}
      hint={t('codeHostSettings.transportMappingsHint')}
      group
    >
      <div className="code-host-transport-mappings">
        {value.length === 0 ? (
          <p className="inspector-hint">{t('codeHostSettings.transportMappingsEmpty')}</p>
        ) : null}
        {value.map((mapping, index) => {
          const preview = transportMappingPreview(mapping)
          return (
            <div
              key={`${provider}-${index}`}
              className="code-host-transport-mapping"
              data-testid={`code-host-transport-mapping-${provider}-${index}`}
            >
              <div className="code-host-transport-mapping__body">
                <div className="code-host-transport-mapping__fields">
                  <Field label={t('codeHostSettings.sshHost')}>
                    <TextInput
                      value={mapping.sshHost}
                      disabled={disabled}
                      placeholder="git.example.com"
                      data-testid={`code-host-transport-ssh-host-${provider}-${index}`}
                      onChange={(sshHost) => update(index, { ...mapping, sshHost })}
                    />
                  </Field>
                  <Field label={t('codeHostSettings.sshPort')}>
                    <NumberInput
                      value={mapping.sshPort}
                      disabled={disabled}
                      min={1}
                      max={65535}
                      placeholder="22"
                      data-testid={`code-host-transport-ssh-port-${provider}-${index}`}
                      onChange={(sshPort) =>
                        update(index, {
                          ...mapping,
                          ...(sshPort === undefined ? { sshPort: undefined } : { sshPort }),
                        })
                      }
                    />
                  </Field>
                  <Field label={t('codeHostSettings.sshPathPrefix')}>
                    <TextInput
                      value={mapping.sshPathPrefix ?? ''}
                      disabled={disabled}
                      placeholder="team"
                      data-testid={`code-host-transport-ssh-path-${provider}-${index}`}
                      onChange={(sshPathPrefix) =>
                        update(index, {
                          ...mapping,
                          ...(sshPathPrefix === ''
                            ? { sshPathPrefix: undefined }
                            : { sshPathPrefix }),
                        })
                      }
                    />
                  </Field>
                  <Field label={t('codeHostSettings.httpBaseUrl')}>
                    <TextInput
                      value={mapping.httpBaseUrl}
                      type="url"
                      disabled={disabled}
                      placeholder="https://git.example.com"
                      data-testid={`code-host-transport-http-base-${provider}-${index}`}
                      onChange={(httpBaseUrl) => update(index, { ...mapping, httpBaseUrl })}
                    />
                  </Field>
                </div>
                <p
                  className="inspector-hint"
                  data-testid={`code-host-transport-preview-${provider}-${index}`}
                >
                  {preview === null
                    ? t('codeHostSettings.transportMappingPreviewUnavailable')
                    : t('codeHostSettings.transportMappingPreview', { preview })}
                </p>
              </div>
              <button
                type="button"
                className="btn btn--xs btn--danger"
                disabled={disabled}
                data-testid={`code-host-transport-remove-${provider}-${index}`}
                onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
              >
                {t('common.delete')}
              </button>
            </div>
          )
        })}
        <div className="code-host-transport-mappings__actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled || value.length >= 32}
            data-testid={`code-host-transport-add-${provider}`}
            onClick={() => onChange([...value, { sshHost: '', httpBaseUrl: '' }])}
          >
            {t('codeHostSettings.addTransportMapping')}
          </button>
        </div>
      </div>
    </Field>
  )
}

function ConnectionCard({ row, onSaved }: { row: CodeHostConnectionWire; onSaved: () => void }) {
  const { t } = useTranslation()
  const saveTriggerRef = useRef<HTMLButtonElement | null>(null)
  const removeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [draft, setDraft] = useState<Draft>({
    baseUrl: row.baseUrl,
    repositoryUrlPrefixes: row.repositoryUrlPrefixes,
    transportMappings: row.transportMappings,
    token: '',
    rejectUnauthorized: row.rejectUnauthorized,
  })
  const [error, setError] = useState<unknown>(null)
  const [testResult, setTestResult] = useState<CodeHostTestResult | null>(null)
  const [saveImpact, setSaveImpact] = useState<CredentialRevocationImpact | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeImpact, setRemoveImpact] = useState<CredentialRevocationImpact | null>(null)

  const save = useMutation({
    mutationFn: async (impact: CredentialRevocationImpact | null) => {
      const normalizedMappings = normalizeRepositoryTransportMappings(draft.transportMappings)
      if (!normalizedMappings.ok) {
        throw new Error(
          t(
            normalizedMappings.issue.endsWith('-ssh-target-conflict')
              ? 'codeHostSettings.transportMappingConflict'
              : 'codeHostSettings.transportMappingInvalid',
          ),
        )
      }
      const transportMappings: RepositoryTransportMappingV1[] = normalizedMappings.value.map(
        (mapping) => ({
          sshHost: mapping.sshHost,
          sshPort: mapping.sshPort,
          ...(mapping.sshPathPrefix === '' ? {} : { sshPathPrefix: mapping.sshPathPrefix }),
          httpBaseUrl: mapping.httpBaseUrl,
        }),
      )
      return await api.put<CodeHostConnectionWire>(`/api/code-hosts/${row.provider}`, {
        baseUrl: draft.baseUrl,
        ...(row.provider === 'gitlab'
          ? { repositoryUrlPrefixes: draft.repositoryUrlPrefixes }
          : {}),
        transportMappings,
        ...(draft.token.length > 0 ? { token: draft.token } : {}),
        ...(row.provider === 'gitlab' ? { rejectUnauthorized: draft.rejectUnauthorized } : {}),
        ...(row.connectionGeneration === null
          ? {}
          : { expectedConnectionGeneration: row.connectionGeneration }),
        ...(impact === null
          ? {}
          : {
              expectedConnectionGeneration: impact.expectedConnectionGeneration,
              confirmCredentialRevocationDigest: impact.confirmCredentialRevocationDigest,
            }),
      })
    },
    onSuccess: () => {
      setError(null)
      setDraft((d) => ({ ...d, token: '' }))
      setTestResult(null)
      setSaveImpact(null)
      onSaved()
    },
    onError: (err) => {
      const impact = revocationImpactOf(err)
      if (impact !== null) {
        setError(null)
        setSaveImpact(impact)
        return
      }
      if (isCredentialBindingStale(err)) {
        setSaveImpact(null)
        setError(err)
        onSaved()
        return
      }
      setError(err)
    },
  })

  const test = useMutation({
    mutationFn: async () =>
      api.post<CodeHostTestResult>(`/api/code-hosts/${row.provider}/test`, {
        baseUrl: draft.baseUrl,
        ...(draft.token.length > 0 ? { token: draft.token } : {}),
        ...(row.provider === 'gitlab' ? { rejectUnauthorized: draft.rejectUnauthorized } : {}),
      }),
    onSuccess: (result) => {
      setError(null)
      setTestResult(result)
      onSaved()
    },
    onError: (err) => {
      setError(err)
    },
  })

  const remove = useMutation({
    mutationFn: async (impact: CredentialRevocationImpact | null) =>
      api.deleteJson<{ ok: true }>(`/api/code-hosts/${row.provider}`, {
        ...(row.connectionGeneration === null
          ? {}
          : { expectedConnectionGeneration: row.connectionGeneration }),
        ...(impact === null
          ? {}
          : {
              expectedConnectionGeneration: impact.expectedConnectionGeneration,
              confirmCredentialRevocationDigest: impact.confirmCredentialRevocationDigest,
            }),
      }),
    onSuccess: () => {
      setError(null)
      setDraft({
        baseUrl: '',
        repositoryUrlPrefixes: [],
        transportMappings: [],
        token: '',
        rejectUnauthorized: true,
      })
      setTestResult(null)
      setRemoveImpact(null)
      setRemoveOpen(false)
      onSaved()
    },
    onError: (err) => {
      const impact = revocationImpactOf(err)
      if (impact !== null) {
        setError(null)
        setRemoveImpact(impact)
        return
      }
      if (isCredentialBindingStale(err)) {
        setRemoveImpact(null)
        setRemoveOpen(false)
        setError(err)
        onSaved()
        return
      }
      setError(err)
    },
  })

  const busy = save.isPending || test.isPending || remove.isPending

  return (
    <SettingsCard
      title={t(`codeHostProvider.${row.provider}`)}
      hint={t(`codeHostSettings.baseUrlHint_${row.provider}`)}
      data-testid={`code-host-card-${row.provider}`}
    >
      {/* 只在真有错误时渲染：ErrorBanner 在 `error == null` 且无 `message` 时会
          落到 `t('common.unknownError')`，无条件渲染等于页面一打开就挂一条
          「未知错误」（用户实报）。 */}
      {error !== null ? <ErrorBanner error={error} /> : null}
      <Field label={t('codeHostSettings.baseUrl')}>
        <TextInput
          value={draft.baseUrl}
          disabled={busy}
          data-testid={`code-host-base-url-${row.provider}`}
          onChange={(next) => {
            setDraft((d) => ({ ...d, baseUrl: next }))
          }}
        />
      </Field>
      {row.provider === 'gitlab' ? (
        <Field
          label={t('codeHostSettings.repositoryUrlPrefixes')}
          hint={t('codeHostSettings.repositoryUrlPrefixesHint')}
        >
          <ChipsInput
            value={draft.repositoryUrlPrefixes}
            disabled={busy}
            placeholder={t('codeHostSettings.repositoryUrlPrefixesPlaceholder')}
            testidPrefix="code-host-repository-url-prefixes-gitlab"
            validate={(value) =>
              normalizeGitLabRepositoryUrlPrefix(value).ok
                ? null
                : t('codeHostSettings.repositoryUrlPrefixInvalid')
            }
            onChange={(next) => {
              const normalized = next.flatMap((value) => {
                const result = normalizeGitLabRepositoryUrlPrefix(value)
                return result.ok ? [result.value] : []
              })
              setDraft((d) => ({
                ...d,
                repositoryUrlPrefixes: [...new Set(normalized)],
              }))
            }}
          />
        </Field>
      ) : null}
      <TransportMappingsEditor
        provider={row.provider}
        value={draft.transportMappings}
        disabled={busy}
        onChange={(transportMappings) => {
          setDraft((d) => ({ ...d, transportMappings }))
        }}
      />
      <Field
        label={t('codeHostSettings.token')}
        hint={
          row.configured
            ? t('codeHostSettings.tokenStored', { hint: row.tokenHint })
            : t('codeHostSettings.tokenHint')
        }
      >
        <TextInput
          value={draft.token}
          type="password"
          disabled={busy}
          placeholder={row.configured ? '••••' + row.tokenHint : ''}
          data-testid={`code-host-token-${row.provider}`}
          onChange={(next) => {
            setDraft((d) => ({ ...d, token: next }))
          }}
        />
      </Field>
      {row.provider === 'gitlab' ? (
        <Switch
          checked={draft.rejectUnauthorized}
          disabled={busy}
          label={t('codeHostSettings.rejectUnauthorized')}
          hint={t('codeHostSettings.rejectUnauthorizedHint')}
          data-testid="code-host-reject-unauthorized-gitlab"
          onChange={(next) => {
            setDraft((d) => ({ ...d, rejectUnauthorized: next }))
          }}
        />
      ) : null}
      <div className="page__actions">
        <button
          ref={saveTriggerRef}
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy || draft.baseUrl.trim().length === 0}
          data-testid={`code-host-save-${row.provider}`}
          onClick={() => {
            save.mutate(null)
          }}
        >
          {t('common.save')}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy || (!row.configured && draft.token.length === 0)}
          data-testid={`code-host-test-${row.provider}`}
          onClick={() => {
            test.mutate()
          }}
        >
          {t('codeHostSettings.test')}
        </button>
        {row.configured ? (
          <button
            ref={removeTriggerRef}
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy}
            data-testid={`code-host-remove-${row.provider}`}
            onClick={() => {
              setRemoveImpact(null)
              setRemoveOpen(true)
            }}
          >
            {t('common.delete')}
          </button>
        ) : null}
      </div>
      {(testResult ?? row.lastTest) !== null ? (
        <p className="inspector-hint" data-testid={`code-host-test-result-${row.provider}`}>
          {(() => {
            const result = testResult ?? row.lastTest!
            if (result.ok) {
              return t('codeHostSettings.testOk', { login: result.login ?? '' })
            }
            return t('codeHostSettings.testFailed', {
              reason: t(`codeHostSettings.testCode_${result.code ?? 'bad-response'}`),
            })
          })()}
        </p>
      ) : null}
      <ConfirmDialog
        open={saveImpact !== null}
        title={t('codeHostSettings.rebindTitle')}
        description={t('codeHostSettings.rebindDescription', {
          count: saveImpact?.personalPushCredentialCount ?? 0,
        })}
        confirmLabel={t('codeHostSettings.confirmRebind')}
        tone="danger"
        triggerRef={saveTriggerRef}
        onClose={() => setSaveImpact(null)}
        onConfirm={async () => {
          if (saveImpact === null) return
          await save.mutateAsync(saveImpact)
        }}
      />
      <ConfirmDialog
        open={removeOpen}
        title={t('codeHostSettings.removeTitle', {
          provider: t(`codeHostProvider.${row.provider}`),
        })}
        description={
          (removeImpact?.personalPushCredentialCount ?? row.personalPushCredentialCount) > 0
            ? t('codeHostSettings.removeWithCredentialsDescription', {
                count: removeImpact?.personalPushCredentialCount ?? row.personalPushCredentialCount,
              })
            : t('codeHostSettings.removeDescription')
        }
        confirmLabel={t('common.delete')}
        tone="danger"
        triggerRef={removeTriggerRef}
        onClose={() => {
          setRemoveOpen(false)
          setRemoveImpact(null)
        }}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(removeImpact)
          } catch (nextError) {
            const impact = revocationImpactOf(nextError)
            if (impact !== null && removeImpact === null) {
              throw new Error(
                t('codeHostSettings.removeConfirmAgain', {
                  count: impact.personalPushCredentialCount,
                }),
              )
            }
            throw nextError
          }
        }}
      />
    </SettingsCard>
  )
}

export function CodeHostsSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const connections = useQuery<CodeHostConnectionWire[]>({
    queryKey: ['code-hosts'],
    queryFn: async () => api.get<CodeHostConnectionWire[]>('/api/code-hosts'),
  })

  if (connections.isLoading) return <LoadingState label={t('codeHostSettings.loading')} />
  if (connections.isError) return <ErrorBanner error={connections.error} />

  const rows = connections.data ?? []
  const byProvider = new Map(rows.map((r) => [r.provider, r]))

  return (
    <div className="form-grid" data-testid="code-hosts-section">
      <p className="inspector-hint">{t('codeHostSettings.intro')}</p>
      {PROVIDERS.map((provider) => {
        const row = byProvider.get(provider) ?? {
          provider,
          configured: false,
          baseUrl: '',
          repositoryUrlPrefixes: [],
          transportMappings: [],
          connectionGeneration: null,
          endpointBindingDigest: null,
          personalPushCredentialCount: 0,
          rejectUnauthorized: true,
          tokenHint: '',
          updatedAt: null,
          updatedBy: null,
          lastTest: null,
        }
        return (
          <ConnectionCard
            key={provider}
            row={row}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: ['code-hosts'] })
            }}
          />
        )
      })}
    </div>
  )
}

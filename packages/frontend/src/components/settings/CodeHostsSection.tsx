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

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  CodeHostConnectionWire,
  CodeHostProvider,
  CodeHostTestResult,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'

const PROVIDERS: readonly CodeHostProvider[] = ['gitlab', 'github']

interface Draft {
  baseUrl: string
  token: string
}

function ConnectionCard({ row, onSaved }: { row: CodeHostConnectionWire; onSaved: () => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>({ baseUrl: row.baseUrl, token: '' })
  const [error, setError] = useState<unknown>(null)
  const [testResult, setTestResult] = useState<CodeHostTestResult | null>(null)

  const save = useMutation({
    mutationFn: async () =>
      api.put<CodeHostConnectionWire>(`/api/code-hosts/${row.provider}`, {
        baseUrl: draft.baseUrl,
        ...(draft.token.length > 0 ? { token: draft.token } : {}),
      }),
    onSuccess: () => {
      setError(null)
      setDraft((d) => ({ ...d, token: '' }))
      setTestResult(null)
      onSaved()
    },
    onError: (err) => {
      setError(err)
    },
  })

  const test = useMutation({
    mutationFn: async () =>
      api.post<CodeHostTestResult>(`/api/code-hosts/${row.provider}/test`, {
        baseUrl: draft.baseUrl,
        ...(draft.token.length > 0 ? { token: draft.token } : {}),
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
    mutationFn: async () => api.delete<{ ok: true }>(`/api/code-hosts/${row.provider}`),
    onSuccess: () => {
      setError(null)
      setDraft({ baseUrl: '', token: '' })
      setTestResult(null)
      onSaved()
    },
    onError: (err) => {
      setError(err)
    },
  })

  const busy = save.isPending || test.isPending || remove.isPending

  return (
    <section className="page__section" data-testid={`code-host-card-${row.provider}`}>
      <h3>{t(`codeHostProvider.${row.provider}`)}</h3>
      {/* 只在真有错误时渲染：ErrorBanner 在 `error == null` 且无 `message` 时会
          落到 `t('common.unknownError')`，无条件渲染等于页面一打开就挂一条
          「未知错误」（用户实报）。 */}
      {error !== null ? <ErrorBanner error={error} /> : null}
      <Field
        label={t('codeHostSettings.baseUrl')}
        hint={t(`codeHostSettings.baseUrlHint_${row.provider}`)}
      >
        <TextInput
          value={draft.baseUrl}
          disabled={busy}
          data-testid={`code-host-base-url-${row.provider}`}
          onChange={(next) => {
            setDraft((d) => ({ ...d, baseUrl: next }))
          }}
        />
      </Field>
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
      <div className="page__actions">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy || draft.baseUrl.trim().length === 0}
          data-testid={`code-host-save-${row.provider}`}
          onClick={() => {
            save.mutate()
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
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy}
            data-testid={`code-host-remove-${row.provider}`}
            onClick={() => {
              remove.mutate()
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
    </section>
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
    <div data-testid="code-hosts-section">
      <p className="inspector-hint">{t('codeHostSettings.intro')}</p>
      {PROVIDERS.map((provider) => {
        const row = byProvider.get(provider) ?? {
          provider,
          configured: false,
          baseUrl: '',
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

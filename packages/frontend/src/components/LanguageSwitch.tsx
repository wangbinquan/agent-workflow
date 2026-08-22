// RFC-025: Sidebar-footer language switcher.
//
// Two-option segmented control. Clicking an option:
//   1. Always flips i18next + its localStorage cache (instant, per-browser).
//   2. Only actors with settings:write queue the minimal daemon config patch.
//   3. A definitive daemon-write error rolls an authorized writer back and
//      shows a muted red error line below the segmented control.
//
// For actors who can read and write daemon settings, backend config remains
// authoritative. Everyone else owns a browser-local language preference.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { Config } from '@agent-workflow/shared'
import { usePermission } from '@/hooks/useActor'
import { describeApiError, setLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n'
import { isSupportedLanguage } from '@/hooks/useLanguage'
import {
  cacheConfigWriteReceipt,
  configReceiptCoordinator,
  queryConfig,
  reconcileAmbiguousConfigWrite,
  useConfigQueryKey,
  writeConfigPatch,
} from '@/lib/config-resource'
import { getToken, subscribeAuth } from '@/stores/auth'
import { ConfigAmbiguousWriteError, type ConfigWriteReceipt } from '@/lib/config-receipts'

interface Props {
  className?: string
}

function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

export function LanguageSwitch({ className }: Props) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const token = useAuthToken()
  // RFC-036: language choice is personal UI state, not daemon administration.
  // A regular user must neither probe nor write /api/config; the i18next
  // localStorage cache remains their authority. Privileged actors retain the
  // historical daemon-wide sync behavior.
  const canReadConfig = usePermission('settings:read')
  const canWriteConfig = usePermission('settings:write')
  const canSyncConfig = canReadConfig && canWriteConfig
  const configQueryKey = useConfigQueryKey()
  const config = useQuery<Config>({
    queryKey: configQueryKey,
    queryFn: ({ signal }) => queryConfig(signal),
    enabled: token !== null && canSyncConfig,
    staleTime: 60_000,
  })

  // Config cache identity follows the daemon and intentionally survives an
  // account rotation. Never let an admin-populated cache override a regular
  // user's browser-local choice after logout/login.
  const daemonLanguage = canSyncConfig ? config.data?.language : undefined
  const current: SupportedLanguage = isSupportedLanguage(daemonLanguage)
    ? (daemonLanguage as SupportedLanguage)
    : isSupportedLanguage(i18n.language)
      ? (i18n.language as SupportedLanguage)
      : 'zh-CN'

  const mutation = useMutation<
    ConfigWriteReceipt,
    Error,
    SupportedLanguage,
    { previous: SupportedLanguage }
  >({
    mutationFn: (lang) => writeConfigPatch({ language: lang }),
    onMutate: (lang) => {
      const previous = current
      setLanguage(lang)
      return { previous }
    },
    onSuccess: (receipt) => {
      cacheConfigWriteReceipt(qc, receipt)
    },
    onError: async (error, lang, ctx) => {
      if (error instanceof ConfigAmbiguousWriteError) {
        try {
          const receipt = await reconcileAmbiguousConfigWrite(error, qc)
          if (isSupportedLanguage(receipt.config.language)) {
            setLanguage(receipt.config.language as SupportedLanguage)
          }
        } catch {
          // Keep the optimistic choice visible alongside the outcome-unknown
          // error. Rolling back would falsely claim the daemon rejected it.
        }
        return
      }
      // A late definitive error must not roll a newer accepted language back.
      const acceptedLanguage = configReceiptCoordinator.getSnapshot()?.config.language
      if (ctx && i18n.language === lang && acceptedLanguage !== lang) setLanguage(ctx.previous)
    },
  })

  return (
    <div
      role="group"
      aria-label={t('sidebar.languageGroupLabel')}
      className={`language-switch ${className ?? ''}`.trim()}
    >
      <div className="language-switch__options">
        {SUPPORTED_LANGUAGES.map((lang) => {
          const labelKey = lang === 'zh-CN' ? 'sidebar.lang.zh' : 'sidebar.lang.en'
          const active = lang === current
          return (
            <button
              key={lang}
              type="button"
              role="radio"
              aria-checked={active}
              data-lang={lang}
              className={`language-switch__option ${active ? 'language-switch__option--active' : ''}`.trim()}
              disabled={mutation.isPending}
              onClick={() => {
                if (lang === current) return
                if (!canWriteConfig) {
                  setLanguage(lang)
                  return
                }
                mutation.mutate(lang)
              }}
            >
              {t(labelKey)}
            </button>
          )
        })}
      </div>
      {mutation.error && (
        <div className="language-switch__error" role="alert">
          {describeApiError(mutation.error)}
        </div>
      )}
    </div>
  )
}

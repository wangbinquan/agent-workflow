// RFC-025: Sidebar-footer language switcher.
//
// Two-option segmented control. Clicking an option:
//   1. Optimistically flips i18next via setLanguage (instant UI response).
//   2. Queues the minimal PUT /api/config { language } patch to persist.
//   3. On error, rolls i18next back to the previous value + shows a muted
//      red error line below the segmented control.
//
// Backend config is the authority — useApplyLanguage will reconcile if the
// backend ever disagrees with the optimistic flip.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { Config } from '@agent-workflow/shared'
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
  const configQueryKey = useConfigQueryKey()
  const config = useQuery<Config>({
    queryKey: configQueryKey,
    queryFn: ({ signal }) => queryConfig(signal),
    enabled: token !== null,
    staleTime: 60_000,
  })

  const current: SupportedLanguage = isSupportedLanguage(config.data?.language)
    ? (config.data!.language as SupportedLanguage)
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

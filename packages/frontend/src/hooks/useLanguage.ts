// RFC-025: Resolve config.language → i18next runtime + <html lang>.
//
// Backend `config.language` is authoritative. The cold-start LanguageDetector
// (localStorage → navigator → fallback zh-CN) gives the first paint to avoid
// a flash, then this hook reconciles to the backend value as soon as the
// /api/config query resolves. Mirror of useApplyTheme so both hooks share the
// same ['config'] query key and TanStack Query de-duplicates the fetch.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import type { Config } from '@agent-workflow/shared'
import i18n, { setLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n'
import { queryConfig, useConfigQueryKey } from '@/lib/config-resource'
import { getToken, subscribeAuth } from '@/stores/auth'

export function isSupportedLanguage(x: unknown): x is SupportedLanguage {
  return typeof x === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(x)
}

function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

/** Side-effect hook: keep i18next + <html lang> in sync with config.language. */
export function useApplyLanguage(): void {
  const token = useAuthToken()
  const configQueryKey = useConfigQueryKey()
  const config = useQuery<Config>({
    queryKey: configQueryKey,
    queryFn: ({ signal }) => queryConfig(signal),
    enabled: token !== null,
    staleTime: 60_000,
  })

  const target: SupportedLanguage | null = isSupportedLanguage(config.data?.language)
    ? (config.data!.language as SupportedLanguage)
    : null

  useEffect(() => {
    if (target === null) return
    if (i18n.language !== target) setLanguage(target)
    if (typeof document !== 'undefined') document.documentElement.lang = target
  }, [target])
}

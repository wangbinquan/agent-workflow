// RFC-025: Resolve config.language → i18next runtime + <html lang>.
//
// For actors who can administer daemon settings, `config.language` is
// authoritative. Everyone else retains the LanguageDetector choice
// (localStorage → navigator → fallback zh-CN) as personal browser state.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import type { Config } from '@agent-workflow/shared'
import { usePermission } from '@/hooks/useActor'
import i18n, { setLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n'
import { queryConfig, useConfigQueryKey } from '@/lib/config-resource'
import { getToken, subscribeAuth } from '@/stores/auth'

export function isSupportedLanguage(x: unknown): x is SupportedLanguage {
  return typeof x === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(x)
}

function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

/** Apply daemon language only for an actor allowed to read and write it. */
export function useApplyLanguage(): void {
  const token = useAuthToken()
  // RFC-036: daemon config is admin state. Regular users keep their language
  // in i18next/localStorage and must not generate a guaranteed-403 config read.
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

  // The config cache is daemon-scoped and can contain an earlier admin's
  // snapshot. Ignore it whenever the current actor cannot read that resource.
  const daemonLanguage = canSyncConfig ? config.data?.language : undefined
  const target: SupportedLanguage | null = isSupportedLanguage(daemonLanguage)
    ? (daemonLanguage as SupportedLanguage)
    : null

  useEffect(() => {
    if (target === null) return
    if (i18n.language !== target) setLanguage(target)
    if (typeof document !== 'undefined') document.documentElement.lang = target
  }, [target])
}
